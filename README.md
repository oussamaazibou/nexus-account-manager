# Nexus Account Manager

A high-performance dashboard for managing, verifying, and monitoring Google Workspace account credentials — with integrated proxy, headless (Puppeteer) automation, and queue-based job processing.

**Dashboard:** `http://localhost:4000` · **Backend API:** `http://localhost:4000`

---

## ✨ Features

- **Account Queue** – enqueue Google Workspace accounts for automated login/verification.
- **Valid Accounts** – verified accounts with password reset, TXT-upload, and monitoring.
- **Bulk Account Creation** – automated Workspace user creation from a list.
- **Verify Unverified Domains** – logs into each admin account, opens the Workspace domain-verification page for every unverified domain, upserts the Cloudflare TXT record, and confirms verification automatically.
- **Phone Verification** – SMS-Activate based phone verification with fallbacks.
- **CAPTCHA Solving** – 2Captcha integration.
- **Cloudflare TXT Upload** – one-click TXT record creation from the dashboard.
- **Upload JSON / SFTP** – push verified account files to a remote server (SFTP or AWS S3).
- **App Passwords & App Users** – manage service-account passwords and dashboard logins.
- **Telegram Notifications** – login alerts and job updates.
- **Proxies** – optional per-account proxy rotation for automation.

---

## 📋 Prerequisites

| Requirement | Version / Notes |
|---|---|
| **Node.js** | v20 or higher |
| **Redis** | Required for the job queue (BullMQ) |
| **Google Chrome / Chromium** | Required by Puppeteer |
| **Git** | To clone the repo |
| **Google Cloud SDK (gcloud)** | Only if you use the Cloud-project setup scripts |
| **Workspace service account** | JSON key with Directory API access, for API calls |

---

## 🐧 Fresh Ubuntu 24.04 (VPS) Server Setup

One-time, run as root. Skip any step you already have.

### 1. System packages + Git

```bash
apt update
apt install -y git curl ca-certificates
```

### 2. Node.js v20+ (NodeSource)

> ⚠️ Ubuntu's default Node is v18 — the AWS SDK v3 stops supporting it after January 2026 and the app targets Node 20+.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version   # should print v20.x or higher
```

### 3. Redis (job queue)

```bash
apt install -y redis-server
systemctl enable --now redis-server
redis-cli ping   # should reply PONG
```

> The service already owns port 6379 — do **not** run `redis-server` manually, it will fail with `bind: Address already in use`.

### 4. Google Chrome runtime libraries (Puppeteer)

The bot launches headless Chrome, which needs these system libraries. Ubuntu 24.04 uses the `t64` package names:

```bash
apt install -y libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libnss3 libnspr4 libatspi2.0-0t64 libdrm2 libx11-xcb1 libxshmfence1 fonts-liberation
```

Chrome itself is downloaded automatically (to `~/.cache/puppeteer`) during `npm install`. If a later run reports a different missing `*.so` library, install the matching package (on 24.04 append `t64` to the package name).

### 5. Google Cloud SDK (optional)

Only needed for the Cloud-project setup scripts:

```bash
apt install -y google-cloud-cli
```

---

## 🚀 Installation

### 1. Clone the repository

```bash
git clone https://github.com/wbennettmary/nexus.git
cd nexus
```

### 2. Install backend dependencies

```bash
npm install
```

### 3. Install and build the frontend

```bash
cd Frontend
npm install
npm run build
cd ..
```

> The backend serves the built UI from `Frontend/dist`, so the build step is required before the dashboard will load.

### 4. Configure

Create/update `config.json` in the project root (it is git-ignored). Example:

```json
{
  "adminEmail": "admin@yourdomain.com",
  "adminPassword": "your-admin-app-password",
  "awsAccessKey": "",
  "awsSecretKey": "",
  "awsRegion": "us-east-1",
  "awsBucket": "json-files-gw",
  "cloudflareEmail": "your@cloudflare-account.com",
  "cloudflareKey": "your-cloudflare-global-api-key",
  "cloudflareZoneId": "",
  "telegramToken": "",
  "telegramChatId": "",
  "heroSmsKey": "",
  "heroSmsUrl": "https://api.hero-sms.com/stubs/handler_api.php",
  "proxiesEnabled": false,
  "proxiesList": ["http://user:pass@host:port"]
}
```

Optional environment variables in `.env` (also git-ignored):

```bash
REDIS_HOST=localhost
REDIS_PORT=6379
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=
ORG_ID=
```

### 5. Start Redis

On a server (systemd):

```bash
systemctl start redis-server
redis-cli ping   # PONG
```

If you installed Redis without systemd (e.g. Docker/WSL), start it directly:

```bash
redis-server &
```

### 6. Run the application

```bash
node server.js
```

The server listens on port `4000` and starts the job worker automatically. Open **http://localhost:4000**.

To keep it running after you log out of SSH, run it in the background (or set up a `systemd` service):

```bash
nohup node server.js > server.log 2>&1 &
tail -f server.log
```

### 7. Login

The first launch creates `app_users.json` automatically with a default admin:

| Username | Password |
|---|---|
| `admin` | `admin` |

> ⚠️ **Change the default password immediately** via the **App Users** page after first login.

---

## 🪟 Windows Helper Scripts

- `setup_project.bat` – checks Node, installs deps, and builds the project.
- `start_app.bat` – starts backend (port 4000), worker, and frontend dev server (port 3000).
- `start_local.ps1` – starts WSL Redis 8, updates `.env`, and launches the backend.

---

## 💡 Usage Highlights

### Verify Unverified Domains

1. Go to **Account Manager → BULK INFO**.
2. Click **✅ Verify Unverified Domains**.
3. Paste in the admin email(s) (or select a saved account) and start.
4. Follow the live progress panel — each unverified domain gets a Cloudflare TXT record and is confirmed on the Workspace codes page automatically.

### Enqueue accounts for verification

1. Go to **Account Queue** and upload your list of `email:password` accounts.
2. Workers process them with Puppeteer; verified results appear under **Valid Accounts**.

---

## 📁 Important File Map

| File | Purpose |
|---|---|
| `server.js` | Main Express API (port 4000) + queue worker spawning |
| `domainVerifyBot.js` | Puppeteer automation for the "Verify Unverified Domains" feature |
| `src/services/verification/AccountVerifier.ts` | Core Puppeteer / Google Login logic |
| `src/jobs/PrepWorker.ts` | Background worker that processes the queue |
| `gcloudAuth.cjs` | Cross-platform `gcloud auth login` helper |
| `Frontend/` | React (Vite + Tailwind) dashboard source |
| `config.json` | Runtime config (cloudflare, aws, telegram, proxies) — git-ignored |
| `app_users.json` | Dashboard login credentials — auto-created on first run |

---

## 🛡️ Security Notes

- `accounts.txt`, `result_accounts.txt`, `config.json`, `.env`, and `tmp/` are git-ignored — never commit real credentials.
- Rotate the default `admin/admin` login after your first sign-in.
- Use app passwords (never your real account password) for the accounts the dashboard automates.
