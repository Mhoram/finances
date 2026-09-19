# Cash Flow Feature — Plan & Status

Last updated: 2026-09-13

## Goal

Add cash-flow tracking to mortgage-calc by syncing bank transactions automatically, rather than manual entry.

## Accounts & data sources

| Account | Method | Status |
|---|---|---|
| N26 (main) | Enable Banking API | Confirmed supported (Ireland ASPSP list, `personal` PSU type, redirect auth, live) |
| Revolut | Enable Banking API | Confirmed supported, live (not beta) |
| Trade Republic (savings) | Enable Banking API | Supported but `beta: true` — 90-day consent validity vs 180-day for the others, needs quarterly re-auth |
| Avant Money credit card | Manual CSV import | Not on Enable Banking's ASPSP list at all. Avant has its own PSD2/Token.io AISP program but registering as a TPP is too heavy for one card. Use Avant's own portal export instead, reuse the existing CSV-import-with-sha256-dedup pattern from `server/lib/degiro.js` + `server/routes/import.js`. |

## Why Enable Banking (not GoCardless)

GoCardless Bank Account Data (formerly Nordigen) is **dead for new signups** — closed since July 2025, docs sunsetting Aug 2026. Enable Banking is the replacement: real self-serve option, no contract needed for personal use via their **Restricted Production** tier (free — "activate by linking your own accounts," no KYB/payment) as long as you're only ever linking accounts you personally own. Full production (serving other people's accounts) requires a paid contract + KYB.

