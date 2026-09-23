'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const ENABLE_BANKING_HOST = 'api.enablebanking.com';

// Load private key from file
function loadPrivateKey() {
    const keyPath = process.env.ENABLE_BANKING_KEY_PATH || path.join(__dirname, '..', 'keys', 'enablebanking.pem');
    if (!fs.existsSync(keyPath)) {
        throw new Error(`Enable Banking private key not found at ${keyPath}`);
    }
    return fs.readFileSync(keyPath, 'utf8');
}

// Generate RS256 JWT for API authentication
function createJwt(appId) {
    const privateKey = loadPrivateKey();
    const now = Math.floor(Date.now() / 1000);

    const header = {
        alg: 'RS256',
        typ: 'JWT',
        kid: appId
    };

    // Per Enable Banking API spec: iss is ALWAYS 'enablebanking.com'
    // (the application id only appears in the kid header claim).
    const payload = {
        iss: 'enablebanking.com',
        aud: 'api.enablebanking.com',
        iat: now,
        exp: now + 30, // 30 second expiry (max allowed TTL: 24h)
        jti: crypto.randomUUID()
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto.createSign('RSA-SHA256')
        .update(signingInput)
        .sign(privateKey, 'base64url');

    return `${signingInput}.${signature}`;
}

// Generic API request wrapper using https module
function apiRequest(endpoint, options = {}) {
    return new Promise((resolve, reject) => {
        const appId = process.env.ENABLE_BANKING_APP_ID;
        if (!appId) {
            return reject(new Error('ENABLE_BANKING_APP_ID not set'));
        }

        const jwt = createJwt(appId);
        const bodyString = options.body || '';

        const requestOptions = {
            hostname: ENABLE_BANKING_HOST,
            port: 443,
            path: endpoint,
            method: options.method || 'GET',
            headers: {
                'Authorization': `Bearer ${jwt}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(bodyString),
                ...options.headers
            }
        };

        console.log('Enable Banking API request:', JSON.stringify({
            url: `https://${ENABLE_BANKING_HOST}${endpoint}`,
            method: requestOptions.method,
            headers: requestOptions.headers,
            body: bodyString
        }, null, 2));

        const req = https.request(requestOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error(`Enable Banking API error ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', (err) => reject(err));

        if (bodyString) {
            req.write(bodyString);
        }
        req.end();
    });
}

// List available ASPSPs (banks). Always fetch names from here rather than
// hardcoding — exact names matter (e.g. 'Mock ASPSP' in sandbox; N26 only
// exists once the application is production).
async function getAspsps(country = 'IE') {
    return apiRequest(`/aspsps?country=${encodeURIComponent(country)}`);
}

// Start authorization for a bank (redirect flow)
async function startAuth(aspspId, psuType = 'personal', state = null) {
    const redirectUrl = process.env.ENABLE_BANKING_REDIRECT_URL;
    if (!redirectUrl) {
        throw new Error('ENABLE_BANKING_REDIRECT_URL not set');
    }

    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 90); // 90 days default

    // NOTE: do NOT send access.accounts — the API expects an array of
    // AccountIdentification objects ({iban: '...'}), and anything else
    // (e.g. the wildcard string '*') fails schema validation with a
    // MISLEADING 422 "set Content-Type" error. Omitting it lets the
    // bank/PSU choose the accounts during the consent flow.
    const body = {
        access: {
            balances: true,
            transactions: true,
            valid_until: validUntil.toISOString()
        },
        aspsp: {
            name: aspspId,
            country: 'IE'
        },
        psu_type: psuType,
        redirect_url: redirectUrl,
        state: state || crypto.randomUUID()
    };

    return apiRequest('/auth', {
        method: 'POST',
        body: JSON.stringify(body)
    });
}

// Exchange authorization code for session
async function createSession(code, state) {
    return apiRequest('/sessions', {
        method: 'POST',
        body: JSON.stringify({ code, state })
    });
}

// Get session details (status, account uuid list, accounts_data)
async function getSession(sessionId) {
    return apiRequest(`/sessions/${encodeURIComponent(sessionId)}`);
}

// Get accounts for a session
async function getAccounts(sessionId) {
    return apiRequest(`/accounts?session_id=${encodeURIComponent(sessionId)}`);
}

// Get transactions for an account
async function getTransactions(accountId, sessionId, dateFrom, dateTo, continuationKey) {
    const params = new URLSearchParams({ session_id: sessionId });
    if (dateFrom) params.append('date_from', dateFrom);
    if (dateTo) params.append('date_to', dateTo);
    if (continuationKey) params.append('continuation_key', continuationKey);

    return apiRequest(`/accounts/${accountId}/transactions?${params}`);
}

// Get account balances
async function getBalances(accountId, sessionId) {
    return apiRequest(`/accounts/${accountId}/balances?session_id=${encodeURIComponent(sessionId)}`);
}

module.exports = {
    createJwt,
    getAspsps,
    startAuth,
    createSession,
    getSession,
    getAccounts,
    getTransactions,
    getBalances
};
