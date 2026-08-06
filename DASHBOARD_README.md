# 🚀 Workspace Automation Dashboard

Professional web dashboard for managing Google Workspace account automation.

## ✨ Features

- **📊 Real-time Stats** - Monitor jobs, processing status, and completion rates
- **🎨 Modern UI** - Beautiful dark theme with smooth animations
- **📋 Template System** - Pre-configured templates for different use cases
- **⚡ One-Click Operations** - Upload files or paste accounts and start processing
- **📈 Job Monitoring** - Track all jobs in real-time with detailed status
- **🎯 Headless Mode** - All browser automation runs in background

## 🎯 Quick Start

### 1. Start the Dashboard Server

```bash
node server.js
```

### 2. Start the Worker (in another terminal)

```bash
node dist/index.js worker
```

### 3. Open Dashboard

Open your browser and navigate to:
```
http://localhost:3000
```

## 📖 Usage

### Create Accounts

1. Click on **"Create Accounts"** tab
2. Either:
   - Upload an `accounts.txt` file, OR
   - Paste accounts manually (format: `email:password`, one per line)
3. Click **"Start Processing"**
4. Switch to **"Monitor"** tab to watch progress

### Templates

1. Click on **"Templates"** tab
2. Preview available templates
3. Click **"Apply Template"** to use it
4. Currently available:
   - ✅ **Education Template** - For educational institutions
   - 🔜 **Business Template** - Coming soon
   - 🔜 **Custom Template** - Coming soon

### Monitor Jobs

1. Click on **"Monitor"** tab
2. View all jobs with real-time status
3. Click **"Refresh"** to update manually (auto-refreshes every 5s)

## 🎨 Features Overview

### Stats Dashboard
- **Total Jobs** - All jobs ever created
- **Processing** - Currently running jobs
- **Completed** - Successfully finished jobs
- **Failed** - Jobs that encountered errors

### Job Statuses
- 🟢 **Completed** - Job finished successfully
- 🔵 **Processing** - Job is currently running
- 🔴 **Failed** - Job encountered an error

### Headless Mode
All browser automation now runs in headless mode:
- ✅ Google Cloud SDK authentication
- ✅ Cloud Console activation check
- ✅ Domain-Wide Delegation
- ✅ 2FA Authenticator setup
- ✅ 2SV Policy configuration

## 🔧 Configuration

The dashboard connects to:
- **API Server**: `http://localhost:3000`
- **Redis**: `localhost:6379`
- **Worker**: Must be running separately

## 📝 API Endpoints

- `POST /api/jobs` - Enqueue new job
- `GET /api/jobs` - Get all jobs
- `GET /api/stats` - Get queue statistics
- `GET /api/worker/status` - Check worker status
- `GET /api/health` - Health check

## 🎯 Template Format

### Education Template (Active)
```json
{
  "educationLevel": "Higher education",
  "numberOfStudents": "Random (1-10000+)",
  "autoFill": true,
  "randomData": true
}
```

## 🚀 Production Tips

1. **Security**: Add authentication to the dashboard
2. **Monitoring**: Set up logging and alerts
3. **Scaling**: Run multiple workers for parallel processing
4. **Backup**: Regularly backup Redis data
5. **SSL**: Use HTTPS in production

## 📊 Performance

- **Headless Mode**: ~35 seconds per account (optimized)
- **Policy Handling**: 3-5 seconds (fast)
- **Retry Logic**: Automatic with exponential backoff
- **Concurrent Jobs**: Supports multiple workers

## 🎨 UI Customization

Edit `dashboard/styles.css` to customize:
- Colors (see `:root` variables)
- Gradients
- Animations
- Layout

## 🐛 Troubleshooting

### Dashboard not loading?
- Check if server is running: `node server.js`
- Verify port 3000 is not in use

### Jobs not processing?
- Start the worker: `node dist/index.js worker`
- Check Redis is running

### Stats not updating?
- Refresh the page
- Check browser console for errors
- Verify API endpoints are accessible

## 📦 Dependencies

- Express.js - Web server
- BullMQ - Job queue
- Redis - Queue storage
- Puppeteer - Browser automation

## 🎉 Enjoy!

Your professional workspace automation dashboard is ready!

For support or questions, check the logs or create an issue.
