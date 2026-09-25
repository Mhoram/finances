/**
 * Cash Flow tab — reads cash_transactions (bank-synced via Enable Banking and
 * CSV imports) from the server's /cashflow endpoints. Uses the shared cgt*
 * helpers (cgtApi, cgtEl, cgtEur) from cgt-ui.js.
 */
'use strict';

const CashflowApp = {
    initialized: false,
    accounts: [],
    offset: 0,
    limit: 100,
    total: 0,
};

async function renderCashflow(app) {
    app.innerHTML = '';

    // --- Load accounts for the filter dropdown ---
    try {
        const connections = await cgtApi('/bank-sync/connections');
        CashflowApp.accounts = connections.flatMap(c => c.accounts || []);
    } catch (_) {
        CashflowApp.accounts = [];
    }

    // --- Header + summary cards ---
    const summaryCards = cgtEl('div', { class: 'cgt-cards' });
    const cards = {
        moneyIn: cgtEl('div', { class: 'card cgt-stat' },
            cgtEl('h3', {}, 'Money In'), cgtEl('div', { class: 'cgt-stat-value cf-in', id: 'cfMoneyIn' }, '—')),
        moneyOut: cgtEl('div', { class: 'card cgt-stat' },
            cgtEl('h3', {}, 'Money Out'), cgtEl('div', { class: 'cgt-stat-value cf-out', id: 'cfMoneyOut' }, '—')),
        net: cgtEl('div', { class: 'card cgt-stat' },
            cgtEl('h3', {}, 'Net'), cgtEl('div', { class: 'cgt-stat-value', id: 'cfNet' }, '—')),
        count: cgtEl('div', { class: 'card cgt-stat' },
            cgtEl('h3', {}, 'Transactions'), cgtEl('div', { class: 'cgt-stat-value', id: 'cfCount' }, '—')),
    };
    Object.values(cards).forEach(c => summaryCards.appendChild(c));

    // --- Filters ---
    const accountSelect = cgtEl('select', { id: 'cfAccountFilter' },
        cgtEl('option', { value: '' }, 'All accounts'));
    CashflowApp.accounts.forEach(a => {
        const label = a.display_name + (a.iban ? ` (${a.iban})` : '');
        accountSelect.appendChild(cgtEl('option', { value: a.id }, label));
    });

    const filters = cgtEl('div', { class: 'card', style: 'margin-bottom:1rem' },
        cgtEl('div', { class: 'form-grid', style: 'grid-template-columns: 1fr 1fr 1fr 2fr auto' },
            labelWrap('Account', accountSelect),
            labelWrap('From', cgtEl('input', { type: 'date', id: 'cfDateFrom' })),
            labelWrap('To', cgtEl('input', { type: 'date', id: 'cfDateTo' })),
            labelWrap('Search', cgtEl('input', { type: 'search', id: 'cfSearch', placeholder: 'counterparty or description…' })),
            cgtEl('button', { class: 'btn btn-primary', onclick: () => { CashflowApp.offset = 0; loadCashflow(); } }, 'Apply'),
        ),
    );

    // --- Monthly chart ---
    const chartCard = cgtEl('div', { class: 'card', style: 'margin-bottom:1rem' },
        cgtEl('h2', {}, 'Monthly Cash Flow'), cgtEl('div', { id: 'cfChart' }));

    // --- Transactions table ---
    const tableCard = cgtEl('div', { class: 'card' },
        cgtEl('h2', {}, 'Transactions'),
        cgtEl('div', { class: 'table-wrapper' },
            cgtEl('table', { class: 'amortization-table', id: 'cfTable' },
                cgtEl('thead', {},
                    cgtEl('tr', {},
                        cgtEl('th', {}, 'Date'),
                        cgtEl('th', {}, 'Account'),
                        cgtEl('th', {}, 'Counterparty'),
                        cgtEl('th', {}, 'Description'),
                        cgtEl('th', {}, 'Source'),
                        cgtEl('th', { class: 'num' }, 'Amount')))),
        ),
        cgtEl('div', { class: 'table-summary', style: 'display:flex;justify-content:space-between;align-items:center' },
            cgtEl('span', { id: 'cfPageInfo' }, ''),
            cgtEl('div', {},
                cgtEl('button', { class: 'btn', id: 'cfPrev', onclick: () => pageBy(-1) }, '← Prev'),
                ' ',
                cgtEl('button', { class: 'btn', id: 'cfNext', onclick: () => pageBy(1) }, 'Next →'),
            ),
        ),
    );

    function labelWrap(text, control) {
        const l = cgtEl('label', {}, text);
        l.appendChild(control);
        return l;
    }

    function pageBy(delta) {
        CashflowApp.offset = Math.max(0, CashflowApp.offset + delta * CashflowApp.limit);
        loadCashflow();
    }

    app.appendChild(summaryCards);
    app.appendChild(filters);
    app.appendChild(chartCard);
    app.appendChild(tableCard);

    async function loadCashflow() {
        const params = new URLSearchParams();
        const accountId = document.getElementById('cfAccountFilter').value;
        const from = document.getElementById('cfDateFrom').value;
        const to = document.getElementById('cfDateTo').value;
        const q = document.getElementById('cfSearch').value;
        if (accountId) params.set('account_id', accountId);
        if (from) params.set('date_from', from);
        if (to) params.set('date_to', to);
        if (q) params.set('q', q);
        params.set('limit', CashflowApp.limit);
        params.set('offset', CashflowApp.offset);

        // Summary + chart
        try {
            const sum = await cgtApi('/cashflow/summary?' + params);
            document.getElementById('cfMoneyIn').textContent = cgtEur(sum.totals.money_in);
            document.getElementById('cfMoneyOut').textContent = cgtEur(sum.totals.money_out);
            const net = document.getElementById('cfNet');
            net.textContent = cgtEur(sum.totals.net);
            net.style.color = sum.totals.net >= 0 ? 'var(--cgt-green, #27ae60)' : 'var(--cgt-red, #e74c3c)';
            document.getElementById('cfCount').textContent = sum.totals.tx_count.toLocaleString('en-IE');
            renderCashflowChart(document.getElementById('cfChart'), sum.months);
        } catch (err) {
            document.getElementById('cfChart').innerHTML = `<p class="error-msg">Summary failed: ${err.message}</p>`;
        }

        // Table
        try {
            const data = await cgtApi('/cashflow/transactions?' + params);
            CashflowApp.total = data.total;
            const tbody = document.querySelector('#cfTable tbody') ||
                document.getElementById('cfTable').appendChild(cgtEl('tbody'));
            tbody.innerHTML = '';
            for (const t of data.rows) {
                const amount = Number(t.amount_eur);
                const tr = cgtEl('tr', {},
                    cgtEl('td', {}, t.date),
                    cgtEl('td', {}, t.account_name || '—'),
                    cgtEl('td', {}, t.counterparty || '—'),
                    cgtEl('td', {}, t.description || ''),
                    cgtEl('td', {}, t.source),
                    cgtEl('td', { class: 'num', style: `color:${amount >= 0 ? 'var(--cgt-green, #27ae60)' : 'var(--cgt-red, #e74c3c)'};font-weight:600` },
                        (amount >= 0 ? '+' : '') + cgtEur(amount)),
                );
                tbody.appendChild(tr);
            }
            if (!data.rows.length) {
                tbody.appendChild(cgtEl('tr', {}, cgtEl('td', { colspan: '6', style: 'text-align:center;padding:2rem' },
                    'No transactions match these filters.')));
            }
            const start = data.offset + 1;
            const end = data.offset + data.rows.length;
            document.getElementById('cfPageInfo').textContent =
                data.total ? `Showing ${start}–${end} of ${data.total.toLocaleString('en-IE')}` : 'No transactions';
            document.getElementById('cfPrev').disabled = data.offset === 0;
            document.getElementById('cfNext').disabled = end >= data.total;
        } catch (err) {
            cgtShowMsg(tableCard, 'Failed to load transactions: ' + err.message);
        }
    }

    // Enter in the search box applies filters
    document.getElementById('cfSearch').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { CashflowApp.offset = 0; loadCashflow(); }
    });

    await loadCashflow();
}

