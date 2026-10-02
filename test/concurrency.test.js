'use strict';

// Several processes writing at once (agents' CLIs and hooks, the server): kanban.jsonl must always end up
// describing the whole board, and runtime writes must never touch it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tracker, fakeSession } = require('./helpers');

const WORKER = `
const { Store } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store'))});
const [home, n, session] = process.argv.slice(1);
const store = new Store(home, { actor: 'agent:w' + n });
for (let i = 0; i < 15; i++) {
    const id = store.add('Task ' + n + '-' + i);
    store.move(id, i % 2 ? 'doing' : 'todo');
    store.update(id, { priority: 'high', tags: 'w' + n });
    store.saveBody(id, '# Task ' + n + '-' + i + '\\n\\n- [x] done\\n');
    store.setSessionStatus(Number(session), i % 2 ? 'idle' : 'busy');
    store.inbox(Number(session));
}
store.close();
`;

const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', WORKER, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(err))));
});

test('concurrent writers leave a complete kanban.jsonl', async t => {
    const { store, home } = tracker(t);
    const sessions = [0, 1, 2, 3].map(n => fakeSession(store, { name: `w${n}` }));
    store.subscribe(sessions[0].id, { task: 0 });
    await Promise.all(sessions.map((s, n) => run([home, String(n), String(s.id)])));

    store.sync();
    const text = fs.readFileSync(store.exportPath, 'utf8');
    assert.strictEqual(text, store.exportText());
    const tasks = store.list();
    assert.strictEqual(tasks.length, 60);
    assert.ok(tasks.every(t => t.priority === 'high' && t.checks_done === 1));
    // Every task has its four history entries, each by the agent that made it.
    for (const t of tasks) {
        const h = store.history(t.id);
        assert.ok(h.length >= 3, `#${t.id} has ${h.length} history entries`);
        assert.ok(h.every(x => /^agent:w\d$/.test(x.actor)));
    }
});

test('runtime writes do not rewrite kanban.jsonl', t => {
    const { store } = tracker(t);
    store.add('Something');
    const before = fs.statSync(store.exportPath).mtimeMs;
    const text = fs.readFileSync(store.exportPath, 'utf8');
    const s = fakeSession(store);
    store.subscribe(s.id, { task: 0 });
    store.setSessionStatus(s.id, 'busy');
    store.claim(1);
    store.post(1, 'note');
    store.inbox(s.id);
    assert.strictEqual(fs.readFileSync(store.exportPath, 'utf8'), text);
    assert.strictEqual(fs.statSync(store.exportPath).mtimeMs, before);
});
