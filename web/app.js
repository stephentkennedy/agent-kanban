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
    };

    /* ---------- API ---------- */

    async function api(method, url, body) {
        const res = await fetch(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
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
    function toast(message, isError) {
        const el = $('#toast');
        el.textContent = message;
        el.className = 'toast' + (isError ? ' error' : '');
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 2500);
    }

    const fail = e => toast(e.message, true);

    /* ---------- board ---------- */

    async function loadBoard() {
        state.board = await api('GET', '/api/board');
        fillFilterOptions();
        renderBoard();
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
            const mine = tasks.filter(t => t.status === col.key && visible(t));
            const over = col.wip_limit && col.count > col.wip_limit;
            const el = document.createElement('section');
            el.className = `column ${col.kind}`;
            el.dataset.status = col.key;
            el.innerHTML = `
                <div class="column-head">
                    <h2>${esc(col.label)}</h2>
                    <span class="count${over ? ' over' : ''}" title="${col.wip_limit ? `Work-in-progress limit ${col.wip_limit}` : ''}">${col.count}${col.wip_limit ? ' / ' + col.wip_limit : ''}</span>
                    <span class="kind">${esc(col.key)}</span>
                </div>
                <div class="cards"></div>
                <div class="add-row"><button type="button">+ Add task</button></div>`;
            const list = el.querySelector('.cards');
            mine.forEach(t => list.appendChild(card(t)));
            list.scrollTop = scroll[i] || 0;
            wireDrop(list, col.key);
            el.querySelector('.add-row button').addEventListener('click', () => quickAdd(el, col.key));
            board.appendChild(el);
        });
    }

    function card(t) {
        const el = document.createElement('article');
        el.className = 'card' + (t.archived ? ' archived' : '') + (state.task && state.task.id === t.id ? ' selected' : '');
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
            const before = cardAfter(list, e.clientY);
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
        history.replaceState(null, '', `#${id}`);
        renderDrawer();
        document.querySelectorAll('.card.selected').forEach(el => el.classList.remove('selected'));
        const el = document.querySelector(`.card[data-id="${id}"]`);
        if (el) el.classList.add('selected');
    }

    function closeDrawer() {
        if (state.dirty && !confirm('Discard unsaved edits?')) return;
        state.task = null;
        state.dirty = false;
        $('#drawer').hidden = true;
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
            return `<li><time>${esc(fmt(h.at))}</time>${esc(what)}</li>`;
        }).join('');
        setTab(state.tab);
    }

    function setTab(tab) {
        state.tab = tab;
        document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
        $('#d-preview').hidden = tab !== 'preview';
        $('#d-edit').hidden = tab !== 'edit';
        if (tab === 'edit') $('#d-body').focus();
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

    // Live updates: the server says something changed, and the board and the open task are re-read.
    let pending = null;
    function connect() {
        const source = new EventSource('/api/events');
        source.onopen = () => { $('#live').classList.add('on'); $('#live').title = 'Live: following file and database changes'; };
        source.onerror = () => { $('#live').classList.remove('on'); $('#live').title = 'Disconnected; retrying'; };
        source.addEventListener('change', () => {
            clearTimeout(pending);
            pending = setTimeout(() => { loadBoard().catch(fail); refreshTask(); }, 100);
        });
    }

    loadBoard().then(() => {
        const id = Number(location.hash.slice(1));
        if (id) openTask(id);
    }).catch(fail);
    connect();
})();
