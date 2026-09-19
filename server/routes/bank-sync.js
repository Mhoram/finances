'use strict';

const express = require('express');
const router = express.Router();
const enableBanking = require('../lib/enableBanking');

// Start bank authorization (redirects to bank login)
router.post('/start', async (req, res) => {
    try {
        const { aspspId, psuType } = req.body;
        if (!aspspId) {
            return res.status(400).json({ error: 'aspspId required' });
        }

        const result = await enableBanking.startAuth(aspspId, psuType);
        res.json(result);
    } catch (err) {
        console.error('Bank sync start error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Callback from Enable Banking after user authorizes at bank
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

        // Exchange code for session
        const session = await enableBanking.createSession(code, state);

        // Store session in database (TODO: implement with bank_connections table)
        // For now, just return it
        res.json({
            ok: true,
            sessionId: session.session_id,
            aspsp: session.aspsp,
            psuType: session.psu_type,
            validUntil: session.valid_until
        });
    } catch (err) {
        console.error('Bank sync callback error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Sync transactions for a connected account
router.post('/sync', async (req, res) => {
    try {
        const { sessionId, accountId, dateFrom, dateTo } = req.body;
        if (!sessionId || !accountId) {
            return res.status(400).json({ error: 'sessionId and accountId required' });
        }

        const transactions = await enableBanking.getTransactions(accountId, sessionId, dateFrom, dateTo);

        // TODO: Store transactions in cash_transactions table with dedup
        res.json({
            ok: true,
            count: transactions.transactions?.length || 0,
            transactions: transactions.transactions || []
        });
    } catch (err) {
        console.error('Bank sync error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
