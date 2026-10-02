'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { format, parse, merge } = require('../lib/exportfile');
const { Store } = require('../lib/store');
const { tracker } = require('./helpers');

const columns = [{ key: 'todo', label: 'To do', kind: 'queue', wip: null }, { key: 'doing', label: 'Doing', kind: 'active', wip: 2, sort: 'attention' }];

test('history entries keep their actor, and old four-element entries still read', () => {
    const text = format({
        columns,
        tasks: [{ id: 1, file: 'a.md', title: 'A', status: 'todo', position: 0, created: 'c', updated: 'u',
            history: [['t1', 'status', null, 'todo'], ['t2', 'priority', 'normal', 'high', 'agent:t1']] }],
    });
    const back = parse(text);
    assert.deepStrictEqual(back.tasks[0].history, [['t1', 'status', null, 'todo'], ['t2', 'priority', 'normal', 'high', 'agent:t1']]);
    assert.deepStrictEqual(back.columns.map(c => c.sort), ['manual', 'attention']);
    assert.ok(!text.split('\n')[1].includes('sort'), 'a manual column line is unchanged');
});

test('the merge keeps a column sort changed on one side', () => {
    const base = format({ columns, tasks: [] });
    const ours = format({ columns: [columns[0], { ...columns[1], sort: 'manual' }], tasks: [] });
    const { text } = merge(base, ours, base);
    assert.deepStrictEqual(parse(text).columns.map(c => c.sort), ['manual', 'manual']);
});

test('kanban.jsonl round-trips actors through a rebuild of kanban.db', t => {
    const { store, home } = tracker(t, { actor: 'user' });
    const id = store.add('Round trip');
    store.as('agent:t3', () => store.update(id, { type: 'bug' }));
    const text = fs.readFileSync(store.exportPath, 'utf8');
    store.close();
    fs.rmSync(`${home}/kanban.db`);
    for (const f of ['kanban.db-wal', 'kanban.db-shm']) fs.rmSync(`${home}/${f}`, { force: true });
    const again = new Store(home);
    t.after(() => again.close());
    again.sync();
    assert.deepStrictEqual(again.history(id).map(h => h.actor), ['user', 'agent:t3']);
    assert.strictEqual(fs.readFileSync(again.exportPath, 'utf8'), text);
});
