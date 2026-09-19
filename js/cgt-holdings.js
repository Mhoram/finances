/**
 * Holdings tab — ported from CGT-tracker's public/js/holdings.js.
 */
'use strict';

async function renderCgtHoldings(app) {
    app.innerHTML = '<p class="loading">Loading holdings…</p>';

    let data;
    try {
        data = await cgtApi('/holdings');
    } catch (err) {
        app.innerHTML = `<p class="error-msg">${err.message}</p>`;
        return;
    }

    app.innerHTML = '';

    const hint = cgtEl('p', { style: 'font-size:.82rem;color:var(--cgt-muted);margin-bottom:.75rem' },
        'Prices are entered manually — click any price (or the — placeholder) in the table below to set or update it.');
    app.appendChild(hint);

    const priced = data.filter(h => h.current_value_eur !== null);
    if (priced.length > 0) {
        const totalCost = priced.reduce((s, h) => s + Number(h.total_cost_eur), 0);
        const totalValue = priced.reduce((s, h) => s + Number(h.current_value_eur), 0);
        const totalGain = totalValue - totalCost;
        const totalPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;

        const summary = cgtEl('div', { class: 'cgt-summary-grid' });
        summary.appendChild(cgtSummaryItem('Total Cost Basis', cgtEur(totalCost)));
        summary.appendChild(cgtSummaryItem('Current Value', cgtEur(totalValue), 'highlight'));
        const gainClass = totalGain >= 0 ? '' : 'tax-owed';
        summary.appendChild(cgtSummaryItem(
            'Unrealised Gain / Loss',
            (totalGain >= 0 ? '+' : '') + cgtEur(totalGain) + '  (' + (totalPct >= 0 ? '+' : '') + cgtFmt(totalPct) + '%)',
            gainClass,
        ));

        const card0 = cgtEl('div', { class: 'card' });
        card0.appendChild(cgtEl('h2', {}, 'Portfolio Unrealised P&L'));
        card0.appendChild(summary);
        app.appendChild(card0);
    }

    const card = cgtEl('div', { class: 'card' });
    card.innerHTML = '<h2>Current Holdings</h2>';

    if (data.length === 0) {
        card.innerHTML += '<p class="empty-state">No open positions.</p>';
        app.appendChild(card);
        return;
    }

    const wrap = cgtEl('div', { class: 'table-wrap' });
    const table = cgtEl('table', {});
    table.innerHTML = `
    <thead><tr>
      <th></th><th>ISIN</th><th>Name</th>
      <th class="num">Qty Held</th>
      <th class="num">Avg Cost</th>
      <th class="num">Total Cost Basis</th>
      <th class="num">Current Price</th>
      <th class="num">Current Value</th>
      <th class="num">Unrealised G/L</th>
      <th class="num">%</th>
    </tr></thead>
  `;
    const tbody = cgtEl('tbody', {});

    for (const h of data) {
        const mainRow = cgtEl('tr', {});
        const expandBtn = cgtEl('button', { class: 'cgt-expand-btn' }, '▶');

        const gainEur = h.unrealised_eur !== null ? Number(h.unrealised_eur) : null;
        const gainPct = h.unrealised_pct !== null ? Number(h.unrealised_pct) : null;
        const gainEurClass = gainEur === null ? '' : gainEur >= 0 ? 'gain-pos' : 'gain-neg';
        const gainPctClass = gainPct === null ? '' : gainPct >= 0 ? 'gain-pos' : 'gain-neg';

        mainRow.appendChild(cgtEl('td', {}, expandBtn));
        mainRow.appendChild(cgtEl('td', {}, h.isin));
        mainRow.appendChild(cgtEl('td', {}, h.product_name));
        mainRow.appendChild(cgtEl('td', { class: 'num' }, cgtFmtQty(h.total_quantity)));
        mainRow.appendChild(cgtEl('td', { class: 'num' }, cgtEur(h.avg_cost_eur)));
        mainRow.appendChild(cgtEl('td', { class: 'num' }, cgtEur(h.total_cost_eur)));
        mainRow.appendChild(buildPriceCell(h));
        mainRow.appendChild(cgtEl('td', { class: 'num' }, h.current_value_eur !== null ? cgtEur(h.current_value_eur) : '—'));
        mainRow.appendChild(cgtEl('td', { class: 'num ' + gainEurClass },
            gainEur !== null ? (gainEur >= 0 ? '+' : '') + cgtEur(gainEur) : '—'));
        mainRow.appendChild(cgtEl('td', { class: 'num ' + gainPctClass },
            gainPct !== null ? (gainPct >= 0 ? '+' : '') + cgtFmt(gainPct) + '%' : '—'));

        const lotRows = h.lots.map(lot => {
            const tr = cgtEl('tr', { class: 'cgt-lots-row', style: 'display:none' });
            tr.innerHTML = `
        <td></td>
        <td colspan="2" style="padding-left:2rem;color:var(--cgt-muted)">Lot #${lot.id} — ${lot.date}</td>
        <td class="num">${cgtFmtQty(lot.quantity_held)}</td>
        <td class="num">${cgtEur(lot.price_eur)}</td>
        <td class="num">${cgtEur(lot.cost_basis)}</td>
        <td colspan="4"></td>
      `;
            return tr;
        });

        let expanded = false;
        expandBtn.onclick = () => {
            expanded = !expanded;
            expandBtn.textContent = expanded ? '▼' : '▶';
            lotRows.forEach(r => r.style.display = expanded ? '' : 'none');
        };

        tbody.appendChild(mainRow);
        lotRows.forEach(r => tbody.appendChild(r));
    }

    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    app.appendChild(card);
}

