'use strict';

// The task store. Markdown files in tasks/ are the content, and are the source of truth for a task's
// title and body. kanban.db holds everything a file cannot say about itself: which column it is in, its
// place in that column, priority, type, tags and history.
//
// kanban.db is not committed; kanban.jsonl is. Every write transaction first reloads kanban.jsonl if it
// changed underneath the database (a pull, checkout or merge), and ends by rewriting it, so the file is
// always the whole board and git never has a stale copy to overwrite.
//
// The two are reconciled by sync(), which every read and write runs first, so a file created, edited,
// renamed or deleted by hand is always picked up. A task is keyed by its file name; a rename is recognised
// by content (or failing that, title) matching a task whose file has just gone.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = loadSqlite();
const exportFile = require('./exportfile');

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const TYPES = ['feature', 'bug', 'content', 'chore', 'idea'];
const KINDS = ['queue', 'active', 'done'];

const DEFAULT_COLUMNS = [
    { key: 'backlog', label: 'Backlog', kind: 'queue' },
    { key: 'todo', label: 'To do', kind: 'queue' },
    { key: 'doing', label: 'In progress', kind: 'active', wip_limit: 3 },
    { key: 'review', label: 'Review', kind: 'active' },
    { key: 'done', label: 'Done', kind: 'done' },
];

const SCHEMA_VERSION = 2;

