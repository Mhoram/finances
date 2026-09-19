/**
 * Net Worth tab — ported from CGT-tracker's public/js/net-worth.js.
 *
 * Simplification vs. the original: CGT-tracker links liability items to its
 * `loans` table (multiple named mortgages/loans with amortization schedules)
 * to prefill a snapshot value from that loan's balance on a given date.
 * mortgage-calc's Mortgage/Loan tabs are single-scenario calculators, not a
 * saved list of named loans, so there's nothing to link to here — liability
 * values are entered manually instead.
 */
'use strict';

const CGT_NW_CATEGORY_LABELS = {
    cash: 'Cash',
    investments: 'Investments',
    property: 'Property',
    pension: 'Pension',
    vehicle: 'Vehicle',
    other_asset: 'Other Asset',
    mortgage: 'Mortgage',
    loan: 'Loan',
    credit_card: 'Credit Card',
    other_liability: 'Other Liability',
};
const CGT_NW_CATEGORIES = {
    asset: ['cash', 'investments', 'property', 'pension', 'vehicle', 'other_asset'],
    liability: ['mortgage', 'loan', 'credit_card', 'other_liability'],
};

let cgtNwEditingDate = null;
let cgtNwShowArchived = false;
let cgtNwIncludeIlliquid = true;

async function renderCgtNetWorth(app) {
    app.innerHTML = '<p class="loading">Loading…</p>';

    let items, snapshots;
    try {
        [items, snapshots] = await Promise.all([
            cgtApi('/net-worth/items?include_archived=1'),
            cgtApi('/net-worth/snapshots'),
        ]);
    } catch (err) {
        app.innerHTML = `<p class="error-msg">${err.message}</p>`;
        return;
    }

    app.innerHTML = '';

    let editingSnapshot = null;
    if (cgtNwEditingDate) {
        try {
            editingSnapshot = await cgtApi('/net-worth/snapshots/' + cgtNwEditingDate);
        } catch {
            cgtNwEditingDate = null;
        }
    }

    app.appendChild(cgtNwBuildItemsCard(app, items));
    app.appendChild(await cgtNwBuildSnapshotFormCard(app, items, editingSnapshot));
    app.appendChild(cgtNwBuildHistoryCard(app, snapshots));
}

// ---- Manage Items ----

