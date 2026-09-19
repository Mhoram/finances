'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { Decimal, toEurStr, toQtyStr } = require('../lib/decimal');

// GET /api/v1/transactions
// Query params: ?isin=, ?year=, ?type=, ?page=, ?limit=
router.get('/', (req, res) => {
  const { isin, year, type, page = 1, limit = 50 } = req.query;

  let where = [];
  let params = [];

  if (isin)  { where.push('isin = ?');               params.push(isin); }
  if (year)  { where.push("date LIKE ?");             params.push(year + '-%'); }
  if (type)  { where.push('type = ?');                params.push(type); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const offset = (Math.max(1, parseInt(page)) - 1) * Math.max(1, parseInt(limit));

  const total = db.prepare(`SELECT COUNT(*) as n FROM transactions ${whereClause}`).get(...params).n;
  const rows  = db.prepare(
    `SELECT * FROM transactions ${whereClause} ORDER BY date DESC, time DESC LIMIT ? OFFSET ?`
  ).all(...params, parseInt(limit), offset);

  res.json({ total, page: parseInt(page), limit: parseInt(limit), transactions: rows });
});

// GET /api/v1/transactions/isins
router.get('/isins', (req, res) => {
  const rows = db.prepare(
    `SELECT DISTINCT isin, product_name FROM transactions ORDER BY product_name`
  ).all();
  res.json(rows);
});

// POST /api/v1/transactions
router.post('/', (req, res) => {
  const { type, date, time, isin, product_name, quantity, price_eur, costs_eur = '0', notes } = req.body;

  if (!type || !date || !isin || !quantity || !price_eur) {
    return res.status(400).json({ error: 'Missing required fields: type, date, isin, quantity, price_eur' });
  }
  if (!['buy', 'sell'].includes(type)) {
    return res.status(400).json({ error: 'type must be buy or sell' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  let qty, price, costs, total;
  try {
    qty   = new Decimal(quantity);
    price = new Decimal(price_eur);
    costs = new Decimal(costs_eur);
    total = qty.mul(price).plus(costs).abs();
  } catch (e) {
    return res.status(400).json({ error: 'Invalid decimal value: ' + e.message });
  }

  const stmt = db.prepare(`
    INSERT INTO transactions (type, date, time, isin, product_name, quantity, price_eur, costs_eur, total_eur, source, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)
  `);

  const result = stmt.run(
    type, date, time || null, isin.toUpperCase(), product_name || '',
    toQtyStr(qty), toEurStr(price), toEurStr(costs), toEurStr(total), notes || null
  );

  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

// DELETE /api/v1/transactions/:id
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const row = db.prepare('SELECT id FROM transactions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Transaction not found' });

  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  res.json({ deleted: true, id: parseInt(id) });
});

module.exports = router;
