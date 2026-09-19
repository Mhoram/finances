# Cloudflare Tunnel Setup for Enable Banking Callback

For the cash flow feature's Enable Banking integration, we need a public HTTPS callback URL. Since `endymion` (the mini PC) already runs a Tailscale Serve on port 3001 for another app, we use Cloudflare Tunnel for a separate public endpoint pointing to the mortgage-calc server.

## Prerequisites

- Cloudflare account with at least one domain
- `endymion` (the mini PC) has outbound internet access
- Mortgage-calc server will run on `localhost:3002` (to avoid conflict with the existing app on 3001)

## Step 1: Install `cloudflared`

```bash
# Option A: via apt (requires Cloudflare repo — see below)
sudo apt-get install cloudflared

# Option B: download latest release directly (works on most systems)
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
```

### If apt fails with "Unable to locate package"

Cloudflare's package is not in default Debian/Ubuntu repos. Add their repo first:

```bash
# Install dependencies
sudo apt-get install -y curl gnupg

# Add Cloudflare GPG key
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null

# Add Cloudflare repo
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bullseye main' | sudo tee /etc/apt/sources.list.d/cloudflared.list

# Update and install
sudo apt-get update
sudo apt-get install -y cloudflared
```

Or just use **Option B** (direct `.deb` download) which works without adding any repo.

Verify: `cloudflared --version`

## Step 2: Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This opens a browser link. Log in to your Cloudflare account and select which domain to authorize. A certificate (`cert.pem`) is saved to `~/.cloudflared/`.

## Step 3: Create a named tunnel

```bash
cloudflared tunnel create mortgage-callback
```

Output includes:
- Tunnel ID (UUID)
- Credentials file path: `~/.cloudflared/<tunnel-id>.json`

Save the tunnel ID for the next step.

## Step 4: Configure the tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /home/<your-username>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: bank-callback.<your-domain>.com
    service: http://localhost:3002
  - service: http_status:404
```

Replace:
- `<tunnel-id>` — from Step 3
- `<your-username>` — your Linux username on `endymion`
- `<your-domain>.com` — your actual Cloudflare domain

## Step 5: Route DNS

```bash
cloudflared tunnel route dns mortgage-callback bank-callback.<your-domain>.com
```

This creates a CNAME in Cloudflare DNS pointing `bank-callback.<your-domain>.com` to the tunnel.

## Step 6: Start the tunnel

### Manual (for testing)

```bash
cloudflared tunnel run mortgage-callback
```

### As a systemd service (for persistence)

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

Check status: `sudo systemctl status cloudflared`

## Step 7: Register with Enable Banking

In the Enable Banking control panel, set the application's redirect URL to:

```
https://bank-callback.<your-domain>.com/api/v1/bank-sync/callback
```

## Port note

The mortgage-calc server should run on **port 3002** (or another free port) to avoid conflict with the existing app on 3001. Set `PORT=3002` in `server/.env`.

## Verification

1. Start the mortgage-calc server on `endymion`: `cd /path/to/mortgage-calc/server && node server.js`
2. Ensure `cloudflared` is running
3. Test from another machine: `curl https://bank-callback.<your-domain>.com/`
4. You should hit the mortgage-calc server (or get its 404/response, confirming the tunnel works)

## Troubleshooting

- **Tunnel not connecting**: Check `cloudflared tunnel list` — status should be `Active`. Check firewall outbound on 443/HTTPS.
- **DNS not resolving**: Verify the CNAME exists in Cloudflare DNS dashboard. TTL may take a minute.
- **Wrong backend**: Confirm `server/.env` has `PORT=3002` and the server is actually listening there (`ss -tlnp | grep 3002`).
