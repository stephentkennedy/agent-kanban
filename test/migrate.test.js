'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../lib/store');
const { tracker } = require('./helpers');

test('a fresh tracker gets the current schema and the default columns', t => {
    const { store } = tracker(t);
    assert.strictEqual(store.db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.deepStrictEqual(store.columns().map(c => `${c.key}:${c.sort}`),
        ['backlog:manual', 'todo:manual', 'doing:attention', 'review:attention', 'done:manual']);
});

test('a version 2 database is upgraded in place, keeping its data', t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, 'tasks'));
    fs.writeFileSync(path.join(home, 'tasks', 'old.md'), '# Old task\n');
    const db = new DatabaseSync(path.join(home, 'kanban.db'));
    db.exec(`
        CREATE TABLE columns (key TEXT PRIMARY KEY, label TEXT NOT NULL, position INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'queue', wip_limit INTEGER);
        CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
            status TEXT NOT NULL REFERENCES columns(key) ON UPDATE CASCADE, position REAL NOT NULL DEFAULT 0,
            priority TEXT NOT NULL DEFAULT 'normal', type TEXT NOT NULL DEFAULT 'feature', hash TEXT,
            checks_done INTEGER NOT NULL DEFAULT 0, checks_total INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
            missing INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
        CREATE TABLE tags (task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (task_id, tag));
        CREATE TABLE history (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            at TEXT NOT NULL, field TEXT NOT NULL, old TEXT, new TEXT);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO columns VALUES ('todo', 'To do', 0, 'queue', NULL), ('doing', 'Doing', 1, 'active', 2);
        INSERT INTO tasks (file, title, status, created_at, updated_at) VALUES ('old.md', 'Old task', 'doing', '2026-01-01', '2026-01-01');
        INSERT INTO history (task_id, at, field, old, new) VALUES (1, '2026-01-01', 'status', NULL, 'doing');
        PRAGMA user_version = 2;
    `);
    db.close();

    const store = new Store(home);
    t.after(() => store.close());
    assert.strictEqual(store.db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.deepStrictEqual(store.columns().map(c => `${c.key}:${c.sort}`), ['todo:manual', 'doing:attention']);
    assert.strictEqual(store.get(1).title, 'Old task');
    assert.deepStrictEqual(store.history(1).map(h => [h.field, h.new, h.actor]), [['status', 'doing', null]]);
    // Opening it again changes nothing.
    new Store(home).close();
    assert.strictEqual(store.db.prepare('SELECT count(*) AS n FROM columns').get().n, 2);
});
