'use strict';

/**
 * DeGiro CSV Parser
 *
 * Parses DeGiro transaction export CSV (English column headers).
 *
 * Actual headers observed:
 *   Date, Time, Product, ISIN, Reference exchange, Venue, Quantity, Price,
 *   (currency), Local value, (currency), Value EUR, Exchange rate,
 *   AutoFX Fee, Transaction and/or third party fees EUR, Total EUR, Order ID
 *
 * costs_eur = abs(AutoFX Fee) + abs(Transaction and/or third party fees EUR)
 * price_eur = abs(Value EUR) / abs(Quantity)   — handles non-EUR stocks correctly
 */

const crypto = require('crypto');
const { Decimal, toEurStr, toQtyStr } = require('./decimal');

/**
 * Parse a European-formatted number string.
 * Handles: "1.234,56" → "1234.56", plain "1234.56" also accepted, "" → "0"
 */
function parseNumber(str) {
  if (!str || str.trim() === '' || str.trim() === '-') return '0';
  const s = str.trim();
  // If it contains a comma it's European format: remove . thousands sep, swap , for .
  if (s.includes(',')) {
    return s.replace(/\./g, '').replace(',', '.');
  }
  return s;
}

/**
 * Parse DD-MM-YYYY → YYYY-MM-DD
 */
function parseDate(str) {
  const m = str.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) throw new Error(`Invalid date format: "${str}" (expected DD-MM-YYYY)`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Minimal CSV parser — handles quoted fields with embedded commas.
 * Returns array of string arrays.
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch   = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if      (ch === '"')  { inQuotes = true; }
      else if (ch === ',')  { row.push(field.trim()); field = ''; }
      else if (ch === '\n') {
        row.push(field.trim());
        if (row.some(f => f !== '')) rows.push(row);
        row = []; field = '';
      } else if (ch === '\r') { /* skip */ }
      else { field += ch; }
    }
  }
  row.push(field.trim());
  if (row.some(f => f !== '')) rows.push(row);

  return rows;
}

/**
 * Generate import_id: sha256(date|isin|abs(quantity_8dp)|price_eur_4dp)
 */
function makeImportId(date, isin, absQty, priceEur) {
  const raw = `${date}|${isin}|${new Decimal(absQty).toFixed(8)}|${new Decimal(priceEur).toFixed(4)}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Find a column index by matching lowercase trimmed header.
 * Tries exact match first, then substring match as fallback.
 */
function findCol(headers, ...candidates) {
  for (const c of candidates) {
    const idx = headers.findIndex(h => h === c);
    if (idx >= 0) return idx;
  }
  // fallback: partial match
  for (const c of candidates) {
    const idx = headers.findIndex(h => h.includes(c));
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Parse a DeGiro CSV export.
 * @param {string} csvText  Raw CSV contents (UTF-8, may have BOM)
 * @returns {{ rows: Array, errors: Array<string> }}
 */
function parseDeGiroCSV(csvText) {
  const text = csvText.replace(/^\uFEFF/, '');
  const allRows = parseCSV(text);
  if (allRows.length < 2) throw new Error('CSV has no data rows');

  const headers = allRows[0].map(h => h.toLowerCase().trim());

  // Column indices
  const iDate     = findCol(headers, 'date', 'datum');
  const iTime     = findCol(headers, 'time', 'tijd');
  const iProduct  = findCol(headers, 'product');
  const iISIN     = findCol(headers, 'isin');
  const iQty      = findCol(headers, 'quantity', 'aantal');
  const iValueEUR = findCol(headers, 'value eur', 'waarde');
  const iAutoFX   = findCol(headers, 'autofx fee');
  const iTxFee    = findCol(headers, 'transaction and/or third party fees eur', 'transactiekosten');

  if (iDate < 0)     throw new Error('CSV missing Date column');
  if (iISIN < 0)     throw new Error('CSV missing ISIN column');
  if (iQty  < 0)     throw new Error('CSV missing Quantity column');
  if (iValueEUR < 0) throw new Error('CSV missing "Value EUR" column');

  const rows   = [];
  const errors = [];

  for (let i = 1; i < allRows.length; i++) {
    const raw = allRows[i];
    const get = (idx) => (idx >= 0 && idx < raw.length ? raw[idx] || '' : '');

    try {
      const isin = get(iISIN).trim().toUpperCase();
      if (!isin) continue; // skip cash/FX rows

      const date        = parseDate(get(iDate));
      const time        = get(iTime).trim() || null;
      const productName = get(iProduct).trim();

      const rawQty      = parseNumber(get(iQty));
      const rawValueEUR = parseNumber(get(iValueEUR));
      const rawAutoFX   = parseNumber(get(iAutoFX));
      const rawTxFee    = parseNumber(get(iTxFee));

      const qty      = new Decimal(rawQty);
      const valueEUR = new Decimal(rawValueEUR);

      if (qty.eq(0)) {
        errors.push(`Row ${i + 1}: zero quantity, skipped`);
        continue;
      }

      // type: positive quantity = buy, negative = sell
      const type   = qty.gt(0) ? 'buy' : 'sell';
      const absQty = qty.abs();

      // price_eur = abs(Value EUR) / abs(quantity)
      // Using Value EUR (not local price) correctly handles non-EUR stocks
      const absValueEUR = valueEUR.abs();
      const priceEur    = absValueEUR.div(absQty);

      // Total costs = abs(AutoFX Fee) + abs(Transaction fees)
      const costsEur = new Decimal(rawAutoFX).abs().plus(new Decimal(rawTxFee).abs());

      // total_eur = abs(Value EUR) + costs (gross cash amount including fees)
      const totalEur = absValueEUR.plus(costsEur);

      const importId = makeImportId(date, isin, absQty, priceEur);

      rows.push({
        type,
        date,
        time,
        isin,
        product_name: productName,
        quantity:     toQtyStr(absQty),
        price_eur:    toEurStr(priceEur),
        costs_eur:    toEurStr(costsEur),
        total_eur:    toEurStr(totalEur),
        import_id:    importId,
      });
    } catch (e) {
      errors.push(`Row ${i + 1}: ${e.message}`);
    }
  }

  return { rows, errors };
}

module.exports = { parseDeGiroCSV };
