#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Store, KanbanError, PRIORITIES, TYPES } = require('./lib/store');

const HELP = `kanban - feature tracker

Tasks are markdown files in tasks/; status and metadata live in kanban.db, which is
kept in kanban.jsonl for git.
A task is referred to by its number (12 or #12) or its file name (or the start of one).

Board
  kanban [board]                     Every column and its tasks
  kanban list [filters] [--json]     One line per task
      --status <col> --tag <tag> --type <type> --priority <p> --search <text>
      --all                          include archived tasks
      --missing                      include tasks whose files are gone
  kanban show <task> [--json]        Metadata and the markdown
  kanban history <task>              What changed and when
  kanban tags [--json]               Tags in use

Tasks
  kanban add <title> [--status <col>] [--priority <p>] [--type <type>] [--tags a,b]
                     [--body <markdown>] [--edit]
  kanban edit <task>                 Open the file in $VISUAL / $EDITOR
  kanban path <task>                 Print the file's path
  kanban move <task> <col> [--top | --at <n>]
  kanban start <task>                Move from a queue column to the first active one
  kanban done <task>                 Move to the first done column
  kanban set <task> [--title <t>] [--priority <p>] [--type <type>]
                    [--tags a,b] [--tag +a,-b]
  kanban archive <task> / unarchive <task>
  kanban rm <task> [--keep-file]

Columns
  kanban columns [--json]
  kanban column add <key> [--label <l>] [--kind queue|active|done] [--wip <n>] [--after <col>]
  kanban column set <key> [--label <l>] [--kind <k>] [--wip <n|0>] [--rename <key>] [--position <n>]
  kanban column rm <key> [--to <col>]

Housekeeping
  kanban sync                        Reconcile kanban.db with tasks/ and report
  kanban prune                       Forget tasks whose files have been deleted
  kanban export [--stage]            Bring kanban.jsonl up to date (--stage: and git add it)
  kanban import                      Rebuild kanban.db from kanban.jsonl
  kanban git-setup                   Install the pre-commit hook and the kanban.jsonl merge driver
  kanban serve [--port 4477] [--open]   The graphical board in a browser

  Priorities: ${PRIORITIES.join(', ')}
  Types:      ${TYPES.join(', ')}
  --home <dir> (or KANBAN_HOME) uses another tracker directory.`;

const BOOLEAN = new Set(['json', 'all', 'edit', 'open', 'keep-file', 'top', 'help', 'missing', 'stage', 'quiet']);

function parseArgs(argv) {
    const pos = [], opts = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
        if (a === '-h') { opts.help = true; continue; }
        if (!a.startsWith('--')) { pos.push(a); continue; }
        const eq = a.indexOf('=');
        const key = a.slice(2, eq === -1 ? undefined : eq);
        if (eq !== -1) opts[key] = a.slice(eq + 1);
        else if (BOOLEAN.has(key)) opts[key] = true;
        else if (i + 1 < argv.length) opts[key] = argv[++i];
        else throw new KanbanError(`--${key} needs a value.`);
    }
    return { pos, opts };
}

