'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { Decimal, ZERO, toEurStr } = require('../lib/decimal');

const CATEGORIES = {
  asset:     ['cash', 'investments', 'property', 'pension', 'vehicle', 'other_asset'],
  liability: ['mortgage', 'loan', 'credit_card', 'other_liability'],
};

// values: [{ value_eur, type, is_illiquid }, ...] for one snapshot.
// Liquid net worth excludes illiquid assets (property, pension, ...) AND their
// matching illiquid liabilities (e.g. the mortgage tied to that property) — a
// mortgage shouldn't drain the "accessible cushion" figure just because its
// backing asset was excluded from it.
function snapshotSummary(row, values) {
  const assets = values.filter(v => v.type === 'asset');
  const liabilities = values.filter(v => v.type === 'liability');
  const liquidAssets = assets.filter(v => !v.is_illiquid);
  const illiquidAssets = assets.filter(v => v.is_illiquid);
  const liquidLiabilities = liabilities.filter(v => !v.is_illiquid);
  const illiquidLiabilities = liabilities.filter(v => v.is_illiquid);

  const sum = (list) => list.reduce((s, v) => s.plus(v.value_eur), ZERO);

  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const liquidAssetsTotal = sum(liquidAssets);
  const illiquidAssetsTotal = sum(illiquidAssets);
  const liquidLiabilitiesTotal = sum(liquidLiabilities);
  const illiquidLiabilitiesTotal = sum(illiquidLiabilities);

  return {
    id:                       row.id,
    date:                     row.snapshot_date,
    notes:                    row.notes,
    total_assets_eur:         toEurStr(totalAssets),
    liquid_assets_eur:        toEurStr(liquidAssetsTotal),
    illiquid_assets_eur:      toEurStr(illiquidAssetsTotal),
    total_liabilities_eur:    toEurStr(totalLiabilities),
    liquid_liabilities_eur:   toEurStr(liquidLiabilitiesTotal),
    illiquid_liabilities_eur: toEurStr(illiquidLiabilitiesTotal),
    net_worth_eur:            toEurStr(totalAssets.minus(totalLiabilities)),
    liquid_net_worth_eur:     toEurStr(liquidAssetsTotal.minus(liquidLiabilitiesTotal)),
  };
}

// ---- Items ----

// GET /api/v1/net-worth/items?include_archived=1
router.get('/items', (req, res) => {
  const where = req.query.include_archived ? '' : 'WHERE archived_at IS NULL';
  const rows = db.prepare(
    `SELECT * FROM net_worth_items ${where} ORDER BY type, sort_order, name`
  ).all();
  res.json(rows);
});

// POST /api/v1/net-worth/items
router.post('/items', (req, res) => {
  const { name, type, category, is_illiquid = false, sort_order = 0 } = req.body;

  if (!name || !type || !category) {
    return res.status(400).json({ error: 'Missing required fields: name, type, category' });
  }
  if (!CATEGORIES[type]?.includes(category)) {
    return res.status(400).json({ error: `Invalid category for type ${type}` });
  }

  const result = db.prepare(
    `INSERT INTO net_worth_items (name, type, category, is_illiquid, sort_order) VALUES (?, ?, ?, ?, ?)`
  ).run(name, type, category, is_illiquid ? 1 : 0, sort_order);

  res.status(201).json(db.prepare('SELECT * FROM net_worth_items WHERE id = ?').get(result.lastInsertRowid));
});

