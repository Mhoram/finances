'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');

/**
 * Cash flow read API — lists/stores nothing itself; reads the
 * cash_transactions rows produced by bank-sync (Enable Banking) and CSV
 * imports. Amounts are signed strings in the DB; SQLite coerces them for SUM.
 */

const MAX_LIMIT = 500;

function buildFilters(query) {
    const where = [];
    const params = [];
    if (query.account_id) { where.push('t.account_id = ?'); params.push(Number(query.account_id)); }
    if (query.date_from) { where.push('t.date >= ?'); params.push(String(query.date_from)); }
    if (query.date_to) { where.push('t.date <= ?'); params.push(String(query.date_to)); }
    if (query.q) {
        where.push('(t.counterparty LIKE ? OR t.description LIKE ?)');
        const like = `%${String(query.q)}%`;
        params.push(like, like);
    }
    return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// GET /api/v1/cashflow/transactions — paged, filtered list
router.get('/transactions', (req, res) => {
    const { where, params } = buildFilters(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), MAX_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

    const total = db.prepare(
        `SELECT COUNT(*) AS n FROM cash_transactions t ${where}`
    ).get(...params).n;

    const rows = db.prepare(`
        SELECT t.id, t.date, t.amount_eur, t.currency, t.counterparty, t.description, t.source,
               t.account_id, a.display_name AS account_name
        FROM cash_transactions t
        LEFT JOIN bank_accounts a ON a.id = t.account_id
        ${where}
        ORDER BY t.date ${order}, t.id ${order}
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ total, limit, offset, rows });
});

// GET /api/v1/cashflow/summary — monthly in/out/net + totals + per-account
router.get('/summary', (req, res) => {
    const { where, params } = buildFilters(req.query);

    const months = db.prepare(`
        SELECT strftime('%Y-%m', t.date) AS month,
               COALESCE(SUM(CASE WHEN t.amount_eur > 0 THEN t.amount_eur ELSE 0 END), 0) AS money_in,
               COALESCE(SUM(CASE WHEN t.amount_eur < 0 THEN -t.amount_eur ELSE 0 END), 0) AS money_out,
               COALESCE(SUM(t.amount_eur), 0) AS net,
               COUNT(t.id) AS tx_count
        FROM cash_transactions t
        ${where}
        GROUP BY month
        ORDER BY month
    `).all(...params);

    const totals = months.reduce(
        (acc, m) => ({
            money_in: acc.money_in + Number(m.money_in),
            money_out: acc.money_out + Number(m.money_out),
            net: acc.net + Number(m.net),
            tx_count: acc.tx_count + m.tx_count,
        }),
        { money_in: 0, money_out: 0, net: 0, tx_count: 0 },
    );

    const byAccount = db.prepare(`
        SELECT a.id AS account_id, a.display_name, a.iban,
               COUNT(t.id) AS tx_count,
               COALESCE(SUM(CASE WHEN t.amount_eur > 0 THEN t.amount_eur ELSE 0 END), 0) AS money_in,
               COALESCE(SUM(CASE WHEN t.amount_eur < 0 THEN -t.amount_eur ELSE 0 END), 0) AS money_out,
               COALESCE(SUM(t.amount_eur), 0) AS net
        FROM bank_accounts a
        LEFT JOIN cash_transactions t ON t.account_id = a.id
        GROUP BY a.id
        ORDER BY a.id
    `).all();

    res.json({ months, totals, by_account: byAccount });
});

module.exports = router;
