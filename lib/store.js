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
//
// Every change is made by an actor: 'user' (the board), 'cli', 'file' (an edit to a task file nobody
// claimed), 'git' (kanban.jsonl reloaded), 'system', or 'agent:<session>'. History records it, and each
// change is also written to the events table, which agent sessions and the board read by id.
//
// Runtime state (sessions, claims, subscriptions, events) is local to this checkout: it lives only in
// kanban.db, never in kanban.jsonl, and is written with rtx(), which leaves kanban.jsonl alone.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = loadSqlite();
const exportFile = require('./exportfile');

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const TYPES = ['feature', 'bug', 'content', 'chore', 'idea'];
const KINDS = ['queue', 'active', 'done'];
// 'attention' floats tasks whose agent needs the user to the top of the column.
const SORTS = ['manual', 'attention'];

const DEFAULT_COLUMNS = [
    { key: 'backlog', label: 'Backlog', kind: 'queue' },
    { key: 'todo', label: 'To do', kind: 'queue' },
    { key: 'doing', label: 'In progress', kind: 'active', wip_limit: 3, sort: 'attention' },
    { key: 'review', label: 'Review', kind: 'active', sort: 'attention' },
    { key: 'done', label: 'Done', kind: 'done' },
];

const SESSION_STATUSES = ['starting', 'busy', 'idle', 'waiting', 'exited', 'lost'];
const LIVE = "status NOT IN ('exited', 'lost')";
const MESSAGE_LIMIT = 4000;

// A session needs the user when it is blocked on a question, has finished its turn, or died unexpectedly.
// Lower ranks come first.
function attentionRank(s) {
    if (!s) return 0;
    if (s.status === 'waiting') return 1;
    if (s.status === 'idle') return 2;
    if (s.status === 'lost' || (s.status === 'exited' && s.exit_code)) return 3;
    return 0;
}

// Events that ask a session to do something. Everything else is for information.
function actionable(event, role) {
    if (event.type.startsWith('message.') || event.type === 'task.user_changed') return true;
    return role === 'orchestrator' && ['session.idle', 'session.waiting', 'session.exited', 'session.lost'].includes(event.type);
}

// Each step takes the database from the version before it to its own. Step 2 is the original schema, so
// it is safe on a database an older kanban made.
const MIGRATIONS = {
    2: `
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
    `,
    // Actors, column sort, and the runtime tables. These refer to tasks by id without a foreign key:
    // importing kanban.jsonl deletes and re-inserts every task (keeping its id), which would cascade.
    3: `
        ALTER TABLE history ADD COLUMN actor TEXT;
        ALTER TABLE columns ADD COLUMN sort TEXT NOT NULL DEFAULT 'manual';
        UPDATE columns SET sort = 'attention' WHERE kind = 'active';
        CREATE TABLE sessions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL UNIQUE,
            role            TEXT NOT NULL,
            profile         TEXT NOT NULL,
            task_id         INTEGER,
            tmux            TEXT NOT NULL,
            cwd             TEXT NOT NULL,
            worktree        TEXT,
            branch          TEXT,
            tool_session    TEXT,
            status          TEXT NOT NULL DEFAULT 'starting',
            status_reason   TEXT,
            attention_since TEXT,
            exit_code       INTEGER,
            inbox_cursor    INTEGER NOT NULL DEFAULT 0,
            nudged_at       TEXT,
            stop_blocks     INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL,
            ended_at        TEXT
        );
        CREATE INDEX sessions_task ON sessions(task_id, status);
        CREATE TABLE subscriptions (
            id         INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            task_id    INTEGER NOT NULL DEFAULT 0,
            types      TEXT,
            since_id   INTEGER NOT NULL DEFAULT 0,
            UNIQUE (session_id, task_id)
        );
        CREATE TABLE events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            at         TEXT NOT NULL,
            type       TEXT NOT NULL,
            task_id    INTEGER,
            actor      TEXT NOT NULL,
            session_id INTEGER,
            target_id  INTEGER,
            payload    TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX events_task ON events(task_id, id);
        CREATE INDEX events_target ON events(target_id, id);
        CREATE TABLE claims (
            task_id    INTEGER PRIMARY KEY,
            actor      TEXT NOT NULL,
            session_id INTEGER,
            at         TEXT NOT NULL
        );
        CREATE TABLE intents (
            file       TEXT NOT NULL,
            actor      TEXT NOT NULL,
            session_id INTEGER,
            expires    TEXT NOT NULL
        );
    `,
};