function cgtSummaryItem(label, value, extraClass = '') {
    const d = cgtEl('div', { class: 'cgt-summary-item' + (extraClass ? ' ' + extraClass : '') });
    d.appendChild(cgtEl('div', { class: 'label' }, label));
    d.appendChild(cgtEl('div', { class: 'value' }, value));
    return d;
}

function buildPriceCell(h) {
    const td = cgtEl('td', { class: 'num' });

    function showDisplay() {
        td.innerHTML = '';
        if (h.current_price_eur === null) {
            const dash = cgtEl('span', { style: 'cursor:pointer;color:var(--cgt-muted)' }, '—');
            dash.title = 'Click to enter price manually';
            dash.onclick = showEdit;
            td.appendChild(dash);
            return;
        }

        const nonEur = h.currency && h.currency !== 'EUR';
        const label = cgtEur(h.current_price_eur) + (nonEur ? ` (${h.currency})` : '');
        const dated = h.price_updated_at ? h.price_updated_at.slice(0, 16).replace('T', ' ') : '';
        const span = cgtEl('span', { style: 'cursor:pointer;border-bottom:1px dashed var(--cgt-muted)' }, label);
        span.title = (h.ticker ? h.ticker + ' · ' : '') + (dated ? 'as of ' + dated : '');
        span.onclick = showEdit;
        td.appendChild(span);
        if (nonEur) {
            const warn = cgtEl('span', {
                class: 'cgt-tip',
                'data-tip': `Price is in ${h.currency}, not EUR. The gain/loss figures are indicative only — apply the EUR/FX rate on the date of any disposal for actual CGT.`,
            }, '!');
            td.appendChild(warn);
        }
    }

    function showEdit() {
        td.innerHTML = '';
        const input = cgtEl('input', {
            type: 'number', min: '0', step: 'any',
            style: 'width:80px;font-size:.8rem',
            value: h.current_price_eur !== null ? h.current_price_eur : '',
        });
        const saveBtn = cgtEl('button', { class: 'btn btn-primary btn-sm', style: 'margin-left:4px' }, 'Save');
        const removeBtn = cgtEl('button', { class: 'btn btn-danger btn-sm', style: 'margin-left:2px' }, 'Remove');
        const cancelBtn = cgtEl('button', { class: 'btn btn-outline btn-sm', style: 'margin-left:2px' }, '✕');

        saveBtn.onclick = async () => {
            const val = input.value.trim();
            if (!val) return;
            try {
                await cgtApi('/prices/' + h.isin, { method: 'PUT', body: JSON.stringify({ price_eur: val }) });
                renderCgtHoldings(document.getElementById('holdingsTab'));
            } catch (e) {
                alert('Error saving price: ' + e.message);
            }
        };

        removeBtn.onclick = async () => {
            try {
                await cgtApi('/prices/' + h.isin, { method: 'DELETE' });
                renderCgtHoldings(document.getElementById('holdingsTab'));
            } catch (e) {
                alert('Error removing price: ' + e.message);
            }
        };

        cancelBtn.onclick = showDisplay;
        input.onkeydown = e => {
            if (e.key === 'Enter') saveBtn.onclick();
            if (e.key === 'Escape') cancelBtn.onclick();
        };

        td.appendChild(input);
        td.appendChild(saveBtn);
        if (h.current_price_eur !== null) td.appendChild(removeBtn);
        td.appendChild(cancelBtn);
        input.focus();
        input.select();
    }

    showDisplay();
    return td;
}
