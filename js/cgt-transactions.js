/**
 * Transactions tab — ported from CGT-tracker's public/js/transactions.js,
 * talking to the server in server/ via cgtApi() instead of a same-origin API.
 */
'use strict';

async function renderCgtTransactions(app) {
    app.innerHTML = '';

    // --- Add transaction form ---
    const formCard = cgtEl('div', { class: 'card' }, cgtEl('h2', {}, 'Add Transaction'));
    const form = cgtEl('form', {});

    let isins = [];
    try { isins = await cgtApi('/transactions/isins'); } catch (_) { /* ignore */ }

    const isinDatalist = cgtEl('datalist', { id: 'cgt-isin-list' });
    isins.forEach(i => {
        const opt = document.createElement('option');
        opt.value = i.isin;
        opt.label = i.product_name;
        isinDatalist.appendChild(opt);
    });
    form.appendChild(isinDatalist);

    const grid = cgtEl('div', { class: 'form-grid' });
    const fields = [
        { name: 'type', label: 'Type', type: 'select', options: ['buy', 'sell'] },
        { name: 'date', label: 'Date', type: 'date' },
        { name: 'isin', label: 'ISIN', type: 'text', list: 'cgt-isin-list' },
        { name: 'product_name', label: 'Name', type: 'text' },
        { name: 'quantity', label: 'Quantity', type: 'text', placeholder: '100' },
        { name: 'price_eur', label: 'Price (€)', type: 'text', placeholder: '12.34' },
        { name: 'costs_eur', label: 'Costs (€)', type: 'text', placeholder: '0' },
        { name: 'notes', label: 'Notes', type: 'text' },
    ];

    for (const f of fields) {
        const lbl = cgtEl('label', {}, f.label);
        let inp;
        if (f.type === 'select') {
            inp = cgtEl('select', { name: f.name });
            f.options.forEach(o => {
                const opt = document.createElement('option');
                opt.value = opt.textContent = o;
                inp.appendChild(opt);
            });
        } else {
            inp = cgtEl('input', { type: f.type, name: f.name, ...(f.placeholder ? { placeholder: f.placeholder } : {}), ...(f.list ? { list: f.list } : {}) });
        }
        lbl.appendChild(inp);
        grid.appendChild(lbl);
    }

    const msgDiv = cgtEl('div', {});
    const actions = cgtEl('div', { class: 'form-actions' },
        cgtEl('button', { class: 'btn btn-primary', type: 'submit' }, 'Add Transaction'),
        msgDiv
    );

    form.appendChild(grid);
    form.appendChild(actions);

    form.onsubmit = async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        data.isin = data.isin.toUpperCase().trim();
        try {
            await cgtApi('/transactions', { method: 'POST', body: JSON.stringify(data) });
            form.reset();
            cgtShowMsg(msgDiv, 'Transaction added.', 'success');
            loadTable();
        } catch (err) {
            cgtShowMsg(msgDiv, err.message);
        }
    };

    formCard.appendChild(form);
    app.appendChild(formCard);

    // --- Transactions table ---
    const tableCard = cgtEl('div', { class: 'card' }, cgtEl('h2', {}, 'Transactions'));

    const filtersDiv = cgtEl('div', { class: 'filters' });
    const yearSel = cgtEl('select', { id: 'cgt-f-year' });
    yearSel.innerHTML = '<option value="">All years</option>';
    const typeSel = cgtEl('select', { id: 'cgt-f-type' });
    typeSel.innerHTML = '<option value="">All types</option><option>buy</option><option>sell</option>';
    const isinInp = cgtEl('input', { type: 'text', id: 'cgt-f-isin', placeholder: 'Filter ISIN' });

    filtersDiv.appendChild(cgtEl('label', {}, 'Year', yearSel));
    filtersDiv.appendChild(cgtEl('label', {}, 'Type', typeSel));
    filtersDiv.appendChild(cgtEl('label', {}, 'ISIN', isinInp));

    const tableWrap = cgtEl('div', { class: 'table-wrap' });
    const paginationDiv = cgtEl('div', { class: 'pagination' });
    tableCard.appendChild(filtersDiv);
    tableCard.appendChild(tableWrap);
    tableCard.appendChild(paginationDiv);
    app.appendChild(tableCard);

    let currentPage = 1;

    async function loadTable() {
        const year = yearSel.value;
        const type = typeSel.value;
        const isin = isinInp.value.trim().toUpperCase();
        const params = new URLSearchParams({ page: currentPage, limit: 50 });
        if (year) params.set('year', year);
        if (type) params.set('type', type);
        if (isin) params.set('isin', isin);

        tableWrap.innerHTML = '<p class="loading">Loading…</p>';
        paginationDiv.innerHTML = '';

        try {
            const data = await cgtApi('/transactions?' + params);
            renderTable(data);
        } catch (err) {
            tableWrap.innerHTML = `<p class="error-msg">${err.message}</p>`;
        }
    }

    function renderTable(data) {
        if (data.transactions.length === 0) {
            tableWrap.innerHTML = '<p class="empty-state">No transactions found.</p>';
            return;
        }
        const table = cgtEl('table', {});
        table.innerHTML = `
      <thead><tr>
        <th>ID</th><th>Type</th><th>Date</th><th>ISIN</th><th>Name</th>
        <th class="num">Qty</th><th class="num">Price (€)</th><th class="num">Costs (€)</th>
        <th class="num">Total (€)</th><th>Source</th><th>Notes</th><th></th>
      </tr></thead>
    `;
        const tbody = cgtEl('tbody', {});
        for (const t of data.transactions) {
            const tr = cgtEl('tr', {});
            tr.innerHTML = `
        <td>${t.id}</td>
        <td>${t.type}</td>
        <td>${t.date}</td>
        <td>${t.isin}</td>
        <td>${t.product_name}</td>
        <td class="num">${cgtFmtQty(t.quantity)}</td>
        <td class="num">${cgtEur(t.price_eur)}</td>
        <td class="num">${cgtEur(t.costs_eur)}</td>
        <td class="num">${cgtEur(t.total_eur)}</td>
        <td>${t.source}</td>
        <td>${t.notes || ''}</td>
      `;
            const delBtn = cgtEl('button', { class: 'btn btn-danger btn-sm' }, 'Delete');
            delBtn.onclick = async () => {
                if (!confirm(`Delete transaction #${t.id}?`)) return;
                try {
                    await cgtApi('/transactions/' + t.id, { method: 'DELETE' });
                    loadTable();
                } catch (err) { alert(err.message); }
            };
            const td = cgtEl('td', {});
            td.appendChild(delBtn);
            tr.appendChild(td);
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        tableWrap.innerHTML = '';
        tableWrap.appendChild(table);

        const totalPages = Math.max(1, Math.ceil(data.total / data.limit));
        paginationDiv.innerHTML = '';
        const prevBtn = cgtEl('button', {}, '← Prev');
        prevBtn.disabled = currentPage <= 1;
        prevBtn.onclick = () => { currentPage--; loadTable(); };

        const nextBtn = cgtEl('button', {}, 'Next →');
        nextBtn.disabled = currentPage >= totalPages;
        nextBtn.onclick = () => { currentPage++; loadTable(); };

        paginationDiv.appendChild(prevBtn);
        paginationDiv.appendChild(cgtEl('span', { class: 'page-info' }, `Page ${currentPage} of ${totalPages} (${data.total} total)`));
        paginationDiv.appendChild(nextBtn);
    }

    try {
        const years = await cgtApi('/report/years');
        years.forEach(y => {
            const opt = document.createElement('option');
            opt.value = opt.textContent = y;
            yearSel.appendChild(opt);
        });
    } catch (_) { /* ignore */ }

    yearSel.onchange = typeSel.onchange = () => { currentPage = 1; loadTable(); };
    let debounce;
    isinInp.oninput = () => { clearTimeout(debounce); debounce = setTimeout(() => { currentPage = 1; loadTable(); }, 300); };

    loadTable();
}
