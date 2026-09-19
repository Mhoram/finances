'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { Decimal } = require('../lib/decimal');
const { computeYear, computeAllYears } = require('../lib/cgt');
const { isEtf } = require('../lib/deemedDisposal');

// CGT only applies to non-ETF assets — ETF-classified ISINs fall under the
// separate offshore-funds exit-tax regime (see lib/deemedDisposal.js /
// routes/deemed-disposal.js) and must be excluded here to avoid double-counting
// or taxing them at the wrong rate/rules.
function getAllTransactions() {
  const rows = db.prepare('SELECT * FROM transactions ORDER BY date, time').all();
  const overrides = Object.fromEntries(
    db.prepare('SELECT isin, is_etf FROM etf_flags').all().map(r => [r.isin, !!r.is_etf])
  );
  return rows.filter(t => !isEtf(t.isin, t.product_name, overrides));
}

function getLossPool() {
  return db.prepare('SELECT * FROM loss_pool').all();
}

// GET /api/v1/report/years
router.get('/years', (req, res) => {
  const rows = db.prepare(
    `SELECT DISTINCT substr(date, 1, 4) as year FROM transactions WHERE type = 'sell' ORDER BY year`
  ).all();
  res.json(rows.map(r => parseInt(r.year)));
});

// GET /api/v1/report/loss-pool
router.get('/loss-pool', (req, res) => {
  res.json(getLossPool());
});

// PUT /api/v1/report/loss-pool/:year
router.put('/loss-pool/:year', (req, res) => {
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: 'Invalid year' });

  const { loss_amount } = req.body;
  if (loss_amount === undefined) return res.status(400).json({ error: 'loss_amount required' });

  let amount;
  try {
    amount = new Decimal(loss_amount);
    if (amount.lt(0)) return res.status(400).json({ error: 'loss_amount must be non-negative' });
  } catch (e) {
    return res.status(400).json({ error: 'Invalid decimal: ' + e.message });
  }

  if (amount.eq(0)) {
    db.prepare('DELETE FROM loss_pool WHERE tax_year = ?').run(year);
  } else {
    db.prepare('INSERT OR REPLACE INTO loss_pool (tax_year, loss_amount) VALUES (?, ?)').run(year, amount.toFixed(2));
  }

  res.json({ tax_year: year, loss_amount: amount.toFixed(2) });
});

// GET /api/v1/report/:year
router.get('/:year', (req, res) => {
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: 'Invalid year' });

  const transactions = getAllTransactions();
  const lossPool     = getLossPool();

  // Compute the full chain — this handles carry-forward and external losses correctly
  const allResults = computeAllYears(transactions, lossPool);

  // If the year has no sells in the DB, computeAllYears won't include it.
  // Compute it directly using the carry-forward from the most recent prior year.
  let result = allResults.get(year);
  if (!result) {
    const manualLosses = new Map(lossPool.map(r => [r.tax_year, new Decimal(r.loss_amount)]));
    let carryIn = new Decimal('0');
    const sortedYears = [...allResults.keys()].sort();
    for (const y of sortedYears) {
      if (y >= year) break;
      carryIn = new Decimal(allResults.get(y).lossCarryForward);
    }
    const externalThisYear = manualLosses.get(year) || new Decimal('0');
    result = computeYear(transactions, year, carryIn.toFixed(2), externalThisYear.toFixed(2));
  }

  res.json({ year, ...result });
});


module.exports = router;
