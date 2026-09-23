'use strict';

const express = require('express');
const crypto = require('crypto');
const { Decimal } = require('decimal.js');
const router = express.Router();
const enableBanking = require('../lib/enableBanking');
const db = require('../db/database');

/**
 * Signed amount string from an Enable Banking transaction.
 * transaction_amount.amount is always positive; credit_debit_indicator
 * (CRDT/DBIT) carries the direction. We store signed: positive = money in.
 */
function signedAmount(t) {
    const amount = new Decimal(t.transaction_amount?.amount ?? '0');
    const signed = t.credit_debit_indicator === 'DBIT' ? amount.neg() : amount;
    return signed.toFixed(2);
}

/**
 * Booking date with fallbacks — some ASPSPs populate different date fields.
 */
function txDate(t) {
    return t.booking_date || t.value_date || t.transaction_date || null;
}

/**
 * Dedup key for an Enable Banking transaction. entry_reference is unique and
 * immutable per account, but only within the same account, so mix in the
 * provider account id.
 */
function makeImportId(providerAccountId, t) {
    const raw = [
        providerAccountId,
        t.entry_reference || '',
        txDate(t) || '',
        signedAmount(t),
    ].join('|');
    return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Extract a usable counterparty + description from an Enable Banking
 * transaction (fields are optional and vary by ASPSP).
 */
function describeTx(t) {
    const counterparty = (t.debtor?.name || t.creditor?.name || '').trim();
    const remittance = Array.isArray(t.remittance_information)
        ? t.remittance_information.filter(Boolean).join(' ')
        : (t.remittance_information || '');
    const description = [t.note, remittance, t.reference_number]
        .filter(Boolean).join(' · ').trim();
    return { counterparty, description };
}

/**
 * Extract the provider account id from an AccountResource. The id used for
 * transaction endpoints is the TOP-LEVEL `uid` field (a UUID — "unique account
 * identificator used for fetching account balances and transactions").
 * account_id is just an AccountIdentification (iban/other) — do NOT use it for
 * API calls. Fall back through the identification fields only for display.
 */
function providerAccountId(account) {
    return account.uid
        || account.account_id?.uid
        || account.account_id?.other?.identification
        || null;
}

/**
 * Some sessions return accounts without `uid` populated. The GET /sessions/{id}
 * response has the same accounts as SessionAccounts (`accounts_data`, with uid)
 * plus a flat `accounts` list of UUIDs — match via identification_hash.
 */
async function fillMissingUids(session) {
    const accounts = session.accounts || [];
    if (!accounts.length || accounts.every(a => a.uid)) return session;

    const sessionData = await enableBanking.getSession(session.session_id);
    const byHash = new Map(
        (sessionData.accounts_data || [])
            .filter(sa => sa.uid && sa.identification_hash)
            .map(sa => [sa.identification_hash, sa.uid]),
    );
    const uuids = sessionData.accounts || [];
    for (const acc of accounts) {
        if (acc.uid) continue;
        if (acc.identification_hash && byHash.has(acc.identification_hash)) {
            acc.uid = byHash.get(acc.identification_hash);
        } else if (accounts.length === uuids.length) {
            // last resort: positional match against the flat uuid list
            acc.uid = uuids[accounts.indexOf(acc)];
        }
    }
    return session;
}

/** Upsert a session and its accounts after the callback. Returns connection row. */
function storeSession(session) {
    const info = db.prepare(`
        INSERT INTO bank_connections
            (aspsp_name, aspsp_country, psu_type, session_id, authorization_id, status, valid_until, state)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            status = 'ACTIVE', valid_until = excluded.valid_until, state = excluded.state
    `).run(
        session.aspsp?.name || 'unknown',
        session.aspsp?.country || 'IE',
        session.psu_type || 'personal',
        session.session_id,
        session.authorization_id || null,
        session.access?.valid_until || null,
        null, // state was consumed by the callback; kept column for audit
    );

    const connectionId = db.prepare(
        'SELECT id FROM bank_connections WHERE session_id = ?'
    ).get(session.session_id).id;

    const upsertAccount = db.prepare(`
        INSERT INTO bank_accounts (connection_id, provider_account_id, iban, currency, display_name)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, provider_account_id) DO UPDATE SET
            iban = excluded.iban, currency = excluded.currency, display_name = excluded.display_name
    `);

    const stored = [];
    const storeMany = db.transaction(() => {
        for (const acc of session.accounts || []) {
            const pid = providerAccountId(acc);
            if (!pid) continue;
            upsertAccount.run(
                connectionId,
                pid,
                acc.account_id?.iban || null,
                acc.currency || acc.account_id?.currency || null,
                acc.name || acc.details || 'Unnamed account',
            );
            stored.push(pid);
        }
    });
    storeMany();

    return { connectionId, accounts: stored.length };
}

/** Fetch and store transactions for one bank_account row. Returns {imported, duplicates}. */
async function syncAccountTransactions(bankAccount, dateFrom, dateTo) {
    const insert = db.prepare(`
        INSERT OR IGNORE INTO cash_transactions
            (account_id, date, amount_eur, currency, counterparty, description, source, import_id)
        VALUES (?, ?, ?, ?, ?, ?, 'enable_banking', ?)
    `);

    let imported = 0;
    let duplicates = 0;

    const importMany = db.transaction((txs) => {
        for (const t of txs) {
            if (!txDate(t)) continue; // can't place on a timeline without a date
            const { counterparty, description } = describeTx(t);
            const result = insert.run(
                bankAccount.id,
                txDate(t),
                signedAmount(t),
                t.transaction_amount?.currency || bankAccount.currency || 'EUR',
                counterparty,
                description,
                makeImportId(bankAccount.provider_account_id, t),
            );
            if (result.changes > 0) imported++;
            else duplicates++;
        }
    });

    // Paginate via continuation_key (spec supports multi-page responses).
    let continuationKey;
    do {
        const data = await enableBanking.getTransactions(
            bankAccount.provider_account_id,
            bankAccount.session_id,
            dateFrom,
            dateTo,
            continuationKey,
        );
        importMany(data.transactions || []);
        continuationKey = data.continuation_key;
    } while (continuationKey);

    return { imported, duplicates };
}

// Start bank authorization — returns { url } to redirect the PSU to.
router.post('/start', async (req, res) => {
    try {
        const { aspspId, psuType, state } = req.body;
        if (!aspspId) {
            return res.status(400).json({ error: 'aspspId required' });
        }
        const result = await enableBanking.startAuth(aspspId, psuType, state);
        res.json(result);
    } catch (err) {
        console.error('Bank sync start error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Callback from Enable Banking after user authorizes at the bank.
// Enable Banking appends ?code=...&state=... to the registered redirect URL.
router.get('/callback', async (req, res) => {
    try {
        const { code, state, error, error_description } = req.query;

        if (error) {
            console.error('Bank auth error:', error, error_description);
            return res.status(400).json({ error, error_description });
        }
        if (!code || !state) {
            return res.status(400).json({ error: 'Missing code or state parameter' });
        }

        // Exchange authorization code for a session (also returns accounts)
        const session = await enableBanking.createSession(code, state);
        await fillMissingUids(session);
        const stored = storeSession(session);

        res.json({
            ok: true,
            connectionId: stored.connectionId,
            aspsp: session.aspsp,
            validUntil: session.access?.valid_until || null,
            accountsStored: stored.accounts,
        });
    } catch (err) {
        console.error('Bank sync callback error:', err);
        res.status(500).json({ error: err.message });
    }
});

// List connections with their accounts and transaction counts.
router.get('/connections', (req, res) => {
    const connections = db.prepare(`
        SELECT c.*, GROUP_CONCAT(a.id) AS account_ids
        FROM bank_connections c LEFT JOIN bank_accounts a ON a.connection_id = c.id
        GROUP BY c.id ORDER BY c.created_at DESC
    `).all();

    const accountsStmt = db.prepare(`
        SELECT a.*, COUNT(t.id) AS tx_count
        FROM bank_accounts a
        LEFT JOIN cash_transactions t ON t.account_id = a.id
        WHERE a.connection_id = ?
        GROUP BY a.id
    `);

    res.json(connections.map(c => ({
        ...c,
        account_ids: c.account_ids ? c.account_ids.split(',').map(Number) : [],
        accounts: accountsStmt.all(c.id),
    })));
});

// Sync transactions. Body: { connectionId, dateFrom?, dateTo? }
// Dates are YYYY-MM-DD; omit for the API's default range.
router.post('/sync', async (req, res) => {
    try {
        const { connectionId, dateFrom, dateTo } = req.body;
        if (!connectionId) {
            return res.status(400).json({ error: 'connectionId required' });
        }

        const connection = db.prepare(
            'SELECT * FROM bank_connections WHERE id = ?'
        ).get(connectionId);
        if (!connection) {
            return res.status(404).json({ error: 'connection not found' });
        }

        const accounts = db.prepare(
            'SELECT a.*, ? AS session_id FROM bank_accounts a WHERE a.connection_id = ?'
        ).all(connection.session_id, connectionId);

        const results = [];
        for (const account of accounts) {
            try {
                const r = await syncAccountTransactions(account, dateFrom, dateTo);
                results.push({
                    accountId: account.id,
                    providerAccountId: account.provider_account_id,
                    displayName: account.display_name,
                    ...r,
                });
            } catch (err) {
                console.error(`Sync failed for account ${account.id}:`, err.message);
                results.push({
                    accountId: account.id,
                    providerAccountId: account.provider_account_id,
                    error: err.message,
                });
            }
        }

        res.json({
            ok: true,
            connectionId,
            results,
            imported: results.reduce((n, r) => n + (r.imported || 0), 0),
            duplicates: results.reduce((n, r) => n + (r.duplicates || 0), 0),
        });
    } catch (err) {
        console.error('Bank sync error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
