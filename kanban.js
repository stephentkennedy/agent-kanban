#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Store, KanbanError, PRIORITIES, TYPES } = require('./lib/store');
const { describe } = require('./lib/describe');

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
                          [--sort manual|attention]
  kanban column rm <key> [--to <col>]

Agents
  kanban whoami [--json]             Who this command acts as, and its session, task and worktree
  kanban claim <task> [--force]      Mark a task as yours / kanban release <task> [--force]
  kanban post <task> <message>       A note on a task, for its agent, the orchestrator and the board
  kanban send <session> <message>    A message to one session (a name, orchestrator, or task:<n>)
  kanban inbox [--peek] [--wait <s>] [--json]   Your session's new events (marks them read)
  kanban subscribe <task|board> [--types a.,b]  / unsubscribe <task|board> / subscriptions
  kanban events [--task <t>] [--after <id>] [--follow] [--json]   Everything that happened
  kanban profiles [--json]           The terminal tools sessions can run (kanban.config.json)

Sessions (each runs in tmux; a task session gets its own git worktree and branch)
  kanban session list [--all] [--attention] [--json]
  kanban session spawn <task> [--profile <p>] [--force]
  kanban session spawn --orchestrator [--profile <p>]
  kanban session attach <s> [--ro]   Open it in this terminal (detach: close the terminal)
  kanban session peek <s> [--lines <n>]   Print what is on its screen
  kanban session send <s> <text> [--no-enter]
  kanban session nudge <s>           Type the profile's reminder to check the inbox
  kanban session resume <s>
  kanban session kill <s> [--worktree keep|remove|force]

