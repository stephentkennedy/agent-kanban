'use strict';

// The graphical board: a small JSON API over the store, the static page in web/, a server-sent event stream
// of the board's events, and terminals for agent sessions over WebSockets. It listens on 127.0.0.1 only.
//
// Events reach the page whoever made them: this server's own writes, the CLI and agents' hooks (other
// processes, noticed through data_version), and edits to task files (the folder is watched).
//
// The terminal endpoints need the optional packages (ws, node-pty, @xterm/*) and tmux; without them the
// board works as before and says why terminals are unavailable.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { KanbanError, PRIORITIES, TYPES, actionable, attentionRank } = require('./store');
const sessions = require('./sessions');
const config = require('./config');
const { what } = require('./describe');

const WEB = path.join(__dirname, '..', 'web');
const MODULES = path.join(__dirname, '..', 'node_modules');
const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'],
    '/term.js': ['term.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const VENDOR = {
    '/vendor/xterm.js': ['@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
    '/vendor/xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
    '/vendor/addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};
// Ended sessions stay on the board this long, so a crash or a finished run is still visible.
const RECENT_MS = 24 * 3600e3;

function optional(name) {
    try { return require(name); } catch { return null; }
}

function serve(store, { port = 4477, open = false } = {}) {
    // The server's own housekeeping is 'system'; each request runs as 'user'.
    store.actor = 'system';
    store.session = null;
    const clients = new Set();
    const lastTyped = new Map(); // session id -> when someone last typed into it in the browser

    function capabilities() {
        const a = sessions.available();
        const xterm = Object.values(VENDOR).every(([file]) => fs.existsSync(path.join(MODULES, file)));
        const ws = !!optional('ws');
        const cfg = config.load(store.home);
        return {
            ...a, xterm, ws, terminals: a.tmuxOk && a.pty && xterm && ws,
            profiles: Object.values(cfg.profiles).map(p => ({ name: p.name, label: p.label || p.name })),
            defaultProfile: cfg.defaultProfile,
        };
    }

    // The agent side of the board: each task's claim, session, and whether a change by the user is still
    // unread by its agent.
    function withRuntime(tasks) {
        const { claims, sessions: bySession, unseen } = store.runtime();
        return tasks.map(t => ({
            ...t,
            claim: claims.get(t.id) || null,
            session: bySession.has(t.id) ? sessionView(bySession.get(t.id)) : null,
            user_changed_unseen: unseen.has(t.id),
        }));
    }

    function boardSessions() {
        const cutoff = Date.now() - RECENT_MS;
        return store.sessions().filter(s => !['exited', 'lost'].includes(s.status) || Date.parse(s.ended_at || s.updated_at) > cutoff)
            .map(sessionView);
    }

    const routes = [
        ['GET', /^\/api\/board$/, () => {
            store.sync();
            return {
                columns: store.columns(), tasks: withRuntime(store.list({ archived: true })), tags: store.tags(),
                priorities: PRIORITIES, types: TYPES, sessions: boardSessions(), lastEventId: store.lastEventId(),
            };
        }],
        ['GET', /^\/api\/tasks\/(\d+)$/, ([id]) => {
            store.sync();
            const [task] = withRuntime([store.get(id)]);
            return { ...task, history: store.history(id) };
        }],
        ['POST', /^\/api\/tasks$/, (_, body) => {
            const id = store.add(body.title, body);
            return store.get(id);
        }],
        ['PATCH', /^\/api\/tasks\/(\d+)$/, ([id], body) => {
            store.update(id, body);
            return store.get(id);
        }],
        ['PUT', /^\/api\/tasks\/(\d+)\/body$/, ([id], body) => {
            store.saveBody(id, String(body.body ?? ''), body.baseHash);
            return store.get(id);
        }],
        ['POST', /^\/api\/tasks\/(\d+)\/move$/, ([id], body) => {
            store.move(id, body.status, body.index);
            return { ok: true };
        }],
        ['POST', /^\/api\/tasks\/(\d+)\/toggle$/, ([id], body) => {
            store.toggleCheck(id, Number(body.line), body.baseHash);
            return store.get(id);
        }],
        ['POST', /^\/api\/tasks\/(\d+)\/open$/, ([id]) => {
            openFile(store.get(id, { body: false }).path);
            return { ok: true };
        }],
        ['DELETE', /^\/api\/tasks\/(\d+)$/, ([id]) => store.remove(id)],
        ['GET', /^\/api\/tasks\/(\d+)\/events$/, ([id], _, url) =>
            store.events({ task: id, limit: Number(url.searchParams.get('limit')) || 100, latest: true }).map(withText)],
        ['POST', /^\/api\/tasks\/(\d+)\/messages$/, ([id], body) => ({ id: store.post(id, body.text) })],
        ['POST', /^\/api\/tasks\/(\d+)\/claim$/, ([id], body) => store.claim(id, { force: body.force })],
        ['POST', /^\/api\/tasks\/(\d+)\/release$/, ([id]) => ({ released: store.release(id, { force: true }) })],

        ['PATCH', /^\/api\/columns\/([a-z0-9][a-z0-9_-]*)$/, ([key], body) => {
            store.updateColumn(key, { sort: body.sort, label: body.label });
            return store.column(key);
        }],
        ['GET', /^\/api\/events\/log$/, (_, __, url) => store.events({
            after: Number(url.searchParams.get('after')) || 0, task: url.searchParams.get('task') || undefined,
            limit: Math.min(500, Number(url.searchParams.get('limit')) || 200),
        }).map(withText)],

        ['GET', /^\/api\/capabilities$/, () => capabilities()],
        ['GET', /^\/api\/profiles$/, () => Object.values(config.load(store.home).profiles)
            .map(p => ({ name: p.name, label: p.label || p.name, command: p.command }))],
        ['GET', /^\/api\/sessions$/, () => {
            const { orphans } = store.as('system', () => sessions.poll(store));
            return { sessions: boardSessions(), orphans };
        }],
        ['POST', /^\/api\/sessions$/, (_, body) => sessionView(sessions.spawnSession(store, {
            role: body.role === 'orchestrator' ? 'orchestrator' : 'task', task: body.task, profile: body.profile, force: !!body.force,
        }))],
        ['GET', /^\/api\/sessions\/(\d+)$/, ([id]) => sessionView(store.sessionOf(id))],
        ['POST', /^\/api\/sessions\/(\d+)\/kill$/, ([id], body) => sessionView(sessions.kill(store, id, { worktree: body.worktree || 'keep' }))],
        ['POST', /^\/api\/sessions\/(\d+)\/resume$/, ([id]) => sessionView(sessions.resume(store, id))],
        ['POST', /^\/api\/sessions\/(\d+)\/input$/, ([id], body) => {
            sessions.send(store, id, String(body.text ?? ''), { enter: body.enter !== false });
            lastTyped.set(Number(id), Date.now());
            return { ok: true };
        }],
        ['POST', /^\/api\/sessions\/(\d+)\/nudge$/, ([id]) => sessionView(sessions.nudge(store, id))],
        ['POST', /^\/api\/sessions\/(\d+)\/messages$/, ([id], body) => ({ id: store.send(id, body.text) })],
        ['GET', /^\/api\/sessions\/(\d+)\/peek$/, ([id], _, url) => ({ text: sessions.peek(store, id, { lines: url.searchParams.get('lines') }) })],
        ['GET', /^\/api\/sessions\/(\d+)\/inbox$/, ([id]) => store.inbox(Number(id), { advance: false }).map(withText)],
        ['GET', /^\/api\/sessions\/(\d+)\/subscriptions$/, ([id]) => store.subscriptions(Number(id))],
        ['POST', /^\/api\/sessions\/(\d+)\/subscriptions$/, ([id], body) => store.subscribe(Number(id), { task: body.task || 0, types: body.types })],
        ['DELETE', /^\/api\/sessions\/(\d+)\/subscriptions\/(\d+)$/, ([id, sub]) => ({ removed: store.unsubscribe(Number(id), { id: Number(sub) }) })],
    ];

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        try {
            if (req.method === 'GET' && STATIC[url.pathname]) {
                const [file, type] = STATIC[url.pathname];
                res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
                return res.end(fs.readFileSync(path.join(WEB, file)));
            }
            if (req.method === 'GET' && VENDOR[url.pathname]) {
                const [file, type] = VENDOR[url.pathname];
                const full = path.join(MODULES, file);
                if (!fs.existsSync(full)) return send(res, 404, { error: 'Run npm install in the kanban folder for terminals.' });
                res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' });
                return res.end(fs.readFileSync(full));
            }
            if (req.method === 'GET' && url.pathname === '/api/events') return stream(req, res);
            if (url.pathname === '/favicon.ico') return res.writeHead(204).end();
            // A page on another site can reach 127.0.0.1 through DNS rebinding; its Host header gives it away.
            if (!localHost(req)) throw new KanbanError('Unexpected Host header.', 403);
            for (const [method, pattern, handler] of routes) {
                const m = url.pathname.match(pattern);
                if (!m || req.method !== method) continue;
                if (method !== 'GET') {
                    // Only same-origin pages may write, so another site open in the browser cannot drive the board,
                    // or its terminals. A JSON body also cannot be sent cross-site without a CORS preflight.
                    if (!sameOrigin(req)) throw new KanbanError('Cross-origin request refused.', 403);
                    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new KanbanError('Send JSON.', 415);
                }
                const body = method === 'GET' ? {} : await readJson(req);
                const result = store.as('user', () => handler(m.slice(1), body, url));
                send(res, 200, result);
                pump();
                return;
            }
            send(res, 404, { error: 'Not found.' });
        } catch (e) {
            if (!(e instanceof KanbanError)) console.error(e);
            send(res, e.status || 500, { error: e.message });
        }
    });

    /* ---------- the event stream ---------- */

    // Each event goes to the page as `event: kanban`. A batch that changed the board also sends the plain
    // `change` the page has always reloaded on.
    function stream(req, res) {
        if (!localHost(req)) return send(res, 403, { error: 'Unexpected Host header.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        // A reconnecting page says what it saw last, and gets what it missed.
        const last = Number(req.headers['last-event-id']);
        if (last > 0) {
            const missed = store.events({ after: last, limit: 1000 });
            if (missed.length) {
                missed.forEach(e => res.write(frame(e)));
                res.write('event: change\ndata: {}\n\n');
            }
        }
        clients.add(res);
        req.on('close', () => clients.delete(res));
    }

    const frame = e => `id: ${e.id}\nevent: kanban\ndata: ${JSON.stringify(withText(e))}\n\n`;
    const boardEvent = e => /^(task|board|column)\./.test(e.type);

    let cursor = store.lastEventId();
    function pump() {
        try {
            for (;;) {
                const batch = store.events({ after: cursor, limit: 500 });
                if (!batch.length) return;
                cursor = batch[batch.length - 1].id;
                for (const res of clients) {
                    batch.forEach(e => res.write(frame(e)));
                    if (batch.some(boardEvent)) res.write('event: change\ndata: {}\n\n');
                }
                if (batch.some(e => actionable(e, 'orchestrator'))) setTimeout(nudgeIdle, 2000);
                if (batch.length < 500) return;
            }
        } catch (e) {
            console.error(e.message);
        }
    }

    /* ---------- watching ---------- */

    // External edits: the tasks folder is watched, and data_version reveals commits by other processes.
    let timer = null;
    const onFileChange = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            try {
                const r = store.sync();
                r.notices.forEach(n => console.log(n));
                pump();
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
        if (v !== version) { version = v; pump(); }
    }, 500).unref();
    setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

    // Sessions: whether each is still there, and for tools without hooks whether it is working, idle or
    // asking something. Idle sessions with something to act on are nudged.
    const watchSessions = () => {
        try {
            if (!sessions.available().tmux || !store.sessions({ live: true }).length) return;
            store.as('system', () => sessions.poll(store));
            nudgeIdle();
            pump();
        } catch (e) {
            console.error(`Watching sessions: ${e.message}`);
        }
    };
    watchSessions();
    setInterval(watchSessions, 2000).unref();
    // Events every live session has read, and that are a fortnight old, are forgotten.
    store.pruneEvents();
    setInterval(() => { try { store.pruneEvents(); } catch (e) { console.error(e.message); } }, 6 * 3600e3).unref();

    // Types the profile's nudge into an idle session that has events to act on, unless it was nudged
    // recently or someone has just been typing into it.
    function nudgeIdle() {
        if (!sessions.available().tmuxOk) return;
        let cfg;
        try { cfg = config.load(store.home); } catch (e) { return console.error(e.message); }
        const now = Date.now();
        for (const s of store.sessions({ live: true })) {
            const p = cfg.profiles[s.profile];
            if (s.status !== 'idle' || !p || !p.nudge) continue;
            if (s.nudged_at && now - Date.parse(s.nudged_at) < cfg.nudge.cooldownMs) continue;
            if (now - (lastTyped.get(s.id) || 0) < cfg.nudge.quietAfterTypingMs) continue;
            if (!store.inbox(s.id, { advance: false, actionableOnly: true }).length) continue;
            try {
                sessions.nudge(store, s.id);
            } catch (e) {
                console.error(`Nudging ${s.name}: ${e.message}`);
            }
        }
    }

    /* ---------- terminals ---------- */

    let wss;
    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://localhost');
        const m = url.pathname.match(/^\/api\/sessions\/(\d+)\/term$/);
        // A WebSocket is not bound by CORS, so the Origin check is the whole defence against another site
        // open in the same browser.
        if (!m || !localHost(req) || req.headers.origin !== `http://${req.headers.host}`) {
            socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        const WS = optional('ws');
        const pty = optional('node-pty');
        if (!WS || !pty) {
            socket.end('HTTP/1.1 501 Not Implemented\r\n\r\n');
            return;
        }
        wss = wss || new WS.WebSocketServer({ noServer: true });
        wss.handleUpgrade(req, socket, head, ws => attachTerminal(ws, pty, Number(m[1]), url));
    });

    // Each viewer is its own tmux client of the session, so several can watch one terminal.
    function attachTerminal(ws, pty, id, url) {
        let s;
        try {
            s = store.sessionOf(id);
            sessions.requireTmux();
        } catch (e) {
            return ws.close(4004, e.message.slice(0, 120));
        }
        const size = (v, d) => Math.max(10, Math.min(500, Number(v) || d));
        const [cmd, args] = sessions.attachCommand(store.home, s, { readOnly: url.searchParams.get('ro') === '1' });
        const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
        delete env.TMUX;
        let term;
        try {
            term = pty.spawn(cmd, args, {
                name: 'xterm-256color', cols: size(url.searchParams.get('cols'), 100), rows: size(url.searchParams.get('rows'), 30),
                cwd: store.home, env,
            });
        } catch (e) {
            return ws.close(4000, e.message.slice(0, 120));
        }
        let paused = false;
        const resumeWhenDrained = () => {
            if (ws.bufferedAmount < 256e3) { paused = false; term.resume(); } else setTimeout(resumeWhenDrained, 50);
        };
        term.onData(data => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(data);
            if (!paused && ws.bufferedAmount > 1e6) {
                paused = true;
                term.pause();
                setTimeout(resumeWhenDrained, 50);
            }
        });
        term.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(4000, 'Detached'); });
        ws.on('message', raw => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            if (msg.t === 'i' && typeof msg.d === 'string') {
                term.write(msg.d);
                lastTyped.set(s.id, Date.now());
            } else if (msg.t === 'r') {
                try { term.resize(size(msg.c, 100), size(msg.r, 30)); } catch { /* the client has gone */ }
            }
        });
        ws.on('close', () => { try { term.kill(); } catch { /* already gone */ } });
    }

    server.listen(port, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${server.address().port}/`;
        console.log(`Kanban board at ${url}  (Ctrl+C to stop)`);
        const a = sessions.available();
        if (!a.tmux) console.log('Agent sessions are off: install tmux 3.2 or later.');
        else if (!a.pty || !optional('ws')) console.log('Terminals in the browser are off: run npm install in the kanban folder.');
        if (open) openFile(url);
    });
    server.on('error', e => {
        console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use; try --port <n>.` : e.message);
        process.exit(1);
    });
    return server;
}

const withText = e => ({ ...e, text: what(e) });

// What the page needs to know about a session.
function sessionView(s) {
    return {
        id: s.id, name: s.name, role: s.role, profile: s.profile, task_id: s.task_id, status: s.status,
        status_reason: s.status_reason, attention: attentionRank(s), attention_since: s.attention_since, exit_code: s.exit_code,
        worktree: s.worktree, branch: s.branch, cwd: s.cwd, created_at: s.created_at, updated_at: s.updated_at, ended_at: s.ended_at,
        worktreeRemoved: s.worktreeRemoved,
    };
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