Confirmed independently via a Firefly III GitHub issue (not just Enable Banking's own marketing/SEO content), so the free personal-use path is real.

## Planned schema (new tables, same style as existing `net_worth_items`/`transactions`)

- `bank_connections` — aspsp name, psu_type, consent/session id, `valid_until` (180d N26/Revolut, 90d Trade Republic), status
- `bank_accounts` — FK to connection, provider account id, IBAN, display name, currency
- `cash_transactions` — FK to account (nullable for CSV-only Avant rows), date, signed `amount_eur`, counterparty/description, category, `source` (`'enable_banking'` | `'avant_csv'`), `import_id` UNIQUE (sha256 dedup, same pattern as `degiro.js`)

## Planned sync module

`server/lib/enableBanking.js` — RS256 JWT signing with the app's private key, thin fetch wrappers for `/auth`, `/sessions`, `/accounts`, `/accounts/{id}/transactions`.

`server/routes/bank-sync.js` — `start` (kick off redirect), `callback` (exchange code for session), `sync` (pull transactions). No auth on the server itself (matches this repo's existing local/private-use design — see `server.js` comment) — bank credentials/tokens get the same "protect at network layer, not in-app" treatment as everything else.

## Signup process (Enable Banking Control Panel)

1. Go to `enablebanking.com/sign-in/`, enter email, click the magic-link — first sign-in auto-creates the account.
2. Register an application in "API applications": name, redirect URL(s), **Environment = Production** (not Sandbox).
3. Private key step — pick **"Generate in the browser (using SubtleCrypto) and export private key"** (the default/simpler option; the alternative is generating your own CSR via openssl, unnecessary for a personal tool). Downloads `<application_id>.pem` — treat like `.env`, never commit.
4. New app starts "Inactive." Click **"Activate by linking accounts"** — walks through Enable Banking's auth screen then the bank's own login/SCA. Confirming flips the app to **Active (restricted mode)**.
5. Repeat step 4 per account (N26, then Revolut, then Trade Republic).
6. API calls: sign a short-lived RS256 JWT with the private key from step 3.

## Blocker hit: redirect URL requirements

Enable Banking's production form rejected two things in sequence:
1. `http://localhost:3001/...` — scheme error (production requires `https://`).
2. `https://localhost:3001/...` — **still rejected as "invalid URL"** even with the right scheme. Production apparently requires a real, publicly-resolvable host, not `localhost` (sandbox is presumably more lenient — untested here since we're on production for restricted-mode).

### mkcert (done, but insufficient alone)

Set up local HTTPS so `localhost` at least serves TLS correctly, in case it was needed as a base:
- Installed `mkcert` + `libnss3-tools` via apt, ran `mkcert -install` and `mkcert localhost 127.0.0.1 ::1`.
- Cert files moved to `server/keys/localhost.pem` + `server/keys/localhost-key.pem`, added `keys/` to `server/.gitignore`.
- `server.js` edited to auto-detect these cert files and serve HTTPS on `PORT` when present, falling back to plain HTTP otherwise (so it doesn't break other deployments). Verified working with a live curl test.
- **WSL2 note**: `mkcert -install` only trusts the CA inside this Linux environment. A Windows-side browser hitting `https://localhost:3001` directly would still show a warning unless `mkcert.exe` + `mkcert -install` is also run on Windows with the same CA root copied across. Not blocking — harmless to click through for personal dev.

This solved the TLS/scheme issue but **not** the "needs a real public host" issue — hence tunnel required regardless.

### ngrok attempt — abandoned

Installed the `ngrok` binary to `~/.local/bin/ngrok` (binary only, never configured/run — no authtoken added). **The user had not given permission for this install** and objected once they noticed. Binary is still sitting there unused; consider deleting it (`~/.local/bin/ngrok` and the download in `/tmp/claude-1000/.../scratchpad`) or leave as-is — user's call, wasn't asked yet.

### Decision: Cloudflare Tunnel instead

User already uses Cloudflare and has several domains in their Cloudflare account. Plan is a **named tunnel** (not the anonymous `trycloudflare.com` quick tunnel) bound to a stable subdomain on one of those domains — e.g. `bank-callback.<one-of-your-domains>.com` — forwarding to local port. This avoids the quick-tunnel/free-ngrok problem where the URL rotates every restart and you'd have to re-register the redirect URL with Enable Banking every session.

## Current blocker / next step

`cloudflared` is **not installed** (`which cloudflared` → not found). Installing needs `sudo apt-get install cloudflared`, which requires an interactive password Claude Code can't supply.

**User decided (2026-09-13): will handle the cloudflared install themselves later, not now.** Picking this up in a future session — see steps below.

### Next session TODO

1. User installs `cloudflared` themselves (`sudo apt-get install cloudflared` — needs their password interactively, or via `!` prefix in a Claude Code session) and logs in (`cloudflared tunnel login`) against whichever domain they want to use.
2. Pick which of the user's several Cloudflare domains to use, and the subdomain name (e.g. `bank-callback.<domain>`).
3. Create the named tunnel + DNS route, pointing at local port (need to settle on final port — see note below).
4. Register that stable `https://bank-callback.<domain>/api/v1/bank-sync/callback` URL as the Enable Banking application's redirect URL.
5. Finish the Enable Banking signup flow (Section "Signup process" above, steps 4–6) — link N26, Revolut, Trade Republic accounts.
6. Implement `server/lib/enableBanking.js` and `server/routes/bank-sync.js` per the "Planned sync module" section.
7. Implement the schema migration for `bank_connections` / `bank_accounts` / `cash_transactions`.
8. Build Avant Money CSV import (reuse `degiro.js` dedup pattern).

## Loose ends / notes

- **Port conflict**: port 3001 is mortgage-calc's default (`server/.env.example`), but it's currently being squatted by an unrelated project (`/home/mhoram/Dev/yo/server`, a `tsx` watch-mode dev server) whenever that's running. Either stop that server before running mortgage-calc's, or give mortgage-calc a different port (e.g. `PORT=3002` in `server/.env`) and use that port consistently in the tunnel config and the registered redirect URL.
- Uncommitted changes already sitting in the mortgage-calc working tree (unrelated to this feature, don't disturb): modified `.gitignore`, `css/styles.css`, `index.html`, and several new untracked `js/cgt-*.js` files plus the `server/` directory itself (this whole cash-flow feature lives in the untracked `server/`).
