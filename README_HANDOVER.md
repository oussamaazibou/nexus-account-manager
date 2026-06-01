# 🚀 Handover: Nexus Account Manager (Workspace Automation)

## 📋 State of the Project
The app is a hybrid automated system for managing Google Workspace accounts. It handles login, phone verification (SMS-Activate API), CAPTCHAs (2Captcha), and automated Google Cloud project setup.

### 🛠️ Key Technologies
- **Backend**: Node.js (v20+), Express, Puppeteer (Headless), BullMQ (Queue System).
- **Frontend**: React (Vite), TailwindCSS, TypeScript.
- **Database/Queue**: Redis (Required for job processing).
- **CLI**: Google Cloud SDK (gcloud).

---

## ✅ Major Fixes Completed
1. **VPS Compatibility (X Server Fix)**:
   - Forced `headless: true` in `AccountVerifier.ts` and `PrepWorker.ts` so it runs on Linux servers without a GUI.
2. **Cross-Platform Spawn (cmd.exe Fix)**:
   - Modified `gcloudAuth.cjs` to detect the OS. It uses `cmd.exe` on Windows and direct `gcloud` command on Linux. This fixed the `ENOENT` error on the VPS.
3. **Module System (ESM Fix)**:
   - Updated `tsconfig.json` to `module: "ESNext"` and `moduleResolution: "node"` to be compatible with `"type": "module"` in `package.json`.
4. **Enhanced UI**:
   - Added "Upload TXT" buttons to both **List Accounts** (Queue) and **Result Accounts** (Verified).

---

## 🚀 Setup on a New Laptop

### 1. Prerequisites
- **Node.js**: v20 or higher.
- **Redis**: Must be running (for the queue).
- **Gcloud SDK**: Install from [Google Cloud](https://cloud.google.com/sdk/docs/install). Ensure it's in your `PATH`.
- **Git**: Installed and configured.

### 2. Installation
```powershell
# Clone the repository
git clone <your-repo-url>
cd createWorkspaceAccount

# Install Backend Dependencies
npm install

# Install Frontend Dependencies
cd Frontend
npm install
cd ..
```

### 3. Environment Config (`.env`)
Ensure you have a `.env` file in the root with:
- `REDIS_HOST=localhost`
- `REDIS_PORT=6379`
- `SMSSERVICE_API_KEY=your_key`
- `CAPTCHA_API_KEY=your_key`
- `ORG_ID=your_org_id`

### 4. Running the App
```powershell
# Terminal 1: Build and Start Worker
npm run build
node dist/index.js worker

# Terminal 2: Start Backend Server
node server.cjs

# Terminal 3: Start Frontend
cd Frontend
npm run dev
```

---

## 📁 Important File Maps
- `src/services/verification/AccountVerifier.ts`: Core logic for Puppeteer/Google Login.
- `gcloudAuth.cjs`: Handles the `gcloud auth login` interaction.
- `src/jobs/PrepWorker.ts`: The background worker that processes the queue.
- `server.cjs`: The main Express API.
- `Frontend/components/`: Storage for all UI pages (AccountQueue, ValidAccounts, etc.).

---

## 📌 Next Steps / Pending
- **Scaling**: If deploying many accounts, consider using Proxies (there is a proxy logic start in the code).
- **Log Management**: Currently logs to `pm2`. In a new laptop, you can check `logs/` folder if created.
