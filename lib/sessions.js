'use strict';

// Agent sessions: terminal tools the board launches, each in its own tmux session on a tmux server that
// belongs to this tracker. tmux keeps them running when the board's server stops, lets any number of
// viewers attach (the browser, or `kanban session attach` in a terminal), and lets the board type into them.
//
// tmux runs `kanban session exec <id>`, the launcher. It renders the prompts, sets the session's environment
// and runs the tool, then records how it ended. A task session works in a git worktree of its own, on its
// own branch, with the tracker's task files left out of it so the only copy an agent can edit is the real one.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { KanbanError, slugify, hashOf, attentionRank } = require('./store');
const config = require('./config');

const KANBAN = path.join(__dirname, '..', 'kanban.js');
const BIN = path.join(__dirname, '..', 'bin');
const TMUX_CONF = path.join(__dirname, 'tmux.conf');
// What the orchestrator hears about from the whole board.
const ORCHESTRATOR_TYPES = 'task.created,task.moved,task.user_changed,task.claimed,task.released,session.,message.';

/* ---------- tmux ---------- */

// One tmux server per tracker, so two boards never see each other's sessions.
function socket(home) {
    return `kanban-${hashOf(path.resolve(home)).slice(0, 8)}`;
}

// Without TMUX, so a session can be started from inside another one (the orchestrator's).
function cleanEnv() {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    return env;
}

function tmux(home, args) {
    const r = spawnSync('tmux', ['-L', socket(home), '-f', TMUX_CONF, ...args], { encoding: 'utf8', env: cleanEnv() });
    if (r.error) {
        throw new KanbanError(r.error.code === 'ENOENT' ? 'tmux is not installed; agent sessions need tmux 3.2 or later.' : r.error.message, 501);
    }
    return r;
}

function tmuxOk(home, args, what) {
    const r = tmux(home, args);
    if (r.status !== 0) throw new KanbanError(`${what}: ${(r.stderr || '').trim() || 'tmux failed'}`, 500);
    return r.stdout;
}

function hasSession(home, name) {
    return tmux(home, ['has-session', '-t', `=${name}`]).status === 0;
}

// The pane of a session, for commands that take a pane.
const pane = name => `=${name}:`;

let tmuxVersion;
function available() {
    if (tmuxVersion === undefined) {
        const r = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
        const m = !r.error && r.status === 0 && r.stdout.match(/(\d+)\.(\d+)/);
        tmuxVersion = m ? { text: r.stdout.trim(), ok: Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2) } : null;
    }
    let pty = false;
    try { require.resolve('node-pty'); pty = true; } catch { /* terminals in the browser need npm install */ }
    const hasGit = !spawnSync('git', ['--version']).error;
    return { tmux: tmuxVersion ? tmuxVersion.text : null, tmuxOk: !!(tmuxVersion && tmuxVersion.ok), pty, git: hasGit };
}

function requireTmux() {
    const a = available();
    if (!a.tmux) throw new KanbanError('tmux is not installed; agent sessions need tmux 3.2 or later.', 501);
    if (!a.tmuxOk) throw new KanbanError(`Agent sessions need tmux 3.2 or later; this is ${a.tmux}.`, 501);
}

// The command and arguments that attach a terminal to a session (node-pty in the server, or this terminal).
function attachCommand(home, s, { readOnly = false } = {}) {
    return ['tmux', ['-L', socket(home), '-f', TMUX_CONF, 'attach-session', ...(readOnly ? ['-r'] : []), '-t', `=${s.tmux}`]];
}

/* ---------- git ---------- */

function git(cwd, args, what) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new KanbanError(`${what || 'git ' + args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`, 500);
    return r.stdout.trim();
}

function repoRoot(dir) {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
}

