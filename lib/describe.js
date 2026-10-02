'use strict';

// One line of plain text per event, for the CLI, the inbox and what hooks hand to an agent.

function time(iso) {
    return iso ? iso.slice(11, 16) : '';
}

function what(e) {
    const p = e.payload || {};
    const n = e.task_id != null ? `#${e.task_id}` : '';
    switch (e.type) {
        case 'task.created': return `${n} created in ${p.status}: "${p.title}"`;
        case 'task.moved': return `${n} moved from ${p.from} to ${p.to}`;
        case 'task.reordered': return `${n} reordered in ${p.status}`;
        case 'task.updated': return `${n} changed: ` + Object.entries(p.changes || {})
            .map(([k, [a, b]]) => `${k} ${a === '' || a == null ? '—' : a} → ${b === '' || b == null ? '—' : b}`).join('; ');
        case 'task.body_changed': return `${n}'s file was edited` + (p.title ? ` (renamed "${p.title[1]}")` : '')
            + (p.checks_total ? `, ${p.checks_done}/${p.checks_total} checked` : '');
        case 'task.deleted': return `${n} was deleted ("${p.title}")`;
        case 'task.missing': return `${n}'s file ${p.file} has gone`;
        case 'task.restored': return `${n}'s file is back`;
        case 'task.claimed': return `${n} claimed by ${p.actor}` + (p.previous ? ` (was ${p.previous})` : '');
        case 'task.released': return `${n} released by ${p.actor}`;
        case 'task.user_changed': return `${n} was changed by ${e.actor === 'file' ? 'someone editing its file' : 'the user'}`
            + ` while ${p.claimant} holds it (${(p.cause || []).join(', ')}). Re-read it: kanban show ${e.task_id}`;
        case 'board.imported': return 'The board was reloaded from kanban.jsonl (a pull, checkout or merge)';
        case 'column.changed': return `Column ${p.key} ${p.action}`;
        case 'session.started': return `Session ${p.name} ${p.resumed ? 'resumed' : 'started'}${n ? ` on ${n}` : ''}`;
        case 'session.busy': return `Session ${p.name} is working`;
        case 'session.idle': return `Session ${p.name}${n ? ` (${n})` : ''} is idle, waiting for its next instruction`;
        case 'session.waiting': return `Session ${p.name}${n ? ` (${n})` : ''} needs input` + (p.reason ? `: ${p.reason}` : '');
        case 'session.exited': return `Session ${p.name}${n ? ` (${n})` : ''} exited` + (p.exit_code ? ` with code ${p.exit_code}` : '')
            + (p.reason && !p.exit_code ? ` (${p.reason})` : '');
        case 'session.lost': return `Session ${p.name}${n ? ` (${n})` : ''} was lost: ${p.reason || 'its terminal is gone'}`;
        case 'message.posted': return `Note on ${n}: ${p.text}`;
        case 'message.sent': return `Message to ${p.to}: ${p.text}`;
        default: return `${e.type} ${n} ${JSON.stringify(p)}`;
    }
}

function describe(e, { max = 0 } = {}) {
    let line = `[${e.id} ${time(e.at)} ${e.actor}] ${what(e)}`;
    if (max && line.length > max) line = line.slice(0, max - 1) + '…';
    return line;
}

module.exports = { describe, what };
