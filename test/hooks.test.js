'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tracker, fakeSession } = require('./helpers');

const KANBAN = path.join(__dirname, '..', 'kanban.js');

function hook(home, s, event, input = {}) {
    const r = spawnSync(process.execPath, [KANBAN, 'hook', event, '--home', home, '--session', String(s.id)],
        { input: JSON.stringify(input), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stderr, '');
    return r.stdout;
}

function setup(t) {
    const { store, home } = tracker(t);
    const id = store.add('Hooked');
    const s = fakeSession(store, { name: 't1-claude', task_id: id });
    store.subscribe(s.id, { task: id });
    return { store, home, id, s };
}

test('post-tool: quiet when there is nothing to act on, context when there is', t => {
    const { store, home, id, s } = setup(t);
    assert.strictEqual(hook(home, s, 'post-tool', { tool_name: 'Bash', tool_input: { command: 'ls' } }), '');
    assert.strictEqual(store.sessionOf(s.id).status, 'busy');

    store.as('user', () => store.post(id, 'Please also cover the empty case.'));
    const out = JSON.parse(hook(home, s, 'post-tool', { tool_name: 'Bash', tool_input: { command: 'ls' } }));
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /Please also cover the empty case/);
    assert.strictEqual(hook(home, s, 'post-tool', {}), '', 'delivered once');
});

test('pre-tool and post-tool attribute an edit to the task file to the agent', t => {
    const { store, home, id, s } = setup(t);
    const file = store.get(id).path;
    assert.strictEqual(hook(home, s, 'pre-tool', { tool_name: 'Edit', tool_input: { file_path: '/elsewhere/x.js' } }), '');
    assert.strictEqual(store.intents().size, 0);
    hook(home, s, 'pre-tool', { tool_name: 'Edit', tool_input: { file_path: file } });
    assert.strictEqual(store.intents().get(path.basename(file)).actor, 'agent:t1-claude');
    require('node:fs').writeFileSync(file, '# Hooked, renamed\n');
    hook(home, s, 'post-tool', { tool_name: 'Edit', tool_input: { file_path: file } });
    assert.strictEqual(store.history(id).at(-1).actor, 'agent:t1-claude');
    assert.strictEqual(store.intents().size, 0);
});

test('stop: keeps the agent going on something to act on, a few times at most, then idle', t => {
    const { store, home, id, s } = setup(t);
    store.setSessionStatus(s.id, 'busy');
    for (let i = 0; i < 3; i++) {
        store.as('user', () => store.post(id, `note ${i}`));
        const out = JSON.parse(hook(home, s, 'stop', {}));
        assert.strictEqual(out.decision, 'block');
        assert.match(out.reason, new RegExp(`note ${i}`));
    }
    store.as('user', () => store.post(id, 'one more'));
    assert.strictEqual(hook(home, s, 'stop', {}), '');
    assert.strictEqual(store.sessionOf(s.id).status, 'idle');
    // A new prompt resets the count and hands over what is waiting.
    assert.match(hook(home, s, 'prompt', { prompt: 'go on' }), /one more/);
    assert.strictEqual(store.sessionOf(s.id).stop_blocks, 0);
    assert.strictEqual(store.sessionOf(s.id).status, 'busy');
});

test('notification: a permission prompt means waiting, with the question', t => {
    const { store, home, s } = setup(t);
    hook(home, s, 'notification', { message: 'Claude needs your permission to use Bash' });
    let row = store.sessionOf(s.id);
    assert.deepStrictEqual([row.status, row.status_reason], ['waiting', 'Claude needs your permission to use Bash']);
    hook(home, s, 'notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    row = store.sessionOf(s.id);
    assert.strictEqual(row.status, 'idle');
});

test('a hook never fails the tool', t => {
    const { home } = setup(t);
    const r = spawnSync(process.execPath, [KANBAN, 'hook', 'post-tool', '--home', home, '--session', '999'], { input: '{}', encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.match(r.stderr, /No session/);
});
