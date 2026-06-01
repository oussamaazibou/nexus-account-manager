# Summary of Project Migration & Deployment Guide

## 1. Major Changes (Migration to ESM)
The project has been migrated from **CommonJS (require)** to **ES Modules (import)** to ensure better compatibility with modern Node.js environments and VPS deployment.

- **package.json**: Added `"type": "module"`.
- **File Renaming**: `server.cjs` has been renamed to `server.js`.
- **TypeScript Config**: Updated `tsconfig.json` to use `NodeNext` for module resolution and added `.js` extensions to all relative imports.
- **Hybrid Imports**: Updated `server.js` to use a hybrid import strategy for `AccountVerifier` to avoid "Named export not found" errors in VPS.

## 2. Local Workflow (D: Drive)
To send updates to GitHub from your local machine:

```powershell
# 1. Add changes
git add .

# 2. Commit
git commit -m "Migration to ESM and deployment fixes"

# 3. Push to GitHub
git push origin main
```

## 3. VPS Deployment Workflow (root@Nexus)
To update the server in your VPS:

```bash
cd ~/appoussama

# 1. Pull latest code (Force reset if package-lock conflicts)
git reset --hard origin/main
git pull origin main

# 2. Re-build the project
npm install
npm run build

# 3. Restart Services (PM2)
pm2 stop nexus-app
pm2 delete nexus-app
pm2 start server.js --name "nexus-app"
pm2 save

# 4. Check Logs
pm2 logs nexus-app --lines 50
```

## 4. Current Status & Pending Issues
- **Backend**: Successfully migrated to ESM; build process is working.
- **Frontend**: Standard Vite/React build process should be followed inside the `Frontend` folder.
- **Redis Warning**: The VPS is running Redis `6.0.16`. It is highly recommended to upgrade to at least `6.2.0` for full `BullMQ` compatibility.

---
*Created by Antigravity AI on 2026-03-12*
