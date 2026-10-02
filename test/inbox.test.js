'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { tracker, fakeSession } = require('./helpers');

test('a task subscription delivers that task\'s events, not others, and not its own', t => {
    const { store } = tracker(t);
    const mine = store.add('Mine');
    const other = store.add('Other');
    const s = fakeSession(store, { name: 't1', task_id: mine });
    store.subscribe(s.id, { task: mine });
    store.move(mine, 'todo');
    store.move(other, 'todo');
    store.as('agent:t1', () => store.post(mine, 'my own note'), s.id);
    const events = store.inbox(s.id);
    assert.deepStrictEqual(events.map(e => `${e.type}#${e.task_id}`), [`task.moved#${mine}`]);
    assert.deepStrictEqual(store.inbox(s.id), [], 'read events are not delivered again');
});

test('nothing from before a subscription is delivered', t => {
    const { store } = tracker(t);
    const id = store.add('Early');
    const s = fakeSession(store);
    store.move(id, 'todo');
    store.subscribe(s.id, { task: 'board' });
    store.move(id, 'doing');
    assert.deepStrictEqual(store.inbox(s.id).map(e => e.payload.to), ['doing']);
});

test('a board subscription filters by type prefix', t => {
    const { store } = tracker(t);
    const s = fakeSession(store, { role: 'orchestrator', name: 'orchestrator' });
    store.subscribe(s.id, { task: 0, types: 'task.moved,message.' });
    const id = store.add('A');
    store.move(id, 'doing');
    store.post(id, 'hello');
    store.update(id, { priority: 'high' });
    assert.deepStrictEqual(store.inbox(s.id).map(e => e.type), ['task.moved', 'message.posted']);
});

test('direct messages arrive without a subscription; peek leaves them unread', t => {
    const { store } = tracker(t);
    const s = fakeSession(store, { name: 't9' });
    store.as('agent:orchestrator', () => store.send('t9', 'please add tests'));
    const peeked = store.inbox(s.id, { advance: false });
    assert.strictEqual(peeked.length, 1);
    assert.strictEqual(peeked[0].actionable, true);
    assert.strictEqual(store.inbox(s.id).length, 1);
    assert.strictEqual(store.inbox(s.id).length, 0);
});

test('the orchestrator is told when an agent goes idle or needs input', t => {
    const { store } = tracker(t);
    const o = fakeSession(store, { role: 'orchestrator', name: 'orchestrator' });
    store.subscribe(o.id, { task: 0, types: 'session.' });
    const a = fakeSession(store, { name: 't1' });
    store.setSessionStatus(a.id, 'busy');
    store.setSessionStatus(a.id, 'waiting', { reason: 'Allow?' });
    store.setSessionStatus(o.id, 'idle'); // its own state is not news to it
    const events = store.inbox(o.id);
    assert.deepStrictEqual(events.map(e => [e.type, e.actionable]), [['session.busy', false], ['session.waiting', true]]);
});

test('a long backlog is delivered in pages without losing any', t => {
    const { store } = tracker(t);
    const id = store.add('Busy task');
    const s = fakeSession(store);
    store.subscribe(s.id, { task: id });
    for (let i = 0; i < 7; i++) store.post(id, `note ${i}`);
    const first = store.inbox(s.id, { limit: 3 });
    const rest = store.inbox(s.id, { limit: 10 });
    assert.deepStrictEqual([...first, ...rest].map(e => e.payload.text), [0, 1, 2, 3, 4, 5, 6].map(i => `note ${i}`));
});
