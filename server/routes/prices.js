'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { Decimal, toEurStr } = require('../lib/decimal');

// GET /api/v1/prices
router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM prices ORDER BY isin').all());
});

// PUT /api/v1/prices/:isin  — manual price entry
router.put('/:isin', (req, res) => {
  const isin = req.params.isin.toUpperCase();
  const { price_eur } = req.body;

  if (price_eur == null) return res.status(400).json({ error: 'price_eur is required' });

  let price;
  try {
    price = new Decimal(price_eur);
    if (price.lt(0)) throw new Error('negative');
  } catch {
    return res.status(400).json({ error: 'Invalid price_eur' });
  }

  db.prepare(`
    INSERT INTO prices (isin, price_eur, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(isin) DO UPDATE SET price_eur = excluded.price_eur, updated_at = excluded.updated_at
  `).run(isin, toEurStr(price));

  res.json(db.prepare('SELECT * FROM prices WHERE isin = ?').get(isin));
});

// DELETE /api/v1/prices/:isin
router.delete('/:isin', (req, res) => {
  db.prepare('DELETE FROM prices WHERE isin = ?').run(req.params.isin.toUpperCase());
  res.json({ deleted: true });
});

module.exports = router;