const CHECKBOX = /^(\s*[-*+]\s+\[)([ xX])(\]\s+\S.*)$/;
const FENCE = /^\s*(```|~~~)/;

function loadSqlite() {
    // node:sqlite announces itself with an ExperimentalWarning on load, which is noise in a CLI.
    const emit = process.emitWarning;
    process.emitWarning = function (warning, ...rest) {
        if (/SQLite/.test(String(warning && warning.message || warning))) return;
        return emit.call(process, warning, ...rest);
    };
    try {
        return require('node:sqlite');
    } catch (e) {
        throw new Error(`kanban needs node:sqlite (Node 22.13 or later); this is Node ${process.versions.node}.`);
    } finally {
        process.emitWarning = emit;
    }
}

function now() {
    return new Date().toISOString();
}

function hashOf(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
}

function slugify(title) {
    return title.toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60).replace(/-+$/, '') || 'task';
}

// Everything the store reads out of a task file. Checkboxes inside code fences are not counted.
function parseTask(text, file) {
    const lines = text.split(/\r?\n/);
    let title = null, done = 0, total = 0, fenced = false;
    for (const line of lines) {
        if (FENCE.test(line)) { fenced = !fenced; continue; }
        if (fenced) continue;
        if (title === null) {
            const h = line.match(/^#\s+(.+?)\s*#*\s*$/);
            if (h) title = h[1];
        }
        const c = line.match(CHECKBOX);
        if (c) { total++; if (c[2] !== ' ') done++; }
    }
    return {
        title: title || path.basename(file, '.md').replace(/[-_]+/g, ' '),
        checks_done: done,
        checks_total: total,
    };
}

class KanbanError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

class Store {
    constructor(home) {
        this.home = path.resolve(home);
        this.tasksDir = path.join(this.home, 'tasks');
        this.dbPath = path.join(this.home, 'kanban.db');
        this.exportPath = path.join(this.home, 'kanban.jsonl');
        this.notices = [];
        this.imported = false;
        fs.mkdirSync(this.tasksDir, { recursive: true });

        this.db = new DatabaseSync(this.dbPath);
        // Rollback journal rather than WAL, so the committed kanban.db is always complete on its own.
        this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        this.migrate();
    }

    close() {
        this.db.close();
    }

    migrate() {
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version >= SCHEMA_VERSION) return;
        // Not this.tx(): that reads and writes kanban.jsonl, which needs the tables this creates.
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS columns (
                    key       TEXT PRIMARY KEY,
                    label     TEXT NOT NULL,
                    position  INTEGER NOT NULL,
                    kind      TEXT NOT NULL DEFAULT 'queue',
                    wip_limit INTEGER
                );
                CREATE TABLE IF NOT EXISTS tasks (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    file         TEXT NOT NULL UNIQUE,
                    title        TEXT NOT NULL,
                    status       TEXT NOT NULL REFERENCES columns(key) ON UPDATE CASCADE,
                    position     REAL NOT NULL DEFAULT 0,
                    priority     TEXT NOT NULL DEFAULT 'normal',
                    type         TEXT NOT NULL DEFAULT 'feature',
                    hash         TEXT,
                    checks_done  INTEGER NOT NULL DEFAULT 0,
                    checks_total INTEGER NOT NULL DEFAULT 0,
                    archived     INTEGER NOT NULL DEFAULT 0,
                    missing      INTEGER NOT NULL DEFAULT 0,
                    created_at   TEXT NOT NULL,
                    updated_at   TEXT NOT NULL,
                    started_at   TEXT,
                    completed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS tags (
                    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                    tag     TEXT NOT NULL,
                    PRIMARY KEY (task_id, tag)
                );
                CREATE TABLE IF NOT EXISTS history (
                    id      INTEGER PRIMARY KEY,
                    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                    at      TEXT NOT NULL,
                    field   TEXT NOT NULL,
                    old     TEXT,
                    new     TEXT
                );
                CREATE TABLE IF NOT EXISTS meta (
                    key   TEXT PRIMARY KEY,
                    value TEXT
                );
                CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, position);
                CREATE INDEX IF NOT EXISTS history_task ON history(task_id, at);
            `);
            if (version === 0) this.insertColumns(DEFAULT_COLUMNS.map(c => ({ ...c, wip: c.wip_limit })));
            this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }

    insertColumns(columns) {
        const insert = this.db.prepare('INSERT INTO columns (key, label, position, kind, wip_limit) VALUES (?, ?, ?, ?, ?)');
        columns.forEach((c, i) => insert.run(c.key, c.label, i, KINDS.includes(c.kind) ? c.kind : 'queue', c.wip || null));
    }

    // Every write takes the database's write lock *before* touching the tasks folder, so a CLI command and
    // a running server never interleave a file write with a sync that would misread it.
    tx(fn) {
        if (this.inTx) return fn();
        this.db.exec('BEGIN IMMEDIATE');
        this.inTx = true;
        this.notices = [];
        this.imported = false;
        try {
            this.importIfChanged();
            const result = fn();
            this.writeExport();
            this.db.exec('COMMIT');
            return result;
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        } finally {
            this.inTx = false;
        }
    }

    // Changes whenever *another* connection commits. The server polls it to notice CLI edits.
    dataVersion() {
        return this.db.prepare('PRAGMA data_version').get().data_version;
    }

    /* ---------- kanban.jsonl ---------- */

    meta(key, value) {
        if (value === undefined) return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
        this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    }

    exportText() {
        const columns = this.db.prepare('SELECT * FROM columns ORDER BY position').all()
            .map(c => ({ key: c.key, label: c.label, kind: c.kind, wip: c.wip_limit }));
        const history = new Map();
        for (const h of this.db.prepare('SELECT task_id, at, field, old, new FROM history ORDER BY at, id').all()) {
            if (!history.has(h.task_id)) history.set(h.task_id, []);
            history.get(h.task_id).push([h.at, h.field, h.old, h.new]);
        }
        const tasks = this.list({ archived: true, missing: true }).map(t => ({
            id: t.id, file: t.file, title: t.title, status: t.status, position: t.position,
            priority: t.priority, type: t.type, tags: t.tags, archived: t.archived, missing: t.missing,
            created: t.created_at, updated: t.updated_at, started: t.started_at, completed: t.completed_at,
            history: history.get(t.id) || [],
        }));
        return exportFile.format({ columns, tasks });
    }

    // Rewrites kanban.jsonl when the board differs from it. export_hash records the file the database
    // matches, which is how importIfChanged tells that someone else changed it.
    writeExport() {
        const text = this.exportText();
        const current = fs.existsSync(this.exportPath) ? fs.readFileSync(this.exportPath, 'utf8') : null;
        if (current !== text) {
            const tmp = path.join(this.home, `.kanban.jsonl.${process.pid}.tmp`);
            fs.writeFileSync(tmp, text);
            fs.renameSync(tmp, this.exportPath);
        }
        this.meta('export_hash', hashOf(text));
    }

    importIfChanged(force = false) {
        if (!fs.existsSync(this.exportPath)) return;
        const text = fs.readFileSync(this.exportPath, 'utf8');
        if (!force && hashOf(text) === this.meta('export_hash')) return;
        this.importText(text);
        this.meta('export_hash', hashOf(text));
        this.imported = true;
    }

    // Replaces the database's contents with kanban.jsonl's. Title and progress are re-read from the task
    // files by the sync that follows.
    importText(text) {
        let data;
        try {
            data = exportFile.parse(text);
        } catch (e) {
            throw new KanbanError(e.message, 409);
        }
        this.db.exec('DELETE FROM history; DELETE FROM tags; DELETE FROM tasks; DELETE FROM columns;');
        const columns = data.columns.length ? data.columns : DEFAULT_COLUMNS.map(c => ({ ...c, wip: c.wip_limit }));
        this.insertColumns(columns);
        const keys = new Set(columns.map(c => c.key));

        // A hand-resolved merge can leave two tasks with one id or one file; the later line gives way.
        const ids = new Set(), files = new Set();
        let nextId = Math.max(0, ...data.tasks.map(t => t.id)) + 1;
        const insert = this.db.prepare(`INSERT INTO tasks (id, file, title, status, position, priority, type, archived,
            missing, created_at, updated_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const tag = this.db.prepare('INSERT OR IGNORE INTO tags (task_id, tag) VALUES (?, ?)');
        const hist = this.db.prepare('INSERT INTO history (task_id, at, field, old, new) VALUES (?, ?, ?, ?, ?)');
        for (const t of data.tasks) {
            if (files.has(t.file)) {
                this.notices.push(`kanban.jsonl line ${t.line} repeats ${t.file}; ignored it.`);
                continue;
            }
            let id = t.id;
            if (ids.has(id)) {
                id = nextId++;
                this.notices.push(`kanban.jsonl has two tasks #${t.id}; ${t.file} is now #${id}.`);
            }
            let status = t.status;
            if (!keys.has(status)) {
                status = columns[0].key;
                this.notices.push(`#${id} was in column "${t.status}", which does not exist; moved it to "${status}".`);
            }
            ids.add(id);
            files.add(t.file);
            const now_ = now();
            insert.run(id, path.basename(t.file), t.title || t.file, status, Number(t.position) || 0,
                PRIORITIES.includes(t.priority) ? t.priority : 'normal', TYPES.includes(t.type) ? t.type : 'feature',
                t.archived ? 1 : 0, t.missing ? 1 : 0, t.created || now_, t.updated || t.created || now_,
                t.started || null, t.completed || null);
            normaliseTags(t.tags).forEach(g => tag.run(id, g));
            for (const h of t.history || []) hist.run(id, h[0], h[1], h[2] ?? null, h[3] ?? null);
        }
        // AUTOINCREMENT would otherwise hand out an id a deleted task once had.
        this.db.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'tasks'").run(nextId - 1);
    }

    /* ---------- files ---------- */

    filePath(file) {
        return path.join(this.tasksDir, path.basename(file));
    }

    readFile(file) {
        return fs.readFileSync(this.filePath(file), 'utf8');
    }

    // Written through a temp file and a rename so an editor or the watcher never sees half a file.
    writeFile(file, text) {
        const target = this.filePath(file);
        const tmp = path.join(this.tasksDir, `.${path.basename(file)}.${process.pid}.tmp`);
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, target);
    }

    // Task files are the folder's *.md, except _template.md and anything else starting with _ or a dot.
    listFiles() {
        return fs.readdirSync(this.tasksDir)
            .filter(f => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
            .sort();
    }

    uniqueFile(title) {
        const base = slugify(title);
        let file = `${base}.md`;
        for (let n = 2; fs.existsSync(this.filePath(file)) || this.db.prepare('SELECT 1 FROM tasks WHERE file = ?').get(file); n++) {
            file = `${base}-${n}.md`;
        }
        return file;
    }

    template(title) {
        const tpl = path.join(this.tasksDir, '_template.md');
        const text = fs.existsSync(tpl) ? fs.readFileSync(tpl, 'utf8') : '# {{title}}\n';
        return text.replace(/\{\{\s*title\s*\}\}/g, title);
    }

    /* ---------- sync ---------- */

    sync() {
        return this.tx(() => {
            const report = { added: [], updated: [], renamed: [], missing: [], restored: [], imported: this.imported, notices: this.notices };
            const rows = this.db.prepare('SELECT id, file, title, hash, missing FROM tasks').all();
            const byFile = new Map(rows.map(r => [r.file, r]));
            const onDisk = new Map();
            for (const file of this.listFiles()) {
                const text = this.readFile(file);
                onDisk.set(file, { text, hash: hashOf(text), ...parseTask(text, file) });
            }

            const update = this.db.prepare(`UPDATE tasks SET title = ?, hash = ?, checks_done = ?, checks_total = ?,
                missing = 0, updated_at = ? WHERE id = ?`);

            const fresh = [];
            for (const [file, f] of onDisk) {
                const row = byFile.get(file);
                if (!row) { fresh.push(file); continue; }
                if (row.missing) {
                    report.restored.push(row.id);
                    this.db.prepare('UPDATE tasks SET missing = 0 WHERE id = ?').run(row.id);
                }
                if (row.hash === null) {
                    // Just loaded from kanban.jsonl: learn the file, but it has not been edited.
                    this.db.prepare('UPDATE tasks SET title = ?, hash = ?, checks_done = ?, checks_total = ?, missing = 0 WHERE id = ?')
                        .run(f.title, f.hash, f.checks_done, f.checks_total, row.id);
                } else if (row.hash !== f.hash) {
                    update.run(f.title, f.hash, f.checks_done, f.checks_total, now(), row.id);
                    if (f.title !== row.title) this.log(row.id, 'title', row.title, f.title); // Renamed in the file itself.
                    report.updated.push(row.id);
                }
            }

            const gone = rows.filter(r => !r.missing && !onDisk.has(r.file));
            for (const file of fresh) {
                const f = onDisk.get(file);
                // A renamed file keeps its task: first by identical content, then by an unambiguous title.
                let match = gone.find(r => r.hash === f.hash);
                if (!match) {
                    const sameTitle = gone.filter(r => r.title === f.title);
                    if (sameTitle.length === 1) match = sameTitle[0];
                }
                if (match) {
                    gone.splice(gone.indexOf(match), 1);
                    this.db.prepare('UPDATE tasks SET file = ? WHERE id = ?').run(file, match.id);
                    update.run(f.title, f.hash, f.checks_done, f.checks_total, now(), match.id);
                    this.log(match.id, 'file', match.file, file);
                    report.renamed.push(match.id);
                } else {
                    report.added.push(this.insertRow(file, f, {}));
                }
            }

            for (const r of gone) {
                this.db.prepare('UPDATE tasks SET missing = 1 WHERE id = ?').run(r.id);
                report.missing.push(r.id);
            }
            return report;
        });
    }

    insertRow(file, parsed, meta) {
        const status = meta.status || this.firstColumn();
        const t = now();
        const { lastInsertRowid } = this.db.prepare(`INSERT INTO tasks
            (file, title, status, position, priority, type, hash, checks_done, checks_total, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            file, parsed.title, status, this.nextPosition(status),
            meta.priority || 'normal', meta.type || 'feature',
            parsed.hash, parsed.checks_done, parsed.checks_total, t, t);
        const id = Number(lastInsertRowid);
        this.log(id, 'status', null, status);
        this.stampStatus(id, status);
        if (meta.tags) this.setTags(id, meta.tags);
        return id;
    }

    /* ---------- columns ---------- */

    columns() {
        return this.db.prepare(`SELECT c.*, (SELECT count(*) FROM tasks t WHERE t.status = c.key
            AND t.archived = 0 AND t.missing = 0) AS count FROM columns c ORDER BY position`).all()
            .map(c => ({ ...c }));
    }

    column(key) {
        const c = this.db.prepare('SELECT * FROM columns WHERE key = ?').get(key);
        if (!c) {
            const keys = this.columns().map(c => c.key).join(', ');
            throw new KanbanError(`No column "${key}". Columns are: ${keys}.`, 404);
        }
        return c;
    }

    firstColumn() {
        return this.db.prepare('SELECT key FROM columns ORDER BY position LIMIT 1').get().key;
    }

    addColumn(key, { label, kind = 'queue', wip_limit = null, after } = {}) {
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) throw new KanbanError('A column key is lower-case letters, digits, - and _.');
        checkKind(kind);
        return this.tx(() => {
            if (this.db.prepare('SELECT 1 FROM columns WHERE key = ?').get(key)) throw new KanbanError(`Column "${key}" already exists.`);
            const keys = this.columns().map(c => c.key);
            const at = after ? keys.indexOf(this.column(after).key) + 1 : keys.length;
            keys.splice(at, 0, key);
            this.db.prepare('INSERT INTO columns (key, label, position, kind, wip_limit) VALUES (?, ?, ?, ?, ?)')
                .run(key, label || key, at, kind, wip_limit);
            this.renumberColumns(keys);
        });
    }

    updateColumn(key, { label, kind, wip_limit, rename, position } = {}) {
        return this.tx(() => {
            this.column(key);
            if (kind !== undefined) checkKind(kind);
            if (label !== undefined) this.db.prepare('UPDATE columns SET label = ? WHERE key = ?').run(label, key);
            if (kind !== undefined) this.db.prepare('UPDATE columns SET kind = ? WHERE key = ?').run(kind, key);
            if (wip_limit !== undefined) this.db.prepare('UPDATE columns SET wip_limit = ? WHERE key = ?').run(wip_limit || null, key);
            if (position !== undefined) {
                const keys = this.columns().map(c => c.key).filter(k => k !== key);
                keys.splice(Math.max(0, Math.min(keys.length, position)), 0, key);
                this.renumberColumns(keys);
            }
            if (rename && rename !== key) {
                if (!/^[a-z0-9][a-z0-9_-]*$/.test(rename)) throw new KanbanError('A column key is lower-case letters, digits, - and _.');
                // tasks.status follows through ON UPDATE CASCADE.
                this.db.prepare('UPDATE columns SET key = ? WHERE key = ?').run(rename, key);
            }
        });
    }

    removeColumn(key, { moveTo } = {}) {
        return this.tx(() => {
            this.column(key);
            const n = this.db.prepare('SELECT count(*) AS n FROM tasks WHERE status = ?').get(key).n;
            if (n && !moveTo) throw new KanbanError(`Column "${key}" still has ${n} task(s); move them first or pass a column to move them to.`);
            if (n) {
                this.column(moveTo);
                for (const { id } of this.db.prepare('SELECT id FROM tasks WHERE status = ? ORDER BY position').all(key)) {
                    this.move(id, moveTo);
                }
            }
            this.db.prepare('DELETE FROM columns WHERE key = ?').run(key);
            this.renumberColumns(this.columns().map(c => c.key));
        });
    }

    renumberColumns(keys) {
        const stmt = this.db.prepare('UPDATE columns SET position = ? WHERE key = ?');
        keys.forEach((k, i) => stmt.run(i, k));
    }

    /* ---------- reading tasks ---------- */

    // Accepts 12, #12, a file name, or the start of one.
    resolve(ref) {
        const s = String(ref).trim().replace(/^#/, '');
        if (/^\d+$/.test(s)) {
            const row = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(Number(s));
            if (row) return row.id;
        } else {
            const file = s.endsWith('.md') ? path.basename(s) : `${s}.md`;
            const exact = this.db.prepare('SELECT id FROM tasks WHERE file = ?').get(file);
            if (exact) return exact.id;
            const like = this.db.prepare("SELECT id FROM tasks WHERE file LIKE ? ESCAPE '\\'")
                .all(s.replace(/[\\%_]/g, '\\$&') + '%');
            if (like.length === 1) return like[0].id;
            if (like.length > 1) throw new KanbanError(`"${ref}" matches ${like.length} tasks; be more specific.`);
        }
        throw new KanbanError(`No task "${ref}".`, 404);
    }

    list({ status, tag, type, priority, search, archived = false, missing = false } = {}) {
        const where = [], args = [];
        if (!archived) where.push('t.archived = 0');
        if (!missing) where.push('t.missing = 0');
        if (status) { where.push('t.status = ?'); args.push(status); }
        if (type) { where.push('t.type = ?'); args.push(type); }
        if (priority) { where.push('t.priority = ?'); args.push(priority); }
        if (tag) { where.push('EXISTS (SELECT 1 FROM tags g WHERE g.task_id = t.id AND g.tag = ?)'); args.push(tag); }
        if (search) { where.push('(t.title LIKE ? OR t.file LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
        const sql = `SELECT t.*, c.position AS column_position,
                (SELECT group_concat(tag, char(31)) FROM (SELECT tag FROM tags WHERE task_id = t.id ORDER BY tag)) AS tagstr
            FROM tasks t JOIN columns c ON c.key = t.status
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY c.position, t.position, t.id`;
        return this.db.prepare(sql).all(...args).map(shape);
    }

    get(ref, { body = true } = {}) {
        const id = this.resolve(ref);
        const task = this.list({ archived: true, missing: true }).find(t => t.id === id);
        if (body && !task.missing) {
            task.body = this.readFile(task.file);
            task.hash = hashOf(task.body);
        }
        task.path = this.filePath(task.file);
        return task;
    }

    history(ref) {
        const id = this.resolve(ref);
        return this.db.prepare('SELECT at, field, old, new FROM history WHERE task_id = ? ORDER BY at, id').all(id).map(r => ({ ...r }));
    }

    tags() {
        return this.db.prepare(`SELECT tag, count(*) AS count FROM tags g JOIN tasks t ON t.id = g.task_id
            WHERE t.archived = 0 AND t.missing = 0 GROUP BY tag ORDER BY tag`).all().map(r => ({ ...r }));
    }

    /* ---------- writing tasks ---------- */

    add(title, { status, priority, type, tags, body } = {}) {
        title = String(title || '').trim();
        if (!title) throw new KanbanError('A task needs a title.');
        if (status) this.column(status);
        if (priority) checkPriority(priority);
        if (type) checkType(type);
        return this.tx(() => {
            const file = this.uniqueFile(title);
            const text = body != null ? `# ${title}\n\n${String(body).replace(/\s*$/, '\n')}` : this.template(title);
            this.writeFile(file, text);
            return this.insertRow(file, { ...parseTask(text, file), hash: hashOf(text) }, { status, priority, type, tags });
        });
    }

    // Moves a task to a column, at an index among that column's visible tasks (the end when omitted).
    move(ref, status, index) {
        return this.tx(() => {
            const id = this.resolve(ref);
            this.column(status);
            const task = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(id);
            const others = () => this.db.prepare(`SELECT id, position FROM tasks WHERE status = ? AND id != ? AND archived = 0
                AND missing = 0 ORDER BY position, id`).all(status, id);
            let list = others();
            const at = index == null ? list.length : Math.max(0, Math.min(list.length, index));
            // The new position is between the new neighbours, so only this task's line in kanban.jsonl changes.
            // When repeated moves have left no room between them, the column is renumbered.
            if (at > 0 && at < list.length && list[at].position - list[at - 1].position < 1e-6) {
                const stmt = this.db.prepare('UPDATE tasks SET position = ? WHERE id = ?');
                list.forEach((r, i) => stmt.run(i, r.id));
                list = others();
            }
            const before = at > 0 ? list[at - 1].position : null;
            const after = at < list.length ? list[at].position : null;
            const position = before === null && after === null ? 0
                : before === null ? Math.floor(after) - 1
                : after === null ? Math.floor(before) + 1
                : (before + after) / 2;
            const current = this.db.prepare('SELECT position FROM tasks WHERE id = ?').get(id).position;
            const inPlace = task.status === status && (before === null || before < current) && (after === null || current < after);
            if (!inPlace) this.db.prepare('UPDATE tasks SET position = ? WHERE id = ?').run(position, id);
            if (task.status !== status) {
                this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
                this.log(id, 'status', task.status, status);
                this.stampStatus(id, status);
            }
            return id;
        });
    }

    // started_at is the first time a task entered an active column; completed_at is set while it sits in a
    // done column and cleared if it leaves one.
    stampStatus(id, status) {
        const { kind } = this.column(status);
        if (kind === 'active' || kind === 'done') {
            this.db.prepare('UPDATE tasks SET started_at = coalesce(started_at, ?) WHERE id = ?').run(now(), id);
        }
        this.db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(kind === 'done' ? now() : null, id);
    }

    update(ref, { title, priority, type, tags, addTags, removeTags, archived } = {}) {
        return this.tx(() => {
            const id = this.resolve(ref);
            const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
            const set = (field, value) => {
                if (value === undefined || value === row[field]) return;
                this.db.prepare(`UPDATE tasks SET ${field} = ?, updated_at = ? WHERE id = ?`).run(value, now(), id);
                this.log(id, field, row[field], value);
            };
            if (priority !== undefined) set('priority', checkPriority(priority));
            if (type !== undefined) set('type', checkType(type));
            if (archived !== undefined) set('archived', archived ? 1 : 0);
            if (tags !== undefined) this.setTags(id, tags);
            if (addTags || removeTags) {
                const current = new Set(this.tagsOf(id));
                (addTags || []).forEach(t => current.add(t));
                (removeTags || []).forEach(t => current.delete(t));
                this.setTags(id, [...current]);
            }
            if (title !== undefined && title.trim() && title.trim() !== row.title) {
                if (row.missing) throw new KanbanError(`#${id}'s file is missing, so its title cannot be changed.`);
                this.saveBody(id, retitle(this.readFile(row.file), title.trim()));
            }
            return id;
        });
    }

    tagsOf(id) {
        return this.db.prepare('SELECT tag FROM tags WHERE task_id = ? ORDER BY tag').all(id).map(r => r.tag);
    }

    setTags(id, tags) {
        const clean = [...new Set(normaliseTags(tags))];
        const before = this.tagsOf(id);
        if (before.join(',') === [...clean].sort().join(',')) return;
        this.db.prepare('DELETE FROM tags WHERE task_id = ?').run(id);
        const insert = this.db.prepare('INSERT INTO tags (task_id, tag) VALUES (?, ?)');
        clean.forEach(t => insert.run(id, t));
        this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), id);
        this.log(id, 'tags', before.join(', '), [...clean].sort().join(', '));
    }

    // Replaces a task's markdown. With baseHash, refuses if the file has changed since the caller read it.
    saveBody(ref, text, baseHash) {
        return this.tx(() => {
            const id = this.resolve(ref);
            const row = this.db.prepare('SELECT file, title FROM tasks WHERE id = ?').get(id);
            const path_ = this.filePath(row.file);
            const current = fs.existsSync(path_) ? fs.readFileSync(path_, 'utf8') : null;
            if (baseHash && current !== null && hashOf(current) !== baseHash) {
                throw new KanbanError(`${row.file} changed on disk since it was opened.`, 409);
            }
            this.writeFile(row.file, text);
            const parsed = parseTask(text, row.file);
            this.db.prepare(`UPDATE tasks SET title = ?, hash = ?, checks_done = ?, checks_total = ?, missing = 0,
                updated_at = ? WHERE id = ?`).run(parsed.title, hashOf(text), parsed.checks_done, parsed.checks_total, now(), id);
            // The title is the file's heading, so a rename from anywhere (set --title, the board, an edit) lands here.
            if (parsed.title !== row.title) this.log(id, 'title', row.title, parsed.title);
            return id;
        });
    }

    // Ticks or unticks the checkbox on a 0-based line of the task file.
    toggleCheck(ref, line, baseHash) {
        return this.tx(() => {
            const id = this.resolve(ref);
            const { file } = this.db.prepare('SELECT file FROM tasks WHERE id = ?').get(id);
            const text = this.readFile(file);
            if (baseHash && hashOf(text) !== baseHash) throw new KanbanError(`${file} changed on disk since it was opened.`, 409);
            const lines = text.split('\n');
            const m = lines[line] !== undefined && lines[line].replace(/\r$/, '').match(CHECKBOX);
            if (!m) throw new KanbanError(`Line ${line + 1} of ${file} is not a checkbox.`, 409);
            lines[line] = lines[line].replace(CHECKBOX, (_, a, mark, b) => a + (mark === ' ' ? 'x' : ' ') + b);
            return this.saveBody(id, lines.join('\n'));
        });
    }

    remove(ref, { keepFile = false } = {}) {
        return this.tx(() => {
            const id = this.resolve(ref);
            const { file } = this.db.prepare('SELECT file FROM tasks WHERE id = ?').get(id);
            this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
            if (!keepFile && fs.existsSync(this.filePath(file))) fs.unlinkSync(this.filePath(file));
            return { id, file };
        });
    }

    // Forgets tasks whose files are gone.
    prune() {
        return this.tx(() => {
            const rows = this.db.prepare('SELECT id, file FROM tasks WHERE missing = 1').all().map(r => ({ ...r }));
            this.db.prepare('DELETE FROM tasks WHERE missing = 1').run();
            return rows;
        });
    }

    nextPosition(status) {
        return this.db.prepare('SELECT coalesce(floor(max(position)), -1) + 1 AS p FROM tasks WHERE status = ?').get(status).p;
    }

    log(id, field, old, value) {
        this.db.prepare('INSERT INTO history (task_id, at, field, old, new) VALUES (?, ?, ?, ?, ?)')
            .run(id, now(), field, old == null ? null : String(old), value == null ? null : String(value));
    }
}

