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

## Free alternative: Cloudflare named tunnel

If your domain's DNS is on Cloudflare **and** you have a machine that can
stay on 24/7, you can run a named `cloudflared` tunnel that maps
`teamhub.knapadvisory.com` straight to the app on that machine — free,
same domain, real HTTPS. The trade-off vs Railway is that you maintain the
always-on machine yourself.