// The task's worktree, made on first use: a branch of its own, checked out without the tracker's task files
// and kanban.jsonl (sparse checkout), so an agent edits the real task file and never commits a stale board.
function ensureWorktree(store, cfg, task, root) {
    const slug = slugify(task.title);
    const vars = { repo: path.basename(root), task: { id: task.id, slug, title: task.title } };
    const branch = config.render(cfg.worktrees.branch, vars);
    const dir = path.resolve(root, config.render(cfg.worktrees.dir, vars), `${task.id}-${slug}`);
    const listed = git(root, ['worktree', 'list', '--porcelain']).split('\n')
        .filter(l => l.startsWith('worktree ')).map(l => path.resolve(l.slice(9)));
    if (listed.includes(dir)) return { dir, branch };
    if (fs.existsSync(dir)) throw new KanbanError(`${dir} already exists and is not a worktree of this repository.`, 409);

    const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root }).status === 0;
    git(root, exists ? ['worktree', 'add', '--no-checkout', dir, branch]
        : ['worktree', 'add', '--no-checkout', '-b', branch, dir, cfg.worktrees.base], 'Creating the worktree');
    const rel = path.relative(root, store.home).split(path.sep).join('/');
    if (!rel.startsWith('..')) {
        const prefix = rel ? `/${rel}` : '';
        const r = spawnSync('git', ['sparse-checkout', 'set', '--no-cone', '/*', `!${prefix}/tasks/`, `!${prefix}/kanban.jsonl`],
            { cwd: dir, encoding: 'utf8' });
        if (r.status !== 0) console.error(`kanban: could not leave the tracker's files out of ${dir}: ${(r.stderr || '').trim()}`);
    }
    git(dir, ['checkout'], 'Checking out the worktree');
    if (cfg.worktrees.setup) {
        const r = spawnSync(cfg.worktrees.setup, { cwd: dir, shell: true, encoding: 'utf8' });
        if (r.status !== 0) console.error(`kanban: the worktree setup command failed in ${dir}: ${(r.stderr || '').trim()}`);
    }
    return { dir, branch };
}

// Removes a session's worktree. Without force, only a clean one whose branch is merged into the main
// checkout's HEAD; the branch is deleted only when merged, so no work is ever lost.
function removeWorktree(store, s, { force = false } = {}) {
    if (!s.worktree || !fs.existsSync(s.worktree)) return false;
    const root = repoRoot(store.home);
    const dirty = git(s.worktree, ['status', '--porcelain']);
    const merged = s.branch && git(root, ['branch', '--merged', 'HEAD', '--format=%(refname:short)']).split('\n').includes(s.branch);
    if (!force && dirty) throw new KanbanError(`${s.worktree} has uncommitted changes; commit them, or remove it with force.`, 409);
    if (!force && !merged) throw new KanbanError(`${s.branch} is not merged; merge it first, or remove the worktree with force (the branch is kept).`, 409);
    git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), s.worktree], 'Removing the worktree');
    if (merged) spawnSync('git', ['branch', '-d', s.branch], { cwd: root });
    return true;
}

/* ---------- starting sessions ---------- */

function shq(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function sessionDir(home, name) {
    return path.join(home, '.kanban', 'sessions', name);
}

function uniqueName(store, base) {
    let name = base;
    for (let n = 2; store.db.prepare('SELECT 1 FROM sessions WHERE name = ?').get(name); n++) name = `${base}-${n}`;
    return name;
}

function vars(store, s) {
    const root = repoRoot(store.home) || store.home;
    const dir = sessionDir(store.home, s.name);
    let task = {};
    if (s.task_id != null) {
        try {
            const t = store.get(s.task_id, { body: false });
            task = { id: t.id, title: t.title, path: t.path, slug: slugify(t.title), file: t.file };
        } catch { task = { id: s.task_id }; }
    }
    return {
        home: store.home, repo: path.basename(root), repoRoot: root, worktree: s.worktree || '', branch: s.branch || '',
        toolSession: s.tool_session, kanban: path.join(BIN, 'kanban'), claudeSettings: path.join(dir, 'claude-settings.json'),
        session: { id: s.id, name: s.name, role: s.role }, task, env: process.env,
    };
}

// The Claude Code hooks that report a session's state to the board and hand it its events.
function claudeSettings(store, s) {
    const hook = event => ({
        type: 'command',
        command: `${shq(process.execPath)} ${shq(KANBAN)} hook ${event} --home ${shq(store.home)} --session ${s.id}`,
    });
    return {
        hooks: {
            SessionStart: [{ hooks: [hook('session-start')] }],
            UserPromptSubmit: [{ hooks: [hook('prompt')] }],
            PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [hook('pre-tool')] }],
            PostToolUse: [{ matcher: '*', hooks: [hook('post-tool')] }],
            Stop: [{ hooks: [hook('stop')] }],
            Notification: [{ hooks: [hook('notification')] }],
        },
    };
}

function writeSessionFiles(store, p, s) {
    const dir = sessionDir(store.home, s.name);
    fs.mkdirSync(dir, { recursive: true });
    const v = vars(store, s);
    fs.writeFileSync(path.join(dir, 'system.md'), p.systemPrompt === 'none' ? '' : config.render(config.promptText(store.home, 'protocol'), v));
    fs.writeFileSync(path.join(dir, 'prompt.md'), p.prompt === 'none' ? '' : config.render(config.promptText(store.home, s.role === 'orchestrator' ? 'orchestrator' : 'task'), v));
    if (p.hooks === 'claude') fs.writeFileSync(path.join(dir, 'claude-settings.json'), JSON.stringify(claudeSettings(store, s), null, 2) + '\n');
}