function shape(row) {
    const { tagstr, column_position, ...t } = row;
    return {
        ...t,
        archived: !!t.archived,
        missing: !!t.missing,
        tags: tagstr ? tagstr.split('\x1f') : [],
    };
}

function normaliseTags(tags) {
    const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
    return list.map(t => String(t).trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
}

function retitle(text, title) {
    const lines = text.split('\n');
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
        if (FENCE.test(lines[i])) { fenced = !fenced; continue; }
        if (!fenced && /^#\s+/.test(lines[i])) {
            lines[i] = `# ${title}`;
            return lines.join('\n');
        }
    }
    return `# ${title}\n\n${text}`;
}

function checkPriority(p) {
    if (!PRIORITIES.includes(p)) throw new KanbanError(`Priority is one of: ${PRIORITIES.join(', ')}.`);
    return p;
}

function checkType(t) {
    if (!TYPES.includes(t)) throw new KanbanError(`Type is one of: ${TYPES.join(', ')}.`);
    return t;
}

function checkKind(k) {
    if (!KINDS.includes(k)) throw new KanbanError(`Column kind is one of: ${KINDS.join(', ')}.`);
    return k;
}

module.exports = { Store, KanbanError, PRIORITIES, TYPES, KINDS, hashOf, parseTask, normaliseTags };
