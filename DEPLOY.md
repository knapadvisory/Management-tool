# Deploying TeamHub to a custom domain

This guide puts TeamHub online, always-on, at your own domain (e.g.
`teamhub.knapadvisory.com`) with automatic HTTPS. The recommended host is
**Railway** — it builds straight from GitHub, keeps your data on a
persistent disk, supports WebSockets (needed for chat/calls), and issues
the TLS certificate for your domain automatically.

The repo ships a `Dockerfile`, so the same steps work on any host that can
build a Docker image (Render, Fly.io, a VPS, …).

## What the app needs from the host

- A **persistent volume** mounted at `/data` (the SQLite database and
  uploaded files live here — without it, data resets on every redeploy).
- **WebSocket** support (Socket.IO).
- These **environment variables**:

  | Variable | Value |
  |---|---|
  | `JWT_SECRET` | a long random string (e.g. 40+ chars) |
  | `SIGNUP_CODE` | the shared code your team types to register |
  | `DATA_DIR` | `/data` |
  | `PORT` | provided by the host automatically |

## Deploy on Railway

1. Create an account at [railway.app](https://railway.app) and click
   **New Project → Deploy from GitHub repo**, then pick
   `knapadvisory/Management-tool`. Railway detects the `Dockerfile` and
   builds it.
2. Open the service → **Variables** and add `JWT_SECRET`, `SIGNUP_CODE`,
   and `DATA_DIR=/data`. (Leave `PORT` alone — Railway sets it.)
3. Open **Settings → Volumes** (or the **Data** tab) and add a volume
   mounted at **`/data`**.
4. Redeploy. When it's live, Railway gives you a URL like
   `something.up.railway.app` — open it to confirm the app loads.

## Point your domain at it

1. In the Railway service → **Settings → Networking → Custom Domain**,
   add `teamhub.knapadvisory.com`. Railway shows a **CNAME target** (looks
   like `xyz.up.railway.app`).
2. At wherever your domain's DNS is managed (Cloudflare, GoDaddy, etc.),
   add a **CNAME** record:
   - **Name/Host:** `teamhub`
   - **Value/Target:** the CNAME Railway showed you
   - (On Cloudflare, set the record to **DNS only / grey cloud** so
     Railway can issue the certificate.)
3. Wait a few minutes for DNS to propagate. Railway auto-provisions HTTPS.
   Then `https://teamhub.knapadvisory.com` is live.

Share that URL and the `SIGNUP_CODE` with your team — they register with
the code and you're all in the same workspace.

## Deploy on a Hostinger VPS

TeamHub is a live Node.js server (real-time chat/calls + a database), so it
needs a **Hostinger VPS** (a KVM VPS plan) — Hostinger's regular web/shared
hosting can't run it. Your domain and DNS already being at Hostinger makes
the domain step easy.

1. **Get a VPS**: in hPanel, order a **KVM VPS** and choose the **Ubuntu**
   (24.04) template. Note its **IP address**.
2. **Point your domain at it**: hPanel → **Domains → DNS / Nameservers** for
   `knapadvisory.com`, add an **A record**:
   - **Type:** A · **Name:** `teamhub` · **Points to:** your VPS IP · **TTL:** default
3. **Connect to the VPS** (hPanel has a **Browser terminal**, or use SSH):
   ```bash
   ssh root@YOUR_VPS_IP
   ```
4. **Get the code and run the one-shot installer**:
   ```bash
   apt-get update && apt-get install -y git
   git clone https://github.com/knapadvisory/Management-tool.git
   cd Management-tool
   sudo bash deploy/vps-setup.sh
   ```
   It asks for your domain (`teamhub.knapadvisory.com`) and a sign-up access
   code, installs Docker + Caddy, builds and runs the app, and turns on HTTPS
   automatically. When it finishes, open **https://teamhub.knapadvisory.com**.

To ship a new version later: `git pull && sudo bash deploy/vps-setup.sh`.
Your data lives in the `teamhub-data` Docker volume and survives redeploys.

## Email (optional but recommended)

Turn on email so TeamHub can send **password-reset links**, **join-request
notifications** to admins, **approval** emails, and let you **email invite
codes** straight to new hires. Without it the app works fine — those steps just
stay manual (admins reset passwords, you copy/paste invite links).

Add your mail provider's SMTP settings to `/root/teamhub.env`, then re-run
`sudo bash deploy/vps-setup.sh`:

```bash
SMTP_HOST="smtp.hostinger.com"   # or smtp.gmail.com, smtp.sendgrid.net, …
SMTP_PORT="587"                   # 465 if your provider uses SSL
SMTP_USER="no-reply@yourdomain.com"
SMTP_PASS="your-smtp-password"
SMTP_FROM="TeamHub <no-reply@yourdomain.com>"
# SMTP_SECURE="true"             # only for port 465
```

Since your domain is on Hostinger, the easiest option is to create an email
account in hPanel (e.g. `no-reply@knapadvisory.com`) and use Hostinger's SMTP
host with that account's credentials. The password-reset link and all email
links use `APP_URL` (set automatically to `https://<your-domain>`).

## Backups & restore

TeamHub backs itself up **automatically every day** — a consistent snapshot of
the database plus all uploaded files, kept in the `teamhub-data` volume at
`/data/backups` (the last 14 are retained). No setup is needed; the first
backup runs shortly after the server starts.

- **See status / run one now / download the database:** sign in as the
  platform owner (the KNAP workspace admin) → **Admin → 💾 Backups**.
- **Off-site copy (important):** the automatic backups live on the same server,
  which protects against accidental deletes, bad updates and corruption — but
  **not** against losing the server itself. Periodically click **Download
  latest database** and keep the file somewhere off the server.
- **Restore** from a backup (replaces the current data):
  ```bash
  cd ~/Management-tool
  bash deploy/restore-backup.sh              # list available backups
  bash deploy/restore-backup.sh teamhub-YYYYMMDD-HHMMSS
  ```

Optional environment variables (defaults are fine): `BACKUP_INTERVAL_HOURS`
(default 24), `BACKUP_KEEP` (default 14), `BACKUP_DIR`, `BACKUP_DISABLED=1`.

## Free alternative: Cloudflare named tunnel

If your domain's DNS is on Cloudflare **and** you have a machine that can
stay on 24/7, you can run a named `cloudflared` tunnel that maps
`teamhub.knapadvisory.com` straight to the app on that machine — free,
same domain, real HTTPS. The trade-off vs Railway is that you maintain the
always-on machine yourself.