// PUT /api/v1/net-worth/items/:id
router.put('/items/:id', (req, res) => {
  const { id } = req.params;
  const item = db.prepare('SELECT * FROM net_worth_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const { name, category, is_illiquid, sort_order, archived } = req.body;

  if (category && !CATEGORIES[item.type]?.includes(category)) {
    return res.status(400).json({ error: `Invalid category for type ${item.type}` });
  }

  db.prepare(`
    UPDATE net_worth_items SET
      name        = ?,
      category    = ?,
      is_illiquid = ?,
      sort_order  = ?,
      archived_at = ?
    WHERE id = ?
  `).run(
    name ?? item.name,
    category ?? item.category,
    is_illiquid === undefined ? item.is_illiquid : (is_illiquid ? 1 : 0),
    sort_order ?? item.sort_order,
    archived === undefined ? item.archived_at : (archived ? new Date().toISOString() : null),
    id,
  );

  res.json(db.prepare('SELECT * FROM net_worth_items WHERE id = ?').get(id));
});

// DELETE /api/v1/net-worth/items/:id
router.delete('/items/:id', (req, res) => {
  const { id } = req.params;
  const item = db.prepare('SELECT id FROM net_worth_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const used = db.prepare('SELECT 1 FROM net_worth_values WHERE item_id = ? LIMIT 1').get(id);
  if (used) {
    return res.status(400).json({ error: 'Item is used in a snapshot — archive it instead of deleting' });
  }

  const linkedLoan = db.prepare('SELECT name FROM loans WHERE net_worth_item_id = ?').get(id);
  if (linkedLoan) {
    return res.status(400).json({ error: `Item is linked to loan "${linkedLoan.name}" — unlink it first` });
  }

  db.prepare('DELETE FROM net_worth_items WHERE id = ?').run(id);
  res.json({ deleted: true, id: parseInt(id) });
});

// ---- Snapshots ----

const VALUES_SELECT = `
  SELECT nwv.item_id, nwv.value_eur, nwi.name, nwi.type, nwi.category, nwi.is_illiquid
  FROM net_worth_values nwv
  JOIN net_worth_items nwi ON nwi.id = nwv.item_id
  WHERE nwv.snapshot_id = ?
`;

// GET /api/v1/net-worth/snapshots
router.get('/snapshots', (req, res) => {
  const rows = db.prepare('SELECT * FROM net_worth_snapshots ORDER BY snapshot_date').all();
  const summaries = rows.map(row => snapshotSummary(row, db.prepare(VALUES_SELECT).all(row.id)));
  res.json(summaries);
});

// GET /api/v1/net-worth/snapshots/:date
router.get('/snapshots/:date', (req, res) => {
  const row = db.prepare('SELECT * FROM net_worth_snapshots WHERE snapshot_date = ?').get(req.params.date);
  if (!row) return res.status(404).json({ error: 'Snapshot not found' });

  const values = db.prepare(VALUES_SELECT + ' ORDER BY nwi.type, nwi.sort_order, nwi.name').all(row.id);
  res.json({ ...snapshotSummary(row, values), items: values });
});

// POST /api/v1/net-worth/snapshots
// body: { date, notes, values: { [item_id]: value_eur } }
router.post('/snapshots', (req, res) => {
  const { date, notes, values = {} } = req.body;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const existing = db.prepare('SELECT id FROM net_worth_snapshots WHERE snapshot_date = ?').get(date);
  if (existing) return res.status(409).json({ error: 'A snapshot already exists for this date' });

  let parsedValues;
  try {
    parsedValues = Object.entries(values).map(([itemId, v]) => [parseInt(itemId), toEurStr(new Decimal(v))]);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid decimal value: ' + e.message });
  }

  const insertSnapshot = db.prepare(
    `INSERT INTO net_worth_snapshots (snapshot_date, notes) VALUES (?, ?)`
  );
  const insertValue = db.prepare(
    `INSERT INTO net_worth_values (snapshot_id, item_id, value_eur) VALUES (?, ?, ?)`
  );

  const snapshotId = db.transaction(() => {
    const result = insertSnapshot.run(date, notes || null);
    for (const [itemId, valueEur] of parsedValues) {
      insertValue.run(result.lastInsertRowid, itemId, valueEur);
    }
    return result.lastInsertRowid;
  })();

  const row = db.prepare('SELECT * FROM net_worth_snapshots WHERE id = ?').get(snapshotId);
  const savedValues = db.prepare(VALUES_SELECT).all(snapshotId);

  res.status(201).json({ ...snapshotSummary(row, savedValues), items: savedValues });
});

// PUT /api/v1/net-worth/snapshots/:date
// body: { notes, values: { [item_id]: value_eur } }
router.put('/snapshots/:date', (req, res) => {
  const row = db.prepare('SELECT * FROM net_worth_snapshots WHERE snapshot_date = ?').get(req.params.date);
  if (!row) return res.status(404).json({ error: 'Snapshot not found' });

  const { notes, values = {} } = req.body;

  let parsedValues;
  try {
    parsedValues = Object.entries(values).map(([itemId, v]) => [parseInt(itemId), toEurStr(new Decimal(v))]);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid decimal value: ' + e.message });
  }

  const deleteValues = db.prepare('DELETE FROM net_worth_values WHERE snapshot_id = ?');
  const insertValue = db.prepare(
    `INSERT INTO net_worth_values (snapshot_id, item_id, value_eur) VALUES (?, ?, ?)`
  );
  const updateSnapshot = db.prepare('UPDATE net_worth_snapshots SET notes = ? WHERE id = ?');

  db.transaction(() => {
    updateSnapshot.run(notes ?? row.notes, row.id);
    deleteValues.run(row.id);
    for (const [itemId, valueEur] of parsedValues) {
      insertValue.run(row.id, itemId, valueEur);
    }
  })();

  const updatedRow = db.prepare('SELECT * FROM net_worth_snapshots WHERE id = ?').get(row.id);
  const savedValues = db.prepare(VALUES_SELECT).all(row.id);

  res.json({ ...snapshotSummary(updatedRow, savedValues), items: savedValues });
});

// DELETE /api/v1/net-worth/snapshots/:date
router.delete('/snapshots/:date', (req, res) => {
  const row = db.prepare('SELECT id FROM net_worth_snapshots WHERE snapshot_date = ?').get(req.params.date);
  if (!row) return res.status(404).json({ error: 'Snapshot not found' });

  db.prepare('DELETE FROM net_worth_snapshots WHERE id = ?').run(row.id);
  res.json({ deleted: true, date: req.params.date });
});

module.exports = router;
