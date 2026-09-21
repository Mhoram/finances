# Enable Banking Integration Debug Log

## 2026-09-20 — RESOLVED: 422 root cause found

**The 422 mystery is solved.** Fetched the official OpenAPI spec from
`https://enablebanking.com/docs/api/reference/enablebanking-api.yaml` (note:
`docs.enablebanking.com` does not resolve — the docs live under
`enablebanking.com/docs/`). Two discrepancies vs. our client:

1. **`access.accounts` must be an array of `AccountIdentification` objects**
   (e.g. `[{"iban": "FI..."}]`), per the spec's `Access` schema. Sending the
   wildcard string `'*'` fails schema validation and produces the misleading
   422 "set Content-Type: application/json" error. The `['*']` wildcard syntax
   appears to be from Nordigen/GoCardless, not Enable Banking. **Fix: omit
   `accounts` entirely** — the bank/PSU then selects accounts during the
   consent flow.
2. **JWT `iss` must always be `"enablebanking.com"`**, not the application ID
   (the app ID belongs only in the `kid` header claim). Confirmed in the spec's
   `bearerAuth` securityScheme description.

Both fixes applied to `server/lib/enableBanking.js` and
`server/test-enable-banking.js`. Verified live with an A/B test matrix
(old body / new body × old iss / new iss): the 422 disappears as soon as
`accounts: ['*']` is removed, regardless of `iss`.

**Blocker 2 — `400 REDIRECT_URI_NOT_ALLOWED`: trailing-slash mismatch.**
The registered redirect URL was `.../callback/` (trailing slash) while the
client sent `.../callback`. Enable Banking compares redirect URLs as exact
strings. Fixed by setting `ENABLE_BANKING_REDIRECT_URL` to match the
registered URL exactly (trailing slash included).

**Blocker 3 — `422 WRONG_ASPSP_PROVIDED`: this is a SANDBOX app.** Real banks
(N26, Revolut, Trade Republic) only exist in production applications.
`GET /aspsps?country=IE` on a sandbox app returns just `"Mock ASPSP"`.
Calling `/auth` with `{name: 'Mock ASPSP', country: 'IE'}` **SUCCEEDS** —
returns a `url` on `tilisy-sandbox.enablebanking.com` plus `authorization_id`.
The full auth → callback → session flow can now be developed/tested against
the mock bank.

✅ **Status: API integration working end-to-end for sandbox.** Added
`getAspsps()` to `server/lib/enableBanking.js` — always fetch ASPSP names from
the API instead of hardcoding.

**Next: for real banks, register a production application** (Restricted
Production, free — activate by linking own accounts, see `cashflow-plan.md`),
register the same redirect URL on it, and switch the app ID + key.

Other spec details worth noting:
- `valid_until` must be RFC3339 with timezone offset (example format
  `2025-12-01T12:00:00.000000+00:00`; `toISOString()`'s `Z` suffix is
  accepted).
- Max JWT TTL is 24h; the API host is `api.enablebanking.com` for both
  sandbox and production.
- Consent validity is capped per-ASPSP by `maximum_consent_validity` from
  `GET /aspsps` — worth fetching at runtime rather than hardcoding 90/180 days.

## 2026-09-19 — Initial Setup

- Registered sandbox app on Enable Banking control panel
- App ID: `19d9db11-41f4-4650-b610-d4054749e153`
- Downloaded private key `.pem` file
- Set up Cloudflare Tunnel on `endymion` (mini PC) for public callback URL
- Tunnel name: `finances-callback`
- Public URL: `https://finances.karlwallace.com/api/v1/bank-sync/callback`
- Server running on `endymion` at `http://localhost:3002`

## 2026-09-20 — API Client Development

### Issues Found & Fixed

1. **JWT `aud` claim missing** — Enable Banking requires `aud` in JWT payload
   - Tried: `api.enablebanking.com`, `https://api.enablebanking.com`
   - Current: `api.enablebanking.com` (still uncertain if correct)

2. **Auth request body format** — Multiple iterations based on API error responses:
   - `access.accounts`: needs to be array `['*']` not object `{}`
   - `access.balances`/`transactions`: need to be booleans `true` not objects
   - `access.valid_until`: needs ISO string with timezone, not just date
   - `aspsp`: needs `name` and `country` fields, not `id`
   - Added `state` parameter for CSRF protection

3. **Content-Type header** — Enable Banking rejects requests with misleading error
   - Tried with and without `charset=utf-8`
   - Currently sending exact `Content-Type: application/json`
   - Also added `Accept: application/json` header

4. **HTTP client issues** — Tried both Node.js built-in `fetch` and native `https` module
   - Both produce identical requests
   - Both receive identical 422 errors

### Current Status: BLOCKED

**Enable Banking API returns 422 for all `/auth` requests:**
```json
{"code":422,"message":"Wrong request parameters provided","error":"WRONG_REQUEST_PARAMETERS","detail":"Invalid body provided. Make sure that you set \"Content-Type: application/json\" header"}
```

This error is **misleading** — the Content-Type header is correctly set. The actual issue is unknown.

### Verified Working Components

- Cloudflare Tunnel: ✅ `https://finances.karlwallace.com` reachable
- Express server: ✅ Running on `endymion:3002`
- JWT generation: ✅ Valid RS256 signatures, correct structure
- Request formatting: ✅ Verified with direct curl from `endymion`
- Content-Type header: ✅ Confirmed present in request

### Tested But Failed

- Direct curl to `https://api.enablebanking.com/auth` with:
  - Valid JWT with `aud: 'api.enablebanking.com'`
  - Correct body format per API docs
  - `Content-Type: application/json` header
  - Result: **422 error** (same as through our server)

### Open Questions

1. Is `api.enablebanking.com` the correct base URL for sandbox?
2. Is `aud: 'api.enablebanking.com'` correct for sandbox JWTs?
3. Does sandbox use a different endpoint (e.g., `sandbox-api.enablebanking.com`)?
4. Is there an undocumented required field in the auth body?

### Next Steps

1. **Contact Enable Banking support** (`info@enablebanking.com`) with reproducible curl example
2. **Try alternative API base URLs** for sandbox if any exist
3. **Verify JWT `aud` claim** — may need different value for sandbox vs production
4. **Check if app needs activation** — sandbox apps auto-activate, but worth confirming

### Files Created/Modified

- `server/lib/enableBanking.js` — API client with JWT signing and request wrappers
- `server/routes/bank-sync.js` — Express routes for `/start`, `/callback`, `/sync`
- `server/server.js` — Added bank-sync router and root/callback placeholder routes
- `server/test-enable-banking.js` — Standalone test script for direct API testing
- `docs/cloudflare-tunnel-setup.md` — Tunnel setup instructions
- `docs/cashflow-plan.md` — Original feature plan
- `server/.env.example` — Added Enable Banking env vars
