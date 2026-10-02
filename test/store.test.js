'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../lib/store');
const { tracker, fakeSession } = require('./helpers');

const types = store => store.events().map(e => e.type);

test('history and events record who made each change', t => {
    const { store } = tracker(t, { actor: 'user' });
    const id = store.add('A task');
    store.as('agent:t1', () => store.move(id, 'doing'));
    store.update(id, { priority: 'high' });
    assert.deepStrictEqual(store.history(id).map(h => `${h.field}:${h.actor}`), ['status:user', 'status:agent:t1', 'priority:user']);
    assert.deepStrictEqual(store.events().map(e => `${e.type}:${e.actor}`),
        ['task.created:user', 'task.moved:agent:t1', 'task.updated:user']);
    assert.deepStrictEqual(store.events()[2].payload, { changes: { priority: ['normal', 'high'] } });
});

test('as() restores the actor even when the change fails', t => {
    const { store } = tracker(t);
    assert.throws(() => store.as('user', () => store.move(99, 'doing')));
    assert.strictEqual(store.actor, 'cli');
});

test('an event is part of the transaction that made the change', t => {
    const { store } = tracker(t);
    const id = store.add('A task');
    const before = store.lastEventId();
    assert.throws(() => store.tx(() => {
        store.move(id, 'doing');
        throw new Error('changed my mind');
    }));
    assert.strictEqual(store.lastEventId(), before);
    assert.strictEqual(store.get(id).status, 'backlog');
});

test('each kind of change has its event', t => {
    const { store, home } = tracker(t);
    const id = store.add('Checks', { body: '- [ ] one\n' });
    const { hash } = store.get(id);
    store.toggleCheck(id, 2, hash);
    store.move(id, 'todo');
    store.add('Other', { status: 'todo' });
    store.move(id, 'todo', 1); // a reorder only
    store.update(id, { tags: 'a' });
    store.updateColumn('todo', { sort: 'attention' });
    store.remove(id);
    assert.deepStrictEqual(types(store), ['task.created', 'task.body_changed', 'task.moved', 'task.created', 'task.reordered',
        'task.updated', 'column.changed', 'task.deleted']);
    assert.ok(fs.existsSync(path.join(home, 'kanban.jsonl')));
});

test('a file edited outside the tool is attributed to "file", or to the agent that announced it', t => {
    const { store } = tracker(t);
    const id = store.add('Edited');
    const file = store.get(id).path;
    fs.writeFileSync(file, '# Edited\n\nBy hand.\n');
    store.as('user', () => store.sync());
    assert.strictEqual(store.events().at(-1).actor, 'file');

    store.as('agent:t1', () => store.addIntent(file), 7);
    fs.writeFileSync(file, '# Renamed by agent\n');
    store.sync();
    const last = store.history(id).at(-1);
    assert.deepStrictEqual([last.field, last.new, last.actor], ['title', 'Renamed by agent', 'agent:t1']);
});

test('changes by another process show up as events', t => {
    const { store, home } = tracker(t);
    const other = new Store(home, { actor: 'agent:x' });
    t.after(() => other.close());
    const after = store.lastEventId();
    other.add('From elsewhere');
    assert.deepStrictEqual(store.events({ after }).map(e => `${e.type}:${e.actor}`), ['task.created:agent:x']);
});

