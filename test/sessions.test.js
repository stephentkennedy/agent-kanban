'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('../lib/config');
const sessions = require('../lib/sessions');
const { tracker } = require('./helpers');

test('render fills placeholders and leaves unknown ones alone', () => {
    assert.strictEqual(config.render('#{{task.id}} {{ task.title }} {{nope}} {{task}}', { task: { id: 4, title: 'X' } }), '#4 X {{nope}} {{task}}');
});

test('kanban.config.json adds and changes profiles over the defaults', t => {
    const { home } = tracker(t);
    fs.writeFileSync(path.join(home, 'kanban.config.json'), JSON.stringify({
        defaultProfile: 'mine',
        profiles: { mine: { command: 'aider', args: ['--yes'] }, claude: { args: ['--model', 'opus'] }, codex: null },
    }));
    const cfg = config.load(home);
    assert.strictEqual(config.profile(cfg).name, 'mine');
    assert.strictEqual(cfg.profiles.mine.idle, 'quiet', 'unset settings come from the profile defaults');
    assert.deepStrictEqual(cfg.profiles.claude.args, ['--model', 'opus']);
    assert.strictEqual(cfg.profiles.claude.hooks, 'claude');
    assert.ok(!cfg.profiles.codex);
    assert.throws(() => config.profile(cfg, 'codex'), /No profile/);
});

test('a home\'s own prompt replaces the shipped one', t => {
    const { home } = tracker(t);
    assert.match(config.promptText(home, 'task'), /Work on task #\{\{task.id\}\}/);
    fs.mkdirSync(path.join(home, 'prompts'));
    fs.writeFileSync(path.join(home, 'prompts', 'task.md'), 'Just do #{{task.id}}.');
    assert.strictEqual(config.promptText(home, 'task'), 'Just do #{{task.id}}.');
});

test('the Claude settings hook every event back to this session', t => {
    const { store } = tracker(t);
    const settings = sessions.claudeSettings(store, { id: 42 });
    assert.deepStrictEqual(Object.keys(settings.hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification']);
    assert.match(settings.hooks.Stop[0].hooks[0].command, /hook stop --home '.*' --session 42$/);
});

test('sessions sort by how much they need the user', () => {
    const list = [
        { name: 'busy', status: 'busy' },
        { name: 'crashed', status: 'exited', exit_code: 1, attention_since: '1' },
        { name: 'idle', status: 'idle', attention_since: '2' },
        { name: 'waiting-later', status: 'waiting', attention_since: '5' },
        { name: 'waiting', status: 'waiting', attention_since: '3' },
    ];
    assert.deepStrictEqual(list.sort(sessions.byAttention).map(s => s.name), ['waiting', 'waiting-later', 'idle', 'crashed', 'busy']);
});

const tmux = sessions.available();
test('a real session: worktree, idle and waiting detection, kill', { skip: !tmux.tmuxOk && 'needs tmux 3.2 or later' }, t => {
    const { store, home: tmp } = tracker(t);
    store.close();
    // A repository with the tracker in tools/kanban, as in a real project.
    const repo = path.join(tmp, 'repo');
    const home = path.join(repo, 'tools', 'kanban');
    fs.mkdirSync(path.join(home, 'tasks'), { recursive: true });
    const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'README'), 'hi\n');
    const { Store } = require('../lib/store');
    const board = new Store(home);
    t.after(() => {
        spawnSync('tmux', ['-L', sessions.socket(home), 'kill-server']);
        board.close();
    });
    const id = board.add('Real task');
    git('add', '-A');
    git('commit', '-qm', 'init');

    const s = sessions.spawnSession(board, { task: id, profile: 'shell' });
    assert.strictEqual(s.branch, 'kanban/1-real-task');
    assert.ok(fs.existsSync(path.join(s.worktree, 'README')));
    assert.ok(!fs.existsSync(path.join(s.worktree, 'tools', 'kanban', 'tasks')), 'the tracker\'s task files are left out');
    assert.ok(!fs.existsSync(path.join(s.worktree, 'tools', 'kanban', 'kanban.jsonl')));
    assert.strictEqual(board.claimOf(id).actor, 'agent:t1-shell');

    const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const until = (what, fn) => {
        for (let i = 0; i < 40; i++) {
            if (fn()) return;
            wait(250);
        }
        assert.fail(`timed out waiting for ${what}`);
    };
    until('the shell to start', () => board.sessionOf(s.id).status === 'busy');
    const poll = () => sessions.poll(board, { now: Date.now() + 10000 });
    until('idle', () => { poll(); return board.sessionOf(s.id).status === 'idle'; });
    sessions.send(board, s.id, 'read -p "Continue (y/n)? " x');
    until('waiting', () => { poll(); return board.sessionOf(s.id).status === 'waiting'; });
    assert.strictEqual(board.sessionOf(s.id).status_reason, 'Continue (y/n)?');
    assert.match(sessions.peek(board, s.id, { lines: 3 }), /Continue \(y\/n\)\?/);

    sessions.kill(board, s.id);
    assert.strictEqual(board.sessionOf(s.id).status, 'exited');
    assert.strictEqual(board.claimOf(id), null);
    // Work on the branch that is not merged keeps its worktree, unless forced; the branch survives either way.
    fs.writeFileSync(path.join(s.worktree, 'work.txt'), 'work\n');
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'x', '--allow-empty'], { cwd: s.worktree });
    spawnSync('git', ['add', 'work.txt'], { cwd: s.worktree });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'work'], { cwd: s.worktree });
    assert.throws(() => sessions.kill(board, s.id, { worktree: 'remove' }), /not merged/);
    sessions.kill(board, s.id, { worktree: 'force' });
    assert.ok(!fs.existsSync(s.worktree));
    assert.strictEqual(git('rev-parse', '--verify', '--quiet', 'refs/heads/kanban/1-real-task').status, 0);
});
