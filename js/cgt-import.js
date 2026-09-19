/**
 * Import tab — ported from CGT-tracker's public/js/import.js, posting the
 * file to the server's multer-backed /import endpoints via CGT_API_BASE.
 */
'use strict';

function cgtApiBase() {
    return (typeof CGT_API_BASE !== 'undefined' && CGT_API_BASE) || CGT_API_BASE_DEFAULT;
}

function renderCgtImport(app) {
    app.innerHTML = '';

    const card = cgtEl('div', { class: 'card' });
    card.innerHTML = '<h2>Import DeGiro CSV</h2>';

    const dropZone = cgtEl('div', { class: 'drop-zone' });
    const fileInput = cgtEl('input', { type: 'file', accept: '.csv,text/csv' });
    dropZone.appendChild(fileInput);
    dropZone.innerHTML += '<p>Drag & drop your DeGiro CSV here, or <strong>click to browse</strong></p><p style="font-size:.8rem;margin-top:.25rem;color:var(--cgt-muted)">Accepts DeGiro transaction export</p>';
    dropZone.appendChild(fileInput);

    dropZone.onclick = () => fileInput.click();
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
    dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
    dropZone.ondrop = (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    };
    fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };

    const statusDiv = cgtEl('div', {});
    const previewDiv = cgtEl('div', {});
    const actionDiv = cgtEl('div', { class: 'form-actions' });

    card.appendChild(dropZone);
    card.appendChild(statusDiv);
    card.appendChild(previewDiv);
    card.appendChild(actionDiv);
    app.appendChild(card);

    let pendingFile = null;

    async function handleFile(file) {
        pendingFile = file;
        actionDiv.innerHTML = '';
        previewDiv.innerHTML = '';
        statusDiv.innerHTML = `<p class="loading">Parsing ${file.name}…</p>`;

        const fd = new FormData();
        fd.append('file', file);

        try {
            const data = await fetch(cgtApiBase() + '/import/preview', { method: 'POST', body: fd })
                .then(r => r.json());
            if (data.error) throw new Error(data.error);
            renderPreview(data);
        } catch (err) {
            statusDiv.innerHTML = `<p class="error-msg">Error: ${err.message}</p>`;
        }
    }

    function renderPreview(data) {
        statusDiv.innerHTML = `
      <p style="margin-bottom:.75rem">
        <span class="badge badge-new">${data.new} new</span>
        <span class="badge badge-dup" style="margin-left:.3rem">${data.duplicates} duplicate${data.duplicates !== 1 ? 's' : ''}</span>
        ${data.errors.length ? `<span class="badge badge-err" style="margin-left:.3rem">${data.errors.length} error${data.errors.length !== 1 ? 's' : ''}</span>` : ''}
        <span style="color:var(--cgt-muted);font-size:.82rem;margin-left:.5rem">from ${data.total} rows</span>
      </p>
    `;

        if (data.errors.length) {
            const errList = cgtEl('ul', { style: 'color:var(--cgt-loss);font-size:.82rem;margin-bottom:.75rem;padding-left:1.2rem' });
            data.errors.forEach(e => { const li = document.createElement('li'); li.textContent = e; errList.appendChild(li); });
            statusDiv.appendChild(errList);
        }

        if (data.rows.length === 0) {
            previewDiv.innerHTML = '<p class="empty-state">No transaction rows found in CSV.</p>';
            return;
        }

        const wrap = cgtEl('div', { class: 'table-wrap' });
        const table = cgtEl('table', {});
        table.innerHTML = `
      <thead><tr>
        <th>Status</th><th>Type</th><th>Date</th><th>ISIN</th><th>Name</th>
        <th class="num">Qty</th><th class="num">Price (€)</th><th class="num">Costs (€)</th><th class="num">Total (€)</th>
      </tr></thead>
    `;
        const tbody = cgtEl('tbody', {});
        for (const r of data.rows) {
            const tr = cgtEl('tr', { class: r.duplicate ? 'row-dup' : 'row-new' });
            tr.innerHTML = `
        <td>${r.duplicate ? '⟳ duplicate' : '✓ new'}</td>
        <td>${r.type}</td>
        <td>${r.date}</td>
        <td>${r.isin}</td>
        <td>${r.product_name}</td>
        <td class="num">${cgtFmtQty(r.quantity)}</td>
        <td class="num">${cgtEur(r.price_eur)}</td>
        <td class="num">${cgtEur(r.costs_eur)}</td>
        <td class="num">${cgtEur(r.total_eur)}</td>
      `;
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        previewDiv.innerHTML = '';
        previewDiv.appendChild(wrap);

        if (data.new > 0) {
            const importBtn = cgtEl('button', { class: 'btn btn-primary' }, `Import ${data.new} new transaction${data.new !== 1 ? 's' : ''}`);
            importBtn.onclick = doImport;
            actionDiv.innerHTML = '';
            actionDiv.appendChild(importBtn);
        } else {
            actionDiv.innerHTML = '<p class="success-msg">All rows already imported.</p>';
        }
    }

    async function doImport() {
        if (!pendingFile) return;
        actionDiv.innerHTML = '<p class="loading">Importing…</p>';

        const fd = new FormData();
        fd.append('file', pendingFile);

        try {
            const data = await fetch(cgtApiBase() + '/import/degiro', { method: 'POST', body: fd })
                .then(r => r.json());
            if (data.error) throw new Error(data.error);
            actionDiv.innerHTML = `<p class="success-msg">Imported ${data.imported} transaction${data.imported !== 1 ? 's' : ''}. ${data.duplicates} duplicate${data.duplicates !== 1 ? 's' : ''} skipped.</p>`;
            pendingFile = null;
            previewDiv.innerHTML = '';
            statusDiv.innerHTML = '';
        } catch (err) {
            actionDiv.innerHTML = `<p class="error-msg">${err.message}</p>`;
        }
    }
}
