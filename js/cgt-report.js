/**
 * Tax Report tab — ported from CGT-tracker's public/js/report.js.
 */
'use strict';

async function renderCgtReport(app) {
    app.innerHTML = '';

    const card = cgtEl('div', { class: 'card' });
    card.innerHTML = '<h2>Tax Report</h2>';

    const controlRow = cgtEl('div', { class: 'filters', style: 'margin-bottom:1rem' });
    const yearSel = cgtEl('select', { id: 'cgt-report-year' });
    yearSel.innerHTML = '<option value="">Select year…</option>';
    const printBtn = cgtEl('button', { class: 'btn btn-outline', onclick: () => window.print() }, 'Print');

    controlRow.appendChild(cgtEl('label', {}, 'Tax Year', yearSel));
    controlRow.appendChild(printBtn);
    card.appendChild(controlRow);

    const lossCard = cgtEl('div', { class: 'card' });
    lossCard.innerHTML = '<h2>External Losses</h2><p style="font-size:.82rem;color:var(--cgt-muted);margin-bottom:.75rem">Enter losses incurred in a specific year from share transactions <em>outside</em> this system (e.g. another broker). The loss is applied within that year\'s CGT computation — offsetting gains in the same year first, with any surplus carried forward automatically.</p>';
    const lossTableWrap = cgtEl('div', {});
    const lossForm = cgtEl('div', { class: 'loss-pool-form' });
    const lossYearInp = cgtEl('input', { type: 'number', placeholder: 'Year (e.g. 2021)', min: '2000', max: '2099' });
    const lossAmtInp = cgtEl('input', { type: 'text', placeholder: 'Loss amount (€)' });
    const lossSaveBtn = cgtEl('button', { class: 'btn btn-primary' }, 'Save');
    const lossMsgDiv = cgtEl('div', {});

    lossForm.appendChild(cgtEl('label', {}, 'Year', lossYearInp));
    lossForm.appendChild(cgtEl('label', {}, 'Loss Amount (€)', lossAmtInp));
    lossForm.appendChild(lossSaveBtn);
    lossForm.appendChild(lossMsgDiv);
    lossCard.appendChild(lossTableWrap);
    lossCard.appendChild(lossForm);

    lossSaveBtn.onclick = async () => {
        const year = parseInt(lossYearInp.value);
        const amt = lossAmtInp.value.trim();
        if (!year || !amt) { cgtShowMsg(lossMsgDiv, 'Enter year and amount.'); return; }
        try {
            await cgtApi('/report/loss-pool/' + year, { method: 'PUT', body: JSON.stringify({ loss_amount: amt }) });
            cgtShowMsg(lossMsgDiv, 'Saved.', 'success');
            lossYearInp.value = '';
            lossAmtInp.value = '';
            loadLossPool();
            if (yearSel.value) loadReport(parseInt(yearSel.value));
        } catch (err) { cgtShowMsg(lossMsgDiv, err.message); }
    };

    const reportDiv = cgtEl('div', {});
    app.appendChild(card);
    app.appendChild(lossCard);
    app.appendChild(reportDiv);

    async function loadLossPool() {
        try {
            const rows = await cgtApi('/report/loss-pool');
            if (rows.length === 0) {
                lossTableWrap.innerHTML = '<p style="font-size:.82rem;color:var(--cgt-muted);margin-bottom:.5rem">No manual losses entered.</p>';
                return;
            }
            const table = cgtEl('table', { style: 'margin-bottom:.75rem' });
            table.innerHTML = '<thead><tr><th>Year Incurred</th><th class="num">Amount (€)</th><th></th></tr></thead>';
            const tbody = cgtEl('tbody', {});
            for (const r of rows) {
                const tr = cgtEl('tr', {});
                const delBtn = cgtEl('button', { class: 'btn btn-danger btn-sm' }, 'Remove');
                delBtn.onclick = async () => {
                    try {
                        await cgtApi('/report/loss-pool/' + r.tax_year, { method: 'PUT', body: JSON.stringify({ loss_amount: '0' }) });
                        loadLossPool();
                        if (yearSel.value) loadReport(parseInt(yearSel.value));
                    } catch (err) { alert(err.message); }
                };
                tr.innerHTML = `<td>${r.tax_year}</td><td class="num">${cgtEur(r.loss_amount)}</td>`;
                const td = cgtEl('td', {}); td.appendChild(delBtn); tr.appendChild(td);
                tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            lossTableWrap.innerHTML = '';
            lossTableWrap.appendChild(table);
        } catch (_) { /* ignore */ }
    }

    async function loadReport(year) {
        reportDiv.innerHTML = '<p class="loading">Computing…</p>';
        try {
            const r = await cgtApi('/report/' + year);
            renderReportResult(r);
        } catch (err) {
            reportDiv.innerHTML = `<p class="error-msg">${err.message}</p>`;
        }
    }

    function renderReportResult(r) {
        const netGain = parseFloat(r.netGain);
        const netClass = netGain > 0 ? 'gain-pos' : (netGain < 0 ? 'gain-neg' : '');

        const summary = cgtEl('div', { class: 'card' });
        summary.innerHTML = `<h2>Tax Year ${r.year} — Summary</h2>`;

        const grid = cgtEl('div', { class: 'cgt-summary-grid' });
        const items = [
            { label: 'Total Proceeds', tip: 'The total amount received from all share sales in the year, before deducting selling costs.',
                value: cgtEur(r.totalProceeds) },
            { label: 'Total Cost Basis', tip: 'The original purchase cost of the shares sold, calculated using the Irish matching rules (same-day, 4-week, then FIFO). Includes buying costs such as transaction fees.',
                value: cgtEur(r.totalCostBasis) },
            { label: 'Gross Gains', tip: 'Sum of all profitable disposals in the year (where proceeds exceeded cost basis).',
                value: cgtEur(r.grossGains), cls: 'gain-pos' },
            { label: 'Gross Losses', tip: 'Sum of all loss-making disposals in the year (where cost basis exceeded proceeds), plus any external losses entered manually for this year.',
                value: r.grossLosses !== '0.00' ? '-' + cgtEur(r.grossLosses) : cgtEur(0), cls: r.grossLosses !== '0.00' ? 'gain-neg' : '' },
            { label: 'Prior Losses Applied', tip: 'Unused losses carried forward from previous years. These are offset against this year\'s net gain before the annual exemption is applied.',
                value: r.priorLossApplied !== '0.00' ? '-' + cgtEur(r.priorLossApplied) : '—' },
            { label: 'Net Gain', tip: 'Gross Gains minus Gross Losses minus Prior Losses Applied. If negative, the full amount carries forward to future years.',
                value: cgtEur(r.netGain), cls: netClass },
            { label: 'Annual Exemption (€1,270)', tip: 'Every individual is entitled to a €1,270 CGT exemption each year. It reduces your taxable gain but cannot create or increase a loss.',
                value: r.exemptionApplied !== '0.00' ? '-' + cgtEur(r.exemptionApplied) : '—' },
            { label: 'Taxable Gain', tip: 'The amount of gain subject to CGT at 33%. This is the Net Gain after subtracting the annual €1,270 exemption.',
                value: cgtEur(r.taxableGain), cls: 'highlight' },
            { label: 'CGT Owed (33%)', tip: 'Irish Capital Gains Tax is charged at 33% on the taxable gain. Payable by 15 December for gains made between 1 January and 30 November, or 31 January for gains in December.',
                value: cgtEur(r.taxOwed), cls: 'tax-owed' },
            { label: 'Loss to Carry Forward', tip: 'Any net loss remaining after offsetting all gains is carried forward indefinitely and applied against gains in future years.',
                value: r.lossCarryForward !== '0.00' ? cgtEur(r.lossCarryForward) : '—' },
        ];
        for (const item of items) {
            const div = cgtEl('div', { class: 'cgt-summary-item' + (item.cls && (item.cls === 'highlight' || item.cls === 'tax-owed') ? ' ' + item.cls : '') });
            const tipHtml = item.tip ? `<span class="cgt-tip" data-tip="${item.tip.replace(/"/g, '&quot;')}">?</span>` : '';
            div.innerHTML = `<div class="label">${item.label}${tipHtml}</div><div class="value ${item.cls || ''}">${item.value}</div>`;
            grid.appendChild(div);
        }
        summary.appendChild(grid);
        reportDiv.innerHTML = '';
        reportDiv.appendChild(summary);

        if (r.disposals.length === 0) {
            reportDiv.innerHTML += '<p class="empty-state">No disposals in this year.</p>';
            return;
        }

        const dispCard = cgtEl('div', { class: 'card' });
        dispCard.innerHTML = '<h2>Disposals</h2>';
        const wrap = cgtEl('div', { class: 'table-wrap' });
        const table = cgtEl('table', {});
        table.innerHTML = `
      <thead><tr>
        <th>Date</th><th>ISIN</th><th>Name</th>
        <th class="num">Qty</th><th class="num">Proceeds (€)</th>
        <th class="num">Cost Basis (€)</th><th class="num">Gain / Loss (€)</th>
        <th>Matching</th>
      </tr></thead>
    `;
        const tbody = cgtEl('tbody', {});
        for (const d of r.disposals) {
            const gain = parseFloat(d.gain);
            const tr = cgtEl('tr', {});
            const m = d.matching_detail;
            const matchParts = [];
            if (parseFloat(m.same_day.qty) > 0) matchParts.push(`Same-day: ${cgtFmtQty(m.same_day.qty)}`);
            if (parseFloat(m.four_week.qty) > 0) matchParts.push(`4-week: ${cgtFmtQty(m.four_week.qty)}`);
            if (parseFloat(m.fifo.qty) > 0) matchParts.push(`FIFO: ${cgtFmtQty(m.fifo.qty)}`);
            tr.innerHTML = `
        <td>${d.date}</td>
        <td>${d.isin}</td>
        <td>${d.product_name}</td>
        <td class="num">${cgtFmtQty(d.quantity)}</td>
        <td class="num">${cgtEur(d.proceeds)}</td>
        <td class="num">${cgtEur(d.cost_basis)}</td>
        <td class="num ${gain >= 0 ? 'gain-pos' : 'gain-neg'}">${gain < 0 ? '-' : ''}${cgtEur(Math.abs(gain))}</td>
        <td style="font-size:.78rem;color:var(--cgt-muted)">${matchParts.join(', ') || '—'}</td>
      `;
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        dispCard.appendChild(wrap);
        reportDiv.appendChild(dispCard);
    }

    try {
        const years = await cgtApi('/report/years');
        years.forEach(y => {
            const opt = document.createElement('option');
            opt.value = opt.textContent = y;
            yearSel.appendChild(opt);
        });
        if (years.length > 0) {
            yearSel.value = years[years.length - 1];
            loadReport(parseInt(yearSel.value));
        }
    } catch (_) { /* ignore */ }

    yearSel.onchange = () => { if (yearSel.value) loadReport(parseInt(yearSel.value)); };
    loadLossPool();
}