/**
 * Monthly in/out bar chart (pure SVG, matching the CGT tabs' chart style).
 * Green bars above the baseline = money in; red below = money out.
 */
function renderCashflowChart(container, months) {
    container.innerHTML = '';
    if (!months || !months.length) {
        container.appendChild(cgtEl('p', {}, 'No data for this range.'));
        return;
    }
    // Keep the chart readable — show at most the last 24 months.
    const data = months.slice(-24);
    const max = Math.max(...data.map(m => Math.max(Number(m.money_in), Number(m.money_out))), 1);

    const W = 100, H = 40, pad = 2, mid = H / 2;
    const slot = (W - pad * 2) / data.length;
    const barW = Math.min(slot * 0.4, 3);

    let bars = '';
    data.forEach((m, i) => {
        const cx = pad + slot * i + slot / 2;
        const inH = (Number(m.money_in) / max) * (mid - pad);
        const outH = (Number(m.money_out) / max) * (mid - pad);
        bars += `<rect x="${(cx - barW - 0.3).toFixed(2)}" y="${(mid - inH).toFixed(2)}" width="${barW.toFixed(2)}" height="${inH.toFixed(2)}" fill="#27ae60"/>`;
        bars += `<rect x="${(cx + 0.3).toFixed(2)}" y="${mid}" width="${barW.toFixed(2)}" height="${outH.toFixed(2)}" fill="#e74c3c"/>`;
    });

    const first = data[0].month, last = data[data.length - 1].month;
    const wrap = cgtEl('div', { style: 'margin-bottom:0.5rem' });
    wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:180px;display:block">
      <line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="var(--cgt-border, #ddd)" stroke-width="0.15"/>
      ${bars}
    </svg>
    <div style="display:flex;justify-content:space-between;font-size:0.8rem;opacity:0.7">
      <span>${first}</span>
      <span>🟢 in &nbsp; 🔴 out</span>
      <span>${last}</span>
    </div>`;
    container.appendChild(wrap);
}