// Starts (or, with resume, restarts) the launcher in the session's tmux session.
function launch(store, s, { resume = false } = {}) {
    const cmd = `exec ${shq(process.execPath)} ${shq(KANBAN)} session exec ${s.id} --home ${shq(store.home)}${resume ? ' --resume' : ''}`;
    if (hasSession(store.home, s.tmux)) {
        tmuxOk(store.home, ['respawn-pane', '-k', '-t', pane(s.tmux), '-c', s.cwd, cmd], 'Could not restart the session');
    } else {
        tmuxOk(store.home, ['new-session', '-d', '-s', s.tmux, '-c', s.cwd, '-x', '200', '-y', '50', cmd], 'Could not start the tmux session');
    }
}

function spawnSession(store, { role = 'task', task, profile: profileName, force = false } = {}) {
    requireTmux();
    const cfg = config.load(store.home);
    const p = config.profile(cfg, profileName);
    let t = null, base;
    if (role === 'orchestrator') {
        const live = store.sessions({ live: true }).find(s => s.role === 'orchestrator');
        if (live) throw new KanbanError(`The orchestrator is already running as ${live.name}.`, 409);
        base = 'orchestrator';
    } else if (role === 'task') {
        if (task == null || task === '') throw new KanbanError('Which task? A task session needs one.');
        t = store.get(task, { body: false });
        const live = store.sessions({ live: true, task: t.id });
        if (live.length && !force) throw new KanbanError(`#${t.id} already has a live session, ${live[0].name}; pass --force to start another.`, 409);
        base = `t${t.id}-${p.name.replace(/[^\w-]/g, '')}`;
    } else {
        throw new KanbanError('A session is an orchestrator or a task session.');
    }

    const root = repoRoot(store.home);
    let cwd = root || store.home, worktree = null, branch = null;
    if (t) {
        if (!root) throw new KanbanError('A task session works in a git worktree, and this tracker is not in a git repository.');
        ({ dir: worktree, branch } = ensureWorktree(store, cfg, t, root));
        cwd = worktree;
    }
    const name = uniqueName(store, base);
    const s = store.createSession({
        name, role, profile: p.name, task_id: t ? t.id : null, tmux: name, cwd, worktree, branch, tool_session: crypto.randomUUID(),
    });
    try {
        if (t) {
            store.subscribe(s.id, { task: t.id });
            store.as(`agent:${name}`, () => store.claim(t.id, { force: true }), s.id);
        } else {
            store.subscribe(s.id, { task: 0, types: ORCHESTRATOR_TYPES });
        }
        writeSessionFiles(store, p, s);
        launch(store, s);
        store.emit('session.started', s.task_id, { name, role, profile: p.name, branch, worktree }, { session: s.id });
    } catch (e) {
        store.setSessionStatus(s.id, 'exited', { reason: `Could not start: ${e.message}` });
        throw e;
    }
    return store.sessionOf(s.id);
}

function resume(store, ref) {
    requireTmux();
    const s = store.sessionOf(ref);
    const live = !['exited', 'lost'].includes(s.status);
    if (live && hasSession(store.home, s.tmux) && !paneDead(store.home, s.tmux)) {
        throw new KanbanError(`${s.name} is still running.`, 409);
    }
    const cfg = config.load(store.home);
    const p = config.profile(cfg, s.profile);
    store.restartSession(s.id);
    if (s.task_id != null) store.as(`agent:${s.name}`, () => store.claim(s.task_id, { force: true }), s.id);
    if (!fs.existsSync(path.join(sessionDir(store.home, s.name), 'prompt.md'))) writeSessionFiles(store, p, s);
    // A tool without a way to resume starts afresh, with its first prompt again.
    launch(store, s, { resume: !!p.resumeArgs });
    store.emit('session.started', s.task_id, { name: s.name, role: s.role, profile: s.profile, resumed: true }, { session: s.id });
    return store.sessionOf(s.id);
}

function paneDead(home, name) {
    const r = tmux(home, ['display-message', '-p', '-t', pane(name), '#{pane_dead}']);
    return r.status === 0 && r.stdout.trim() === '1';
}

/* ---------- the launcher (runs inside tmux) ---------- */

