'use strict';

// `kanban hook <event>`: Claude Code's hooks for a session the board started (see claudeSettings in
// sessions.js). They tell the board what the session is doing, and hand the agent its board events: as
// context after a tool call, before a prompt, or by keeping it going when it would stop.
//
// A hook runs on every tool call, so it is quick (no sync unless a task file was written) and it never
// fails the tool: problems go to stderr and the exit code stays 0.

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./store');
const { describe } = require('./describe');

const MAX_EVENTS = 12;
const MAX_LINE = 300;
const MAX_STOP_BLOCKS = 3;

function readInput() {
    if (process.stdin.isTTY) return {};
    try {
        const text = fs.readFileSync(0, 'utf8');
        return text.trim() ? JSON.parse(text) : {};
    } catch {
        return {};
    }
}

// The pending events, as text for the agent, marked read.
function deliver(store, s) {
    const events = store.inbox(s.id, { advance: true, limit: MAX_EVENTS });
    if (!events.length) return '';
    const more = store.inbox(s.id, { advance: false }).length;
    return [
        `[kanban] ${events.length} new board event${events.length === 1 ? '' : 's'} for ${s.name}:`,
        ...events.map(e => '- ' + describe(e, { max: MAX_LINE })),
        more ? `(${more} more: run \`kanban inbox\`.)` : '',
    ].filter(Boolean).join('\n');
}

function hasActionable(store, s) {
    return store.inbox(s.id, { advance: false, actionableOnly: true }).length > 0;
}

function taskFile(store, input) {
    const file = input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path);
    if (!file) return null;
    const abs = path.resolve(input.cwd || process.cwd(), file);
    return path.dirname(abs) === store.tasksDir && abs.endsWith('.md') ? abs : null;
}

// What a Notification is about. Newer Claude Code versions say so in notification_type; older ones only in
// the message.
function notificationKind(input) {
    if (input.notification_type) return input.notification_type;
    const m = String(input.message || '');
    if (/permission/i.test(m)) return 'permission_prompt';
    if (/waiting for your input/i.test(m)) return 'idle_prompt';
    return 'other';
}

const handlers = {
    'session-start'(store, s, input) {
        if (input.session_id && input.session_id !== s.tool_session) store.updateSession(s.id, { tool_session: input.session_id });
        // A resumed or cleared conversation waits for the user; a new one starts on its prompt, and a
        // compaction happens mid-work.
        store.setSessionStatus(s.id, ['resume', 'clear'].includes(input.source) ? 'idle' : 'busy');
        const text = deliver(store, s);
        if (text) process.stdout.write(text + '\n');
    },

    prompt(store, s) {
        store.updateSession(s.id, { stop_blocks: 0 });
        store.setSessionStatus(s.id, 'busy');
        const text = deliver(store, s);
        if (text) process.stdout.write(text + '\n');
    },

    'pre-tool'(store, s, input) {
        const file = taskFile(store, input);
        if (file) store.addIntent(file);
    },

    'post-tool'(store, s, input) {
        store.setSessionStatus(s.id, 'busy'); // also the end of a permission prompt the user answered
        const file = taskFile(store, input);
        if (file) {
            store.sync();
            store.clearIntent(file);
        }
        if (!hasActionable(store, s)) return;
        const text = deliver(store, s);
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }) + '\n');
    },

    // Something the agent must act on keeps it going, a few times in a row at most; otherwise it is idle.
    stop(store, s) {
        if (s.stop_blocks < MAX_STOP_BLOCKS && hasActionable(store, s)) {
            store.updateSession(s.id, { stop_blocks: s.stop_blocks + 1 });
            const text = deliver(store, s);
            process.stdout.write(JSON.stringify({ decision: 'block', reason: `${text}\nAct on these, then carry on or stop.` }) + '\n');
            return;
        }
        store.setSessionStatus(s.id, 'idle');
    },

    notification(store, s, input) {
        const kind = notificationKind(input);
        if (kind === 'permission_prompt' || kind === 'elicitation_dialog') {
            store.setSessionStatus(s.id, 'waiting', { reason: String(input.message || 'Waiting for permission').slice(0, 200) });
        } else if (kind === 'idle_prompt') {
            store.setSessionStatus(s.id, 'idle');
        }
    },
};

function run(event, { home, session }) {
    const handler = handlers[event];
    if (!handler) {
        console.error(`kanban hook: unknown event "${event}".`);
        return;
    }
    const input = readInput();
    // Most tool calls are not about task files; those leave without opening the database.
    if (event === 'pre-tool') {
        const file = input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path);
        if (!file || !path.resolve(input.cwd || process.cwd(), file).startsWith(path.join(path.resolve(home), 'tasks') + path.sep)) return;
    }
    let store;
    try {
        store = new Store(home);
        const s = store.sessionOf(session);
        store.actor = `agent:${s.name}`;
        store.session = s.id;
        handler(store, s, input);
    } catch (e) {
        console.error(`kanban hook ${event}: ${e.message}`);
    } finally {
        if (store) store.close();
    }
}

module.exports = { run, notificationKind };
