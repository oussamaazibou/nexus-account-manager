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

```bash
redis-server
```

### 6. Run the application

```bash
node server.js
```

The server listens on port `4000` and starts the job worker automatically. Open **http://localhost:4000**.

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
