'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');

// A fresh tracker in a temporary folder, removed when the test ends.
function tracker(t, opts) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
    const store = new Store(home, opts);
    t.after(() => {
        try { store.close(); } catch { /* already closed */ }
        fs.rmSync(home, { recursive: true, force: true });
    });
    return { home, store };
}

// A session row without tmux behind it, for testing the store's side of sessions.
function fakeSession(store, fields = {}) {
    const name = fields.name || `s${Math.random().toString(36).slice(2, 7)}`;
    return store.createSession({ name, role: 'task', profile: 'shell', tmux: name, cwd: store.home, ...fields });
}

module.exports = { tracker, fakeSession };
