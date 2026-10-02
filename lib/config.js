'use strict';

// Settings for agent sessions: which terminal tools ("profiles") the board can launch, how to start them,
// and where task worktrees go. Built-in defaults are merged with kanban.config.json in the tracker's home,
// which is optional and meant to be committed. Prompts are templates in prompts/: the home's own copy of a
// prompt wins over the one shipped with the tool.
//
// A profile is only ever chosen by name. Commands and arguments come from this file, never from a request.

const fs = require('node:fs');
const path = require('node:path');
const { KanbanError } = require('./store');

const TOOL_PROMPTS = path.join(__dirname, '..', 'prompts');

const DEFAULTS = {
    defaultProfile: 'claude',
    worktrees: {
        dir: '../{{repo}}-worktrees', // relative to the repository root
        branch: 'kanban/{{task.id}}-{{task.slug}}',
        base: 'HEAD',
        setup: null,                   // a shell command run in a new worktree (npm install, copying .env, ...)
    },
    nudge: { cooldownMs: 30000, quietAfterTypingMs: 15000 },
    profiles: {
        claude: {
            label: 'Claude Code',
            command: 'claude',
            args: ['--name', '{{session.name}}', '--add-dir', '{{home}}', '--settings', '{{claudeSettings}}',
                '--append-system-prompt', '{{system}}'],
            startArgs: ['--session-id', '{{toolSession}}'],
            resumeArgs: ['--resume', '{{toolSession}}'],
            prompt: 'argv',       // argv: last argument; type: typed in once started; none
            systemPrompt: 'argv', // argv: through args ({{system}}); prepend: put before the prompt; none
            hooks: 'claude',
            idle: 'hooks',        // hooks: the tool reports itself; quiet: judged by terminal output; none
            quietMs: 8000,
            waitingPatterns: ['Do you want to', 'trust this folder', 'Enter to confirm', '❯ \\d+\\. Yes'],
            nudge: '[kanban] You have new board events.',
        },
        codex: {
            label: 'Codex CLI',
            command: 'codex',
            args: [],
            prompt: 'argv',
            systemPrompt: 'prepend',
            idle: 'quiet',
            quietMs: 5000,
            waitingPatterns: ['\\(y/n\\)', 'Allow .*\\?', 'Approve', 'Press Enter'],
            nudge: 'You have new kanban events. Run `kanban inbox` and act on them.',
        },
        shell: {
            label: 'Shell',
            command: '{{env.SHELL}}',
            args: [],
            prompt: 'none',
            systemPrompt: 'none',
            idle: 'quiet',
            quietMs: 3000,
            waitingPatterns: ['\\(y/n\\)', '\\[y/N\\]', '\\[Y/n\\]', 'Continue\\?', 'Password:'],
            nudge: null,
        },
    },
};

const PROFILE_DEFAULTS = {
    args: [], startArgs: [], resumeArgs: null, env: {}, prompt: 'argv', systemPrompt: 'none',
    hooks: null, idle: 'quiet', quietMs: 5000, waitingPatterns: [], nudge: null, typeDelayMs: 1500,
};

function load(home) {
    const file = path.join(home, 'kanban.config.json');
    let own = {};
    if (fs.existsSync(file)) {
        try {
            own = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            throw new KanbanError(`${file} is not valid JSON: ${e.message}`);
        }
    }
    const profiles = {};
    for (const [name, p] of Object.entries({ ...DEFAULTS.profiles, ...(own.profiles || {}) })) {
        if (p === null) continue; // a home can switch a built-in profile off
        const merged = { ...PROFILE_DEFAULTS, ...(DEFAULTS.profiles[name] || {}), ...((own.profiles || {})[name] || {}), name };
        if (typeof merged.command !== 'string' || !Array.isArray(merged.args)) {
            throw new KanbanError(`Profile "${name}" in kanban.config.json needs a "command" string and an "args" list.`);
        }
        profiles[name] = merged;
    }
    return {
        defaultProfile: own.defaultProfile || DEFAULTS.defaultProfile,
        worktrees: { ...DEFAULTS.worktrees, ...(own.worktrees || {}) },
        nudge: { ...DEFAULTS.nudge, ...(own.nudge || {}) },
        profiles,
    };
}

function profile(config, name) {
    const p = config.profiles[name || config.defaultProfile];
    if (!p) throw new KanbanError(`No profile "${name}". Profiles are: ${Object.keys(config.profiles).join(', ')}.`, 404);
    return p;
}

function promptText(home, name) {
    for (const dir of [path.join(home, 'prompts'), TOOL_PROMPTS]) {
        const file = path.join(dir, `${name}.md`);
        if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    }
    return '';
}

// Fills {{name}} and {{a.b}} from vars. Unknown placeholders are left as they are, so a stray pair of
// braces in a prompt survives.
function render(text, vars) {
    return String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key) => {
        let v = vars;
        for (const part of key.split('.')) v = v == null ? undefined : v[part];
        return v == null || typeof v === 'object' ? whole : String(v);
    });
}

module.exports = { load, profile, promptText, render, DEFAULTS };