function exec(store, id, { resume: resuming = false } = {}) {
    const s = store.sessionOf(id);
    store.actor = `agent:${s.name}`;
    store.session = s.id;
    const cfg = config.load(store.home);
    const p = config.profile(cfg, s.profile);
    const dir = sessionDir(store.home, s.name);
    const read = f => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : '');
    const v = { ...vars(store, s), system: read('system.md') };
    const render = x => config.render(x, v);

    let command = render(p.command).trim();
    if (!command || command.includes('{{')) command = process.env.SHELL || '/bin/sh';
    const args = [...p.args, ...(resuming ? p.resumeArgs || [] : p.startArgs)].map(render);
    let first = resuming ? '' : read('prompt.md');
    if (!resuming && p.systemPrompt === 'prepend' && v.system) first = `${v.system}\n\n${first}`.trim();
    if (first && p.prompt === 'argv') args.push(first);

    const env = { ...process.env };
    for (const [k, val] of Object.entries(p.env || {})) env[k] = render(val);
    Object.assign(env, {
        KANBAN_HOME: store.home, KANBAN_SESSION: String(s.id), KANBAN_ACTOR: `agent:${s.name}`,
        PATH: `${BIN}${path.delimiter}${process.env.PATH || ''}`,
    });
    if (s.task_id != null) env.KANBAN_TASK = String(s.task_id);
    if (s.worktree) env.KANBAN_WORKTREE = s.worktree;

    // Ctrl+C and friends are for the tool, which shares this terminal; the launcher waits for it.
    for (const sig of ['SIGINT', 'SIGQUIT', 'SIGTSTP']) process.on(sig, () => {});
    let done = false;
    const finish = (code, why) => {
        if (done) return;
        done = true;
        try {
            store.setSessionStatus(s.id, 'exited', { exit_code: code, reason: why || (code ? `Exited with code ${code}` : null) });
        } catch (e) { console.error(e.message); }
        const how = code ? `exited with code ${code}` : 'exited';
        console.log(`\n\x1b[2m[kanban] ${command} ${how}. Resume it from the board, or: kanban session resume ${s.name}\x1b[0m`);
        store.close();
        process.exit(code || 0);
    };
    process.on('SIGHUP', () => finish(129, 'The terminal closed'));

    store.setSessionStatus(s.id, 'busy');
    console.log(`\x1b[2m[kanban] ${s.name}: ${command} in ${s.cwd}\x1b[0m`);
    const child = spawn(command, args, { stdio: 'inherit', env, cwd: s.cwd });
    child.on('error', e => finish(127, e.code === 'ENOENT' ? `${command} was not found` : e.message));
    child.on('exit', (code, signal) => finish(code ?? 128 + (os.constants.signals[signal] || 0), signal ? `Killed by ${signal}` : null));
    if (first && p.prompt === 'type') setTimeout(() => sendText(store.home, s.tmux, first), p.typeDelayMs);
}

/* ---------- driving sessions ---------- */

function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Pastes text into a session (as a bracketed paste, so a tool sees several lines as one input), then
// presses Enter separately: a tool that reads a fast Enter as part of the paste would not submit it.
function sendText(home, name, text, { enter = true } = {}) {
    if (text) {
        const buffer = `kanban-${process.pid}-${Date.now()}`;
        tmuxOk(home, ['set-buffer', '-b', buffer, '--', text], 'Could not type into the session');
        tmuxOk(home, ['paste-buffer', '-p', '-d', '-b', buffer, '-t', pane(name)], 'Could not type into the session');
    }
    if (enter) {
        if (text) sleep(150);
        tmuxOk(home, ['send-keys', '-t', pane(name), 'Enter'], 'Could not type into the session');
    }
}

function liveSession(store, ref) {
    const s = store.sessionOf(ref);
    if (['exited', 'lost'].includes(s.status) || !hasSession(store.home, s.tmux)) {
        throw new KanbanError(`${s.name} is not running.`, 409);
    }
    return s;
}

function send(store, ref, text, { enter = true } = {}) {
    requireTmux();
    const s = liveSession(store, ref);
    sendText(store.home, s.tmux, String(text ?? ''), { enter });
    return s;
}

function nudge(store, ref) {
    requireTmux();
    const s = liveSession(store, ref);
    const p = config.profile(config.load(store.home), s.profile);
    if (!p.nudge) throw new KanbanError(`The ${p.name} profile has no nudge text.`);
    sendText(store.home, s.tmux, p.nudge);
    store.updateSession(s.id, { nudged_at: new Date().toISOString() });
    return s;
}

// The last lines on a session's screen.
function peek(store, ref, { lines = 40 } = {}) {
    requireTmux();
    const s = store.sessionOf(ref);
    if (!hasSession(store.home, s.tmux)) throw new KanbanError(`${s.name} has no terminal any more.`, 409);
    return capture(store.home, s.tmux, lines);
}