/* ---------- output ---------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = code => s => useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s);
const c = {
    bold: sgr(1), dim: sgr(2), red: sgr(31), green: sgr(32), yellow: sgr(33),
    blue: sgr(34), magenta: sgr(35), cyan: sgr(36), grey: sgr(90),
};

const PRIORITY_MARK = { urgent: c.red('!!'), high: c.yellow('! '), normal: '  ', low: c.grey('↓ ') };
const TYPE_COLOR = { feature: c.cyan, bug: c.red, content: c.magenta, chore: c.grey, idea: c.yellow };

function taskLine(t, { showStatus = false } = {}) {
    const parts = [
        c.grey(`#${String(t.id).padEnd(3)}`),
        PRIORITY_MARK[t.priority] || '  ',
        t.archived ? c.dim(t.title) : t.title,
        (TYPE_COLOR[t.type] || (s => s))(t.type),
    ];
    if (showStatus) parts.push(c.blue(`[${t.status}]`));
    if (t.checks_total) parts.push((t.checks_done === t.checks_total ? c.green : c.grey)(`${t.checks_done}/${t.checks_total}`));
    if (t.tags.length) parts.push(c.grey(t.tags.map(g => '#' + g).join(' ')));
    if (t.archived) parts.push(c.dim('(archived)'));
    if (t.missing) parts.push(c.red('(file missing)'));
    return parts.join(' ');
}

function printBoard(store, filters) {
    const tasks = store.list(filters);
    for (const col of store.columns()) {
        const mine = tasks.filter(t => t.status === col.key);
        const over = col.wip_limit && col.count > col.wip_limit;
        const limit = col.wip_limit ? `/${col.wip_limit}` : '';
        const count = `(${col.count}${limit})`;
        console.log(`${c.bold(col.label)} ${over ? c.red(count + ' over limit') : c.grey(count)} ${c.grey(col.key)}`);
        if (!mine.length) console.log(c.grey('  -'));
        for (const t of mine) console.log('  ' + taskLine(t));
        console.log();
    }
}

function printReport(report) {
    const lines = [];
    const ids = a => a.map(id => '#' + id).join(', ');
    if (report.added.length) lines.push(`Added ${ids(report.added)} from new files.`);
    if (report.renamed.length) lines.push(`Followed renamed file(s) for ${ids(report.renamed)}.`);
    if (report.updated.length) lines.push(`Picked up edits to ${ids(report.updated)}.`);
    if (report.restored.length) lines.push(`Files are back for ${ids(report.restored)}.`);
    if (report.missing.length) lines.push(c.yellow(`Files have gone for ${ids(report.missing)}; \`kanban prune\` forgets them.`));
    if (report.imported) lines.unshift('Loaded the board from kanban.jsonl, which had changed.');
    report.notices.forEach(n => lines.push(c.yellow(n)));
    return lines;
}

function json(value) {
    console.log(JSON.stringify(value, null, 2));
}

function when(iso) {
    return iso ? iso.replace('T', ' ').slice(0, 16) : '-';
}

function openInEditor(file) {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    const r = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
    if (r.status !== 0) throw new KanbanError(`${editor} exited with status ${r.status}.`);
}

/* ---------- commands ---------- */

function tagEdits(spec) {
    const add = [], remove = [];
    for (const raw of String(spec).split(',')) {
        const t = raw.trim();
        if (!t) continue;
        if (t.startsWith('-')) remove.push(t.slice(1));
        else add.push(t.replace(/^\+/, ''));
    }
    return { addTags: add, removeTags: remove };
}

function wip(value) {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new KanbanError('--wip is a whole number (0 for no limit).');
    return n || null;
}

function firstOfKind(store, kind) {
    const col = store.columns().find(c => c.kind === kind);
    if (!col) throw new KanbanError(`There is no ${kind} column.`);
    return col.key;
}

function need(value, what) {
    if (value === undefined) throw new KanbanError(`Missing ${what}. See \`kanban help\`.`);
    return value;
}