Housekeeping
  kanban sync                        Reconcile kanban.db with tasks/ and report
  kanban prune                       Forget tasks whose files have been deleted
  kanban export [--stage]            Bring kanban.jsonl up to date (--stage: and git add it)
  kanban import                      Rebuild kanban.db from kanban.jsonl
  kanban git-setup                   Install the pre-commit hook and the kanban.jsonl merge driver
  kanban serve [--port 4477] [--open]   The graphical board in a browser

  Priorities: ${PRIORITIES.join(', ')}
  Types:      ${TYPES.join(', ')}
  --home <dir> (or KANBAN_HOME) uses another tracker directory.
  Changes are recorded as made by "cli", or by the session in KANBAN_SESSION, or by KANBAN_ACTOR.`;

const BOOLEAN = new Set(['json', 'all', 'edit', 'open', 'keep-file', 'top', 'help', 'missing', 'stage', 'quiet',
    'peek', 'follow', 'orchestrator', 'force', 'no-enter', 'attention', 'resume', 'ro']);

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
            console.log(`  ${c.grey(when(h.at))}  ${h.field.padEnd(8)} ${change}${h.actor ? c.grey(`  (${h.actor})`) : ''}`);
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
            return claimIfAgent(store, t.id);
        }
        if (col.kind !== 'queue') {
            console.log(`#${t.id} is already in ${col.label}; left it there. To move it back: kanban move ${t.id} ${status}`);
        } else {
            report(store, store.move(t.id, status), status);
        }
        claimIfAgent(store, t.id);
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
            const sort = col.sort !== 'manual' ? `  sort ${col.sort}` : '';
            console.log(`${col.key.padEnd(12)} ${col.label.padEnd(16)} ${c.grey(col.kind.padEnd(6))} ${c.grey(col.count + ' task(s)')}${c.grey(limit + sort)}`);
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
                position: opts.position !== undefined ? Number(opts.position) - 1 : undefined, sort: opts.sort,
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
            // Committing in another checkout (an agent's worktree) must not stage this one's kanban.jsonl.
            const top = dir => spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
            if (top(process.cwd()) !== top(store.home)) {
                if (!opts.quiet) console.log(`${store.exportPath} belongs to another checkout; not staging it.`);
                return;
            }
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
            '# A checkout without kanban.jsonl (a kanban agent\'s worktree leaves the tracker\'s files out) is skipped,',
            '# and KANBAN_HOME is cleared so an agent\'s session never stages the main checkout\'s board.',
            `if [ ! -f "${home ? home + '/' : ''}kanban.jsonl" ]; then`,
            '    :',
            'elif command -v node >/dev/null 2>&1; then',
            `    KANBAN_HOME= KANBAN_SESSION= node "${script}" export --stage --quiet || { echo "kanban: fix the problem above, or commit with --no-verify" >&2; exit 1; }`,
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

    /* ---------- agents ---------- */

    whoami(store, pos, opts) {
        const s = store.session != null ? store.sessionOf(store.session) : null;
        const info = {
            actor: store.actor, home: store.home,
            session: s && { id: s.id, name: s.name, role: s.role, profile: s.profile, status: s.status },
            task: s && s.task_id, worktree: s && s.worktree, branch: s && s.branch,
            claims: store.db.prepare('SELECT task_id FROM claims WHERE actor = ?').all(store.actor).map(r => r.task_id),
        };
        if (opts.json) return json(info);
        console.log(`${c.bold(info.actor)}  ${c.grey(store.home)}`);
        if (s) {
            console.log(`session  ${s.name} (${s.role}, ${s.profile}) ${statusText(s)}`);
            if (s.task_id != null) console.log(`task     #${s.task_id}  ${c.grey(store.get(s.task_id, { body: false }).path)}`);
            if (s.worktree) console.log(`worktree ${s.worktree}  ${c.grey('branch ' + s.branch)}`);
        }
        if (info.claims.length) console.log(`claims   ${info.claims.map(id => '#' + id).join(', ')}`);
    },

    claim(store, [ref], opts) {
        const claim = store.claim(need(ref, 'a task'), { force: opts.force });
        console.log(`#${claim.task_id} is claimed by ${claim.actor}.`);
    },

    release(store, [ref], opts) {
        const id = store.resolve(need(ref, 'a task'));
        console.log(store.release(id, { force: opts.force }) ? `Released #${id}.` : `#${id} was not claimed.`);
    },

    post(store, [ref, ...words]) {
        const id = store.resolve(need(ref, 'a task'));
        store.post(id, need(words.join(' ').trim() || undefined, 'a message'));
        console.log(`Posted on #${id}.`);
    },

    send(store, [ref, ...words]) {
        const target = store.sessionOf(need(ref, 'a session'));
        store.send(target.id, need(words.join(' ').trim() || undefined, 'a message'));
        console.log(`Sent to ${target.name}.`);
    },

    async inbox(store, pos, opts) {
        const s = mySession(store, opts);
        const read = () => store.inbox(s.id, { advance: !opts.peek, limit: opts.limit ? Number(opts.limit) : 50 });
        let events = read();
        for (const until = Date.now() + Number(opts.wait || 0) * 1000; !events.length && Date.now() < until;) {
            await new Promise(r => setTimeout(r, 1000));
            events = read();
        }
        if (opts.json) return json(events);
        if (!events.length) return console.log(c.grey('Nothing new.'));
        events.forEach(e => console.log((e.actionable ? c.yellow('! ') : '  ') + describe(e)));
    },

    subscribe(store, [target], opts) {
        const s = mySession(store, opts);
        const sub = store.subscribe(s.id, { task: need(target, 'a task or "board"'), types: opts.types });
        console.log(`${s.name} follows ${sub.task_id ? '#' + sub.task_id : 'the board'}${sub.types ? ` (${sub.types})` : ''}.`);
    },

    unsubscribe(store, [target], opts) {
        const s = mySession(store, opts);
        const n = store.unsubscribe(s.id, opts.id !== undefined ? { id: Number(opts.id) } : { task: need(target, 'a task or "board"') });
        console.log(n ? 'Unsubscribed.' : 'There was no such subscription.');
    },

    subscriptions(store, pos, opts) {
        const s = mySession(store, opts);
        const subs = store.subscriptions(s.id);
        if (opts.json) return json(subs);
        if (!subs.length) return console.log(c.grey('No subscriptions.'));
        subs.forEach(x => console.log(`${String(x.id).padEnd(4)} ${x.task_id ? '#' + x.task_id : 'board'}  ${c.grey(x.types || 'all events')}`));
    },

    async events(store, pos, opts) {
        let after = Number(opts.after || 0);
        const task = opts.task;
        const limit = Number(opts.limit || 50);
        const print = list => {
            if (opts.json) list.forEach(e => console.log(JSON.stringify(e)));
            else list.forEach(e => console.log(describe(e)));
            if (list.length) after = list[list.length - 1].id;
        };
        print(store.events({ after, task, limit, latest: !opts.after }));
        while (opts.follow) {
            await new Promise(r => setTimeout(r, 1000));
            print(store.events({ after, task, limit: 500 }));
        }
    },

    profiles(store, pos, opts) {
        const cfg = require('./lib/config').load(store.home);
        if (opts.json) return json(cfg.profiles);
        for (const p of Object.values(cfg.profiles)) {
            console.log(`${p.name.padEnd(10)} ${p.label || ''} ${c.grey(p.command)}${p.name === cfg.defaultProfile ? c.green('  (default)') : ''}`);
        }
    },

    session(store, [action, ref, ...rest], opts) {
        const sessions = require('./lib/sessions');
        const show = s => console.log(sessionLine(s));
        switch (action) {
            case undefined:
            case 'list':
            case 'ls': {
                let list = store.sessions({ live: !opts.all });
                if (opts.attention) list = list.filter(s => s.attention).sort(sessions.byAttention);
                if (opts.json) return json(list);
                if (!list.length) return console.log(c.grey(opts.all ? 'No sessions.' : 'No live sessions. --all shows ended ones.'));
                return list.forEach(show);
            }
            case 'spawn':
            case 'start': {
                const s = sessions.spawnSession(store, {
                    role: opts.orchestrator ? 'orchestrator' : 'task', task: ref, profile: opts.profile, force: opts.force,
                });
                show(s);
                if (s.worktree) console.log(c.grey(`  worktree ${s.worktree} on ${s.branch}`));
                return console.log(c.grey(`  kanban session attach ${s.name}   to open it here`));
            }
            case 'attach': {
                sessions.requireTmux();
                const s = store.sessionOf(need(ref, 'a session'));
                const [cmd, args] = sessions.attachCommand(store.home, s, { readOnly: opts.ro });
                const env = { ...process.env };
                delete env.TMUX;
                spawnSync(cmd, args, { stdio: 'inherit', env });
                return;
            }
            case 'peek':
                return console.log(sessions.peek(store, need(ref, 'a session'), { lines: opts.lines }));
            case 'send': {
                const s = sessions.send(store, need(ref, 'a session'), rest.join(' '), { enter: !opts['no-enter'] });
                return console.log(`Typed into ${s.name}.`);
            }
            case 'nudge':
                return console.log(`Nudged ${sessions.nudge(store, need(ref, 'a session')).name}.`);
            case 'resume':
            case 'restart':
                return show(sessions.resume(store, need(ref, 'a session')));
            case 'kill':
            case 'stop': {
                const s = sessions.kill(store, need(ref, 'a session'), { worktree: opts.worktree || 'keep' });
                show(s);
                if (s.worktreeRemoved) console.log(c.grey(`  removed ${s.worktree}`));
                return;
            }
            default:
                throw new KanbanError(`Unknown session action "${action}". See \`kanban help\`.`);
        }
    },
};