function cgtNwBuildItemsCard(app, items) {
    const card = cgtEl('div', { class: 'card' });
    card.appendChild(cgtEl('h2', {}, 'Assets & Liabilities'));
    card.appendChild(cgtEl('p', { style: 'font-size:.82rem;color:var(--cgt-muted);margin-bottom:.75rem' },
        'Define the accounts and holdings you want to track (cash, your investment portfolio, property, pension, mortgage…). ' +
        'Mark an asset "Illiquid" if it can’t be readily accessed (property, pension), and mark a liability "Illiquid" if it\'s ' +
        'tied to one (a mortgage against an illiquid house) — the history section below can then show net worth with or ' +
        'without those paired items included. ' +
        'Enter liability values as the positive amount owed (e.g. 200000 for a mortgage) — it’s subtracted automatically.'));

    const visible = items.filter(i => cgtNwShowArchived || !i.archived_at);

    const filterRow = cgtEl('label', { style: 'display:inline-flex;align-items:center;gap:.4rem;font-size:.82rem;font-weight:400;margin-bottom:.5rem' });
    const showArchivedCheckbox = cgtEl('input', { type: 'checkbox' });
    showArchivedCheckbox.checked = cgtNwShowArchived;
    showArchivedCheckbox.onchange = () => {
        cgtNwShowArchived = showArchivedCheckbox.checked;
        renderCgtNetWorth(app);
    };
    filterRow.appendChild(showArchivedCheckbox);
    filterRow.appendChild(document.createTextNode('Show archived items'));
    card.appendChild(filterRow);

    const wrap = cgtEl('div', { class: 'table-wrap' });
    const table = cgtEl('table', {});
    table.innerHTML = '<thead><tr><th>Name</th><th>Type</th><th>Category</th><th>Illiquid?</th><th></th></tr></thead>';
    const tbody = cgtEl('tbody', {});

    if (visible.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No items yet — add one below.</td></tr>';
    }

    for (const item of visible) {
        const tr = cgtEl('tr', {});
        tr.appendChild(cgtEl('td', {}, item.name + (item.archived_at ? ' (archived)' : '')));
        tr.appendChild(cgtEl('td', {}, item.type === 'asset' ? 'Asset' : 'Liability'));
        tr.appendChild(cgtEl('td', {}, CGT_NW_CATEGORY_LABELS[item.category] || item.category));

        const illiquidTd = cgtEl('td', {});
        const illiquidCheckbox = cgtEl('input', { type: 'checkbox' });
        illiquidCheckbox.checked = !!item.is_illiquid;
        illiquidCheckbox.onchange = async () => {
            illiquidCheckbox.disabled = true;
            try {
                await cgtApi('/net-worth/items/' + item.id, {
                    method: 'PUT',
                    body: JSON.stringify({ is_illiquid: illiquidCheckbox.checked }),
                });
                renderCgtNetWorth(app);
            } catch (e) {
                alert('Error: ' + e.message);
                illiquidCheckbox.checked = !illiquidCheckbox.checked;
                illiquidCheckbox.disabled = false;
            }
        };
        illiquidTd.appendChild(illiquidCheckbox);
        tr.appendChild(illiquidTd);

        const actionTd = cgtEl('td', {});
        const toggleBtn = cgtEl('button', { class: 'btn btn-outline btn-sm' }, item.archived_at ? 'Restore' : 'Archive');
        toggleBtn.onclick = async () => {
            toggleBtn.disabled = true;
            try {
                await cgtApi('/net-worth/items/' + item.id, {
                    method: 'PUT',
                    body: JSON.stringify({ archived: !item.archived_at }),
                });
                renderCgtNetWorth(app);
            } catch (e) {
                alert('Error: ' + e.message);
                toggleBtn.disabled = false;
            }
        };
        actionTd.appendChild(toggleBtn);
        tr.appendChild(actionTd);
        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);

    const form = cgtEl('div', { class: 'form-grid', style: 'margin-top:1rem' });

    const nameInput = cgtEl('input', { type: 'text', placeholder: 'e.g. Revolut Savings' });
    const typeSelect = cgtEl('select', {});
    typeSelect.innerHTML = '<option value="asset">Asset</option><option value="liability">Liability</option>';
    const categorySelect = cgtEl('select', {});

    const illiquidLabel = cgtEl('label', { style: 'display:inline-flex;align-items:center;gap:.4rem;font-weight:400' });
    const illiquidCheckbox = cgtEl('input', { type: 'checkbox' });
    const illiquidText = document.createTextNode('');
    illiquidLabel.appendChild(illiquidCheckbox);
    illiquidLabel.appendChild(illiquidText);

    function populateCategories() {
        categorySelect.innerHTML = CGT_NW_CATEGORIES[typeSelect.value]
            .map(c => `<option value="${c}">${CGT_NW_CATEGORY_LABELS[c]}</option>`)
            .join('');
        illiquidText.textContent = typeSelect.value === 'asset'
            ? 'Illiquid (not readily accessible)'
            : 'Illiquid (tied to an illiquid asset, e.g. a mortgage)';
    }
    typeSelect.onchange = populateCategories;
    populateCategories();

    form.appendChild(cgtEl('label', {}, 'Name', nameInput));
    form.appendChild(cgtEl('label', {}, 'Type', typeSelect));
    form.appendChild(cgtEl('label', {}, 'Category', categorySelect));
    form.appendChild(illiquidLabel);
    card.appendChild(form);

    const actions = cgtEl('div', { class: 'form-actions' });
    const addBtn = cgtEl('button', { class: 'btn btn-primary' }, 'Add Item');
    addBtn.onclick = async () => {
        const name = nameInput.value.trim();
        if (!name) return cgtShowMsg(card, 'Name is required');
        addBtn.disabled = true;
        try {
            await cgtApi('/net-worth/items', {
                method: 'POST',
                body: JSON.stringify({
                    name, type: typeSelect.value, category: categorySelect.value,
                    is_illiquid: illiquidCheckbox.checked,
                }),
            });
            renderCgtNetWorth(app);
        } catch (e) {
            cgtShowMsg(card, e.message);
            addBtn.disabled = false;
        }
    };
    actions.appendChild(addBtn);
    card.appendChild(actions);

    return card;
}

// ---- Record / Edit Snapshot ----

