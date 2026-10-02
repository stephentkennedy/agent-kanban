// A small markdown renderer for task files: headings, paragraphs, emphasis, code, links, block quotes,
// tables, rules, and nested lists with task checkboxes. Every checkbox carries data-line, the 0-based line
// of the file it came from, so the board can tick it in the file itself.
//
// Input is escaped before any markup is added, and only http(s), mailto and relative URLs become links.
(function (global) {
    'use strict';

    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const esc = s => String(s).replace(/[&<>"']/g, ch => ESC[ch]);

    const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)/;
    const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

    function safeUrl(url) {
        const u = url.replace(/&amp;/g, '&');
        return !/^[a-z][a-z0-9+.-]*:/i.test(u) || /^(https?|mailto):/i.test(u);
    }

    function inline(src) {
        const codes = [];
        let s = src.replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
        s = esc(s);
        s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => safeUrl(url) ? `<img alt="${alt}" src="${url}">` : m);
        s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
            safeUrl(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>` : m);
        s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
        s = s.replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(?=\S)(.+?)__/g, '<strong>$1</strong>');
        s = s.replace(/(^|[^*\w])\*(?=\S)(.+?)\*(?![*\w])/g, '$1<em>$2</em>');
        s = s.replace(/(^|[^_\w])_(?=\S)(.+?)_(?![_\w])/g, '$1<em>$2</em>');
        s = s.replace(/~~(?=\S)(.+?)~~/g, '<del>$1</del>');
        return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(codes[n])}</code>`);
    }

    function cells(row) {
        return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    }

    // options.skipTitle drops the first "# " heading, which the board shows separately.
    function render(md, options = {}) {
        const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
        return renderLines(lines, 0, lines.length, options);
    }

    function renderLines(lines, from, to, options) {
        let html = '';
        let para = [];
        let skipTitle = !!options.skipTitle;
        const flush = () => {
            if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`;
            para = [];
        };
        // Soft-wrapped paragraph lines join with a space; the <br> above is only for explicit breaks.
        const pushPara = line => {
            if (para.length && !/ {2,}$|\\$/.test(para[para.length - 1])) para[para.length - 1] += ' ' + line.trim();
            else {
                if (para.length) para[para.length - 1] = para[para.length - 1].replace(/ {2,}$|\\$/, '');
                para.push(line.trim());
            }
        };

        let i = from;
        while (i < to) {
            const line = lines[i];

            const fence = line.match(FENCE);
            if (fence) {
                flush();
                const close = new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
                const body = [];
                i++;
                while (i < to && !close.test(lines[i])) body.push(lines[i++]);
                i++;
                const lang = fence[2] ? ` class="lang-${esc(fence[2])}"` : '';
                html += `<pre><code${lang}>${esc(body.join('\n'))}</code></pre>`;
                continue;
            }

            if (!line.trim()) { flush(); i++; continue; }

            const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
            if (heading) {
                flush();
                if (skipTitle && heading[1].length === 1) { skipTitle = false; i++; continue; }
                const n = heading[1].length;
                html += `<h${n}>${inline(heading[2])}</h${n}>`;
                i++;
                continue;
            }
            skipTitle = false;

            if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html += '<hr>'; i++; continue; }

            if (/^\s*>/.test(line)) {
                flush();
                const quoted = [];
                while (i < to && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
                html += `<blockquote>${renderLines(quoted, 0, quoted.length, {})}</blockquote>`;
                continue;
            }

            if (line.includes('|') && i + 1 < to && TABLE_RULE.test(lines[i + 1])) {
                flush();
                const align = cells(lines[i + 1]).map(c => /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : '');
                const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
                html += '<table><thead><tr>' + cells(line).map((c, k) => td('th', c, k)).join('') + '</tr></thead><tbody>';
                i += 2;
                while (i < to && lines[i].includes('|') && lines[i].trim()) {
                    html += '<tr>' + cells(lines[i]).map((c, k) => td('td', c, k)).join('') + '</tr>';
                    i++;
                }
                html += '</tbody></table>';
                continue;
            }

            if (LIST.test(line) && !(para.length && /^\s*\d/.test(line) && !/^\s*1[.)]/.test(line))) {
                flush();
                const items = [];
                while (i < to) {
                    const m = lines[i].match(LIST);
                    if (m) {
                        items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3], line: i });
                        i++;
                    } else if (items.length && /^\s+\S/.test(lines[i])) {
                        items[items.length - 1].text += ' ' + lines[i].trim();
                        i++;
                    } else if (items.length && !lines[i].trim() && i + 1 < to && (LIST.test(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))) {
                        i++;
                    } else break;
                }
                html += renderList(items);
                continue;
            }

            pushPara(line);
            i++;
        }
        flush();
        return html;
    }

    function renderList(items) {
        let pos = 0;
        function level() {
            const base = items[pos].indent;
            const ordered = items[pos].ordered;
            const tag = ordered ? 'ol' : 'ul';
            let out = '';
            // A sibling of the other kind (bullets then numbers) starts a new list.
            while (pos < items.length && items[pos].indent >= base && !(items[pos].indent === base && items[pos].ordered !== ordered)) {
                if (items[pos].indent > base) {
                    out = out.replace(/<\/li>$/, '') + level() + '</li>';
                    continue;
                }
                const it = items[pos++];
                const task = it.text.match(/^\[([ xX])\]\s+(\S.*)$/);
                if (task) {
                    const checked = task[1] !== ' ';
                    out += `<li class="task${checked ? ' checked' : ''}"><input type="checkbox" data-line="${it.line}"${checked ? ' checked' : ''}> <span>${inline(task[2])}</span></li>`;
                } else {
                    out += `<li>${inline(it.text)}</li>`;
                }
            }
            return `<${tag}>${out}</${tag}>`;
        }
        let html = '';
        while (pos < items.length) html += level();
        return html;
    }

    global.markdown = { render, inline, esc };
})(typeof window !== 'undefined' ? window : globalThis);
