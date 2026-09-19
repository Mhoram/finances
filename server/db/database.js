'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Point this at your existing CGT-tracker data/cgt.db to migrate with zero
// transformation — the schema here is identical. e.g.:
//   DB_PATH=/path/to/CGT-tracker/data/cgt.db node server.js
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cgt.db');

const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migrations — safe to re-run, errors ignored for already-existing columns.
const migrations = [
    `ALTER TABLE prices ADD COLUMN ticker   TEXT`,
    `ALTER TABLE prices ADD COLUMN currency TEXT`,
    `ALTER TABLE net_worth_items ADD COLUMN is_illiquid INTEGER NOT NULL DEFAULT 0`,
];
for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
}

module.exports = db;