async function cgtNwBuildSnapshotFormCard(app, items, editingSnapshot) {
    const card = cgtEl('div', { class: 'card' });
    const isEditing = !!editingSnapshot;

    card.appendChild(cgtEl('h2', {}, isEditing ? `Edit Snapshot — ${editingSnapshot.date}` : 'Record New Snapshot'));

    const valueByItemId = {};
    if (isEditing) {
        for (const v of editingSnapshot.items) valueByItemId[v.item_id] = v.value_eur;
    }

    const relevantItems = items.filter(i => !i.archived_at || valueByItemId[i.id] !== undefined);

    const dateInput = cgtEl('input', { type: 'date', value: isEditing ? editingSnapshot.date : new Date().toISOString().slice(0, 10) });
    if (isEditing) dateInput.disabled = true;
    dateInput.onchange = () => renderCgtNetWorth(app);

    const dateRow = cgtEl('div', { class: 'form-grid' });
    dateRow.appendChild(cgtEl('label', {}, 'Date', dateInput));
    card.appendChild(dateRow);

    const inputs = {};

    function buildSection(title, typeItems) {
        if (typeItems.length === 0) return;
        card.appendChild(cgtEl('h3', {}, title));
        const grid = cgtEl('div', { class: 'form-grid' });
        for (const item of typeItems) {
            const input = cgtEl('input', {
                type: 'number', step: 'any', placeholder: '0.00',
                value: valueByItemId[item.id] !== undefined ? valueByItemId[item.id] : '',
            });
            inputs[item.id] = input;
            const label = cgtEl('label', {}, item.name + (item.archived_at ? ' (archived)' : ''), input);
            grid.appendChild(label);
        }
        card.appendChild(grid);
    }

    const assets = relevantItems.filter(i => i.type === 'asset');
    const liabilities = relevantItems.filter(i => i.type === 'liability');
    buildSection('Liquid Assets', assets.filter(i => !i.is_illiquid));
    buildSection('Illiquid Assets', assets.filter(i => i.is_illiquid));
    buildSection('Liquid Liabilities', liabilities.filter(i => !i.is_illiquid));
    buildSection('Illiquid Liabilities', liabilities.filter(i => i.is_illiquid));

    if (relevantItems.length === 0) {
        card.appendChild(cgtEl('p', { class: 'empty-state' }, 'Add assets/liabilities above to include them in a snapshot.'));
    }

    const notesInput = cgtEl('input', { type: 'text', placeholder: 'Optional note', value: isEditing ? (editingSnapshot.notes || '') : '' });
    const notesRow = cgtEl('div', { class: 'form-grid', style: 'margin-top:.6rem' });
    notesRow.appendChild(cgtEl('label', {}, 'Notes', notesInput));
    card.appendChild(notesRow);

    const actions = cgtEl('div', { class: 'form-actions' });
    const saveBtn = cgtEl('button', { class: 'btn btn-primary' }, isEditing ? 'Save Changes' : 'Save Snapshot');
    saveBtn.onclick = async () => {
        const date = dateInput.value;
        if (!date) return cgtShowMsg(card, 'Date is required');

        const values = {};
        for (const [itemId, input] of Object.entries(inputs)) {
            const v = input.value.trim();
            if (v !== '') values[itemId] = v;
        }

        saveBtn.disabled = true;
        try {
            if (isEditing) {
                await cgtApi('/net-worth/snapshots/' + date, {
                    method: 'PUT',
                    body: JSON.stringify({ notes: notesInput.value.trim(), values }),
                });
            } else {
                await cgtApi('/net-worth/snapshots', {
                    method: 'POST',
                    body: JSON.stringify({ date, notes: notesInput.value.trim(), values }),
                });
            }
            cgtNwEditingDate = null;
            renderCgtNetWorth(app);
        } catch (e) {
            cgtShowMsg(card, e.message);
            saveBtn.disabled = false;
        }
    };
    actions.appendChild(saveBtn);

    if (isEditing) {
        const cancelBtn = cgtEl('button', { class: 'btn btn-outline' }, 'Cancel');
        cancelBtn.onclick = () => { cgtNwEditingDate = null; renderCgtNetWorth(app); };
        actions.appendChild(cancelBtn);
    }

    card.appendChild(actions);
    return card;
}

// ---- History ----

