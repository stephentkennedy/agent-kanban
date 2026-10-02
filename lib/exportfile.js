'use strict';

// kanban.jsonl: the committed, text form of kanban.db. kanban.db itself is not committed.
//
// One JSON object per line: a header, then the columns in board order, then the tasks by id. A task's tags
// and history ride on its own line, so a change to one task touches one line, and git (or the merge
// driver below) can merge two branches that changed different tasks.
//
// A task's position is a number that orders it within its column. Moving a task gives it a number between
// its new neighbours, so a move rewrites only the moved task's line.

const VERSION = 1;
const HEADER = { kanban: VERSION, note: 'Generated from kanban.db; kanban reloads it when it changes. Tasks are in tasks/.' };

// Canonical key order for a task line. Fields at their default are left out to keep lines short.
const TASK_FIELDS = ['id', 'file', 'title', 'status', 'position', 'priority', 'type', 'tags', 'archived', 'missing',
    'created', 'updated', 'started', 'completed', 'history'];
const TASK_DEFAULTS = { priority: 'normal', type: 'feature', tags: [], archived: false, missing: false, started: null, completed: null, history: [] };

class ExportError extends Error {}

function isDefault(key, value) {
    if (!(key in TASK_DEFAULTS)) return false;
    const d = TASK_DEFAULTS[key];
    return Array.isArray(d) ? Array.isArray(value) && value.length === 0 : value === d || value === undefined;
}

function format({ columns, tasks }) {
    const lines = [JSON.stringify(HEADER)];
    for (const c of columns) {
        lines.push(JSON.stringify({ column: c.key, label: c.label, kind: c.kind, wip: c.wip ?? null }));
    }
    for (const t of [...tasks].sort((a, b) => a.id - b.id)) {
        const out = {};
        for (const k of TASK_FIELDS) if (t[k] !== undefined && !isDefault(k, t[k])) out[k] = t[k];
        lines.push(JSON.stringify(out));
    }
    return lines.join('\n') + '\n';
}

function parse(text, name = 'kanban.jsonl') {
    const columns = [], tasks = [];
    const lines = String(text).split(/\r?\n/);
    lines.forEach((line, i) => {
        const where = `${name} line ${i + 1}`;
        if (!line.trim()) return;
        if (/^(<{7}|={7}|>{7}|\|{7})( |$)/.test(line)) {
            throw new ExportError(`${where} is a git conflict marker. Resolve the conflict in ${name} (keep both sides' lines), then run kanban again.`);
        }
        let rec;
        try { rec = JSON.parse(line); } catch { throw new ExportError(`${where} is not valid JSON.`); }
        if (rec.kanban !== undefined) {
            if (rec.kanban > VERSION) throw new ExportError(`${name} is format ${rec.kanban}; this kanban reads up to ${VERSION}. Update the tool.`);
            return;
        }
        if (typeof rec.column === 'string') {
            columns.push({ key: rec.column, label: rec.label || rec.column, kind: rec.kind || 'queue', wip: rec.wip ?? null });
            return;
        }
        if (Number.isInteger(rec.id) && typeof rec.file === 'string' && typeof rec.status === 'string') {
            const t = {};
            for (const k of TASK_FIELDS) t[k] = rec[k] !== undefined ? rec[k] : (k in TASK_DEFAULTS ? structuredClone(TASK_DEFAULTS[k]) : null);
            Object.defineProperty(t, 'line', { value: i + 1 }); // for messages; not part of the record
            tasks.push(t);
            return;
        }
        throw new ExportError(`${where} is neither a column nor a task.`);
    });
    return { columns, tasks };
}

/* ---------- three-way merge (the git merge driver) ---------- */

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Fields that change together: a move sets status and position, and done-ness follows status.
const GROUPS = [['status', 'position', 'completed'], ['title', 'file']];