test('the user changing a task an agent holds is flagged to the agent', t => {
    const { store } = tracker(t);
    const id = store.add('Held');
    const s = fakeSession(store, { name: 't1', task_id: id });
    store.as('agent:t1', () => store.claim(id), s.id);
    store.subscribe(s.id, { task: id });

    store.as('agent:t1', () => store.move(id, 'doing'), s.id);
    assert.ok(!types(store).includes('task.user_changed'), 'the agent itself does not trigger it');

    store.as('user', () => store.update(id, { priority: 'urgent' }));
    const flagged = store.events().filter(e => e.type === 'task.user_changed');
    assert.strictEqual(flagged.length, 1);
    assert.deepStrictEqual(flagged[0].payload.cause, ['task.updated']);
    assert.ok(store.runtime().unseen.has(id));

    const inbox = store.inbox(s.id);
    assert.ok(inbox.some(e => e.type === 'task.user_changed' && e.actionable));
    assert.ok(!store.runtime().unseen.has(id), 'reading the inbox clears it');

    // A reorder is not worth telling the agent about, and an unclaimed task never is.
    store.as('user', () => store.move(id, 'doing', 0));
    const other = store.add('Unclaimed');
    store.as('user', () => store.update(other, { priority: 'low' }));
    assert.strictEqual(store.events().filter(e => e.type === 'task.user_changed').length, 1);
});

test('an unattributed file edit is not flagged while the agent is mid-turn', t => {
    const { store } = tracker(t);
    const id = store.add('Busy');
    const s = fakeSession(store, { name: 't1', task_id: id });
    store.as('agent:t1', () => store.claim(id), s.id);
    store.as('agent:t1', () => store.setSessionStatus(s.id, 'busy'), s.id);
    fs.writeFileSync(store.get(id).path, '# Busy\n\nedited by sed\n');
    store.sync();
    assert.ok(!types(store).includes('task.user_changed'));

    store.setSessionStatus(s.id, 'idle');
    fs.writeFileSync(store.get(id).path, '# Busy\n\nedited by the user\n');
    store.sync();
    assert.ok(types(store).includes('task.user_changed'));
});

test('claims: one holder at a time, released when its session ends', t => {
    const { store } = tracker(t);
    const id = store.add('Claimed');
    const s = fakeSession(store, { name: 't1', task_id: id });
    store.as('agent:t1', () => store.claim(id), s.id);
    assert.throws(() => store.as('agent:t2', () => store.claim(id)), /already claimed by agent:t1/);
    store.setSessionStatus(s.id, 'exited', { exit_code: 0 });
    assert.strictEqual(store.claimOf(id), null);
    assert.ok(types(store).includes('task.released'));
});

test('session status: events only on a change, attention while it needs the user', t => {
    const { store } = tracker(t);
    const s = fakeSession(store, { name: 't1' });
    assert.strictEqual(store.setSessionStatus(s.id, 'busy'), true);
    assert.strictEqual(store.setSessionStatus(s.id, 'busy'), false);
    store.setSessionStatus(s.id, 'waiting', { reason: 'Continue (y/n)?' });
    let row = store.sessionOf('t1');
    assert.strictEqual(row.status_reason, 'Continue (y/n)?');
    assert.ok(row.attention_since);
    store.setSessionStatus(s.id, 'busy');
    assert.strictEqual(store.sessionOf('t1').attention_since, null);
    store.setSessionStatus(s.id, 'exited', { exit_code: 2 });
    row = store.sessions()[0];
    assert.strictEqual(row.attention, 3);
    assert.strictEqual(store.setSessionStatus(s.id, 'idle'), false, 'an ended session stays ended');
    assert.deepStrictEqual(types(store), ['session.busy', 'session.waiting', 'session.busy', 'session.exited']);
});

test('sessions are found by id, name, orchestrator or task', t => {
    const { store } = tracker(t);
    const id = store.add('Task');
    const a = fakeSession(store, { name: 'orchestrator', role: 'orchestrator' });
    const b = fakeSession(store, { name: 't1-claude', task_id: id });
    assert.strictEqual(store.sessionOf(String(a.id)).name, 'orchestrator');
    assert.strictEqual(store.sessionOf('orchestrator').id, a.id);
    assert.strictEqual(store.sessionOf(`task:${id}`).id, b.id);
    assert.strictEqual(store.sessionOf('t1-claude').id, b.id);
    assert.throws(() => store.sessionOf('nobody'), /No session/);
});
