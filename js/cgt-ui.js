/**
 * Shared DOM/formatting/API helpers for the CGT/Holdings/Net Worth tabs.
 * Ported from CGT-tracker's public/js/app.js, talking to the server in
 * server/ (see js/cgt-config.js for the API base URL) instead of a
 * same-origin Express app.
 */
'use strict';

// window.CGT_API_BASE isn't set — falls back to a same-origin relative path,
// which works if you reverse-proxy /api/* to the server alongside the static
// site. Otherwise copy js/cgt-config.example.js to js/cgt-config.js and set
// CGT_API_BASE to the server's full URL.
const CGT_API_BASE_DEFAULT = '/api/v1';

async function cgtApi(path, opts = {}) {
    const base = (typeof CGT_API_BASE !== 'undefined' && CGT_API_BASE) || CGT_API_BASE_DEFAULT;
    const res = await fetch(base + path, {
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        ...opts,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
}

function cgtFmt(num, dp = 2) {
    return Number(num).toLocaleString('en-IE', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function cgtFmtQty(num) {
    const n = Number(num);
    if (Number.isInteger(n)) return n.toLocaleString('en-IE');
    return n.toLocaleString('en-IE', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

function cgtEur(num) {
    return '€' + cgtFmt(num, 2);
}

function cgtEl(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e[k] = v;
        else e.setAttribute(k, v);
    }
    for (const c of children) {
        if (c == null) continue;
        e.append(typeof c === 'string' ? c : c);
    }
    return e;
}

function cgtShowMsg(container, msg, type = 'error') {
    const d = cgtEl('p', { class: type === 'error' ? 'error-msg' : 'success-msg' }, msg);
    container.appendChild(d);
    setTimeout(() => d.remove(), 4000);
}
