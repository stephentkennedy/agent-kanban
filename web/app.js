(function () {
    'use strict';

    const $ = sel => document.querySelector(sel);
    const esc = markdown.esc;

    const state = {
        board: null,
        filters: { search: '', type: '', priority: '', tag: '', archived: false },
        task: null,         // the task open in the drawer, with body and hash
        tab: 'preview',
        dirty: false,       // the editor holds unsaved text
        dragId: null,
        caps: null,         // what the server can do: tmux, terminals, profiles
        activity: [],       // the open task's events
        taskTerm: null,     // the drawer's terminal, attached to the open task's session
        dockTerm: null,     // the orchestrator's terminal
    };

    const LIVE = s => !!s && s.status !== 'exited' && s.status !== 'lost';

    /* ---------- API ---------- */

    // Writes are always JSON: the server refuses anything else, so another site cannot post a form to it.
    async function api(method, url, body) {
        const write = method !== 'GET';
        const res = await fetch(url, {
            method,
            headers: write ? { 'Content-Type': 'application/json' } : {},
            body: write ? JSON.stringify(body || {}) : undefined,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error((data && data.error) || res.statusText);
            err.status = res.status;
            throw err;
        }
        return data;
    }

    let toastTimer;
    function toast(message, isError, onClick) {
        const el = $('#toast');
        el.textContent = message;
        el.className = 'toast' + (isError ? ' error' : '') + (onClick ? ' action' : '');
        el.onclick = onClick ? () => { el.hidden = true; onClick(); } : null;
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.hidden = true; }, onClick ? 10000 : isError ? 5000 : 2500);
    }

    const fail = e => toast(e.message, true);

    /* ---------- board ---------- */

    async function loadBoard() {
        state.board = await api('GET', '/api/board');
        fillFilterOptions();
        renderBoard();
        renderSessions();
    }

    function visible(t) {
        const f = state.filters;
        if (t.missing) return false;
        if (t.archived && !f.archived) return false;
        if (f.type && t.type !== f.type) return false;
        if (f.priority && t.priority !== f.priority) return false;
        if (f.tag && !t.tags.includes(f.tag)) return false;
        if (f.search) {
            const q = f.search.toLowerCase();
            const hay = `#${t.id} ${t.title} ${t.file} ${t.tags.join(' ')}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    }

    function renderBoard() {
        const { columns, tasks } = state.board;
        const board = $('#board');
        const scroll = [...board.querySelectorAll('.cards')].map(el => el.scrollTop);
        board.innerHTML = '';
        columns.forEach((col, i) => {
            const mine = ordered(col, tasks.filter(t => t.status === col.key && visible(t)));
            const over = col.wip_limit && col.count > col.wip_limit;
            const attention = col.sort === 'attention';
            const el = document.createElement('section');
            el.className = `column ${col.kind}`;
            el.dataset.status = col.key;
            el.innerHTML = `
                <div class="column-head">
                    <h2>${esc(col.label)}</h2>
                    <span class="count${over ? ' over' : ''}" title="${col.wip_limit ? `Work-in-progress limit ${col.wip_limit}` : ''}">${col.count}${col.wip_limit ? ' / ' + col.wip_limit : ''}</span>
                    <span class="kind">${esc(col.key)}</span>
                    <button type="button" class="sort-toggle${attention ? ' on' : ''}" aria-pressed="${attention}"
                        title="${attention ? 'Agents that need you are at the top. Click for your own order.' : 'Click to float agents that need you to the top.'}">⇡</button>
                </div>
                <div class="cards"></div>
                <div class="add-row"><button type="button">+ Add task</button></div>`;
            const list = el.querySelector('.cards');
            mine.forEach(t => list.appendChild(card(t)));
            list.scrollTop = scroll[i] || 0;
            wireDrop(list, col.key);
            el.querySelector('.add-row button').addEventListener('click', () => quickAdd(el, col.key));
            el.querySelector('.sort-toggle').addEventListener('click', () => {
                api('PATCH', `/api/columns/${encodeURIComponent(col.key)}`, { sort: attention ? 'manual' : 'attention' })
                    .then(loadBoard).catch(fail);
            });
            board.appendChild(el);
        });
    }

    // A column sorted by attention shows tasks whose agent needs the user first (blocked, then finished, then
    // crashed; longest-waiting first), then the rest in the column's own order.
    function pinned(col, t) {
        return col.sort === 'attention' && t.session && t.session.attention > 0;
    }

    function ordered(col, list) {
        const top = list.filter(t => pinned(col, t)).sort((a, b) =>
            a.session.attention - b.session.attention
            || String(a.session.attention_since).localeCompare(String(b.session.attention_since)));
        return [...top, ...list.filter(t => !pinned(col, t))];
    }

    function ago(iso) {
        if (!iso) return '';
        const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
        return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
    }

    function statusLabel(s) {
        switch (s.status) {
            case 'busy': return 'Working';
            case 'idle': return `Idle ${ago(s.attention_since)}`.trim();
            case 'waiting': return 'Needs input';
            case 'starting': return 'Starting';
            case 'lost': return 'Lost';
            case 'exited': return s.exit_code ? `Exited (${s.exit_code})` : 'Stopped';
            default: return s.status;
        }
    }

    function statusTag(s, { name = false } = {}) {
        const tip = [s.name, s.status_reason].filter(Boolean).join(': ');
        return `<span class="agent-tag" data-status="${esc(s.status)}" data-attention="${s.attention}" title="${esc(tip)}">`
            + `<i></i>${esc(statusLabel(s))}${name ? ` <b>${esc(s.name)}</b>` : ''}</span>`;
    }

    function card(t) {
        const col = state.board.columns.find(c => c.key === t.status);
        const el = document.createElement('article');
        el.className = 'card' + (t.archived ? ' archived' : '') + (state.task && state.task.id === t.id ? ' selected' : '')
            + (col && pinned(col, t) ? ' pinned' : '');
        el.draggable = true;
        el.tabIndex = 0;
        el.dataset.id = t.id;
        el.dataset.priority = t.priority;
        const prio = { urgent: '!!', high: '!', low: '↓' }[t.priority] || '';
        const pct = t.checks_total ? Math.round(100 * t.checks_done / t.checks_total) : 0;
        el.innerHTML = `
            <div class="card-top">
                <span class="task-id">#${t.id}</span>
                <span class="type" data-type="${esc(t.type)}">${esc(t.type)}</span>
                ${prio ? `<span class="prio" data-priority="${t.priority}" title="${t.priority} priority">${prio}</span>` : ''}
            </div>
            <div class="card-title">${markdown.inline(t.title)}</div>
            ${t.session || t.claim || t.user_changed_unseen ? `<div class="card-agent">
                ${t.session ? statusTag(t.session) : ''}
                ${t.claim && !t.claim.actor.startsWith('agent:') ? `<span class="claim" title="Claimed">${esc(t.claim.actor)}</span>` : ''}
                ${t.user_changed_unseen ? '<span class="changed" title="You changed this task; its agent has not read that yet">changed</span>' : ''}
            </div>` : ''}
            ${t.tags.length || t.checks_total || t.archived ? `<div class="card-foot">
                ${t.tags.map(g => `<button type="button" class="tag" data-tag="${esc(g)}" title="Show only #${esc(g)}">${esc(g)}</button>`).join('')}
                ${t.archived ? '<span class="flag">archived</span>' : ''}
                ${t.checks_total ? `<span class="progress${pct === 100 ? ' complete' : ''}" title="${t.checks_done} of ${t.checks_total} checked"><span class="bar"><i style="width:${pct}%"></i></span>${t.checks_done}/${t.checks_total}</span>` : ''}
            </div>` : ''}`;
        el.addEventListener('click', e => {
            const tag = e.target.closest('.tag');
            if (tag) {
                e.stopPropagation();
                setFilter('tag', tag.dataset.tag);
                return;
            }
            openTask(t.id);
        });
        el.addEventListener('keydown', e => { if (e.key === 'Enter') openTask(t.id); });
        el.addEventListener('dragstart', e => {
            state.dragId = t.id;
            e.dataTransfer.setData('text/plain', String(t.id));
            e.dataTransfer.effectAllowed = 'move';
            requestAnimationFrame(() => el.classList.add('dragging'));
        });
        el.addEventListener('dragend', () => {
            state.dragId = null;
            el.classList.remove('dragging');
            document.querySelectorAll('.drop-marker').forEach(m => m.remove());
        });
        return el;
    }

    // The card a drop at clientY would land before, or null for the end of the list.
    function cardAfter(list, y) {
        for (const el of list.querySelectorAll('.card:not(.dragging)')) {
            const r = el.getBoundingClientRect();
            if (y < r.top + r.height / 2) return el;
        }
        return null;
    }

    function wireDrop(list, status) {
        list.addEventListener('dragover', e => {
            if (state.dragId == null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const before = cardAfter(list, e.clientY);
            let marker = document.querySelector('.drop-marker');
            if (!marker) {
                marker = document.createElement('div');
                marker.className = 'drop-marker';
            }
            if (before) list.insertBefore(marker, before);
            else list.appendChild(marker);
        });
        list.addEventListener('dragleave', e => {
            if (!list.contains(e.relatedTarget)) list.querySelectorAll('.drop-marker').forEach(m => m.remove());
        });
        list.addEventListener('drop', e => {
            e.preventDefault();
            const id = state.dragId;
            if (id == null) return;
            // Pinned cards are ordered by attention, not by hand: a drop among them lands before the first
            // card in the column's own order.
            let before = cardAfter(list, e.clientY);
            if (before && before.classList.contains('pinned')) before = list.querySelector('.card:not(.pinned):not(.dragging)');
            moveTask(id, status, before ? Number(before.dataset.id) : null);
        });
    }

    // The server orders a column over all its unarchived tasks, including any the filters hide, so the drop
    // position is sent as an index into that full list.
    function moveTask(id, status, beforeId) {
        const tasks = state.board.tasks;
        const column = tasks.filter(t => t.status === status && !t.archived && !t.missing && t.id !== id);
        let index = beforeId == null ? column.length : column.findIndex(t => t.id === beforeId);
        if (index < 0) index = column.length;

        // Optimistic: reorder locally, then let the server's answer replace it.
        const task = tasks.find(t => t.id === id);
        const from = task.status;
        tasks.splice(tasks.indexOf(task), 1);
        const anchor = beforeId == null ? null : tasks.find(t => t.id === beforeId);
        task.status = status;
        if (anchor) tasks.splice(tasks.indexOf(anchor), 0, task);
        else {
            const last = tasks.map(t => t.status).lastIndexOf(status);
            tasks.splice(last === -1 ? tasks.length : last + 1, 0, task);
        }
        if (from !== status) {
            state.board.columns.forEach(c => {
                if (c.key === from && !task.archived) c.count--;
                if (c.key === status && !task.archived) c.count++;
            });
        }
        renderBoard();

        api('POST', `/api/tasks/${id}/move`, { status, index })
            .then(() => {
                if (state.task && state.task.id === id) refreshTask();
                return loadBoard();
            })
            .catch(e => { fail(e); loadBoard(); });
    }

    function quickAdd(columnEl, status) {
        const row = columnEl.querySelector('.add-row');
        row.innerHTML = '<input type="text" placeholder="Title, then Enter" aria-label="New task title">';
        const input = row.querySelector('input');
        input.focus();
        const done = () => renderBoard();
        input.addEventListener('keydown', async e => {
            if (e.key === 'Escape') return done();
            if (e.key !== 'Enter' || !input.value.trim()) return;
            const title = input.value.trim();
            input.value = '';
            try {
                const t = await api('POST', '/api/tasks', { title, status });
                await loadBoard();
                const again = document.querySelector(`.column[data-status="${CSS.escape(status)}"]`);
                if (again) quickAdd(again, status);
                toast(`Added #${t.id}`);
            } catch (err) { fail(err); }
        });
        input.addEventListener('blur', () => { if (!input.value.trim()) setTimeout(done, 150); });
    }

    /* ---------- filters ---------- */

    function fillFilterOptions() {
        const { types, priorities, tags } = state.board;
        const fill = (sel, values, all) => {
            const el = $(sel);
            const current = el.value;
            el.innerHTML = `<option value="">${all}</option>` + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
            el.value = values.includes(current) ? current : '';
        };
        fill('#filter-type', types, 'All types');
        fill('#filter-priority', [...priorities].reverse(), 'All priorities');
        const tagNames = tags.map(t => t.tag);
        if (state.filters.tag && !tagNames.includes(state.filters.tag)) tagNames.push(state.filters.tag);
        fill('#filter-tag', tagNames, 'All tags');
        $('#filter-tag').value = state.filters.tag;
        $('#tag-list').innerHTML = tags.map(t => `<option value="${esc(t.tag)}">`).join('');
    }

    function setFilter(key, value) {
        state.filters[key] = value;
        const input = { type: '#filter-type', priority: '#filter-priority', tag: '#filter-tag', search: '#search' }[key];
        if (input) $(input).value = value;
        renderBoard();
    }

    /* ---------- drawer ---------- */

    async function openTask(id) {
        if (state.dirty && state.task && state.task.id !== id && !confirm('Discard unsaved edits?')) return;
        try {
            state.task = await api('GET', `/api/tasks/${id}`);
        } catch (e) {
            if (e.status === 404) history.replaceState(null, '', location.pathname);
            return fail(e);
        }
        state.dirty = false;
        state.activity = [];
        history.replaceState(null, '', `#${id}`);
        renderDrawer();
        loadActivity();
        document.querySelectorAll('.card.selected').forEach(el => el.classList.remove('selected'));
        const el = document.querySelector(`.card[data-id="${id}"]`);
        if (el) el.classList.add('selected');
    }

    function closeDrawer() {
        if (state.dirty && !confirm('Discard unsaved edits?')) return;
        state.task = null;
        state.dirty = false;
        if (state.taskTerm) state.taskTerm.dispose();
        $('#drawer').hidden = true;
        $('#drawer').classList.remove('wide');
        history.replaceState(null, '', location.pathname);
        document.querySelectorAll('.card.selected').forEach(el => el.classList.remove('selected'));
    }

    // Re-reads the open task after something changed. Unsaved editor text is never replaced; a banner says
    // the file moved on instead.
    async function refreshTask() {
        if (!state.task) return;
        let fresh;
        try {
            fresh = await api('GET', `/api/tasks/${state.task.id}`);
        } catch (e) {
            if (e.status === 404) {
                state.dirty = false;
                closeDrawer();
                toast('That task was deleted.');
            }
            return;
        }
        if (state.dirty && fresh.hash !== state.task.hash) {
            state.task = { ...fresh, body: state.task.body, hash: state.task.hash };
            renderDrawer({ keepEditor: true });
            showConflict(fresh);
            return;
        }
        state.task = fresh;
        renderDrawer({ keepEditor: state.dirty });
    }

    function showConflict(fresh) {
        const el = $('#d-conflict');
        el.hidden = false;
        el.innerHTML = '<span>The file changed on disk while you were editing.</span><button type="button" data-a="load">Load theirs</button><button type="button" data-a="keep">Keep mine</button>';
        el.onclick = e => {
            const a = e.target.dataset.a;
            if (!a) return;
            el.hidden = true;
            if (a === 'load') {
                state.dirty = false;
                state.task = fresh;
                renderDrawer();
            } else {
                state.task.hash = fresh.hash; // the next save overwrites theirs
            }
        };
    }

    function renderDrawer({ keepEditor = false } = {}) {
        const t = state.task;
        const b = state.board;
        $('#drawer').hidden = false;
        $('#d-id').textContent = `#${t.id}`;
        if (document.activeElement !== $('#d-title')) $('#d-title').value = t.title;
        const options = (values, current, label = v => v) =>
            values.map(v => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label(v))}</option>`).join('');
        const labels = Object.fromEntries(b.columns.map(c => [c.key, c.label]));
        $('#d-status').innerHTML = options(b.columns.map(c => c.key), t.status, k => labels[k]);
        $('#d-priority').innerHTML = options([...b.priorities].reverse(), t.priority);
        $('#d-type').innerHTML = options(b.types, t.type);
        if (document.activeElement !== $('#d-tags')) $('#d-tags').value = t.tags.join(', ');
        $('#d-claim').textContent = t.claim ? `held by ${t.claim.actor}` : '';
        $('#d-changed').hidden = !t.user_changed_unseen;
        $('#d-agent-dot').innerHTML = t.session && LIVE(t.session) ? `<i class="dot" data-status="${esc(t.session.status)}"></i>` : '';
        $('#d-path').textContent = `tasks/${t.file}`;
        $('#d-path').title = `${t.path}\nClick to copy`;
        $('#d-progress').textContent = t.checks_total ? `${t.checks_done} of ${t.checks_total} checked` : '';
        $('#d-archive').textContent = t.archived ? 'Unarchive' : 'Archive';
        const fmt = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
        $('#d-dates').textContent = [
            `Created ${fmt(t.created_at)}`,
            t.started_at && `started ${fmt(t.started_at)}`,
            t.completed_at && `done ${fmt(t.completed_at)}`,
        ].filter(Boolean).join(' · ');
        if (!keepEditor) $('#d-conflict').hidden = true;

        if (t.missing) {
            $('#d-preview').innerHTML = `<p class="flag">${esc(t.file)} is missing from tasks/. Restore it, or run <code>kanban prune</code>.</p>`;
        } else {
            $('#d-preview').innerHTML = markdown.render(t.body, { skipTitle: true });
        }
        if (!keepEditor) $('#d-body').value = t.body || '';
        $('#d-history').innerHTML = (t.history || []).slice().reverse().map(h => {
            const what = h.field === 'status'
                ? (h.old ? `moved from ${labels[h.old] || h.old} to ${labels[h.new] || h.new}` : `created in ${labels[h.new] || h.new}`)
                : h.field === 'file' ? `file renamed from ${h.old} to ${h.new}`
                : `${h.field}: ${h.old || '—'} → ${h.new || '—'}`;
            return `<li><time>${esc(fmt(h.at))}</time>${esc(what)}${h.actor ? ` <span class="actor">${esc(h.actor)}</span>` : ''}</li>`;
        }).join('');
        setTab(state.tab);
        renderActivity();
    }

    function setTab(tab) {
        state.tab = tab;
        document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
        $('#d-preview').hidden = tab !== 'preview';
        $('#d-edit').hidden = tab !== 'edit';
        $('#d-agent').hidden = tab !== 'agent';
        $('#drawer').classList.toggle('wide', tab === 'agent');
        if (tab === 'edit') $('#d-body').focus();
        renderAgent();
    }

    async function patch(changes) {
        try {
            state.task = { ...await api('PATCH', `/api/tasks/${state.task.id}`, changes), history: state.task.history };
            await Promise.all([loadBoard(), refreshTask()]);
        } catch (e) { fail(e); refreshTask(); }
    }

    async function save() {
        const t = state.task;
        try {
            state.task = await api('PUT', `/api/tasks/${t.id}/body`, { body: $('#d-body').value, baseHash: t.hash });
            state.dirty = false;
            $('#d-conflict').hidden = true;
            toast('Saved');
            await Promise.all([loadBoard(), refreshTask()]);
        } catch (e) {
            if (e.status === 409) {
                const fresh = await api('GET', `/api/tasks/${t.id}`);
                showConflict(fresh);
            } else fail(e);
        }
    }

    /* ---------- activity ---------- */

    async function loadActivity() {
        const t = state.task;
        if (!t) return;
        try {
            const events = await api('GET', `/api/tasks/${t.id}/events?limit=100`);
            if (state.task && state.task.id === t.id) {
                state.activity = events;
                renderActivity();
            }
        } catch { /* the drawer still works without it */ }
    }

    // Everything but reorders, newest first; notes and messages stand out.
    function renderActivity() {
        const fmt = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
        $('#d-activity').innerHTML = state.activity.filter(e => e.type !== 'task.reordered').slice().reverse().map(e => `
            <li class="${e.type.startsWith('message.') ? 'message' : ''}${e.type === 'session.waiting' ? ' alert' : ''}">
                <time>${esc(fmt(e.at))}</time><span class="actor">${esc(e.actor)}</span> ${esc(e.text || e.type)}
            </li>`).join('') || '<li class="hint">Nothing yet.</li>';
    }

    /* ---------- agents ---------- */

    function sessionsOf(role) {
        return (state.board ? state.board.sessions : []).filter(s => s.role === role);
    }

    // The orchestrator session to show: the live one, or else the latest.
    function orchestrator() {
        const list = sessionsOf('orchestrator');
        return list.find(LIVE) || list[list.length - 1] || null;
    }

    function capsProblem() {
        const c = state.caps;
        if (!c) return 'Checking what this server can run…';
        if (!c.tmux) return 'Agent sessions need tmux 3.2 or later on the machine running the board.';
        if (!c.tmuxOk) return `Agent sessions need tmux 3.2 or later; this is ${c.tmux}.`;
        if (!c.terminals) return 'Terminals in the browser need the optional packages: run npm install in the kanban folder. Sessions still run; attach with kanban session attach.';
        return null;
    }

    async function startSession(body) {
        try {
            const s = await api('POST', '/api/sessions', body);
            toast(`Started ${s.name}`);
            await loadBoard();
            return s;
        } catch (e) { fail(e); }
    }

    async function sessionAction(s, action, body) {
        try {
            await api('POST', `/api/sessions/${s.id}/${action}`, body);
        } catch (e) {
            fail(e);
            return false;
        }
        await loadBoard().catch(fail);
        if (state.task) await refreshTask();
        return true;
    }

    function stopSession(s) {
        if (!confirm(`Stop ${s.name}? Its worktree and branch are kept.`)) return;
        sessionAction(s, 'kill', { worktree: 'keep' });
    }

    // The drawer's Agent tab: start an agent on the task, or watch and drive the one that is there.
    function renderAgent() {
        const t = state.task;
        if (!t || state.tab !== 'agent') {
            if (state.taskTerm && state.tab !== 'agent') state.taskTerm.dispose();
            return;
        }
        const s = t.session;
        const problem = capsProblem();
        const live = LIVE(s);
        $('#d-agent-status').innerHTML = s ? statusTag(s, { name: true }) : '<span class="hint">No agent has worked on this task.</span>';
        $('#d-agent-profile').hidden = live;
        $('#d-agent-start').hidden = live;
        $('#d-agent-start').textContent = s ? 'Start a new agent' : 'Start agent';
        $('#d-agent-start').disabled = !!problem && !(state.caps && state.caps.tmuxOk);
        $('#d-agent-resume').hidden = !s || live;
        $('#d-agent-nudge').hidden = !live;
        $('#d-agent-stop').hidden = !live;
        $('#d-agent-info').innerHTML = s ? [
            s.status_reason ? `<span class="reason">${esc(s.status_reason)}</span>` : '',
            s.branch ? `<span>branch <code>${esc(s.branch)}</code></span>` : '',
            s.worktree ? `<span>worktree <code class="copy" data-copy="${esc(s.worktree)}" title="Click to copy">${esc(s.worktree)}</code></span>` : '',
        ].filter(Boolean).join('') : '';

        const canView = s && s.status !== 'lost' && state.caps && state.caps.terminals;
        $('#d-agent-empty').hidden = !!canView;
        $('#d-agent-empty').textContent = problem || (s ? (s.status === 'lost' ? 'This session\'s terminal is gone. Resume it, or start a new agent.' : '')
            : 'Start an agent to work on this task in its own git worktree and branch. It follows the task\'s events, and you can type into its terminal here.');
        $('#d-term').hidden = !canView;
        if (!canView) {
            if (state.taskTerm) state.taskTerm.dispose();
            return;
        }
        state.taskTerm = state.taskTerm || new window.KanbanTerm.Term($('#d-term'));
        state.taskTerm.open(s.id).catch(fail);
    }

    // The orchestrator dock at the bottom of the board.
    function renderDock() {
        const s = orchestrator();
        const live = LIVE(s);
        const problem = capsProblem();
        $('#dock-status').innerHTML = s ? statusTag(s) : '';
        $('#dock-profile').hidden = live;
        $('#dock-start').hidden = live;
        $('#dock-start').disabled = !(state.caps && state.caps.tmuxOk);
        $('#dock-resume').hidden = !s || live;
        $('#dock-nudge').hidden = !live;
        $('#dock-stop').hidden = !live;
        const open = !$('#dock').classList.contains('collapsed');
        const canView = s && s.status !== 'lost' && state.caps && state.caps.terminals;
        $('#dock-empty').hidden = !!canView;
        $('#dock-empty').textContent = problem || 'The orchestrator is an agent that plans the board, starts agents on tasks and answers them. Start one to talk to it here.';
        $('#dock-term').hidden = !canView;
        if (!canView || !open) {
            if (state.dockTerm) state.dockTerm.dispose();
            return;
        }
        state.dockTerm = state.dockTerm || new window.KanbanTerm.Term($('#dock-term'));
        state.dockTerm.open(s.id).catch(fail);
    }

    function toggleDock(force) {
        const collapsed = force !== undefined ? !force : !$('#dock').classList.contains('collapsed');
        $('#dock').classList.toggle('collapsed', collapsed);
        $('#dock-toggle').textContent = collapsed ? '▸' : '▾';
        $('#dock-toggle').setAttribute('aria-expanded', String(!collapsed));
        store('dock-collapsed', collapsed ? '1' : '');
        renderDock();
        if (!collapsed && state.dockTerm) setTimeout(() => state.dockTerm.focus(), 50);
    }

    function store(key, value) {
        try {
            if (value === undefined) return localStorage.getItem(`kanban.${key}`);
            localStorage.setItem(`kanban.${key}`, value);
        } catch { return null; }
    }

    // The top bar: how many agents need the user, and the list of every session.
    function renderSessions() {
        if (!state.board) return;
        const all = state.board.sessions;
        const live = all.filter(LIVE);
        // An ended session stops counting once a newer one has taken over its task (or the orchestrator's role).
        const superseded = s => all.some(o => o.id > s.id && o.role === s.role && o.task_id === s.task_id);
        const needy = all.filter(s => s.attention > 0 && !superseded(s));
        $('#sessions-count').textContent = live.length || '';
        $('#attention').hidden = !needy.length;
        $('#attention').textContent = `${needy.length} need${needy.length === 1 ? 's' : ''} you`;
        document.title = needy.length ? `(${needy.length}) Kanban` : 'Kanban';
        const order = (a, b) => (a.attention || 9) - (b.attention || 9) || (LIVE(b) - LIVE(a)) || b.id - a.id;
        $('#sessions-list').innerHTML = all.slice().sort(order).map(s => `
            <li data-id="${s.id}">
                ${statusTag(s)}
                <b>${esc(s.name)}</b>
                <span class="hint">${s.task_id != null ? `#${s.task_id}` : 'orchestrator'} · ${esc(s.profile)}${s.status_reason ? ' · ' + esc(s.status_reason) : ''}</span>
                <span class="spacer"></span>
                <button type="button" data-a="open">Open</button>
            </li>`).join('') || '<li class="hint">No sessions yet. Start the orchestrator below, or an agent from a task\'s Agent tab.</li>';
        renderDock();
        if (state.tab === 'agent') renderAgent();
    }

    function showSession(s) {
        $('#sessions-pop').hidden = true;
        if (s.role === 'orchestrator') return toggleDock(true);
        if (s.task_id == null) return;
        state.tab = 'agent';
        openTask(s.task_id);
    }

    function announceWaiting(e) {
        const s = { id: e.session_id, name: e.payload.name, role: e.payload.role, task_id: e.task_id };
        const text = `${e.payload.name} needs input${e.payload.reason ? ': ' + e.payload.reason : ''}`;
        toast(text, false, () => showSession(s));
        if ($('#notify').checked && window.Notification && Notification.permission === 'granted' && document.hidden) {
            const n = new Notification('Kanban', { body: text, tag: `session-${e.session_id}` });
            n.onclick = () => { window.focus(); showSession(s); };
        }
    }

    /* ---------- wiring ---------- */

    $('#search').addEventListener('input', e => setFilter('search', e.target.value));
    $('#filter-type').addEventListener('change', e => setFilter('type', e.target.value));
    $('#filter-priority').addEventListener('change', e => setFilter('priority', e.target.value));
    $('#filter-tag').addEventListener('change', e => setFilter('tag', e.target.value));
    $('#show-archived').addEventListener('change', e => setFilter('archived', e.target.checked));

    $('#new-task').addEventListener('click', () => {
        const first = document.querySelector('.column');
        if (first) quickAdd(first, first.dataset.status);
    });

    $('#d-close').addEventListener('click', closeDrawer);
    $('#d-title').addEventListener('keydown', e => {
        if (e.key === 'Enter') e.target.blur();
        if (e.key === 'Escape') { e.target.value = state.task.title; e.target.blur(); }
    });
    $('#d-title').addEventListener('blur', e => {
        const title = e.target.value.trim();
        if (!state.task || !title || title === state.task.title) return;
        if (state.dirty) {
            toast('Save or revert the editor before renaming.', true);
            e.target.value = state.task.title;
            return;
        }
        patch({ title });
    });
    $('#d-status').addEventListener('change', e => {
        api('POST', `/api/tasks/${state.task.id}/move`, { status: e.target.value })
            .then(() => Promise.all([loadBoard(), refreshTask()])).catch(fail);
    });
    $('#d-priority').addEventListener('change', e => patch({ priority: e.target.value }));
    $('#d-type').addEventListener('change', e => patch({ type: e.target.value }));
    $('#d-tags').addEventListener('change', e => patch({ tags: e.target.value }));
    $('#d-path').addEventListener('click', () => {
        navigator.clipboard.writeText(state.task.path).then(() => toast('Path copied'), fail);
    });
    $('#d-open').addEventListener('click', () => api('POST', `/api/tasks/${state.task.id}/open`).catch(fail));
    $('#d-archive').addEventListener('click', () => patch({ archived: !state.task.archived }));
    $('#d-delete').addEventListener('click', async () => {
        const t = state.task;
        if (!confirm(`Delete #${t.id} "${t.title}" and its file ${t.file}?`)) return;
        try {
            await api('DELETE', `/api/tasks/${t.id}`);
            state.dirty = false;
            closeDrawer();
            await loadBoard();
            toast(`Deleted #${t.id}`);
        } catch (e) { fail(e); }
    });

    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('#d-body').addEventListener('input', () => { state.dirty = $('#d-body').value !== state.task.body; });
    $('#d-save').addEventListener('click', save);
    $('#d-revert').addEventListener('click', () => {
        state.dirty = false;
        $('#d-body').value = state.task.body;
        $('#d-conflict').hidden = true;
        refreshTask();
    });

    // Ticking a checkbox in the preview ticks it in the file.
    $('#d-preview').addEventListener('change', async e => {
        if (!e.target.matches('input[type=checkbox][data-line]')) return;
        if (state.dirty) {
            e.target.checked = !e.target.checked;
            return toast('Save or revert the editor first.', true);
        }
        try {
            state.task = { ...await api('POST', `/api/tasks/${state.task.id}/toggle`, { line: Number(e.target.dataset.line), baseHash: state.task.hash }), history: state.task.history };
            renderDrawer();
            loadBoard();
        } catch (err) {
            fail(err);
            refreshTask();
        }
    });

    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.key === '`') {
            e.preventDefault();
            return toggleDock();
        }
        if (e.target.closest('.xterm')) return; // a terminal gets every key, Escape included
        const typing = e.target.matches('input, textarea, select');
        if ((e.ctrlKey || e.metaKey) && e.key === 's' && state.task && state.tab === 'edit') {
            e.preventDefault();
            save();
        } else if (e.key === 'Escape' && !typing && state.task) {
            closeDrawer();
        } else if (e.key === 'Escape' && e.target.id === 'd-body') {
            e.target.blur();
        } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
            if (e.key === 'n') { e.preventDefault(); $('#new-task').click(); }
        }
    });

    window.addEventListener('beforeunload', e => { if (state.dirty) e.preventDefault(); });

    // Agents: the drawer's Agent tab, the activity feed, the orchestrator dock and the sessions list.
    $('#d-agent-start').addEventListener('click', async () => {
        const t = state.task;
        const s = await startSession({ role: 'task', task: t.id, profile: $('#d-agent-profile').value, force: LIVE(t.session) });
        if (s) refreshTask();
    });
    $('#d-agent-resume').addEventListener('click', () => sessionAction(state.task.session, 'resume'));
    $('#d-agent-nudge').addEventListener('click', async () => { if (await sessionAction(state.task.session, 'nudge')) toast('Nudged'); });
    $('#d-agent-stop').addEventListener('click', () => stopSession(state.task.session));
    $('#d-agent-info').addEventListener('click', e => {
        const el = e.target.closest('[data-copy]');
        if (el) navigator.clipboard.writeText(el.dataset.copy).then(() => toast('Path copied'), fail);
    });
    $('#d-msg-form').addEventListener('submit', async e => {
        e.preventDefault();
        const text = $('#d-msg').value.trim();
        if (!text || !state.task) return;
        try {
            await api('POST', `/api/tasks/${state.task.id}/messages`, { text });
            $('#d-msg').value = '';
            loadActivity();
        } catch (err) { fail(err); }
    });

    $('#dock-toggle').addEventListener('click', () => toggleDock());
    $('#dock-start').addEventListener('click', () => startSession({ role: 'orchestrator', profile: $('#dock-profile').value }));
    $('#dock-resume').addEventListener('click', () => sessionAction(orchestrator(), 'resume'));
    $('#dock-nudge').addEventListener('click', async () => { if (await sessionAction(orchestrator(), 'nudge')) toast('Nudged'); });
    $('#dock-stop').addEventListener('click', () => stopSession(orchestrator()));
    $('#dock-handle').addEventListener('pointerdown', e => {
        e.preventDefault();
        const dock = $('#dock');
        const start = e.clientY, height = dock.getBoundingClientRect().height;
        const move = ev => {
            const h = Math.max(120, Math.min(window.innerHeight - 160, height + start - ev.clientY));
            dock.style.setProperty('--dock-height', `${h}px`);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            store('dock-height', dock.style.getPropertyValue('--dock-height'));
            if (state.dockTerm) state.dockTerm.refit();
        };
        if ($('#dock').classList.contains('collapsed')) toggleDock(true);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    });
    if (store('dock-height')) $('#dock').style.setProperty('--dock-height', store('dock-height'));
    if (store('dock-collapsed')) {
        $('#dock').classList.add('collapsed');
        $('#dock-toggle').textContent = '▸';
        $('#dock-toggle').setAttribute('aria-expanded', 'false');
    }

    async function openSessions() {
        const pop = $('#sessions-pop');
        pop.hidden = !pop.hidden;
        if (pop.hidden) return;
        try {
            const { orphans } = await api('GET', '/api/sessions');
            $('#sessions-orphans').hidden = !orphans.length;
            $('#sessions-orphans').textContent = orphans.length
                ? `tmux also has ${orphans.join(', ')}, which the board did not start or has forgotten.` : '';
        } catch (e) { fail(e); }
    }
    $('#sessions-btn').addEventListener('click', e => { e.stopPropagation(); openSessions(); });
    $('#attention').addEventListener('click', e => { e.stopPropagation(); openSessions(); });
    $('#sessions-list').addEventListener('click', e => {
        const row = e.target.closest('li[data-id]');
        const s = row && state.board.sessions.find(x => x.id === Number(row.dataset.id));
        if (s) showSession(s);
    });
    document.addEventListener('click', e => {
        if (!$('#sessions-pop').hidden && !e.target.closest('#sessions-pop')) $('#sessions-pop').hidden = true;
    });
    $('#notify').checked = store('notify') === '1' && window.Notification && Notification.permission === 'granted';
    $('#notify').addEventListener('change', async e => {
        if (e.target.checked && window.Notification && Notification.permission !== 'granted') {
            e.target.checked = (await Notification.requestPermission()) === 'granted';
        }
        store('notify', e.target.checked ? '1' : '');
    });

    // Live updates. Each event arrives as `kanban`; a batch that changed the board also sends `change`, and the
    // board and the open task are re-read. Session and message events update what shows agents.
    let pending = null, pendingBoard = null, pendingActivity = null;
    function connect() {
        const source = new EventSource('/api/events');
        source.onopen = () => { $('#live').classList.add('on'); $('#live').title = 'Live: following the board, its files and its agents'; };
        source.onerror = () => { $('#live').classList.remove('on'); $('#live').title = 'Disconnected; retrying'; };
        source.addEventListener('change', () => {
            clearTimeout(pending);
            pending = setTimeout(() => { loadBoard().catch(fail); refreshTask(); }, 100);
        });
        source.addEventListener('kanban', msg => {
            let e;
            try { e = JSON.parse(msg.data); } catch { return; }
            if (e.type.startsWith('session.')) {
                clearTimeout(pendingBoard);
                pendingBoard = setTimeout(() => { loadBoard().then(refreshTask).catch(fail); }, 150);
                if (e.type === 'session.waiting') announceWaiting(e);
            }
            if (state.task && e.task_id === state.task.id) {
                clearTimeout(pendingActivity);
                pendingActivity = setTimeout(loadActivity, 150);
            }
        });
    }

    api('GET', '/api/capabilities').then(caps => {
        state.caps = caps;
        const options = caps.profiles.map(p => `<option value="${esc(p.name)}"${p.name === caps.defaultProfile ? ' selected' : ''}>${esc(p.label)}</option>`).join('');
        $('#dock-profile').innerHTML = options;
        $('#d-agent-profile').innerHTML = options;
        renderSessions();
        renderAgent();
    }).catch(fail);
    loadBoard().then(() => {
        const id = Number(location.hash.slice(1));
        if (id) openTask(id);
    }).catch(fail);
    connect();
})();
