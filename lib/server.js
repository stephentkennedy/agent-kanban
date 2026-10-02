'use strict';

// The graphical board: a small JSON API over the store, the static page in web/, and a server-sent event
// stream that tells open pages to refresh when a task file is edited or the CLI changes kanban.db.
// It listens on 127.0.0.1 only.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { KanbanError, PRIORITIES, TYPES } = require('./store');

const WEB = path.join(__dirname, '..', 'web');
const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function serve(store, { port = 4477, open = false } = {}) {
    const clients = new Set();
    const broadcast = () => {
        for (const res of clients) res.write('event: change\ndata: {}\n\n');
    };

    const routes = [
        ['GET', /^\/api\/board$/, () => {
            store.sync();
            return { columns: store.columns(), tasks: store.list({ archived: true }), tags: store.tags(), priorities: PRIORITIES, types: TYPES };
        }],
        ['GET', /^\/api\/tasks\/(\d+)$/, ([id]) => {
            store.sync();
            return { ...store.get(id), history: store.history(id) };
        }],
        ['POST', /^\/api\/tasks$/, (_, body) => {
            const id = store.add(body.title, body);
            return store.get(id);
        }, true],
        ['PATCH', /^\/api\/tasks\/(\d+)$/, ([id], body) => {
            store.update(id, body);
            return store.get(id);
        }, true],
        ['PUT', /^\/api\/tasks\/(\d+)\/body$/, ([id], body) => {
            store.saveBody(id, String(body.body ?? ''), body.baseHash);
            return store.get(id);
        }, true],
        ['POST', /^\/api\/tasks\/(\d+)\/move$/, ([id], body) => {
            store.move(id, body.status, body.index);
            return { ok: true };
        }, true],
        ['POST', /^\/api\/tasks\/(\d+)\/toggle$/, ([id], body) => {
            store.toggleCheck(id, Number(body.line), body.baseHash);
            return store.get(id);
        }, true],
        ['POST', /^\/api\/tasks\/(\d+)\/open$/, ([id]) => {
            openFile(store.get(id, { body: false }).path);
            return { ok: true };
        }],
        ['DELETE', /^\/api\/tasks\/(\d+)$/, ([id]) => store.remove(id), true],
    ];

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        try {
            if (req.method === 'GET' && STATIC[url.pathname]) {
                const [file, type] = STATIC[url.pathname];
                res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
                return res.end(fs.readFileSync(path.join(WEB, file)));
            }
            if (req.method === 'GET' && url.pathname === '/api/events') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
                res.write('retry: 2000\n\n');
                clients.add(res);
                req.on('close', () => clients.delete(res));
                return;
            }
            // A page on another site can reach 127.0.0.1 through DNS rebinding; its Host header gives it away.
            if (!localHost(req)) throw new KanbanError('Unexpected Host header.', 403);
            for (const [method, pattern, handler, changes] of routes) {
                const m = url.pathname.match(pattern);
                if (!m || req.method !== method) continue;
                // Only same-origin pages may write, so another site open in the browser cannot drive the board.
                if (method !== 'GET' && !sameOrigin(req)) throw new KanbanError('Cross-origin request refused.', 403);
                const body = method === 'GET' ? {} : await readJson(req);
                const result = handler(m.slice(1), body);
                if (changes) broadcast();
                return send(res, 200, result);
            }
            send(res, 404, { error: 'Not found.' });
        } catch (e) {
            if (!(e instanceof KanbanError)) console.error(e);
            send(res, e.status || 500, { error: e.message });
        }
    });

    // External edits: the tasks folder is watched, and data_version reveals commits by other processes.
    let timer = null;
    const onFileChange = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            try {
                const r = store.sync();
                if (r.imported || ['added', 'updated', 'renamed', 'missing', 'restored'].some(k => r[k].length)) broadcast();
                r.notices.forEach(n => console.log(n));
            } catch (e) {
                console.error(e.message);
            }
        }, 150);
    };
    fs.watch(store.tasksDir, onFileChange);
    // kanban.jsonl changes under us on a pull, checkout or merge. Git replaces the file, so the folder is watched.
    fs.watch(store.home, (event, name) => { if (name === path.basename(store.exportPath)) onFileChange(); });
    let version = store.dataVersion();
    setInterval(() => {
        const v = store.dataVersion();
        if (v !== version) { version = v; broadcast(); }
    }, 1000).unref();
    setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

    server.listen(port, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${server.address().port}/`;
        console.log(`Kanban board at ${url}  (Ctrl+C to stop)`);
        if (open) openFile(url);
    });
    server.on('error', e => {
        console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use; try --port <n>.` : e.message);
        process.exit(1);
    });
    return server;
}

function localHost(req) {
    return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '');
}

function sameOrigin(req) {
    const origin = req.headers.origin;
    return !origin || origin === `http://${req.headers.host}`;
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            data += chunk;
            if (data.length > 5e6) reject(new KanbanError('Request too large.', 413));
        });
        req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new KanbanError('Body is not JSON.')); }
        });
        req.on('error', reject);
    });
}

function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value ?? null));
}

// "Open file" uses KANBAN_OPEN when set (e.g. "code" or "subl"), otherwise the desktop's default handler.
function openFile(target) {
    const cmd = process.env.KANBAN_OPEN
        || (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open');
    const child = spawn(cmd, [target], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('error', e => console.error(`Could not run ${cmd}: ${e.message}`));
    child.unref();
}

module.exports = { serve };
