'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { Decimal } = require('../lib/decimal');
const {
  isEtf,
  buildLotPool,
  computeSchedule,
  buildConfirmedDisposal,
  computeActualDisposals,
} = require('../lib/deemedDisposal');

function getAllTransactions() {
  return db.prepare('SELECT * FROM transactions ORDER BY date, time').all();
}

function getEtfOverrides() {
  const rows = db.prepare('SELECT isin, is_etf FROM etf_flags').all();
  return Object.fromEntries(rows.map(r => [r.isin, !!r.is_etf]));
}

function getConfirmedDisposals(isin) {
  return db.prepare('SELECT * FROM deemed_disposals WHERE isin = ? ORDER BY lot_id, cycle').all(isin);
}

// GET /api/v1/deemed-disposal/etf-flags
// Merged auto-detect (product_name contains "ETF") + manual override, per ISIN.
router.get('/etf-flags', (req, res) => {
  const isinRows = db.prepare('SELECT DISTINCT isin, product_name FROM transactions ORDER BY product_name').all();
  const overrides = getEtfOverrides();

  const result = isinRows.map(r => ({
    isin:         r.isin,
    product_name: r.product_name,
    is_etf:       isEtf(r.isin, r.product_name, overrides),
    overridden:   Object.prototype.hasOwnProperty.call(overrides, r.isin),
  }));

  res.json(result);
});

// PUT /api/v1/deemed-disposal/etf-flags/:isin
router.put('/etf-flags/:isin', (req, res) => {
  const isin = req.params.isin.toUpperCase();
  const { is_etf } = req.body;
  if (typeof is_etf !== 'boolean') return res.status(400).json({ error: 'is_etf must be a boolean' });

  db.prepare(`
    INSERT INTO etf_flags (isin, is_etf) VALUES (?, ?)
    ON CONFLICT(isin) DO UPDATE SET is_etf = excluded.is_etf
  `).run(isin, is_etf ? 1 : 0);

  res.json({ isin, is_etf });
});

// DELETE /api/v1/deemed-disposal/etf-flags/:isin
// Removes the manual override, reverting to auto-detect.
router.delete('/etf-flags/:isin', (req, res) => {
  db.prepare('DELETE FROM etf_flags WHERE isin = ?').run(req.params.isin.toUpperCase());
  res.json({ deleted: true });
});

// GET /api/v1/deemed-disposal
// Deemed-disposal schedule for every open lot of every ETF-classified ISIN.
router.get('/', (req, res) => {
  const transactions = getAllTransactions();
  const overrides    = getEtfOverrides();

  const etfIsins = [...new Set(
    transactions
      .filter(t => isEtf(t.isin, t.product_name, overrides))
      .map(t => t.isin)
  )];

  const priceRows = db.prepare('SELECT isin, price_eur FROM prices').all();
  const priceMap  = Object.fromEntries(priceRows.map(r => [r.isin, r.price_eur]));

  const schedule = [];
  for (const isin of etfIsins) {
    const isinTxns = transactions.filter(t => t.isin === isin);
    const lots      = buildLotPool(isinTxns);
    const confirmed = getConfirmedDisposals(isin);
    const price     = priceMap[isin] ?? null;
    schedule.push(...computeSchedule(lots, price, confirmed));
  }

  schedule.sort((a, b) => a.anniversary.localeCompare(b.anniversary));
  res.json(schedule);
});

// POST /api/v1/deemed-disposal/confirm
// Records a confirmed (filed) deemed disposal for one lot/cycle.
// Body: { lot_id, cycle, disposal_date, price_eur }
router.post('/confirm', (req, res) => {
  const { lot_id, cycle, disposal_date, price_eur } = req.body;

  if (!lot_id || !cycle || !disposal_date || price_eur === undefined) {
    return res.status(400).json({ error: 'Missing required fields: lot_id, cycle, disposal_date, price_eur' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(disposal_date)) {
    return res.status(400).json({ error: 'disposal_date must be YYYY-MM-DD' });
  }

  let price;
  try {
    price = new Decimal(price_eur);
    if (price.lt(0)) throw new Error('negative');
  } catch {
    return res.status(400).json({ error: 'Invalid price_eur' });
  }

  const buyTxn = db.prepare("SELECT * FROM transactions WHERE id = ? AND type = 'buy'").get(lot_id);
  if (!buyTxn) return res.status(404).json({ error: 'No buy transaction found for lot_id' });

  const isinTxns = db.prepare('SELECT * FROM transactions WHERE isin = ?').all(buyTxn.isin);
  const lots      = buildLotPool(isinTxns);
  const lot       = lots.find(l => l.lot_id === Number(lot_id));
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  if (lot.remaining.lte(0)) return res.status(400).json({ error: 'No remaining quantity on this lot' });

  const confirmed = getConfirmedDisposals(buyTxn.isin);
  const existing  = confirmed.find(d => d.lot_id === Number(lot_id) && d.cycle === Number(cycle));
  if (existing) return res.status(409).json({ error: 'This lot/cycle has already been confirmed' });

  // Determine opening_value: previous cycle's closing_value, or original cost basis for cycle 1.
  let openingValue;
  if (Number(cycle) === 1) {
    openingValue = lot.cost_basis_per_unit.mul(lot.remaining).toFixed(2);
  } else {
    const prev = confirmed.find(d => d.lot_id === Number(lot_id) && d.cycle === Number(cycle) - 1);
    if (!prev) return res.status(400).json({ error: `Cycle ${cycle - 1} must be confirmed before cycle ${cycle}` });
    openingValue = prev.closing_value;
  }

  const row = buildConfirmedDisposal(lot, Number(cycle), disposal_date, openingValue, price.toFixed(2));

  db.prepare(`
    INSERT INTO deemed_disposals
      (lot_id, isin, cycle, disposal_date, quantity, opening_value, closing_value, gain_eur, tax_rate, tax_paid_eur)
    VALUES (@lot_id, @isin, @cycle, @disposal_date, @quantity, @opening_value, @closing_value, @gain_eur, @tax_rate, @tax_paid_eur)
  `).run(row);

  res.status(201).json(row);
});

// DELETE /api/v1/deemed-disposal/:id
// Corrects a mistaken confirmation. Only safe to delete the highest confirmed
// cycle for a lot — otherwise later cycles would be left referencing a gap.
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM deemed_disposals WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const laterExists = db.prepare(
    'SELECT 1 FROM deemed_disposals WHERE lot_id = ? AND cycle > ?'
  ).get(row.lot_id, row.cycle);
  if (laterExists) return res.status(409).json({ error: 'A later cycle for this lot is already confirmed — delete that first' });

  db.prepare('DELETE FROM deemed_disposals WHERE id = ?').run(req.params.id);
  res.json({ deleted: true, id: Number(req.params.id) });
});

// GET /api/v1/deemed-disposal/actual/:year
// Realised disposals of ETF-classified ISINs for a tax year, with deemed-disposal credit applied.
router.get('/actual/:year', (req, res) => {
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: 'Invalid year' });

  const transactions = getAllTransactions();
  const overrides     = getEtfOverrides();

  const etfIsins = [...new Set(
    transactions
      .filter(t => isEtf(t.isin, t.product_name, overrides))
      .map(t => t.isin)
  )];

  let disposals = [];
  for (const isin of etfIsins) {
    const isinTxns = transactions.filter(t => t.isin === isin);
    const confirmed = getConfirmedDisposals(isin);
    disposals = disposals.concat(computeActualDisposals(isinTxns, year, confirmed));
  }

  disposals.sort((a, b) => a.date.localeCompare(b.date));
  res.json({ year, disposals });
});

module.exports = router;