function statusText(s) {
    const color = { busy: c.cyan, idle: c.yellow, waiting: c.red, exited: c.grey, lost: c.red, starting: c.grey }[s.status] || (x => x);
    const label = s.status === 'waiting' ? 'needs input' : s.status === 'exited' && s.exit_code ? `exited ${s.exit_code}` : s.status;
    return color(label);
}

function sessionLine(s) {
    const task = s.task_id != null ? `#${s.task_id}` : s.role;
    const since = s.attention_since ? c.grey(` since ${when(s.attention_since)}`) : '';
    return `${s.name.padEnd(18)} ${statusText(s).padEnd(useColor ? 21 : 12)} ${task.padEnd(13)} ${c.grey(s.profile)}${since}`
        + (s.status_reason ? c.grey(`\n${' '.repeat(19)}${s.status_reason}`) : '');
}

// The session a command such as inbox acts for: --session, or the one this command runs in.
function mySession(store, opts) {
    if (opts.session !== undefined) return store.sessionOf(opts.session);
    if (store.session != null) return store.sessionOf(store.session);
    throw new KanbanError('That belongs to a session: run it inside one the board started, or pass --session <name>.');
}

function claimIfAgent(store, id) {
    if (!store.actor.startsWith('agent:')) return;
    try {
        store.claim(id);
    } catch (e) {
        if (!(e instanceof KanbanError)) throw e;
        console.error(c.yellow(e.message));
    }
}

// Who a command acts as: the session the board started it in, or KANBAN_ACTOR, or "cli".
function identify(store) {
    if (process.env.KANBAN_SESSION) {
        try {
            const s = store.sessionOf(process.env.KANBAN_SESSION);
            store.actor = `agent:${s.name}`;
            store.session = s.id;
            return;
        } catch { /* a session from another tracker, or one that has been forgotten */ }
    }
    const actor = process.env.KANBAN_ACTOR;
    if (actor && /^[\w.:@-]{1,80}$/.test(actor)) store.actor = actor;
}

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
    const home = opts.home || process.env.KANBAN_HOME || __dirname;
    // Hooks run on every tool call of an agent, and the launcher runs for a session's whole life: neither
    // syncs the board first.
    if (name === 'hook') return require('./lib/hooks').run(pos[0], { home, session: opts.session });
    if (name === 'session' && pos[0] === 'exec') return require('./lib/sessions').exec(new Store(home), need(pos[1], 'a session id'), { resume: opts.resume });
    const command = commands[name];
    if (!command) throw new KanbanError(`Unknown command "${name}". See \`kanban help\`.`);

    const store = new Store(home);
    identify(store);
    const syncReport = store.sync();
    if (name !== 'sync' && name !== 'import' && !opts.json && !opts.quiet) {
        const lines = printReport(syncReport);
        if (lines.length) console.error(c.grey(lines.join('\n')));
    }
    const result = command(store, pos, opts, syncReport);
    if (result && result.then) return result.then(() => store.close());
    if (name !== 'serve') store.close();
}

function fatal(e) {
    if (!(e instanceof KanbanError)) throw e;
    console.error(c.red(e.message));
    process.exit(1);
}

try {
    const result = main();
    if (result && result.catch) result.catch(fatal);
} catch (e) {
    fatal(e);
}