const SCHEMA_VERSION = 3;

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
    constructor(home, { actor = 'cli', session = null } = {}) {
        this.home = path.resolve(home);
        this.tasksDir = path.join(this.home, 'tasks');
        this.dbPath = path.join(this.home, 'kanban.db');
        this.exportPath = path.join(this.home, 'kanban.jsonl');
        this.notices = [];
        this.imported = false;
        this.actor = actor;
        this.session = session; // the acting session's id, when the actor is an agent
        this.touched = new Map(); // task id -> [{type, actor}] for the events of the current tx
        fs.mkdirSync(this.tasksDir, { recursive: true });

        this.db = new DatabaseSync(this.dbPath);
        // WAL lets the many short-lived hook processes of agent sessions read while one process writes.
        // Writers still take turns, so kanban.jsonl is only ever written by the holder of the write lock.
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        this.migrate();
    }

    close() {
        this.db.close();
    }

    // Not this.tx(): that reads and writes kanban.jsonl, which needs the tables this creates.
    migrate() {
        const version = () => this.db.prepare('PRAGMA user_version').get().user_version;
        const from = version();
        if (from >= SCHEMA_VERSION) return;
        for (let v = Math.max(from, 1) + 1; v <= SCHEMA_VERSION; v++) {
            this.db.exec('BEGIN IMMEDIATE');
            try {
                // Another process may have migrated while this one waited for the lock.
                if (version() < v) {
                    this.db.exec(MIGRATIONS[v]);
                    if (v === SCHEMA_VERSION && !this.db.prepare('SELECT 1 FROM columns').get()) {
                        this.insertColumns(DEFAULT_COLUMNS.map(c => ({ ...c, wip: c.wip_limit })));
                    }
                    this.db.exec(`PRAGMA user_version = ${v}`);
                }
                this.db.exec('COMMIT');
            } catch (e) {
                this.db.exec('ROLLBACK');
                throw e;
            }
        }
    }

    insertColumns(columns) {
        const insert = this.db.prepare('INSERT INTO columns (key, label, position, kind, wip_limit, sort) VALUES (?, ?, ?, ?, ?, ?)');
        columns.forEach((c, i) => insert.run(c.key, c.label, i, KINDS.includes(c.kind) ? c.kind : 'queue', c.wip || null,
            SORTS.includes(c.sort) ? c.sort : 'manual'));
    }

    // Runs fn with changes attributed to another actor (and session), then restores the previous one.
    as(actor, fn, session = null) {
        const before = [this.actor, this.session];
        this.actor = actor;
        this.session = session;
        try {
            return fn();
        } finally {
            [this.actor, this.session] = before;
        }
    }

    // Every write takes the database's write lock *before* touching the tasks folder, so a CLI command and
    // a running server never interleave a file write with a sync that would misread it.
    tx(fn) {
        if (this.inTx === 'tx') return fn();
        if (this.inTx) throw new Error('A board write cannot run inside a runtime transaction.');
        this.db.exec('BEGIN IMMEDIATE');
        this.inTx = 'tx';
        this.notices = [];
        this.imported = false;
        this.touched = new Map();
        try {
            this.importIfChanged();
            const result = fn();
            this.flagUserChanges();
            this.writeExport();
            this.db.exec('COMMIT');
            return result;
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        } finally {
            this.inTx = false;
            this.touched = new Map();
        }
    }

    // A transaction for runtime state only: sessions, claims, subscriptions, cursors and events. It neither
    // reloads nor rewrites kanban.jsonl, so the frequent writes of agent hooks never churn the committed file.
    rtx(fn) {
        if (this.inTx) return fn();
        this.db.exec('BEGIN IMMEDIATE');
        this.inTx = 'rtx';
        try {
            const result = fn();
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
            .map(c => ({ key: c.key, label: c.label, kind: c.kind, wip: c.wip_limit, sort: c.sort }));
        const history = new Map();
        for (const h of this.db.prepare('SELECT task_id, at, field, old, new, actor FROM history ORDER BY at, id').all()) {
            if (!history.has(h.task_id)) history.set(h.task_id, []);
            // The actor rides as a fifth element, left off when unknown so older lines stay as they were.
            history.get(h.task_id).push(h.actor ? [h.at, h.field, h.old, h.new, h.actor] : [h.at, h.field, h.old, h.new]);
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
        this.as('git', () => {
            this.importText(text);
            this.emit('board.imported', null);
        });
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
        const hist = this.db.prepare('INSERT INTO history (task_id, at, field, old, new, actor) VALUES (?, ?, ?, ?, ?, ?)');
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
            for (const h of t.history || []) hist.run(id, h[0], h[1], h[2] ?? null, h[3] ?? null, h[4] ?? null);
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

            // An edit found on disk was made by whoever announced they were about to write that file (an agent's
            // hook), or else by someone outside the tool.
            const intents = this.intents();
            const by = (file, fn) => {
                const who = intents.get(file);
                return who ? this.as(who.actor, fn, who.session_id) : this.as('file', fn);
            };

            const fresh = [];
            for (const [file, f] of onDisk) {
                const row = byFile.get(file);
                if (!row) { fresh.push(file); continue; }
                if (row.missing) {
                    report.restored.push(row.id);
                    this.db.prepare('UPDATE tasks SET missing = 0 WHERE id = ?').run(row.id);
                    by(file, () => this.emit('task.restored', row.id, { file }));
                }
                if (row.hash === null) {
                    // Just loaded from kanban.jsonl: learn the file, but it has not been edited.
                    this.db.prepare('UPDATE tasks SET title = ?, hash = ?, checks_done = ?, checks_total = ?, missing = 0 WHERE id = ?')
                        .run(f.title, f.hash, f.checks_done, f.checks_total, row.id);
                } else if (row.hash !== f.hash) {
                    update.run(f.title, f.hash, f.checks_done, f.checks_total, now(), row.id);
                    by(file, () => {
                        if (f.title !== row.title) this.log(row.id, 'title', row.title, f.title); // Renamed in the file itself.
                        this.emit('task.body_changed', row.id, bodyPayload(f, row.title));
                    });
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
                    by(file, () => {
                        this.log(match.id, 'file', match.file, file);
                        this.emit('task.updated', match.id, { changes: { file: [match.file, file] } });
                    });
                    report.renamed.push(match.id);
                } else {
                    report.added.push(by(file, () => this.insertRow(file, f, {})));
                }
            }

            for (const r of gone) {
                this.db.prepare('UPDATE tasks SET missing = 1 WHERE id = ?').run(r.id);
                by(r.file, () => this.emit('task.missing', r.id, { file: r.file }));
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
        this.emit('task.created', id, { title: parsed.title, status, file });
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
            this.emit('column.changed', null, { key, action: 'added' });
        });
    }

    updateColumn(key, { label, kind, wip_limit, rename, position, sort } = {}) {
        return this.tx(() => {
            this.column(key);
            if (kind !== undefined) checkKind(kind);
            if (sort !== undefined) checkSort(sort);
            if (sort !== undefined) this.db.prepare('UPDATE columns SET sort = ? WHERE key = ?').run(sort, key);
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
            this.emit('column.changed', null, { key: rename || key, action: 'updated' });
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
            this.emit('column.changed', null, { key, action: 'removed' });
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
        return this.db.prepare('SELECT at, field, old, new, actor FROM history WHERE task_id = ? ORDER BY at, id').all(id).map(r => ({ ...r }));
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
                this.emit('task.moved', id, { from: task.status, to: status });
            } else if (!inPlace) {
                this.emit('task.reordered', id, { status });
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
            const changes = {};
            const set = (field, value) => {
                if (value === undefined || value === row[field]) return;
                this.db.prepare(`UPDATE tasks SET ${field} = ?, updated_at = ? WHERE id = ?`).run(value, now(), id);
                this.log(id, field, row[field], value);
                changes[field] = [row[field], value];
            };
            const tagsBefore = this.tagsOf(id).join(', ');
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
            const tagsAfter = this.tagsOf(id).join(', ');
            if (tagsAfter !== tagsBefore) changes.tags = [tagsBefore, tagsAfter];
            if (Object.keys(changes).length) this.emit('task.updated', id, { changes });
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
            if (current !== text) this.emit('task.body_changed', id, bodyPayload(parsed, row.title));
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
            const { file, title } = this.db.prepare('SELECT file, title FROM tasks WHERE id = ?').get(id);
            this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
            if (!keepFile && fs.existsSync(this.filePath(file))) fs.unlinkSync(this.filePath(file));
            this.emit('task.deleted', id, { file, title });
            this.db.prepare('DELETE FROM claims WHERE task_id = ?').run(id);
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

    /* ---------- events ---------- */

    // Records an event as the current actor. Inside a transaction it commits (or rolls back) with the change
    // it describes. For session.* events, session_id is the session the event is about.
    emit(type, taskId, payload = {}, { target = null, session = this.session } = {}) {
        const run = () => {
            const { lastInsertRowid } = this.db.prepare(`INSERT INTO events (at, type, task_id, actor, session_id, target_id, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(now(), type, taskId ?? null, this.actor, session ?? null, target, JSON.stringify(payload));
            if (this.inTx === 'tx' && taskId != null) {
                if (!this.touched.has(taskId)) this.touched.set(taskId, []);
                this.touched.get(taskId).push({ type, actor: this.actor });
            }
            return Number(lastInsertRowid);
        };
        return this.inTx ? run() : this.rtx(run);
    }

    // At the end of a transaction: a person changed a task an agent is working on, so tell the agent. An
    // unattributed file edit counts unless the agent is mid-turn, when it most likely made the edit itself.
    flagUserChanges() {
        for (const [taskId, list] of [...this.touched]) {
            const human = list.filter(e => ['user', 'cli', 'file'].includes(e.actor) && !QUIET_TYPES.has(e.type));
            if (!human.length) continue;
            const claim = this.db.prepare('SELECT * FROM claims WHERE task_id = ?').get(taskId);
            if (!claim || !claim.actor.startsWith('agent:')) continue;
            const busy = claim.session_id && this.db.prepare("SELECT 1 FROM sessions WHERE id = ? AND status = 'busy'").get(claim.session_id);
            const counted = human.filter(e => e.actor !== 'file' || !busy);
            if (!counted.length) continue;
            const actor = counted.find(e => e.actor !== 'file')?.actor || 'file';
            this.as(actor, () => this.emit('task.user_changed', taskId, {
                cause: [...new Set(counted.map(e => e.type))], claimant: claim.actor,
            }, { session: null }));
        }
    }

    lastEventId() {
        return this.db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get().id;
    }

    // Events in id order. latest: the last `limit` of them rather than the first (an activity feed).
    events({ after = 0, task, limit = 200, latest = false } = {}) {
        const where = ['id > ?'], args = [after];
        if (task != null) { where.push('task_id = ?'); args.push(this.resolve(task)); }
        const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id ${latest ? 'DESC' : ''} LIMIT ?`)
            .all(...args, limit).map(shapeEvent);
        return latest ? rows.reverse() : rows;
    }

    // Forgets events every live session has read, once they are old enough not to matter to the board.
    pruneEvents(days = 14) {
        return this.rtx(() => {
            const cutoff = new Date(Date.now() - days * 864e5).toISOString();
            const floor = this.db.prepare(`SELECT min(inbox_cursor) AS c FROM sessions WHERE ${LIVE}`).get().c;
            const r = this.db.prepare('DELETE FROM events WHERE at < ? AND id <= ?').run(cutoff, floor ?? Number.MAX_SAFE_INTEGER);
            return Number(r.changes);
        });
    }

    /* ---------- intents: who is about to write a task file ---------- */

    addIntent(file, { ttl = 30000 } = {}) {
        const name = path.basename(file);
        return this.rtx(() => {
            this.db.prepare('DELETE FROM intents WHERE file = ? AND actor = ?').run(name, this.actor);
            this.db.prepare('INSERT INTO intents (file, actor, session_id, expires) VALUES (?, ?, ?, ?)')
                .run(name, this.actor, this.session, new Date(Date.now() + ttl).toISOString());
        });
    }

    clearIntent(file) {
        return this.rtx(() => this.db.prepare('DELETE FROM intents WHERE file = ? AND actor = ?').run(path.basename(file), this.actor));
    }

    intents() {
        const t = now();
        const rows = this.db.prepare('SELECT * FROM intents WHERE expires > ? ORDER BY expires').all(t);
        return new Map(rows.map(r => [r.file, { ...r }]));
    }

    /* ---------- claims: who is working on a task ---------- */

    claimOf(ref) {
        const row = this.db.prepare('SELECT * FROM claims WHERE task_id = ?').get(this.resolve(ref));
        return row ? { ...row } : null;
    }

    claim(ref, { force = false } = {}) {
        const id = this.resolve(ref);
        return this.rtx(() => {
            const current = this.db.prepare('SELECT * FROM claims WHERE task_id = ?').get(id);
            if (current && current.actor === this.actor) return { ...current };
            if (current && !force) throw new KanbanError(`#${id} is already claimed by ${current.actor}; pass --force to take it over.`, 409);
            this.db.prepare('INSERT OR REPLACE INTO claims (task_id, actor, session_id, at) VALUES (?, ?, ?, ?)')
                .run(id, this.actor, this.session, now());
            this.emit('task.claimed', id, { actor: this.actor, previous: current ? current.actor : null });
            return this.claimOf(id);
        });
    }

    release(ref, { force = false } = {}) {
        const id = this.resolve(ref);
        return this.rtx(() => {
            const current = this.db.prepare('SELECT * FROM claims WHERE task_id = ?').get(id);
            if (!current) return false;
            if (current.actor !== this.actor && !force) {
                throw new KanbanError(`#${id} is claimed by ${current.actor}, not ${this.actor}; pass --force to release it anyway.`, 409);
            }
            this.db.prepare('DELETE FROM claims WHERE task_id = ?').run(id);
            this.emit('task.released', id, { actor: current.actor });
            return true;
        });
    }

    /* ---------- sessions ---------- */

    createSession(fields) {
        return this.rtx(() => {
            const t = now();
            const { lastInsertRowid } = this.db.prepare(`INSERT INTO sessions (name, role, profile, task_id, tmux, cwd, worktree,
                branch, tool_session, status, inbox_cursor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?)`)
                .run(fields.name, fields.role, fields.profile, fields.task_id ?? null, fields.tmux, fields.cwd, fields.worktree ?? null,
                    fields.branch ?? null, fields.tool_session ?? null, this.lastEventId(), t, t);
            return this.session_(Number(lastInsertRowid));
        });
    }

    session_(id) {
        const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
        return row ? { ...row } : null;
    }

    // Accepts an id, a name, 'orchestrator' (the live one) or 'task:12' (the live session on #12).
    sessionOf(ref) {
        const s = String(ref).trim();
        let row;
        if (/^\d+$/.test(s)) row = this.session_(Number(s));
        const task = s.match(/^task:#?(\d+)$/);
        if (!row && task) {
            row = this.db.prepare(`SELECT * FROM sessions WHERE task_id = ? ORDER BY ${LIVE} DESC, id DESC LIMIT 1`).get(Number(task[1]));
        }
        if (!row && s === 'orchestrator') {
            row = this.db.prepare(`SELECT * FROM sessions WHERE role = 'orchestrator' ORDER BY ${LIVE} DESC, id DESC LIMIT 1`).get();
        }
        if (!row) row = this.db.prepare('SELECT * FROM sessions WHERE name = ?').get(s);
        if (!row) throw new KanbanError(`No session "${ref}".`, 404);
        return { ...row };
    }

    sessions({ live = false, task } = {}) {
        const where = [], args = [];
        if (live) where.push(LIVE);
        if (task != null) { where.push('task_id = ?'); args.push(this.resolve(task)); }
        return this.db.prepare(`SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`)
            .all(...args).map(r => ({ ...r, attention: attentionRank(r) }));
    }

    updateSession(id, fields) {
        const keys = Object.keys(fields);
        if (!keys.length) return;
        return this.rtx(() => {
            this.db.prepare(`UPDATE sessions SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
                .run(...keys.map(k => fields[k]), now(), id);
        });
    }

    // Moves a session to a new status, and says so with a session.<status> event, but only on a real change.
    // A session that has ended stays ended (restartSession brings it back), and gives up its claims.
    setSessionStatus(id, status, { reason = null, exit_code } = {}) {
        if (!SESSION_STATUSES.includes(status) || status === 'starting') throw new KanbanError(`Cannot set a session to "${status}".`);
        const ended = st => st === 'exited' || st === 'lost';
        return this.rtx(() => {
            const row = this.session_(id);
            if (!row) throw new KanbanError(`No session ${id}.`, 404);
            if (ended(row.status)) return false;
            if (row.status === status && (row.status_reason || null) === (reason || null)) return false;
            const code = exit_code !== undefined ? exit_code : row.exit_code;
            const t = now();
            const since = attentionRank({ status, exit_code: code }) ? (row.status === status ? row.attention_since : t) : null;
            this.db.prepare(`UPDATE sessions SET status = ?, status_reason = ?, attention_since = ?, exit_code = ?, updated_at = ?,
                ended_at = ? WHERE id = ?`).run(status, reason, since, code ?? null, t, ended(status) ? t : null, id);
            this.emit(`session.${status}`, row.task_id, {
                name: row.name, role: row.role, previous: row.status, reason, exit_code: code ?? null,
            }, { session: id });
            if (ended(status)) {
                for (const c of this.db.prepare('SELECT task_id FROM claims WHERE session_id = ?').all(id)) {
                    this.db.prepare('DELETE FROM claims WHERE task_id = ?').run(c.task_id);
                    this.emit('task.released', c.task_id, { actor: `agent:${row.name}`, reason: status }, { session: id });
                }
            }
            return true;
        });
    }

    // Back to 'starting' for a resume or restart.
    restartSession(id) {
        return this.rtx(() => {
            this.db.prepare(`UPDATE sessions SET status = 'starting', status_reason = NULL, attention_since = NULL, exit_code = NULL,
                ended_at = NULL, stop_blocks = 0, updated_at = ? WHERE id = ?`).run(now(), id);
            return this.session_(id);
        });
    }

    /* ---------- subscriptions and the inbox ---------- */

    // task 0 (or 'board') is the whole board. types is a comma-separated list of event type prefixes.
    subscribe(sessionId, { task = 0, types = null } = {}) {
        const taskId = task === 0 || task === 'board' || task == null ? 0 : this.resolve(task);
        const list = normaliseTypes(types);
        return this.rtx(() => {
            this.db.prepare(`INSERT INTO subscriptions (session_id, task_id, types, since_id) VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id, task_id) DO UPDATE SET types = excluded.types`).run(sessionId, taskId, list, this.lastEventId());
            return { ...this.db.prepare('SELECT * FROM subscriptions WHERE session_id = ? AND task_id = ?').get(sessionId, taskId) };
        });
    }

    unsubscribe(sessionId, { task = 0, id } = {}) {
        return this.rtx(() => {
            if (id != null) return Number(this.db.prepare('DELETE FROM subscriptions WHERE id = ? AND session_id = ?').run(id, sessionId).changes);
            const taskId = task === 0 || task === 'board' || task == null ? 0 : this.resolve(task);
            return Number(this.db.prepare('DELETE FROM subscriptions WHERE session_id = ? AND task_id = ?').run(sessionId, taskId).changes);
        });
    }

    subscriptions(sessionId) {
        return this.db.prepare('SELECT * FROM subscriptions WHERE session_id = ? ORDER BY task_id').all(sessionId).map(r => ({ ...r }));
    }

    // The events waiting for a session: messages sent to it, and anything matching its subscriptions, except
    // what it did itself (or what happened to it). advance moves its read cursor past what was returned.
    inbox(sessionId, { advance = true, limit = 50, actionableOnly = false } = {}) {
        const s = this.session_(sessionId);
        if (!s) throw new KanbanError(`No session ${sessionId}.`, 404);
        const subs = this.subscriptions(sessionId).map(x => ({ ...x, prefixes: x.types ? x.types.split(',') : null }));
        const candidates = this.db.prepare(`SELECT * FROM events e WHERE e.id > ? AND e.session_id IS NOT ? AND (
                e.target_id = ? OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.session_id = ? AND e.id > s.since_id
                AND (s.task_id = 0 OR s.task_id = e.task_id))) ORDER BY e.id LIMIT 500`)
            .all(s.inbox_cursor, sessionId, sessionId, sessionId).map(shapeEvent);
        const wanted = candidates.filter(e => e.target_id === sessionId || subs.some(x => e.id > x.since_id
            && (x.task_id === 0 || x.task_id === e.task_id)
            && (!x.prefixes || x.prefixes.some(p => e.type.startsWith(p)))));
        let events = wanted.map(e => ({ ...e, actionable: actionable(e, s.role) }));
        if (actionableOnly) events = events.filter(e => e.actionable);
        const truncated = events.length > limit;
        events = events.slice(0, limit);
        if (advance && candidates.length) {
            const cursor = truncated ? events[events.length - 1].id : candidates[candidates.length - 1].id;
            this.rtx(() => this.db.prepare('UPDATE sessions SET inbox_cursor = max(inbox_cursor, ?) WHERE id = ?').run(cursor, sessionId));
        }
        return events;
    }

    /* ---------- messages ---------- */

    // A note on a task: its agent and anyone subscribed to it or the board see it.
    post(ref, text) {
        const id = this.resolve(ref);
        return this.emit('message.posted', id, { text: messageText(text) });
    }

    // A message to one session.
    send(ref, text) {
        const target = this.sessionOf(ref);
        return this.emit('message.sent', target.task_id, { text: messageText(text), to: target.name }, { target: target.id });
    }

    // What the board shows about agents on each task: the claim, the latest session, and whether a change the
    // user made has not yet reached the agent.
    runtime() {
        const claims = new Map(this.db.prepare('SELECT * FROM claims').all().map(c => [c.task_id, { ...c }]));
        const sessions = new Map();
        const live = s => s.status !== 'exited' && s.status !== 'lost';
        for (const s of this.sessions()) {
            if (s.task_id == null) continue;
            const prev = sessions.get(s.task_id);
            // The newest live session, or failing that the newest one.
            if (!prev || live(s) || !live(prev)) sessions.set(s.task_id, s);
        }
        const unseen = new Set(this.db.prepare(`SELECT DISTINCT e.task_id FROM events e JOIN claims c ON c.task_id = e.task_id
            JOIN sessions s ON s.id = c.session_id WHERE e.type = 'task.user_changed' AND e.id > s.inbox_cursor`).all().map(r => r.task_id));
        return { claims, sessions, unseen };
    }

    nextPosition(status) {
        return this.db.prepare('SELECT coalesce(floor(max(position)), -1) + 1 AS p FROM tasks WHERE status = ?').get(status).p;
    }

    log(id, field, old, value) {
        this.db.prepare('INSERT INTO history (task_id, at, field, old, new, actor) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, now(), field, old == null ? null : String(old), value == null ? null : String(value), this.actor);
    }
}

// Changes a person makes that an agent need not hear about.
const QUIET_TYPES = new Set(['task.reordered', 'task.claimed', 'task.released', 'task.user_changed', 'message.posted', 'message.sent']);

function shapeEvent(row) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { payload = {}; }
    return { ...row, payload };
}

function bodyPayload(parsed, oldTitle) {
    const p = { checks_done: parsed.checks_done, checks_total: parsed.checks_total };
    if (oldTitle !== undefined && parsed.title !== oldTitle) p.title = [oldTitle, parsed.title];
    return p;
}

function messageText(text) {
    const t = String(text ?? '').trim();
    if (!t) throw new KanbanError('A message needs some text.');
    if (t.length > MESSAGE_LIMIT) throw new KanbanError(`A message is at most ${MESSAGE_LIMIT} characters.`);
    return t;
}

function normaliseTypes(types) {
    if (types == null || types === '') return null;
    const list = (Array.isArray(types) ? types : String(types).split(',')).map(t => t.trim()).filter(Boolean);
    return list.length ? list.join(',') : null;
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

function checkSort(s) {
    if (!SORTS.includes(s)) throw new KanbanError(`Column sort is one of: ${SORTS.join(', ')}.`);
    return s;
}

function checkKind(k) {
    if (!KINDS.includes(k)) throw new KanbanError(`Column kind is one of: ${KINDS.join(', ')}.`);
    return k;
}

module.exports = {
    Store, KanbanError, PRIORITIES, TYPES, KINDS, SORTS, SESSION_STATUSES,
    hashOf, parseTask, normaliseTags, slugify, attentionRank, actionable,
};
