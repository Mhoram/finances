'use strict';

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const db      = require('../db/database');
const { parseDeGiroCSV } = require('../lib/degiro');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// POST /api/v1/import/preview  — dry run, no DB writes
router.post('/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const csv = req.file.buffer.toString('utf8');
  let parsed;
  try {
    parsed = parseDeGiroCSV(csv);
  } catch (e) {
    return res.status(400).json({ error: 'CSV parse error: ' + e.message });
  }

  // Annotate each row with duplicate status
  const annotated = parsed.rows.map(row => {
    const exists = row.import_id
      ? !!db.prepare('SELECT id FROM transactions WHERE import_id = ?').get(row.import_id)
      : false;
    return { ...row, duplicate: exists };
  });

  res.json({
    total:      annotated.length,
    new:        annotated.filter(r => !r.duplicate).length,
    duplicates: annotated.filter(r =>  r.duplicate).length,
    errors:     parsed.errors,
    rows:       annotated,
  });
});

// POST /api/v1/import/degiro  — actual import
router.post('/degiro', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const csv = req.file.buffer.toString('utf8');
  let parsed;
  try {
    parsed = parseDeGiroCSV(csv);
  } catch (e) {
    return res.status(400).json({ error: 'CSV parse error: ' + e.message });
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO transactions
      (type, date, time, isin, product_name, quantity, price_eur, costs_eur, total_eur, source, import_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'degiro', ?)
  `);

  let imported   = 0;
  let duplicates = 0;

  const importMany = db.transaction((rows) => {
    for (const row of rows) {
      const result = insert.run(
        row.type, row.date, row.time, row.isin, row.product_name,
        row.quantity, row.price_eur, row.costs_eur, row.total_eur, row.import_id
      );
      if (result.changes > 0) imported++;
      else duplicates++;
    }
  });

  importMany(parsed.rows);

  res.json({ imported, duplicates, errors: parsed.errors });
});

module.exports = router;
