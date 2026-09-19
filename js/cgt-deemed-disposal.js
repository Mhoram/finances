/**
 * Deemed Disposal tab — ported from CGT-tracker's public/js/deemed-disposal.js.
 */
'use strict';

let cgtDdShowAllIsins = false;

async function renderCgtDeemedDisposal(app) {
    app.innerHTML = '<p class="loading">Loading…</p>';

    let flags, schedule;
    try {
        [flags, schedule] = await Promise.all([
            cgtApi('/deemed-disposal/etf-flags'),
            cgtApi('/deemed-disposal'),
        ]);
    } catch (err) {
        app.innerHTML = `<p class="error-msg">${err.message}</p>`;
        return;
    }

    app.innerHTML = '';

    const intro = cgtEl('div', { class: 'card' });
    intro.innerHTML = `
    <h2>Deemed Disposal (ETF Exit Tax)</h2>
    <p style="font-size:.82rem;color:var(--cgt-muted);line-height:1.5">
      Irish tax law treats "equivalent" offshore funds — most UCITS ETFs — separately from ordinary shares.
      Instead of CGT, gains are taxed at 41% (2014&ndash;2025) or 38% (2026 onward, Finance Act 2025) under
      TCA 1997 s.747E, with a <strong>deemed disposal every 8 years</strong> per holding lot even if you
      haven't sold, and <strong>no relief for losses</strong>. Tax already paid on a deemed disposal is a
      non-refundable credit against tax due on an eventual real sale.
      This page is not professional tax advice &mdash; verify against Revenue's current
      Tax and Duty Manual Part 27-04-01 before filing, since rates and rules can change.
    </p>
  `;
    app.appendChild(intro);

    const flagsCard = cgtEl('div', { class: 'card' });
    flagsCard.innerHTML = `
    <h2>ETF Classification</h2>
    <p style="font-size:.82rem;color:var(--cgt-muted);margin-bottom:.75rem">
      Auto-detected from product names containing "ETF". Names truncated by CSV imports (e.g. broker
      exports) may be missed &mdash; override manually. Toggling this changes which regime a holding's
      disposals are reported under, including on the Tax Report page for past years.
    </p>
  `;
    const etfFlagCount = flags.filter(f => f.is_etf).length;
    const filterRow = cgtEl('label', { style: 'display:inline-flex;align-items:center;gap:.4rem;font-size:.82rem;font-weight:400;margin-bottom:.5rem' });
    const showAllCheckbox = cgtEl('input', { type: 'checkbox' });
    showAllCheckbox.checked = cgtDdShowAllIsins;
    filterRow.appendChild(showAllCheckbox);
    filterRow.appendChild(document.createTextNode(
        `Show all ${flags.length} ISINs (currently showing ${etfFlagCount} tagged as ETF)`
    ));
    showAllCheckbox.onchange = () => {
        cgtDdShowAllIsins = showAllCheckbox.checked;
        renderFlagsRows();
    };
    flagsCard.appendChild(filterRow);

    const flagsWrap = cgtEl('div', { class: 'table-wrap' });
    const flagsTable = cgtEl('table', {});
    flagsTable.innerHTML = `<thead><tr><th>ISIN</th><th>Name</th><th>ETF?</th><th>Source</th></tr></thead>`;
    const flagsTbody = cgtEl('tbody', {});
    flagsTable.appendChild(flagsTbody);
    flagsWrap.appendChild(flagsTable);
    flagsCard.appendChild(flagsWrap);
    app.appendChild(flagsCard);

    renderFlagsRows();

    function renderFlagsRows() {
        flagsTbody.innerHTML = '';
        const visible = cgtDdShowAllIsins ? flags : flags.filter(f => f.is_etf);

        if (visible.length === 0) {
            flagsTbody.innerHTML = '<tr><td colspan="4" class="empty-state">No ISINs tagged as ETF yet — check "Show all" to find and tag one.</td></tr>';
            return;
        }

        for (const f of visible) {
            const tr = cgtEl('tr', {});
            const checkbox = cgtEl('input', { type: 'checkbox' });
            checkbox.checked = f.is_etf;
            checkbox.onchange = async () => {
                checkbox.disabled = true;
                try {
                    await cgtApi('/deemed-disposal/etf-flags/' + f.isin, {
                        method: 'PUT',
                        body: JSON.stringify({ is_etf: checkbox.checked }),
                    });
                    renderCgtDeemedDisposal(app);
                } catch (e) {
                    alert('Error: ' + e.message);
                    checkbox.checked = !checkbox.checked;
                    checkbox.disabled = false;
                }
            };
            const cbTd = cgtEl('td', {}); cbTd.appendChild(checkbox);

            tr.appendChild(cgtEl('td', {}, f.isin));
            tr.appendChild(cgtEl('td', {}, f.product_name));
            tr.appendChild(cbTd);
            tr.appendChild(cgtEl('td', { style: 'font-size:.78rem;color:var(--cgt-muted)' }, f.overridden ? 'manual override' : 'auto-detected'));
            flagsTbody.appendChild(tr);
        }
    }

    const schedCard = cgtEl('div', { class: 'card' });
    schedCard.innerHTML = '<h2>Deemed Disposal Schedule</h2>';

    const etfCount = flags.filter(f => f.is_etf).length;
    if (etfCount === 0) {
        schedCard.innerHTML += '<p class="empty-state">No holdings classified as ETFs yet — tag one above.</p>';
        app.appendChild(schedCard);
        return;
    }

    if (schedule.length === 0) {
        schedCard.innerHTML += '<p class="empty-state">No open ETF lots.</p>';
        app.appendChild(schedCard);
        return;
    }

    const priceNote = cgtEl('p', { style: 'font-size:.82rem;color:var(--cgt-muted);margin-bottom:.75rem' },
        'Projected gains use whatever price is on file for each ISIN — set or update it on the Holdings tab.');
    schedCard.appendChild(priceNote);

    const schedWrap = cgtEl('div', { class: 'table-wrap' });
    const schedTable = cgtEl('table', {});
    schedTable.innerHTML = `
    <thead><tr>
      <th>ISIN</th><th>Name</th><th>Acquired</th>
      <th class="num">Qty Held</th><th>Cycle</th><th>Next Deemed Disposal</th>
      <th>Status</th>
      <th class="num">Projected Gain<span class="cgt-tip" data-tip="Based on the latest manually-entered price on file, not a value locked to the actual deemed-disposal date. Re-check closer to the date — this will move with the market.">?</span></th>
      <th class="num">Projected Tax</th><th>Pay By</th><th></th>
    </tr></thead>
  `;
    const schedTbody = cgtEl('tbody', {});

    for (const s of schedule) {
        const tr = cgtEl('tr', {});
        tr.appendChild(cgtEl('td', {}, s.isin));
        tr.appendChild(cgtEl('td', {}, s.product_name));
        tr.appendChild(cgtEl('td', {}, s.acquisition_date));
        tr.appendChild(cgtEl('td', { class: 'num' }, cgtFmtQty(s.quantity_held)));
        tr.appendChild(cgtEl('td', {}, String(s.cycle)));
        tr.appendChild(cgtEl('td', {}, s.anniversary));

        const statusLabel = s.status === 'due' ? 'Due / Overdue' : s.status === 'upcoming' ? 'Upcoming' : 'No price set';
        const statusBadgeClass = s.status === 'due' ? 'badge-err' : s.status === 'upcoming' ? 'badge-new' : 'badge-dup';
        const statusTd = cgtEl('td', {});
        statusTd.appendChild(cgtEl('span', { class: 'badge ' + statusBadgeClass }, statusLabel));
        tr.appendChild(statusTd);

        const gainClass = s.projected_gain === null ? '' : parseFloat(s.projected_gain) >= 0 ? 'gain-pos' : 'gain-neg';
        tr.appendChild(cgtEl('td', { class: 'num ' + gainClass }, s.projected_gain !== null ? cgtEur(s.projected_gain) : '—'));
        tr.appendChild(cgtEl('td', { class: 'num' }, s.projected_tax !== null ? cgtEur(s.projected_tax) : '—'));
        tr.appendChild(cgtEl('td', {}, s.pay_by));

        const actionTd = cgtEl('td', {});
        if (s.status === 'due') {
            const confirmBtn = cgtEl('button', { class: 'btn btn-primary btn-sm' }, 'Confirm');
            confirmBtn.onclick = () => showConfirmForm(s, actionTd, confirmBtn);
            actionTd.appendChild(confirmBtn);
            const removeBtn = cgtEl('button', { class: 'btn btn-outline btn-sm', style: 'margin-left:2px' }, 'Remove price');
            removeBtn.onclick = () => removePrice(s.isin);
            actionTd.appendChild(removeBtn);
        } else if (s.status === 'no_price') {
            const setPriceBtn = cgtEl('button', { class: 'btn btn-outline btn-sm' }, 'Set price');
            setPriceBtn.onclick = () => showSetPriceForm(s.isin, actionTd, setPriceBtn);
            actionTd.appendChild(setPriceBtn);
        } else if (s.status === 'upcoming') {
            const removeBtn = cgtEl('button', { class: 'btn btn-outline btn-sm' }, 'Remove price');
            removeBtn.onclick = () => removePrice(s.isin);
            actionTd.appendChild(removeBtn);
        }
        tr.appendChild(actionTd);

        schedTbody.appendChild(tr);

        if (s.confirmed_history.length > 0) {
            const histTr = cgtEl('tr', { class: 'cgt-lots-row' });
            const histTd = cgtEl('td', { colspan: '11' });
            histTd.style.paddingLeft = '2rem';
            histTd.innerHTML = 'Confirmed: ' + s.confirmed_history.map(h =>
                `cycle ${h.cycle} on ${h.disposal_date} — gain ${cgtEur(h.gain_eur)}, tax paid ${cgtEur(h.tax_paid_eur)}`
            ).join('; ');
            histTr.appendChild(histTd);
            schedTbody.appendChild(histTr);
        }
    }
    schedTable.appendChild(schedTbody);
    schedWrap.appendChild(schedTable);
    schedCard.appendChild(schedWrap);
    app.appendChild(schedCard);

    async function removePrice(isin) {
        try {
            await cgtApi('/prices/' + isin, { method: 'DELETE' });
            renderCgtDeemedDisposal(app);
        } catch (e) {
            alert('Error removing price: ' + e.message);
        }
    }

    function showSetPriceForm(isin, container, triggerBtn) {
        container.innerHTML = '';
        const priceInput = cgtEl('input', { type: 'number', min: '0', step: 'any', placeholder: 'Price €', style: 'width:80px' });
        const saveBtn = cgtEl('button', { class: 'btn btn-primary btn-sm', style: 'margin-left:4px' }, 'Save');
        const cancelBtn = cgtEl('button', { class: 'btn btn-outline btn-sm', style: 'margin-left:2px' }, '✕');

        saveBtn.onclick = async () => {
            if (!priceInput.value) return;
            try {
                await cgtApi('/prices/' + isin, { method: 'PUT', body: JSON.stringify({ price_eur: priceInput.value }) });
                renderCgtDeemedDisposal(app);
            } catch (e) {
                alert('Error: ' + e.message);
            }
        };
        cancelBtn.onclick = () => {
            container.innerHTML = '';
            container.appendChild(triggerBtn);
        };

        container.appendChild(priceInput);
        container.appendChild(saveBtn);
        container.appendChild(cancelBtn);
        priceInput.focus();
    }

    function showConfirmForm(s, container, triggerBtn) {
        container.innerHTML = '';
        const priceInput = cgtEl('input', { type: 'number', min: '0', step: 'any', placeholder: 'Price €', style: 'width:80px' });
        const dateInput = cgtEl('input', { type: 'date', value: s.anniversary, style: 'width:130px' });
        const saveBtn = cgtEl('button', { class: 'btn btn-primary btn-sm', style: 'margin-left:4px' }, 'Save');
        const cancelBtn = cgtEl('button', { class: 'btn btn-outline btn-sm', style: 'margin-left:2px' }, '✕');

        saveBtn.onclick = async () => {
            if (!priceInput.value) { alert('Enter the market price per unit on the deemed disposal date.'); return; }
            try {
                await cgtApi('/deemed-disposal/confirm', {
                    method: 'POST',
                    body: JSON.stringify({
                        lot_id: s.lot_id,
                        cycle: s.cycle,
                        disposal_date: dateInput.value,
                        price_eur: priceInput.value,
                    }),
                });
                renderCgtDeemedDisposal(app);
            } catch (e) {
                alert('Error: ' + e.message);
            }
        };
        cancelBtn.onclick = () => {
            container.innerHTML = '';
            container.appendChild(triggerBtn);
        };

        container.appendChild(dateInput);
        container.appendChild(priceInput);
        container.appendChild(saveBtn);
        container.appendChild(cancelBtn);
    }

    const realizedCard = cgtEl('div', { class: 'card' });
    realizedCard.innerHTML = '<h2>Realised ETF Disposals</h2>';
    const yearRow = cgtEl('div', { class: 'filters' });
    const yearSel = cgtEl('select', {});
    yearSel.innerHTML = '<option value="">Select year…</option>';
    yearRow.appendChild(cgtEl('label', {}, 'Tax Year', yearSel));
    realizedCard.appendChild(yearRow);
    const realizedBody = cgtEl('div', {});
    realizedCard.appendChild(realizedBody);
    app.appendChild(realizedCard);

    try {
        const years = await cgtApi('/report/years');
        const extra = new Set(schedule.map(s => parseInt(s.acquisition_date.slice(0, 4))));
        const allYears = [...new Set([...years, ...extra, new Date().getFullYear()])].sort();
        allYears.forEach(y => {
            const opt = document.createElement('option');
            opt.value = opt.textContent = y;
            yearSel.appendChild(opt);
        });
        yearSel.value = new Date().getFullYear();
        loadRealized(parseInt(yearSel.value));
    } catch (_) { /* ignore */ }

    yearSel.onchange = () => { if (yearSel.value) loadRealized(parseInt(yearSel.value)); };

    async function loadRealized(year) {
        realizedBody.innerHTML = '<p class="loading">Loading…</p>';
        try {
            const r = await cgtApi('/deemed-disposal/actual/' + year);
            if (r.disposals.length === 0) {
                realizedBody.innerHTML = '<p class="empty-state">No ETF disposals in this year.</p>';
                return;
            }
            const wrap = cgtEl('div', { class: 'table-wrap' });
            const table = cgtEl('table', {});
            table.innerHTML = `
        <thead><tr>
          <th>Date</th><th>ISIN</th><th>Name</th><th class="num">Qty</th>
          <th class="num">Proceeds</th><th class="num">Cost Basis</th>
          <th class="num">Gain/Loss</th><th class="num">Tax (pre-credit)</th>
          <th class="num">Credit Applied</th><th class="num">Tax Due</th>
        </tr></thead>
      `;
            const tbody = cgtEl('tbody', {});
            for (const d of r.disposals) {
                const gain = parseFloat(d.gain);
                const tr = cgtEl('tr', {});
                tr.innerHTML = `
          <td>${d.date}</td><td>${d.isin}</td><td>${d.product_name}</td>
          <td class="num">${cgtFmtQty(d.quantity)}</td>
          <td class="num">${cgtEur(d.proceeds)}</td>
          <td class="num">${cgtEur(d.cost_basis)}</td>
          <td class="num ${gain >= 0 ? 'gain-pos' : 'gain-neg'}">${gain < 0 ? '-' : ''}${cgtEur(Math.abs(gain))}</td>
          <td class="num">${cgtEur(d.tax_before_credit)}</td>
          <td class="num">${cgtEur(d.credit_applied)}</td>
          <td class="num tax-owed">${cgtEur(d.tax_due)}</td>
        `;
                tbody.appendChild(tr);
                if (d.loss_relief) {
                    const noteTr = cgtEl('tr', { class: 'cgt-lots-row' });
                    noteTr.innerHTML = `<td colspan="10" style="padding-left:2rem">${d.loss_relief}</td>`;
                    tbody.appendChild(noteTr);
                }
            }
            table.appendChild(tbody);
            wrap.appendChild(table);
            realizedBody.innerHTML = '';
            realizedBody.appendChild(wrap);
        } catch (err) {
            realizedBody.innerHTML = `<p class="error-msg">${err.message}</p>`;
        }
    }
}