// Merges one task that both sides kept. A field only one side changed takes that side's value. When both
// changed it differently, the side whose task was updated later wins, and the clash is reported.
function mergeTask(o, a, b, notes) {
    const later = (b.updated || '') > (a.updated || '') ? b : a;
    const out = { ...a };
    const grouped = new Set(GROUPS.flat());
    const units = [...GROUPS, ...TASK_FIELDS.filter(k => !grouped.has(k) && !['id', 'tags', 'history', 'updated', 'started'].includes(k)).map(k => [k])];
    for (const keys of units) {
        const pick = side => keys.map(k => side[k]);
        const [va, vb, vo] = [pick(a), pick(b), o ? pick(o) : undefined];
        let from;
        if (same(va, vb) || same(vb, vo)) from = a;
        else if (same(va, vo)) from = b;
        else {
            from = later;
            notes.push(`#${a.id} ${keys.join('/')} changed on both sides; kept the later change (${keys.map(k => JSON.stringify(from[k])).join(', ')}).`);
        }
        keys.forEach(k => { out[k] = from[k]; });
    }
    // started is "first time work began", so the earlier stamp is right whichever side set it.
    out.started = [a.started, b.started].filter(Boolean).sort()[0] || null;
    out.updated = [a.updated, b.updated].filter(Boolean).sort().pop() || null;

    const inO = new Set(o ? o.tags : []), inA = new Set(a.tags), inB = new Set(b.tags);
    out.tags = [...new Set([...a.tags, ...b.tags])]
        .filter(t => (inA.has(t) && inB.has(t)) || !inO.has(t))
        .sort();

    const seen = new Set();
    out.history = [...a.history, ...b.history]
        .filter(h => { const k = JSON.stringify(h); return seen.has(k) ? false : seen.add(k); })
        .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    return out;
}

// Two branches can each create a task with the next free id. Same id but a different file and creation
// time means two different tasks, and theirs is renumbered.
function isSameTask(x, y) {
    return x.file === y.file || x.created === y.created;
}

function merge(baseText, oursText, theirsText) {
    const notes = [];
    const O = parse(baseText || '', 'base'), A = parse(oursText, 'ours'), B = parse(theirsText, 'theirs');

    // Columns: keyed by key, in our order, with any column only they added placed after its neighbour there.
    const colO = new Map(O.columns.map(c => [c.key, c]));
    const colA = new Map(A.columns.map(c => [c.key, c]));
    const colB = new Map(B.columns.map(c => [c.key, c]));
    const order = A.columns.map(c => c.key);
    B.columns.forEach((c, i) => {
        if (colA.has(c.key) || colO.has(c.key)) return;
        const prev = i > 0 ? order.indexOf(B.columns[i - 1].key) : -1;
        order.splice(prev + 1, 0, c.key);
    });
    const columns = [];
    for (const key of order) {
        const o = colO.get(key), a = colA.get(key), b = colB.get(key);
        if (o && (!a || !b)) {
            const kept = a || b;
            if (same(kept, o)) continue; // deleted on one side, untouched on the other
        }
        if (a && b) {
            const c = { ...a };
            for (const k of ['label', 'kind', 'wip']) c[k] = same(a[k], b[k]) || (o && same(b[k], o[k])) ? a[k] : (o && same(a[k], o[k])) ? b[k] : a[k];
            columns.push(c);
        } else columns.push(a || b);
    }

    // Tasks.
    const taskO = new Map(O.tasks.map(t => [t.id, t]));
    const taskA = new Map(A.tasks.map(t => [t.id, t]));
    const taskB = new Map(B.tasks.map(t => [t.id, t]));
    let nextId = Math.max(0, ...[...taskO.keys(), ...taskA.keys(), ...taskB.keys()]) + 1;
    const tasks = [];
    const ids = [...new Set([...taskO.keys(), ...taskA.keys(), ...taskB.keys()])].sort((x, y) => x - y);
    for (const id of ids) {
        const o = taskO.get(id), a = taskA.get(id), b = taskB.get(id);
        if (a && b && !(o && isSameTask(o, a) && isSameTask(o, b)) && !isSameTask(a, b)) {
            tasks.push(a);
            const moved = { ...b, id: nextId++ };
            tasks.push(moved);
            notes.push(`Both sides created a task #${id}; theirs (${b.file}) is now #${moved.id}.`);
            continue;
        }
        if (!a && !b) continue;
        if (o && !a) { if (!same(b, o)) { tasks.push(b); notes.push(`#${id} was deleted here but changed there; kept it.`); } continue; }
        if (o && !b) { if (!same(a, o)) { tasks.push(a); notes.push(`#${id} was deleted there but changed here; kept it.`); } continue; }
        if (!b) { tasks.push(a); continue; }
        if (!a) { tasks.push(b); continue; }
        tasks.push(mergeTask(o, a, b, notes));
    }

    // A task left pointing at a column that no longer exists goes to the first column.
    const keys = new Set(columns.map(c => c.key));
    for (const t of tasks) {
        if (!keys.has(t.status) && columns.length) {
            notes.push(`#${t.id} was in column "${t.status}", which is gone; moved it to "${columns[0].key}".`);
            t.status = columns[0].key;
        }
    }
    return { text: format({ columns, tasks }), notes };
}

module.exports = { format, parse, merge, ExportError, VERSION };