function cgtNwBuildHistoryCard(app, snapshots) {
    const card = cgtEl('div', { class: 'card' });
    card.appendChild(cgtEl('h2', {}, 'Net Worth History'));

    if (snapshots.length === 0) {
        card.appendChild(cgtEl('p', { class: 'empty-state' }, 'No snapshots recorded yet.'));
        return card;
    }

    const toggleRow = cgtEl('label', { style: 'display:inline-flex;align-items:center;gap:.4rem;font-size:.82rem;font-weight:400;margin-bottom:.75rem' });
    const includeCheckbox = cgtEl('input', { type: 'checkbox' });
    includeCheckbox.checked = cgtNwIncludeIlliquid;
    includeCheckbox.onchange = () => {
        cgtNwIncludeIlliquid = includeCheckbox.checked;
        renderCgtNetWorth(app);
    };
    toggleRow.appendChild(includeCheckbox);
    toggleRow.appendChild(document.createTextNode('Include illiquid assets/liabilities (property + its mortgage, pension, …)'));
    card.appendChild(toggleRow);

    const assetsField = cgtNwIncludeIlliquid ? 'total_assets_eur' : 'liquid_assets_eur';
    const liabilitiesField = cgtNwIncludeIlliquid ? 'total_liabilities_eur' : 'liquid_liabilities_eur';
    const netWorthField = cgtNwIncludeIlliquid ? 'net_worth_eur' : 'liquid_net_worth_eur';

    if (snapshots.length >= 2) card.appendChild(cgtNwBuildTrendChart(snapshots, netWorthField));

    const wrap = cgtEl('div', { class: 'table-wrap' });
    const table = cgtEl('table', {});
    table.innerHTML = `
    <thead><tr>
      <th>Date</th>
      <th class="num">${cgtNwIncludeIlliquid ? 'Total Assets' : 'Liquid Assets'}</th>
      <th class="num">${cgtNwIncludeIlliquid ? 'Total Liabilities' : 'Liquid Liabilities'}</th>
      <th class="num">${cgtNwIncludeIlliquid ? 'Net Worth' : 'Liquid Net Worth'}</th>
      <th class="num">Change</th>
      <th></th>
    </tr></thead>
  `;
    const tbody = cgtEl('tbody', {});

    const sorted = [...snapshots].sort((a, b) => b.date.localeCompare(a.date));
    const byDateAsc = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));

    for (const snap of sorted) {
        const idx = byDateAsc.findIndex(s => s.date === snap.date);
        const prev = idx > 0 ? byDateAsc[idx - 1] : null;
        const change = prev ? Number(snap[netWorthField]) - Number(prev[netWorthField]) : null;

        const tr = cgtEl('tr', {});
        tr.appendChild(cgtEl('td', {}, snap.date));
        tr.appendChild(cgtEl('td', { class: 'num' }, cgtEur(snap[assetsField])));
        tr.appendChild(cgtEl('td', { class: 'num' }, cgtEur(snap[liabilitiesField])));
        tr.appendChild(cgtEl('td', { class: 'num' }, cgtEur(snap[netWorthField])));
        tr.appendChild(cgtEl('td', { class: 'num ' + (change === null ? '' : change >= 0 ? 'gain-pos' : 'gain-neg') },
            change === null ? '—' : (change >= 0 ? '+' : '') + cgtEur(change)));

        const actionTd = cgtEl('td', {});
        const editBtn = cgtEl('button', { class: 'btn btn-outline btn-sm' }, 'Edit');
        editBtn.onclick = () => { cgtNwEditingDate = snap.date; renderCgtNetWorth(app); window.scrollTo(0, 0); };
        const deleteBtn = cgtEl('button', { class: 'btn btn-danger btn-sm', style: 'margin-left:.3rem' }, 'Delete');
        deleteBtn.onclick = async () => {
            if (!confirm(`Delete the ${snap.date} snapshot?`)) return;
            try {
                await cgtApi('/net-worth/snapshots/' + snap.date, { method: 'DELETE' });
                renderCgtNetWorth(app);
            } catch (e) {
                alert('Error: ' + e.message);
            }
        };
        actionTd.appendChild(editBtn);
        actionTd.appendChild(deleteBtn);
        tr.appendChild(actionTd);

        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    return card;
}

function cgtNwBuildTrendChart(snapshots, netWorthField) {
    const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
    const values = sorted.map(s => Number(s[netWorthField]));
    const min = Math.min(...values, 0);
    const max = Math.max(...values, 0);
    const range = max - min || 1;

    const w = 100, h = 30, pad = 2;
    const points = values.map((v, i) => {
        const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
        const y = h - pad - ((v - min) / range) * (h - 2 * pad);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');

    const wrap = cgtEl('div', { style: 'margin-bottom:1.25rem' });
    wrap.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:120px;display:block">
      <polyline points="${points}" fill="none" stroke="var(--cgt-primary)" stroke-width="0.6" vector-effect="non-scaling-stroke" />
    </svg>
  `;
    return wrap;
}
