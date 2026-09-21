'use strict';

// Test script to verify Enable Banking API directly with curl
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const appId = process.env.ENABLE_BANKING_APP_ID;
const keyPath = process.env.ENABLE_BANKING_KEY_PATH || path.join(__dirname, 'keys', 'enablebanking.pem');
const redirectUrl = process.env.ENABLE_BANKING_REDIRECT_URL;

if (!appId || !fs.existsSync(keyPath) || !redirectUrl) {
    console.error('Missing required env vars: ENABLE_BANKING_APP_ID, ENABLE_BANKING_KEY_PATH, ENABLE_BANKING_REDIRECT_URL');
    process.exit(1);
}

// Generate JWT
const privateKey = fs.readFileSync(keyPath, 'utf8');
const now = Math.floor(Date.now() / 1000);

const header = { alg: 'RS256', typ: 'JWT', kid: appId };
const payload = {
    iss: 'enablebanking.com',
    aud: 'api.enablebanking.com',
    iat: now,
    exp: now + 30,
    jti: crypto.randomUUID()
};

const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
const signingInput = `${encodedHeader}.${encodedPayload}`;

const signature = crypto.createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privateKey, 'base64url');

const jwt = `${signingInput}.${signature}`;

// Build request body
const validUntil = new Date();
validUntil.setDate(validUntil.getDate() + 90);

// access.accounts omitted: must be AccountIdentification objects ({iban: ...}),
// not strings — sending "'*'" fails validation with a misleading 422 error.
const body = {
    access: {
        balances: true,
        transactions: true,
        valid_until: validUntil.toISOString()
    },
    aspsp: {
        name: 'n26',
        country: 'IE'
    },
    psu_type: 'personal',
    redirect_url: redirectUrl,
    state: crypto.randomUUID()
};

const bodyString = JSON.stringify(body);

// Write body to temp file for curl
const bodyFile = '/tmp/eb-body.json';
fs.writeFileSync(bodyFile, bodyString);

// Build curl command exactly as in their docs
const curlCmd = `curl -v -X POST \\
  -H "Authorization: Bearer ${jwt}" \\
  -H "Content-Type: application/json" \\
  -d @${bodyFile} \\
  https://api.enablebanking.com/auth`;

console.log('Running curl command...');
console.log(curlCmd);
console.log('\n---\n');

try {
    const result = execSync(curlCmd, { encoding: 'utf8', shell: '/bin/bash' });
    console.log('Success:', result);
} catch (err) {
    console.error('Error:', err.stderr || err.message);
}

// Cleanup
fs.unlinkSync(bodyFile);