// The screen includes its blank lower part, so the last lines are counted after trimming that.
function capture(home, name, lines) {
    const n = Math.max(1, Number(lines) || 40);
    const out = tmuxOk(home, ['capture-pane', '-p', '-J', '-t', pane(name), '-S', `-${n}`], 'Could not read the session');
    return out.replace(/\s+$/, '').split('\n').slice(-n).join('\n');
}

function kill(store, ref, { worktree = 'keep' } = {}) {
    const s = store.sessionOf(ref);
    // Recorded first, so the launcher's own report of the hang-up (an error code) does not win.
    store.setSessionStatus(s.id, 'exited', { reason: 'Stopped from the board' });
    if (available().tmux && hasSession(store.home, s.tmux)) tmux(store.home, ['kill-session', '-t', `=${s.tmux}`]);
    let removed = false;
    if (worktree !== 'keep' && s.worktree) removed = removeWorktree(store, s, { force: worktree === 'force' });
    return { ...store.sessionOf(s.id), worktreeRemoved: removed };
}

/* ---------- watching sessions ---------- */

// The line on screen that looks like the tool asking something, if any.
function waitingLine(home, s, p) {
    if (!p.waitingPatterns || !p.waitingPatterns.length) return null;
    let text;
    try { text = capture(home, s.tmux, 15); } catch { return null; }
    const lines = text.split('\n').reverse();
    for (const pattern of p.waitingPatterns) {
        let re;
        try { re = new RegExp(pattern); } catch { continue; }
        const hit = lines.find(l => re.test(l));
        if (hit) return hit.trim().slice(0, 200);
    }
    return null;
}

// One look at every session: gone, exited, or (for tools without hooks) busy, idle or waiting by how long
// the screen has been still and what is on it. The board's server runs this every couple of seconds.
function poll(store, { now = Date.now() } = {}) {
    if (!available().tmux) return { orphans: [] };
    const r = tmux(store.home, ['list-panes', '-a', '-F', '#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{window_activity}']);
    const panes = new Map();
    if (r.status === 0) {
        for (const line of r.stdout.split('\n').filter(Boolean)) {
            const [name, dead, code, activity] = line.split('\t');
            panes.set(name, { dead: dead === '1', code: code === '' ? null : Number(code), activity: Number(activity) * 1000 });
        }
    } else if (!/no server running|error connecting|No such file/i.test(r.stderr)) {
        return { orphans: [], error: r.stderr.trim() };
    }
    const cfg = config.load(store.home);
    for (const s of store.sessions({ live: true })) {
        const pn = panes.get(s.tmux);
        if (!pn) {
            if (s.status === 'starting' && now - Date.parse(s.created_at) < 10000) continue;
            store.setSessionStatus(s.id, 'lost', { reason: 'Its tmux session is gone' });
            continue;
        }
        if (pn.dead) {
            store.setSessionStatus(s.id, 'exited', { exit_code: pn.code, reason: pn.code ? `Exited with code ${pn.code}` : null });
            continue;
        }
        const p = cfg.profiles[s.profile];
        if (!p || p.idle === 'none' || s.status === 'starting') continue;
        const quiet = now - pn.activity >= p.quietMs;
        if (p.idle === 'quiet') {
            if (quiet) {
                const line = waitingLine(store.home, s, p);
                store.setSessionStatus(s.id, line ? 'waiting' : 'idle', { reason: line });
            } else if (s.status !== 'busy') {
                store.setSessionStatus(s.id, 'busy');
            }
        } else if (p.idle === 'hooks' && s.status === 'busy' && quiet) {
            // The hooks say when the tool stops or asks; this catches a prompt they did not report.
            const line = waitingLine(store.home, s, p);
            if (line) store.setSessionStatus(s.id, 'waiting', { reason: line });
        }
    }
    const known = new Set(store.sessions().map(s => s.tmux));
    return { orphans: [...panes.keys()].filter(n => !known.has(n)) };
}

// Sessions in the order they need the user: blocked first, then finished, then crashed, each longest-waiting
// first.
function byAttention(a, b) {
    const ra = attentionRank(a) || 9, rb = attentionRank(b) || 9;
    if (ra !== rb) return ra - rb;
    return String(a.attention_since || a.updated_at).localeCompare(String(b.attention_since || b.updated_at));
}

module.exports = {
    available, requireTmux, socket, attachCommand, spawnSession, resume, exec, send, nudge, peek, kill, poll,
    removeWorktree, byAttention, claudeSettings, ensureWorktree, ORCHESTRATOR_TYPES,
};
