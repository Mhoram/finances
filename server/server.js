'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();

// This is an API-only server — the mortgage-calc frontend is deployed
// separately as a static site (see ../index.html and friends), so requests
// will usually be cross-origin. Set CORS_ORIGIN to the exact origin(s) the
// frontend is served from in production; defaults to allow-all for local dev.
//
// SECURITY NOTE: there is no authentication here (matching the original
// CGT-tracker, which was designed to run locally/privately). Anyone who can
// reach this API can read and modify all transactions and net worth data.
// If you expose this beyond localhost, put it behind a VPN/firewall/auth
// proxy of your choosing — that's on the deployment side, not this code.
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(corsOrigin ? { origin: corsOrigin.split(',').map(s => s.trim()) } : {}));

app.use(express.json());

// Debug logging for all requests
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${req.headers['user-agent'] || 'no-ua'} ${JSON.stringify(req.headers['host'])}`);
    next();
});

app.get('/api/v1/health', (req, res) => res.json({ ok: true }));

// Root route for URL validation (e.g. Enable Banking redirect URL check)
app.get('/', (req, res) => res.json({ ok: true }));

app.use('/api/v1/transactions', require('./routes/transactions'));
app.use('/api/v1/import', require('./routes/import'));
app.use('/api/v1/report', require('./routes/reports'));
app.use('/api/v1/holdings', require('./routes/holdings'));
app.use('/api/v1/prices', require('./routes/prices'));
app.use('/api/v1/deemed-disposal', require('./routes/deemed-disposal'));
app.use('/api/v1/net-worth', require('./routes/net-worth'));
app.use('/api/v1/cashflow', require('./routes/cashflow'));
app.use('/api/v1/bank-sync', require('./routes/bank-sync'));

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;

// Bank open-banking flows (Enable Banking) redirect back to this server after
// SCA, and their production environment requires an https:// redirect URL —
// even on loopback. mkcert (see README) gives us a locally-trusted cert for
// that; TLS_CERT_PATH/TLS_KEY_PATH let a real deployment override with its own.
const certPath = process.env.TLS_CERT_PATH || path.join(__dirname, 'keys', 'localhost.pem');
const keyPath  = process.env.TLS_KEY_PATH  || path.join(__dirname, 'keys', 'localhost-key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
        .listen(PORT, () => console.log(`mortgage-calc CGT API running on https://localhost:${PORT}`));
} else {
    app.listen(PORT, () => console.log(`mortgage-calc CGT API running on http://localhost:${PORT}`));
}