const commands = {
    board(store, pos, opts) {
        printBoard(store, { tag: opts.tag, type: opts.type, priority: opts.priority, search: opts.search, archived: opts.all });
    },

    list(store, pos, opts) {
        const tasks = store.list({
            status: opts.status, tag: opts.tag, type: opts.type, priority: opts.priority,
            search: opts.search, archived: opts.all, missing: opts.missing,
        });
        if (opts.json) return json(tasks);
        if (!tasks.length) return console.log(c.grey('No tasks.'));
        tasks.forEach(t => console.log(taskLine(t, { showStatus: true })));
    },

    show(store, [ref], opts) {
        const t = store.get(need(ref, 'a task'));
        if (opts.json) return json(t);
        const col = store.column(t.status);
        console.log(c.bold(`#${t.id} ${t.title}`));
        console.log(c.grey(t.path));
        console.log(`${c.grey('status')}   ${col.label} ${c.grey(`(${col.key})`)}${t.archived ? c.dim(' archived') : ''}`);
        console.log(`${c.grey('priority')} ${t.priority}    ${c.grey('type')} ${t.type}`);
        if (t.tags.length) console.log(`${c.grey('tags')}     ${t.tags.join(', ')}`);
        if (t.checks_total) console.log(`${c.grey('checks')}   ${t.checks_done}/${t.checks_total}`);
        console.log(c.grey(`created ${when(t.created_at)}  updated ${when(t.updated_at)}  started ${when(t.started_at)}  done ${when(t.completed_at)}`));
        console.log();
        console.log(t.missing ? c.red('(the file is missing)') : t.body.trimEnd());
    },

    history(store, [ref]) {
        const t = store.get(need(ref, 'a task'), { body: false });
        console.log(c.bold(`#${t.id} ${t.title}`));
        for (const h of store.history(t.id)) {
            const change = h.old == null ? `→ ${h.new}` : `${h.old} → ${h.new ?? ''}`;
            console.log(`  ${c.grey(when(h.at))}  ${h.field.padEnd(8)} ${change}`);
        }
    },

    tags(store, pos, opts) {
        const tags = store.tags();
        if (opts.json) return json(tags);
        if (!tags.length) return console.log(c.grey('No tags.'));
        tags.forEach(t => console.log(`${t.tag} ${c.grey(t.count)}`));
    },

    add(store, pos, opts) {
        const title = need(pos.join(' ').trim() || undefined, 'a title');
        // Allowed, since two tasks can share a name, but usually it means the task already exists.
        const same = store.list({ archived: true }).filter(t => t.title.toLowerCase() === title.toLowerCase());
        if (same.length) {
            console.error(c.yellow(`${same.map(t => `#${t.id} [${t.status}]`).join(', ')} already has this title; adding anyway.`));
        }
        const id = store.add(title, {
            status: opts.status, priority: opts.priority, type: opts.type, tags: opts.tags, body: opts.body,
        });
        const t = store.get(id, { body: false });
        console.log(`Added ${taskLine(t)}\n  ${c.grey(t.path)}`);
        if (opts.edit) {
            openInEditor(t.path);
            store.sync();
        }
    },

    edit(store, [ref]) {
        const t = store.get(need(ref, 'a task'), { body: false });
        if (t.missing) throw new KanbanError(`${t.file} is missing.`);
        openInEditor(t.path);
        store.sync();
    },

    path(store, [ref]) {
        console.log(store.get(need(ref, 'a task'), { body: false }).path);
    },

    move(store, [ref, status], opts) {
        need(ref, 'a task');
        need(status, 'a column');
        const index = opts.top ? 0 : opts.at !== undefined ? Number(opts.at) - 1 : undefined;
        const id = store.move(ref, status, index);
        report(store, id, status);
    },

    // Starts work on a task that hasn't begun. One already under way or finished stays where it is: moving
    // it back is a decision (rework), made with `move`, not a side effect of saying "start".
    start(store, [ref]) {
        const status = firstOfKind(store, 'active');
        const t = store.get(need(ref, 'a task'), { body: false });
        const col = store.column(t.status);
        if (t.status === status) {
            console.log(`#${t.id} is already in ${col.label}.`);
            return;
        }
        if (col.kind !== 'queue') {
            console.log(`#${t.id} is already in ${col.label}; left it there. To move it back: kanban move ${t.id} ${status}`);
            return;
        }
        report(store, store.move(t.id, status), status);
    },

    done(store, [ref]) {
        const status = firstOfKind(store, 'done');
        report(store, store.move(need(ref, 'a task'), status), status);
    },

    set(store, [ref], opts) {
        const changes = {
            title: opts.title, priority: opts.priority, type: opts.type,
            tags: opts.tags, ...(opts.tag !== undefined ? tagEdits(opts.tag) : {}),
        };
        const id = store.update(need(ref, 'a task'), changes);
        console.log(taskLine(store.get(id, { body: false })));
    },

    archive(store, [ref]) {
        const id = store.update(need(ref, 'a task'), { archived: true });
        console.log(`Archived #${id}.`);
    },

    unarchive(store, [ref]) {
        const id = store.update(need(ref, 'a task'), { archived: false });
        console.log(`Unarchived #${id}.`);
    },

    rm(store, [ref], opts) {
        const { id, file } = store.remove(need(ref, 'a task'), { keepFile: opts['keep-file'] });
        console.log(opts['keep-file'] ? `Removed #${id}; kept ${file}.` : `Removed #${id} and deleted ${file}.`);
        if (opts['keep-file']) console.log(c.yellow(`It will come back as a new task on the next sync unless you move or delete ${file}.`));
    },

    columns(store, pos, opts) {
        const cols = store.columns();
        if (opts.json) return json(cols);
        for (const col of cols) {
            const limit = col.wip_limit ? `  wip ${col.wip_limit}` : '';
            console.log(`${col.key.padEnd(12)} ${col.label.padEnd(16)} ${c.grey(col.kind.padEnd(6))} ${c.grey(col.count + ' task(s)')}${c.grey(limit)}`);
        }
    },

    column(store, [action, key], opts) {
        need(action, 'add, set or rm');
        need(key, 'a column key');
        if (action === 'add') {
            store.addColumn(key, { label: opts.label, kind: opts.kind, wip_limit: wip(opts.wip) ?? null, after: opts.after });
        } else if (action === 'set') {
            store.updateColumn(key, {
                label: opts.label, kind: opts.kind, wip_limit: wip(opts.wip), rename: opts.rename,
                position: opts.position !== undefined ? Number(opts.position) - 1 : undefined,
            });
        } else if (action === 'rm') {
            store.removeColumn(key, { moveTo: opts.to });
        } else {
            throw new KanbanError(`Unknown column action "${action}"; it is add, set or rm.`);
        }
        commands.columns(store, [], {});
    },

    sync(store, pos, opts, syncReport) {
        const lines = printReport(syncReport);
        console.log(lines.length ? lines.join('\n') : 'kanban.db and tasks/ agree.');
    },

    prune(store) {
        const gone = store.prune();
        console.log(gone.length ? `Forgot ${gone.map(r => `#${r.id} (${r.file})`).join(', ')}.` : 'Nothing to prune.');
    },

    export(store, pos, opts, syncReport) {
        // The store's own transaction has already written kanban.jsonl; this only reports and stages it.
        if (opts.stage) {
            const r = spawnSync('git', ['add', '--', path.basename(store.exportPath)], { cwd: store.home, stdio: 'inherit' });
            if (r.status !== 0) throw new KanbanError('git add kanban.jsonl failed.');
        }
        if (!opts.quiet) console.log(`${store.exportPath} is up to date.`);
    },

    import(store) {
        store.tx(() => store.importIfChanged(true));
        printBoard(store, {});
        console.log(c.grey('Rebuilt kanban.db from kanban.jsonl.'));
    },

    'git-setup'(store) {
        const git = (...args) => {
            const r = spawnSync('git', args, { cwd: store.home, encoding: 'utf8' });
            if (r.status !== 0) throw new KanbanError(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
            return r.stdout.trim();
        };
        const root = git('rev-parse', '--show-toplevel');
        const hooks = path.resolve(store.home, git('rev-parse', '--git-path', 'hooks')); // relative to where git ran
        const script = path.relative(root, path.join(__dirname, 'kanban.js')).split(path.sep).join('/');
        const home = path.relative(root, store.home).split(path.sep).join('/');

        // Git runs hooks and merge drivers from the top of the work tree, so repo-relative paths hold.
        const block = [
            '# >>> kanban',
            `# Brings ${home}/kanban.jsonl, the committed form of kanban.db, up to date and stages it.`,
            '# It stops the commit only when the board cannot be read (for example, conflict markers left in kanban.jsonl).',
            'if command -v node >/dev/null 2>&1; then',
            `    node "${script}" export --stage --quiet || { echo "kanban: fix the problem above, or commit with --no-verify" >&2; exit 1; }`,
            'else',
            '    echo "kanban: node not found; kanban.jsonl was not refreshed" >&2',
            'fi',
            '# <<< kanban',
        ].join('\n');
        const hook = path.join(hooks, 'pre-commit');
        fs.mkdirSync(hooks, { recursive: true });
        if (fs.existsSync(hook)) {
            const text = fs.readFileSync(hook, 'utf8');
            if (/# >>> kanban[\s\S]*# <<< kanban/.test(text)) {
                fs.writeFileSync(hook, text.replace(/# >>> kanban[\s\S]*# <<< kanban/, block));
                console.log(`Updated the kanban block in ${hook}.`);
            } else {
                console.log(c.yellow(`${hook} already exists and is not kanban's. Add this to it yourself:\n`));
                console.log(block);
            }
        } else {
            fs.writeFileSync(hook, `#!/bin/sh\n${block}\n`);
            console.log(`Installed ${hook}.`);
        }
        if (fs.existsSync(hook)) fs.chmodSync(hook, 0o755);

        git('config', 'merge.kanban.name', 'kanban.jsonl record-by-record merge');
        git('config', 'merge.kanban.driver', `node "${script}" merge-driver %O %A %B %P`);
        console.log('Registered the kanban merge driver (used by .gitattributes for kanban.jsonl).');
    },

    serve(store, pos, opts) {
        const { serve } = require('./lib/server');
        serve(store, { port: opts.port ? Number(opts.port) : 4477, open: opts.open });
    },
};

commands.ls = commands.list;
commands.new = commands.add;
commands.mv = commands.move;
commands.cat = commands.show;

function report(store, id, status) {
    const t = store.get(id, { body: false });
    const col = store.columns().find(col => col.key === status);
    console.log(`${taskLine(t)} → ${c.bold(col.label)}`);
    if (col.wip_limit && col.count > col.wip_limit) {
        console.log(c.yellow(`${col.label} now has ${col.count} tasks against a limit of ${col.wip_limit}.`));
    }
}

// Git's merge driver for kanban.jsonl: merges task by task instead of line by line, writes the result over
// ours, and says what it decided. It never needs the database.
function mergeDriver([base, ours, theirs, name = 'kanban.jsonl']) {
    const { merge } = require('./lib/exportfile');
    const read = f => (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    try {
        const { text, notes } = merge(read(base), read(ours), read(theirs));
        fs.writeFileSync(ours, text);
        notes.forEach(n => console.error(`kanban merge (${name}): ${n}`));
    } catch (e) {
        console.error(`kanban merge (${name}): ${e.message}`);
        process.exit(1); // git then treats it as a conflict and leaves ours in place
    }
}

function main() {
    const { pos, opts } = parseArgs(process.argv.slice(2));
    const name = pos.shift() || 'board';
    if (opts.help || name === 'help') return console.log(HELP);
    if (name === 'merge-driver') return mergeDriver(pos);
    const command = commands[name];
    if (!command) throw new KanbanError(`Unknown command "${name}". See \`kanban help\`.`);

    const store = new Store(opts.home || process.env.KANBAN_HOME || __dirname);
    const syncReport = store.sync();
    if (name !== 'sync' && name !== 'import' && !opts.json && !opts.quiet) {
        const lines = printReport(syncReport);
        if (lines.length) console.error(c.grey(lines.join('\n')));
    }
    command(store, pos, opts, syncReport);
    if (name !== 'serve') store.close();
}

try {
    main();
} catch (e) {
    if (!(e instanceof KanbanError)) throw e;
    console.error(c.red(e.message));
    process.exit(1);
}
