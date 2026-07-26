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

Every snapshot is **integrity-checked** the moment it's taken; a corrupt one is
discarded rather than kept (so a "backup" that wouldn't restore can't quietly
pile up).

- **See status / run one now / download the database:** sign in as the
  platform owner (the KNAP workspace admin) → **Admin → 💾 Backups**.

### Off-site copies (do this — it's the real safety net)

On-box backups protect against accidental deletes, bad updates and corruption —
but **not** against losing the server itself. Two ways to keep copies off the
box:

- **Manual:** periodically click **Download latest database** in Admin → Backups
  and keep the file somewhere else.
- **Automatic (recommended):** set `BACKUP_SYNC_CMD` to a command that pushes
  each new backup off-box. It runs after every verified snapshot with
  `BACKUP_PATH` (the backup folder), `BACKUP_NAME` and `BACKUP_ROOT` in its
  environment. Any tool works — no new dependencies:
  ```bash
  # in /root/teamhub.env — pick one
  BACKUP_SYNC_CMD='rclone copy "$BACKUP_PATH" remote:teamhub/$BACKUP_NAME'
  BACKUP_SYNC_CMD='aws s3 sync "$BACKUP_PATH" s3://my-bucket/$BACKUP_NAME'
  BACKUP_SYNC_CMD='rsync -a "$BACKUP_PATH" user@host:/backups/$BACKUP_NAME'
  ```
  The last off-site result (ok / failed + time) shows in Admin → Backups, so a
  silently-broken pipeline is visible rather than assumed working.

### Continuous replication (litestream) — near-zero data loss

Daily snapshots leave a gap: if the server dies at 3pm and the last backup was
2am, that day's work is gone. **Litestream** closes the gap — it's bundled in the
image and, when configured, streams every database change to off-site storage
**within seconds**. On a fresh/rebuilt box it also **restores the database
automatically** from that replica on first boot. It's off by default; set these
in `/root/teamhub.env` and redeploy:

```bash
# S3-compatible bucket + credentials (AWS S3, Backblaze B2, Wasabi, MinIO…)
LITESTREAM_REPLICA_URL="s3://my-bucket/teamhub"
LITESTREAM_ACCESS_KEY_ID="…"
LITESTREAM_SECRET_ACCESS_KEY="…"
# Only for non-AWS S3 providers:
# LITESTREAM_ENDPOINT="https://s3.us-west-002.backblazeb2.com"
# LITESTREAM_FORCE_PATH_STYLE="true"
```

Then `bash deploy/redeploy.sh`. On boot you'll see `[litestream] replicating …`
in `docker logs teamhub`. **Disaster recovery** is then: stand up a fresh box,
put the same values in `teamhub.env`, run the deploy — litestream pulls the
database back to within seconds of the crash. (Uploaded files still come from the
`BACKUP_SYNC_CMD` off-site copy above, so keep both on.)

Litestream **complements** the daily snapshots — it's replication (near-live
mirror), not versioned history, so keep the snapshots for point-in-time restores.
For arm64 hosts, rebuild with `--build-arg LITESTREAM_ARCH=arm64`.

### Prove the backups restore (recovery drill)

Backups you've never restored are a guess. Run the **non-destructive** drill —
it opens the newest backup, integrity-checks it and confirms it still holds real
rows, without touching live data:

```bash
cd ~/Management-tool
bash deploy/verify-backup.sh               # drill the newest backup
bash deploy/verify-backup.sh teamhub-YYYYMMDD-HHMMSS
```

It exits non-zero on failure, so it's worth adding as a **weekly cron** (and
alerting if it ever fails). You can also run the same check from the app: Admin →
Backups → **Verify**.

### Restore for real (replaces current data)

```bash
cd ~/Management-tool
bash deploy/restore-backup.sh              # list available backups
bash deploy/restore-backup.sh teamhub-YYYYMMDD-HHMMSS
```

Optional environment variables (defaults are fine): `BACKUP_INTERVAL_HOURS`
(default 24), `BACKUP_KEEP` (default 14), `BACKUP_DIR`, `BACKUP_SYNC_CMD`
(off-site push, unset by default), `BACKUP_DISABLED=1`.

## Free alternative: Cloudflare named tunnel

If your domain's DNS is on Cloudflare **and** you have a machine that can
stay on 24/7, you can run a named `cloudflared` tunnel that maps
`teamhub.knapadvisory.com` straight to the app on that machine — free,
same domain, real HTTPS. The trade-off vs Railway is that you maintain the
always-on machine yourself.
