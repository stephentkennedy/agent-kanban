// A terminal attached to an agent session: xterm.js in the page, a WebSocket to the server, and on the
// server a tmux client of the session. tmux keeps the scrollback (scroll with the mouse wheel), so the
// page's terminal keeps none of its own.
(function () {
    'use strict';

    let loading = null;
    function load() {
        if (window.Terminal && window.FitAddon) return Promise.resolve();
        if (!loading) {
            const css = href => new Promise((resolve, reject) => {
                const el = Object.assign(document.createElement('link'), { rel: 'stylesheet', href, onload: resolve, onerror: reject });
                document.head.appendChild(el);
            });
            const script = src => new Promise((resolve, reject) => {
                const el = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: () => reject(new Error(`Could not load ${src}`)) });
                document.head.appendChild(el);
            });
            loading = Promise.all([css('/vendor/xterm.css'), script('/vendor/xterm.js')])
                .then(() => script('/vendor/addon-fit.js'))
                .catch(e => { loading = null; throw e; });
        }
        return loading;
    }

    function theme() {
        const v = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return {
            background: v('--term-bg'), foreground: v('--text'), cursor: v('--accent'), cursorAccent: v('--term-bg'),
            selectionBackground: v('--term-selection'),
        };
    }

    class Term {
        constructor(host, { onClose } = {}) {
            this.host = host;
            this.onClose = onClose;
            this.sessionId = null;
        }

        // Attaches to a session; does nothing when already attached to it.
        async open(sessionId, { readOnly = false } = {}) {
            if (this.sessionId === sessionId && this.ws && this.ws.readyState <= 1) return;
            this.dispose();
            this.sessionId = sessionId;
            await load();
            if (this.sessionId !== sessionId) return; // replaced while loading
            const term = new window.Terminal({
                fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
                fontSize: 13, scrollback: 0, cursorBlink: true, theme: theme(), macOptionIsMeta: true,
            });
            const fit = new window.FitAddon.FitAddon();
            term.loadAddon(fit);
            this.host.innerHTML = '';
            term.open(this.host);
            try { fit.fit(); } catch { /* not visible yet */ }

            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            const ws = new WebSocket(`${proto}://${location.host}/api/sessions/${sessionId}/term?cols=${term.cols}&rows=${term.rows}${readOnly ? '&ro=1' : ''}`);
            const send = msg => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
            ws.onmessage = e => term.write(e.data);
            ws.onclose = e => {
                if (this.ws !== ws) return;
                term.write(`\r\n\x1b[2m[${e.reason || 'Disconnected'}]\x1b[0m\r\n`);
                if (this.onClose) this.onClose(e);
            };
            term.onData(d => send({ t: 'i', d }));
            term.onResize(({ cols, rows }) => send({ t: 'r', c: cols, r: rows }));
            this.observer = new ResizeObserver(() => {
                clearTimeout(this.fitTimer);
                this.fitTimer = setTimeout(() => { try { fit.fit(); } catch { /* hidden */ } }, 40);
            });
            this.observer.observe(this.host);
            Object.assign(this, { term, fit, ws });
        }

        focus() {
            if (this.term) this.term.focus();
        }

        refit() {
            if (this.fit) try { this.fit.fit(); } catch { /* hidden */ }
        }

        dispose() {
            if (this.observer) this.observer.disconnect();
            const ws = this.ws;
            this.ws = null;
            if (ws) ws.close();
            if (this.term) this.term.dispose();
            this.term = this.fit = this.observer = null;
            this.sessionId = null;
            this.host.innerHTML = '';
        }
    }

    window.KanbanTerm = { Term, load };
})();
