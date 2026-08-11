import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { Queue } from 'bullmq';
import axios from 'axios';
import pkg from 'ssh2';
const { Client } = pkg;
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { checkStatus } from './checkStatusBot.js';
import { SSHUploader } from './dist/services/ssh/SSHUploader.js';
import * as AVModule from './dist/services/verification/AccountVerifier.js';
const { AccountVerifier } = AVModule;
import { verifyUnverifiedDomains as runDomainVerifyBot } from './domainVerifyBot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Per-account log capture ───────────────────────────────────────────────────
const accountLogs = {};        // { email: [{ ts, level, msg }] }
const MAX_LOGS_PER_ACCOUNT = 200;
const GLOBAL_LOG_BUFFER = [];  // last 500 lines for unmatched
const MAX_GLOBAL = 500;

const pushLog = (email, level, msg) => {
    if (!accountLogs[email]) accountLogs[email] = [];
    accountLogs[email].push({ ts: new Date().toISOString(), level, msg });
    if (accountLogs[email].length > MAX_LOGS_PER_ACCOUNT)
        accountLogs[email].shift();
};

// ── Dynu Domains activity log buffer ─────────────────────────────────────────
const dynuLogBuffer = [];      // last 300 lines of Dynu operations
const MAX_DYNU_LOGS = 300;
const dynuLog = (level, msg) => {
    dynuLogBuffer.push({ ts: new Date().toISOString(), level, msg });
    if (dynuLogBuffer.length > MAX_DYNU_LOGS) dynuLogBuffer.shift();
    // Mirror to normal console too (also lands in per-email logs when an email is present)
    if (level === 'ERROR') console.error(msg);
    else if (level === 'WARN') console.warn(msg);
    else console.log(msg);
};

// Intercept console to capture per-email logs
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn  = console.warn.bind(console);

const interceptConsole = (level, args) => {
    const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    // Try to extract email from the log line
    const emailMatch = line.match(/[\w.+\-]+@[\w.\-]+\.[a-zA-Z]{2,12}/);
    if (emailMatch) {
        pushLog(emailMatch[0].toLowerCase(), level, line);
    }
    GLOBAL_LOG_BUFFER.push({ ts: new Date().toISOString(), level, msg: line });
    if (GLOBAL_LOG_BUFFER.length > MAX_GLOBAL) GLOBAL_LOG_BUFFER.shift();
};

console.log   = (...a) => { interceptConsole('INFO',  a); _origLog(...a); };
console.error = (...a) => { interceptConsole('ERROR', a); _origError(...a); };
console.warn  = (...a) => { interceptConsole('WARN',  a); _origWarn(...a); };
// ─────────────────────────────────────────────────────────────────────────────

// --- Dynamic Env Injector ---
const loadConfigToEnv = () => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            // AWS S3
            if (config.awsAccessKey) process.env.AWS_ACCESS_KEY_ID = config.awsAccessKey;
            if (config.awsSecretKey) process.env.AWS_SECRET_ACCESS_KEY = config.awsSecretKey;
            if (config.awsRegion) process.env.AWS_REGION = config.awsRegion;
            if (config.awsBucket) process.env.AWS_BUCKET_NAME = config.awsBucket;
            
            // Google Admin Setup
            if (config.adminEmail) process.env.ADMIN_EMAIL = config.adminEmail;
            if (config.adminPassword) process.env.ADMIN_PASSWORD = config.adminPassword;
            
            // SFTP / SSH
            if (config.sftpHost) process.env.SSH_HOST = config.sftpHost;
            if (config.sftpPort) process.env.SSH_PORT = config.sftpPort;
            if (config.sftpUser) process.env.SSH_USER = config.sftpUser;
            if (config.sftpPassword) process.env.SSH_PASSWORD = config.sftpPassword;
            if (config.sftpPath) process.env.SSH_BASE_PATH = config.sftpPath;

            // Proxies
            if (config.proxiesEnabled && config.proxiesList) {
                process.env.PROXY_LIST = config.proxiesList;
            }
        }
    } catch (e) {
        console.error('Failed to load dynamic config to env:', e.message);
    }
};
loadConfigToEnv();

const app = express();
const PORT = 4000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
// Serve dashboard (Frontend React Build)
app.use(express.static(path.join(__dirname, 'Frontend', 'dist')));

// Redis connection
const redisConnection = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
};

// Queue
const prepQueue = new Queue('prep-queue', { connection: redisConnection });

// Stats for workspace creation (mapped by username)
let workspaceStats = {};
let activeWorker = null;
let workspaceWorkers = {};

// ── Online Session Tracking ─────────────────────────────────────────────────
// { username: { role, lastSeen: Date.now(), loginTime } }
const onlineSessions = {};
// Admin notifications queue: [{ id, message, time, read }]
const adminNotifications = [];

// Metadata Helpers
const getMetadata = () => {
    try {
        const metadataPath = path.join(__dirname, 'accounts_metadata.json');
        if (fs.existsSync(metadataPath)) {
            return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        }
    } catch (e) { console.error('Error reading metadata:', e); }
    return {};
};

const sendTelegramMessage = async (token, chatId, message) => {
    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        });
        return true;
    } catch (e) {
        console.error('Telegram Error:', e.response?.data || e.message);
        return false;
    }
};

// ... (getResultCount unchanged)

// ... (endpoint)

const getResultCount = () => {
    try {
        const resultPath = path.join(__dirname, 'result_accounts.txt');
        if (fs.existsSync(resultPath)) {
            const content = fs.readFileSync(resultPath, 'utf-8');
            return content.split('\n').filter(l => l.trim().length > 0).length;
        }
    } catch (e) { }
    return 0;
};


const saveMetadata = (data) => {
    try {
        const metadataPath = path.join(__dirname, 'accounts_metadata.json');
        fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2));
    } catch (e) { console.error('Error saving metadata:', e); }
};

const startWorker = () => {
    if (activeWorker && activeWorker.exitCode === null) return;

    console.log('🚀 Starting Verification Worker...');
    activeWorker = spawn('node', ['dist/index.js', 'worker'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        cwd: __dirname
    });

    const handleWorkerLine = (line, level) => {
        // Mirror to terminal
        if (level === 'ERROR') _origError('[worker]', line);
        else _origLog('[worker]', line);

        // Store in global buffer
        GLOBAL_LOG_BUFFER.push({ ts: new Date().toISOString(), level, msg: line });
        if (GLOBAL_LOG_BUFFER.length > MAX_GLOBAL) GLOBAL_LOG_BUFFER.shift();

        // Extract email and store per-account
        const emailMatch = line.match(/[\w.+\-]+@[\w.\-]+\.[a-zA-Z]{2,12}/);
        if (emailMatch) {
            pushLog(emailMatch[0].toLowerCase(), level, line);
        }
    };

    let stdoutBuf = '';
    activeWorker.stdout.on('data', chunk => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop();
        lines.forEach(l => l.trim() && handleWorkerLine(l.trim(), 'INFO'));
    });

    let stderrBuf = '';
    activeWorker.stderr.on('data', chunk => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop();
        lines.forEach(l => l.trim() && handleWorkerLine(l.trim(), 'ERROR'));
    });

    activeWorker.on('error', (err) => console.error('❌ Worker Error:', err));
    activeWorker.on('exit', (code) => {
        // Flush remaining buffers
        if (stdoutBuf.trim()) handleWorkerLine(stdoutBuf.trim(), 'INFO');
        if (stderrBuf.trim()) handleWorkerLine(stderrBuf.trim(), 'ERROR');
        console.log(`Worker stopped (Code: ${code})`);
        activeWorker = null;
    });
};

// Routes

// --- APP USERS AUTH & MANAGEMENT ---
const APP_USERS_FILE = path.join(__dirname, 'app_users.json');

const getAppUsers = () => {
    if (!fs.existsSync(APP_USERS_FILE)) {
        const defaultUsers = [{
            id: 'admin',
            username: 'admin',
            password: 'admin',
            role: 'admin',
            permissions: ['DASHBOARD', 'QUEUE', 'OPERATIONS', 'SETTINGS', 'VALID_ACCOUNTS', 'PHONE_VERIFY', 'MANAGE_ACCOUNTS', 'UPLOAD_JSON', 'APP_PASSWORDS', 'APP_USERS']
        }];
        fs.writeFileSync(APP_USERS_FILE, JSON.stringify(defaultUsers, null, 2));
        return defaultUsers;
    }
    return JSON.parse(fs.readFileSync(APP_USERS_FILE, 'utf8'));
};

const saveAppUsers = (users) => {
    fs.writeFileSync(APP_USERS_FILE, JSON.stringify(users, null, 2));
};

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const users = getAppUsers();
    const user = users.find(u => u.username === username && u.password === password);

    if (user) {
        // Track session online
        const isFirstLogin = !onlineSessions[username];
        onlineSessions[username] = {
            role: user.role,
            lastSeen: Date.now(),
            loginTime: Date.now()
        };

        // Push admin notification
        if (user.role !== 'admin') {
            adminNotifications.unshift({
                id: Date.now().toString(),
                message: `🟢 ${username} just connected`,
                time: new Date().toISOString(),
                read: false
            });
            // Keep only last 50 notifications
            if (adminNotifications.length > 50) adminNotifications.splice(50);
        }

        // Notify telegram on login
        if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID) {
            sendTelegramMessage(
                process.env.TELEGRAM_TOKEN,
                process.env.TELEGRAM_CHAT_ID,
                `🟢 *Nexus Console Login*\n\n👤 User: \`${username}\`\n🛡️ Role: ${user.role}\n⏰ Time: ${new Date().toISOString()}`
            ).catch(err => console.error('Telegram Login Notification Failed:', err));
        }

        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role, permissions: user.permissions } });
    } else {
        res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
});

// ── Get fresh permissions for current user ──────────────────────────────────
app.get('/api/auth/me', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username required' });
    const users = getAppUsers();
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json({ id: user.id, username: user.username, role: user.role, permissions: user.permissions || [] });
});

// ── Session Ping (users call every 30s to stay "online") ────────────────────
app.post('/api/sessions/ping', (req, res) => {
    const { username, role } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    onlineSessions[username] = {
        role: role || 'user',
        lastSeen: Date.now(),
        loginTime: onlineSessions[username]?.loginTime || Date.now()
    };
    res.json({ success: true });
});

// ── Session Logout ───────────────────────────────────────────────────────────
app.post('/api/sessions/logout', (req, res) => {
    const { username, role } = req.body;
    if (username) {
        delete onlineSessions[username];
        if (role !== 'admin') {
            adminNotifications.unshift({
                id: Date.now().toString(),
                message: `🔴 ${username} disconnected`,
                time: new Date().toISOString(),
                read: false
            });
            if (adminNotifications.length > 50) adminNotifications.splice(50);
        }
    }
    res.json({ success: true });
});

// ── Get Online Sessions (admin only) ────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
    const allUsers = getAppUsers();
    const now = Date.now();
    const ONLINE_THRESHOLD = 2 * 60 * 1000; // 2 minutes

    // Build list of all users with online status
    const result = allUsers.map(u => {
        const session = onlineSessions[u.username];
        const isOnline = session && (now - session.lastSeen) < ONLINE_THRESHOLD;
        return {
            id: u.id,
            username: u.username,
            role: u.role,
            online: isOnline,
            lastSeen: session?.lastSeen || null,
            loginTime: session?.loginTime || null
        };
    });

    res.json(result);
});

// ── Admin Notifications ──────────────────────────────────────────────────────
app.get('/api/notifications', (req, res) => {
    res.json(adminNotifications);
});

app.post('/api/notifications/read', (req, res) => {
    adminNotifications.forEach(n => n.read = true);
    res.json({ success: true });
});

app.delete('/api/notifications', (req, res) => {
    adminNotifications.length = 0;
    res.json({ success: true });
});

app.get('/api/app-users', (req, res) => {
    res.json(getAppUsers());
});

app.post('/api/app-users', (req, res) => {
    const { username, password, role, permissions } = req.body;
    const users = getAppUsers();
    if (users.find(u => u.username === username)) {
        return res.status(400).json({ success: false, error: 'User already exists' });
    }
    const newUser = {
        id: Date.now().toString(),
        username,
        password,
        role: role || 'mailer',
        permissions: role === 'admin' ? [] : (permissions || []) // Admin doesn't strictly need permissions array, but we keep it clean
    };
    users.push(newUser);
    saveAppUsers(users);
    res.json({ success: true, user: newUser });
});

app.put('/api/app-users/:id', (req, res) => {
    const { id } = req.params;
    const { username, password, role, permissions } = req.body;
    const users = getAppUsers();
    const index = users.findIndex(u => u.id === id);
    if (index === -1) return res.status(404).json({ success: false, error: 'User not found' });

    users[index] = {
        ...users[index],
        username: username || users[index].username,
        password: password || users[index].password,
        role: role || users[index].role,
        permissions: role === 'admin' ? [] : (permissions || users[index].permissions)
    };
    saveAppUsers(users);
    res.json({ success: true, user: users[index] });
});

app.delete('/api/app-users/:id', (req, res) => {
    const { id } = req.params;
    if (id === 'admin') return res.status(400).json({ success: false, error: 'Cannot delete admin' });
    let users = getAppUsers();
    users = users.filter(u => u.id !== id);
    saveAppUsers(users);
    res.json({ success: true });
});
// Internal stats update
app.post('/api/internal/update-stats', (req, res) => {
    try {
        const newStats = req.body;
        workspaceStats = { ...workspaceStats, ...newStats };
        res.json({ success: true });
    } catch (e) {
        console.error('Stats update error:', e);
        res.json({ success: false });
    }
});

// Settings API
app.get('/api/settings', (req, res) => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            res.json(config);
        } else {
            res.json({});
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/settings', (req, res) => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch('/api/settings/concurrency', (req, res) => {
    try {
        const { concurrency } = req.body;
        if (!concurrency) return res.status(400).json({ error: 'concurrency required' });

        const configPath = path.join(__dirname, 'config.json');
        let config = {};
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }
        config.concurrency = String(concurrency);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`[Sessions] Concurrency updated to: ${concurrency}`);
        res.json({ success: true, concurrency });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Test Endpoints
app.post('/api/test/hero-sms', async (req, res) => {
    try {
        const { key, url } = req.body;
        // Hero-SMS / SMS-Activate protocol
        // Action: getBalance
        const baseUrl = url || 'https://herosms.online/api/stubs/handler_api.php';
        const response = await axios.get(`${baseUrl}?api_key=${key}&action=getBalance`);
        res.json({ success: true, balance: response.data });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/test/cloudflare', async (req, res) => {
    try {
        const { email, key } = req.body;
        // Check verify token
        const response = await axios.get('https://api.cloudflare.com/client/v4/user/tokens/verify', {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`
                // Note: If using Global API Key, headers are different: 'X-Auth-Email': email, 'X-Auth-Key': key
                // Checking user input: if email provided, assume Global Key. If only key, assume Token.
            }
        }).catch(async (e) => {
            // Fallback to Global Key check
            return await axios.get('https://api.cloudflare.com/client/v4/user', {
                headers: {
                    'X-Auth-Email': email,
                    'X-Auth-Key': key
                }
            });
        });

        res.json({ success: true, message: 'Connected' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/test/sftp', (req, res) => {
    const { host, port, user, password } = req.body;
    const conn = new Client();
    conn.on('ready', () => {
        conn.end();
        res.json({ success: true, message: 'Connected to SFTP' });
    });
    conn.on('error', (err) => {
        res.status(500).json({ error: err.message });
    });
    try {
        conn.connect({ host, port: parseInt(port), username: user, password });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/test/2captcha', async (req, res) => {
    try {
        const { key } = req.body;
        const response = await axios.get(`https://2captcha.com/res.php?key=${key}&action=getbalance&json=1`);
        if (response.data.status === 0) throw new Error(response.data.request);
        res.json({ success: true, balance: response.data.request });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/test/telegram', async (req, res) => {
    try {
        const { token, chatId } = req.body;
        const sent = await sendTelegramMessage(token, chatId, "🔔 *Test Notification*\n\nYour Telegram configuration is working correctly! 🚀");
        if (sent) res.json({ success: true, message: 'Message sent!' });
        else throw new Error('Failed to send message');
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/test/dynu', async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) return res.status(400).json({ error: 'API key required' });
        const response = await axios.get('https://api.dynu.com/v2/dns', {
            headers: { 'API-Key': key, accept: 'application/json' }
        });
        if (response.data.exception) throw new Error(response.data.exception.message || 'Invalid API key');
        const count = (response.data.domains || []).length;
        res.json({ success: true, message: `Connected — ${count} DNS zone(s)` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/manual-otp', async (req, res) => {
    try {
        const { email, secretKey } = req.body;
        if (!email || !secretKey) return res.status(400).json({ success: false, error: 'Email and secretKey are required' });

        const configStr = fs.readFileSync('config.json', 'utf8');
        const config = JSON.parse(configStr);
        
        const host = config.sftpHost || '46.224.9.127';
        const port = parseInt(config.sftpPort || '22');
        const username = config.sftpUser || 'root';
        const password = config.sftpPassword || 'JnsQ3G98JU027QP';
        const basePath = config.sftpPath || '/home/brightmindscampus';

        const conn = new Client();
        conn.on('ready', () => {
            conn.sftp((err, sftp) => {
                if (err) { conn.end(); return res.status(500).json({ success: false, error: 'SFTP Error' }); }
                const remoteDir = `${basePath}/${email}`;
                sftp.mkdir(remoteDir, {}, () => {
                    const remotePath = `${remoteDir}/${email}_authenticator_secret_key.txt`;
                    const stream = sftp.createWriteStream(remotePath);
                    stream.on('close', () => {
                        conn.end();
                        res.json({ success: true });
                    });
                    stream.on('error', (err) => {
                        conn.end();
                        res.status(500).json({ success: false, error: 'Write Error: ' + err.message });
                    });
                    stream.write(secretKey);
                    stream.end();
                });
            });
        });
        conn.on('error', (err) => {
            res.status(500).json({ success: false, error: 'SSH Error: ' + err.message });
        });
        conn.connect({ host, port, username, password });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Serve dashboard

// Serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'Frontend', 'dist', 'index.html'));
});

// Enqueue job
app.post('/api/jobs', async (req, res) => {
    try {
        const { projectId, userEmail, userPassword, saName, template, headless, verifiedBy } = req.body;

        if (!projectId || !userEmail || !userPassword) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const job = await prepQueue.add('prep-job', {
            projectId,
            userEmail,
            userPassword,
            saName: saName || 'automation-sa',
            template: template || 'education',
            headless
        }, {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 10000
            },
            removeOnComplete: true,
            removeOnFail: false
        });

        // Save verifiedBy in metadata
        if (verifiedBy) {
            const metadata = getMetadata();
            if (!metadata[userEmail]) metadata[userEmail] = {};
            metadata[userEmail].verifiedBy = verifiedBy;
            saveMetadata(metadata);
        }

        // Automatically start worker to process this job
        startWorker();

        res.json({
            success: true,
            jobId: job.id,
            message: 'Job queued successfully'
        });
    } catch (error) {
        console.error('Error enqueueing job:', error);
        res.status(500).json({ error: error.message });
    }
});

// ── Reset jobs back to Pending state ──
app.post('/api/jobs/reset', async (req, res) => {
    try {
        const { emails } = req.body;
        if (!emails || !Array.isArray(emails)) return res.status(400).json({ error: 'Missing emails array' });

        const jobs = await prepQueue.getJobs(['waiting', 'active', 'completed', 'failed', 'delayed'], 0, 1000);
        let resetCount = 0;
        for (const job of jobs) {
            if (job.data && job.data.userEmail && emails.includes(job.data.userEmail)) {
                try {
                    const isActive = await job.isActive();
                    if (isActive) {
                        console.warn(`[Reset] Skipping job ${job.id} (${job.data.userEmail}) - worker currently active`);
                        continue;
                    }
                    await job.remove();
                    resetCount++;
                } catch (e) {
                    console.error(`[Reset] Could not remove job ${job.id}:`, e.message);
                }
            }
        }
        res.json({ success: true, reset: resetCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Get failed jobs with details ──
app.get('/api/jobs/failed', async (req, res) => {
    try {
        const failedJobs = await prepQueue.getFailed(0, 100);
        const details = failedJobs.map(job => ({
            id: job.id,
            name: job.name,
            data: job.data,
            failedReason: job.failedReason,
            stacktrace: job.stacktrace,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn
        }));
        res.json(details);
    } catch (error) {
        console.error('Error fetching failed jobs:', error);
        res.status(500).json({ error: error.message });
    }
});


// ── gcloud-only mode: skip verification, run gcloud + DWD + SDK steps ──────
app.post('/api/jobs/gcloud', async (req, res) => {
    try {
        const { userEmail, userPassword, headless } = req.body;
        if (!userEmail || !userPassword) {
            return res.status(400).json({ error: 'userEmail and userPassword required' });
        }

        // Build a deterministic projectId from email domain
        const domain = userEmail.split('@')[1] || 'workspace';
        const projectId = `${domain.replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 20)}-${Date.now().toString().slice(-6)}`;

        const job = await prepQueue.add('prep-job', {
            projectId,
            userEmail,
            userPassword,
            saName: 'automation-sa',
            headless: headless !== false, // default headless true
            mode: 'gcloud-only'           // skip domain verify, run gcloud+DWD
        });

        startWorker();
        console.log(`[gcloud-only] Queued job ${job.id} for ${userEmail}`);
        res.json({ success: true, jobId: job.id, projectId });
    } catch (error) {
        console.error('[gcloud-only] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});


// Get jobs
// Get jobs (from accounts.txt + BullMQ status)
app.get('/api/jobs', async (req, res) => {
    try {
        const accountsPath = path.join(__dirname, 'accounts.txt');

        // 1. Get real jobs from Queue to check status
        const jobs = await prepQueue.getJobs(['waiting', 'active', 'completed', 'failed'], 0, 100);

        let jobsData = [];

        if (fs.existsSync(accountsPath)) {
            const fileContent = fs.readFileSync(accountsPath, 'utf-8');
            const lines = fileContent.split('\n').filter(l => l.trim().length > 0);
            const metadata = getMetadata();

            // 2. Map each account from file to its potential job status
            jobsData = await Promise.all(lines.map(async (line, index) => {
                const parts = line.split(':');
                const email = parts[0] ? parts[0].trim() : '';
                const password = parts.slice(1).join(':').trim();

                // Find matching job in queue for this email
                const relatedJob = jobs.find(j => j.data && j.data.userEmail === email);

                let status = 'pending';
                let timestamp = Date.now();
                let progress = 0;

                if (relatedJob) {
                    try {
                        const jobState = await relatedJob.getState() || 'pending';
                        // If BullMQ says 'completed' but account is still in accounts.txt,
                        // it means it was moved back to queue — treat as 'pending'
                        status = jobState === 'completed' ? 'pending' : jobState;
                        timestamp = relatedJob.timestamp;
                        progress = relatedJob.progress;
                    } catch (e) {
                        console.error(`Error getting state for job ${relatedJob.id}:`, e);
                    }
                }

                // Load metadata for this account
                const accountMetadata = metadata[email] || {};

                // Auto-populate createdAt if not present
                if (!accountMetadata.createdAt) {
                    accountMetadata.createdAt = new Date().toISOString();
                    metadata[email] = accountMetadata;
                }

                // Override BullMQ status with metadata status when it carries richer info
                const OVERRIDE_STATUSES = ['ACCOUNT_NOT_FOUND', 'NO_ACTIVE'];
                const finalStatus = OVERRIDE_STATUSES.includes(accountMetadata.status) ? accountMetadata.status : status;

                return {
                    id: `file-${index}`,
                    status: finalStatus,
                    data: { userEmail: email, userPassword: password },
                    timestamp: accountMetadata.timestamp || timestamp,
                    progress: progress,
                    collection: accountMetadata.collection || 'Queue',
                    createdAt: accountMetadata.createdAt,
                    verifiedBy: accountMetadata.verifiedBy || null
                };
            }));

            // Save updated metadata
            try {
                fs.writeFileSync(
                    path.join(__dirname, 'accounts_metadata.json'),
                    JSON.stringify(metadata, null, 2)
                );
            } catch (e) { }
        }

        // Return ONLY accounts.txt data — result_accounts.txt has its own /api/result-accounts endpoint
        res.json(jobsData);
    } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).json({ error: error.message });
    }
});


// ── Dedicated Result Accounts Endpoint (result_accounts.txt ONLY) ─────────────
app.get('/api/result-accounts', (req, res) => {
    try {
        const resultPath = path.join(__dirname, 'result_accounts.txt');
        const metadata = getMetadata();

        if (!fs.existsSync(resultPath)) return res.json([]);

        const lines = fs.readFileSync(resultPath, 'utf8')
            .split('\n').map(l => l.trim()).filter(Boolean);

        const accounts = lines.map((line, idx) => {
            const parts = line.split(':');
            const email = parts[0]?.trim();
            const password = parts.slice(1).join(':').trim();
            const meta = metadata[email] || {};

            // Auto-populate createdAt
            if (!meta.createdAt) {
                meta.createdAt = new Date().toISOString();
                metadata[email] = meta;
            }

            return {
                id: `result-${idx}-${email}`,
                status: 'completed',
                data: { userEmail: email, userPassword: password },
                timestamp: meta.timestamp || Date.now(),
                progress: 100,
                collection: meta.collection || 'Completed Accounts',
                createdAt: meta.createdAt,
                verifiedBy: meta.verifiedBy || null
            };
        });

        // Persist any new createdAt values
        try {
            fs.writeFileSync(
                path.join(__dirname, 'accounts_metadata.json'),
                JSON.stringify(metadata, null, 2)
            );
        } catch (e) { }

        res.json(accounts);
    } catch (e) {
        console.error('[result-accounts] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Archive Accounts ──────────────────────────────────────────────────────────
const ARCHIVE_PATH = path.join(__dirname, 'archived_accounts.json');

const getArchive = () => {
    try {
        if (!fs.existsSync(ARCHIVE_PATH)) return [];
        return JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
    } catch { return []; }
};

const saveArchive = (data) => {
    fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(data, null, 2));
};

// POST /api/accounts/archive — move one account from result_accounts.txt to archive
app.post('/api/accounts/archive', (req, res) => {
    try {
        const { email, password, collection, createdAt, verifiedBy, archivedBy } = req.body;
        if (!email) return res.status(400).json({ error: 'email required' });

        // Remove from result_accounts.txt
        const resultPath = path.join(__dirname, 'result_accounts.txt');
        if (fs.existsSync(resultPath)) {
            const lines = fs.readFileSync(resultPath, 'utf8').split('\n').filter(Boolean);
            const updated = lines.filter(l => !l.startsWith(email + ':') && l !== email);
            fs.writeFileSync(resultPath, updated.join('\n') + (updated.length ? '\n' : ''));
        }

        // Add to archive
        const archive = getArchive();
        const existing = archive.findIndex(a => a.email === email);
        const entry = { id: `arc-${Date.now()}-${email}`, email, password: password || '', collection: collection || null, createdAt: createdAt || null, verifiedBy: verifiedBy || null, archivedAt: new Date().toISOString(), archivedBy: archivedBy || 'unknown' };
        if (existing >= 0) archive[existing] = entry;
        else archive.push(entry);
        saveArchive(archive);

        console.log(`[Archive] Archived ${email} by ${archivedBy || 'unknown'}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/accounts/archived — list all archived accounts
app.get('/api/accounts/archived', (req, res) => {
    try {
        res.json(getArchive());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/accounts/archive/restore — move account(s) back to result_accounts.txt
app.post('/api/accounts/archive/restore', (req, res) => {
    try {
        const { emails } = req.body;
        if (!emails || !emails.length) return res.status(400).json({ error: 'emails required' });

        const archive = getArchive();
        const toRestore = archive.filter(a => emails.includes(a.email));
        const remaining = archive.filter(a => !emails.includes(a.email));
        saveArchive(remaining);

        // Append back to result_accounts.txt
        const resultPath = path.join(__dirname, 'result_accounts.txt');
        const lines = toRestore.map(a => `${a.email}:${a.password}`).join('\n');
        if (lines) fs.appendFileSync(resultPath, '\n' + lines + '\n');

        console.log(`[Archive] Restored ${toRestore.length} account(s)`);
        res.json({ success: true, restored: toRestore.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/accounts/archive — permanently delete from archive
app.delete('/api/accounts/archive', (req, res) => {
    try {
        const { emails } = req.body;
        if (!emails || !emails.length) return res.status(400).json({ error: 'emails required' });
        const archive = getArchive();
        const updated = archive.filter(a => !emails.includes(a.email));
        saveArchive(updated);
        res.json({ success: true, deleted: archive.length - updated.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Update Single Account Status (e.g. NO_ACTIVE) ─────────────────────────
app.patch('/api/accounts/status', (req, res) => {
    try {
        const { email, status } = req.body;
        if (!email || !status) return res.status(400).json({ error: 'email and status required' });
        const metadata = getMetadata();
        if (!metadata[email]) metadata[email] = {};
        metadata[email].status = status;
        saveMetadata(metadata);
        console.log(`[Status] Set ${email} => ${status}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Bulk Assign to User ────────────────────────
app.patch('/api/accounts/bulk_assign', (req, res) => {
    try {
        const { emails, username, force } = req.body;
        if (!emails || !username) {
            return res.status(400).json({ error: 'Missing emails or username' });
        }

        const metadata = getMetadata();
        let assigned = 0;
        emails.forEach(email => {
            if (!metadata[email]) metadata[email] = {};
            // Only overwrite if: force=true, currently unset, or currently 'ALL'
            const current = metadata[email].verifiedBy;
            if (force || !current || current === 'ALL') {
                metadata[email].verifiedBy = username;
                assigned++;
            }
        });

        saveMetadata(metadata);
        console.log(`[Assign] Assigned ${assigned}/${emails.length} accounts to ${username}`);
        res.json({ success: true, assigned });
    } catch (e) {
        console.error('[Assign] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Bulk Update Collection & Date ────────────────────────
app.patch('/api/accounts/bulk_update', (req, res) => {
    try {
        const { emails, collection, newDate } = req.body;
        if (!emails || !Array.isArray(emails)) {
            return res.status(400).json({ error: 'Missing emails array' });
        }

        const metadata = getMetadata();
        let updated = 0;

        for (const email of emails) {
            if (!metadata[email]) metadata[email] = {};

            if (collection !== undefined && collection.trim() !== '') {
                metadata[email].collection = collection;
            }

            if (newDate) {
                metadata[email].createdAt = new Date(newDate).toISOString();
            }

            updated++;
        }

        saveMetadata(metadata);

        console.log(`[Bulk Update] Updated fields for ${updated} accounts.`);
        res.json({ success: true, updated });
    } catch (e) {
        console.error('[Bulk Update] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Full Edit (Email, Password, Collection, Date) ────────────────────────
app.put('/api/accounts/edit_full', (req, res) => {
    try {
        const { oldEmail, newEmail, newPassword, newCollection, newDate } = req.body;
        if (!oldEmail || !newEmail || !newPassword) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const resultPath = path.join(__dirname, 'result_accounts.txt');
        if (fs.existsSync(resultPath)) {
            let lines = fs.readFileSync(resultPath, 'utf8').split('\n');
            let updatedLines = lines.map(line => {
                if (line.startsWith(oldEmail + ':')) {
                    return `${newEmail}:${newPassword}`;
                }
                return line;
            });
            fs.writeFileSync(resultPath, updatedLines.join('\n'));
        }

        const metadata = getMetadata();

        // If email changed, we move metadata
        if (oldEmail !== newEmail) {
            metadata[newEmail] = metadata[oldEmail] || {};
            delete metadata[oldEmail];
        } else {
            if (!metadata[newEmail]) metadata[newEmail] = {};
        }

        if (newCollection !== undefined) metadata[newEmail].collection = newCollection;
        if (newDate) metadata[newEmail].createdAt = new Date(newDate).toISOString();

        saveMetadata(metadata);

        console.log(`[Edit] Updated account ${oldEmail} -> ${newEmail}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[Edit] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Bulk Delete Accounts ────────────────────────
app.delete('/api/accounts', (req, res) => {
    try {
        const { emails } = req.body;
        if (!emails || !Array.isArray(emails)) {
            return res.status(400).json({ error: 'Missing emails array' });
        }

        const filesToCheck = ['accounts.txt', 'result_accounts.txt', 'accounts-noverify.txt', 'account_verfy_phone.txt'];
        const emailsSet = new Set(emails.map(e => e.trim().toLowerCase()));

        let deletedCount = 0;

        for (const file of filesToCheck) {
            const filePath = path.join(__dirname, file);
            if (!fs.existsSync(filePath)) continue;

            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            const newLines = lines.filter(line => {
                const parts = line.split(':');
                if (parts.length < 2 && line.trim() === '') return false;
                const email = parts[0]?.trim().toLowerCase();
                if (emailsSet.has(email)) {
                    deletedCount++;
                    return false;
                }
                return true;
            });

            if (lines.length !== newLines.length) {
                fs.writeFileSync(filePath, newLines.join('\n') + '\n');
            }
        }

        // Remove from metadata
        const metadata = getMetadata();
        let metadataChanged = false;
        for (const email of emails) {
            if (metadata[email]) {
                delete metadata[email];
                metadataChanged = true;
            }
        }
        if (metadataChanged) {
            saveMetadata(metadata);
        }

        console.log(`[Delete] Deleted ${emails.length} accounts from files.`);
        res.json({ success: true, deleted: deletedCount });
    } catch (e) {
        console.error('[Delete] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Upload accounts: UI txt file upload ────────────────────────
app.post('/api/accounts/upload', (req, res) => {
    try {
        const { accounts, verifiedBy } = req.body;
        if (!accounts || !Array.isArray(accounts)) return res.status(400).json({ error: 'invalid data' });

        const accountsFile = path.join(__dirname, 'accounts.txt');
        const metadata = getMetadata();
        let appendedCount = 0;

        for (const act of accounts) {
            fs.appendFileSync(accountsFile, `${act.email}:${act.password}\n`);
            metadata[act.email] = { 
                collection: 'Uploaded List', 
                status: 'PENDING', 
                ts: new Date().toISOString(),
                verifiedBy: verifiedBy || 'admin'
            };
            appendedCount++;
        }

        saveMetadata(metadata);

        res.json({ success: true, count: appendedCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Upload accounts to result_accounts.txt ────────────────────────
app.post('/api/accounts/upload-results', (req, res) => {
    try {
        const { accounts } = req.body;
        if (!accounts || !Array.isArray(accounts)) return res.status(400).json({ error: 'invalid data' });

        const resultsFile = path.join(__dirname, 'result_accounts.txt');
        const metadata = getMetadata();
        let appendedCount = 0;

        for (const act of accounts) {
            fs.appendFileSync(resultsFile, `${act.email}:${act.password}\n`);
            metadata[act.email] = { collection: 'Uploaded Results', status: 'COMPLETED', ts: new Date().toISOString() };
            appendedCount++;
        }

        saveMetadata(metadata);
        res.json({ success: true, count: appendedCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Move accounts: result_accounts.txt → accounts.txt ────────────────────────
app.post('/api/accounts/move', (req, res) => {
    try {
        const { emails } = req.body;
        if (!emails || !Array.isArray(emails) || emails.length === 0) {
            return res.status(400).json({ error: 'emails array required' });
        }

        const resultPath = path.join(__dirname, 'result_accounts.txt');
        const queuePath = path.join(__dirname, 'accounts.txt');
        const metadata = getMetadata();
        let movedCount = 0;

        // 1. Read result_accounts.txt - collect lines AND passwords for emails to move
        const resultLines = fs.existsSync(resultPath)
            ? fs.readFileSync(resultPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
            : [];

        const toMove = []; // { email, password }
        const keepInResult = [];

        for (const line of resultLines) {
            const parts = line.split(':');
            const email = parts[0]?.trim();
            const password = parts.slice(1).join(':').trim();

            if (emails.includes(email)) {
                toMove.push({ email, password });
                movedCount++;
            } else {
                keepInResult.push(line);
            }
        }

        // 2. Write back result_accounts.txt (without moved accounts)
        fs.writeFileSync(resultPath, keepInResult.join('\n') + (keepInResult.length > 0 ? '\n' : ''));

        // 3. Add to accounts.txt (no duplicates)
        const queueLines = fs.existsSync(queuePath)
            ? fs.readFileSync(queuePath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
            : [];

        const existingEmails = new Set(queueLines.map(l => l.split(':')[0]?.trim()));
        const newQueueLines = [...queueLines];

        for (const { email, password } of toMove) {
            if (!existingEmails.has(email)) {
                newQueueLines.push(`${email}:${password}`);
            }
        }

        fs.writeFileSync(queuePath, newQueueLines.join('\n') + '\n');

        // 4. Clear collection from metadata for moved accounts
        for (const { email } of toMove) {
            if (metadata[email]) {
                delete metadata[email].collection;
            }
        }
        try {
            fs.writeFileSync(
                path.join(__dirname, 'accounts_metadata.json'),
                JSON.stringify(metadata, null, 2)
            );
        } catch (e) { }

        console.log(`🔄 Moved ${movedCount} account(s) back to accounts.txt`);
        res.json({ success: true, moved: movedCount });
    } catch (e) {
        console.error('[accounts/move] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Get stats
app.get('/api/stats', async (req, res) => {
    try {
        const username = req.query.user || 'global';
        const waiting = await prepQueue.getWaitingCount();
        const active = await prepQueue.getActiveCount();
        const completed = await prepQueue.getCompletedCount();
        const failed = await prepQueue.getFailedCount();

        res.json({
            // Traditional Queue Stats
            total: waiting + active + completed + failed,
            processing: active,
            completed,
            failed,
            waiting,
            // Workspace Stats (User Specific)
            workspace: workspaceStats[username] || undefined
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Internal Update Stats Endpoint
app.post('/api/internal/update-stats', (req, res) => {
    try {
        const { user, stats } = req.body;
        if (user) {
            workspaceStats[user] = { ...workspaceStats[user], ...stats };
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'User required' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Internal Notify Endpoint for Telegram (from scripts)
app.post('/api/internal/notify', async (req, res) => {
    try {
        const { message } = req.body;
        if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID) {
            await sendTelegramMessage(process.env.TELEGRAM_TOKEN, process.env.TELEGRAM_CHAT_ID, message);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Worker status
app.get('/api/worker/status', async (req, res) => {
    try {
        const workers = await prepQueue.getWorkers();
        res.json({
            running: workers && workers.length > 0,
            count: workers ? workers.length : 0
        });
    } catch (error) {
        res.json({ running: false, error: error.message });
    }
});

// Settings API endpoints
app.get('/api/settings', (req, res) => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            res.json(config);
        } else {
            res.json({});
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/settings', (req, res) => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        
        // Merge with existing if necessary, or just overwrite
        let existingConfig = {};
        if (fs.existsSync(configPath)) {
            existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }

        const newConfig = { ...existingConfig, ...req.body };
        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');

        // Dynamically inject back into environment so the current server context picks them up immediately
        loadConfigToEnv();

        res.json({ success: true, message: 'Settings saved successfully' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Prepare file endpoint (for compatibility)
app.post('/api/prepare-file', async (req, res) => {
    try {
        const { accounts, options, verifiedBy } = req.body;

        if (!accounts || !Array.isArray(accounts)) {
            return res.status(400).json({ error: 'Invalid accounts data' });
        }

        const metadata = getMetadata();
        let queued = 0;
        for (const account of accounts) {
            const [email, password] = account.split(':').map(s => s.trim());

            if (!email || !password) continue;

            const domain = email.split('@')[1];
            const domainPrefix = domain.split('.')[0].replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 12);
            const projectId = `${domainPrefix}-${Date.now().toString().slice(-6)}-${Math.random().toString(36).substr(2, 3)}`.substring(0, 30).replace(/-+$/, '');

            await prepQueue.add('prep-job', {
                projectId,
                userEmail: email,
                userPassword: password,
                saName: 'automation-sa',
                ...options
            }, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 10000
                },
                removeOnComplete: true,
                removeOnFail: false
            });

            // Save verifiedBy in metadata
            if (!metadata[email]) metadata[email] = {};
            if (verifiedBy) metadata[email].verifiedBy = verifiedBy;
            if (!metadata[email].createdAt) metadata[email].createdAt = new Date().toISOString();

            queued++;
        }
        saveMetadata(metadata);

        res.json({
            success: true,
            queued,
            message: `Queued ${queued} job(s)`
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Stop Creation Endpoint
app.post('/api/stop-creation', (req, res) => {
    try {
        const username = req.body.username || 'global';
        let stopped = [];

        // Stop workspace creation (GCP/DWD)
        if (workspaceWorkers[username]) {
            workspaceWorkers[username].kill('SIGKILL');
            delete workspaceWorkers[username];
            stopped.push('Workspace creation');
        }

        // Also stop the global verification worker if it's running
        if (activeWorker && activeWorker.exitCode === null) {
            console.log('🛑 Force-stopping Verification Worker via API...');
            activeWorker.kill('SIGKILL');
            activeWorker = null;
            stopped.push('Verification worker');
        }

        if (stopped.length > 0) {
            res.json({ success: true, message: `${stopped.join(' and ')} forcefully stopped.` });
        } else {
            res.json({ success: false, message: 'No active processes found to stop.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Import Registry directly to VPS
app.post('/api/upload-registry', (req, res) => {
    try {
        const { registryData, username } = req.body;
        const safeUser = (username || 'global').replace(/[^a-zA-Z0-9_-]/g, '');
        
        if (!registryData) return res.status(400).json({ error: 'No registry data provided' });
        
        const filePath = path.join(__dirname, `domains_${safeUser}.txt`);
        fs.writeFileSync(filePath, registryData.trim());
        
        const count = registryData.split('\n').filter((l) => l.trim().length > 0).length;
        res.json({ success: true, count, content: registryData.trim() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create Workspace Endpoint (New)
app.post('/api/create-workspace', async (req, res) => {
    try {
        const { domains, options, concurrency, username } = req.body;
        const safeUser = (username || 'global').replace(/[^a-zA-Z0-9_-]/g, '');

        if (!domains || !Array.isArray(domains)) {
            return res.status(400).json({ error: 'Invalid domains data' });
        }

        const threadCount = parseInt(concurrency) || 1;

        // Reset stats for specific user
        workspaceStats[safeUser] = {
            batchCurrent: 1,
            batchTotal: Math.ceil(domains.length / threadCount),
            successful: 0,
            failed: 0,
            antiSpamBlocked: 0,
            failureRate: 0,
            antiSpamRate: 0,
            activeThreads: 0
        };

        // Write domains to domains_[username].txt
        const filename = `domains_${safeUser}.txt`;
        const domainsPath = path.join(__dirname, filename);
        fs.writeFileSync(domainsPath, domains.join('\n'));

        console.log(`\nSaved ${domains.length} domains to ${filename} for user ${safeUser}`);
        console.log(`Starting workspace creation script with concurrency: ${threadCount}...`);

        // Launch the wrapper script in background
        const scriptPath = path.join(__dirname, 'run_workspace_creation.js');

        const worker = spawn('node', [scriptPath], {
            detached: false,
            stdio: 'inherit', // Show output in server console
            cwd: __dirname,
            env: {
                ...process.env,
                CONCURRENCY: threadCount.toString(),
                TOTAL_DOMAINS: domains.length.toString(),
                DOMAINS_FILE: filename,
                WORKSPACE_USER: safeUser
            }
        });

        workspaceWorkers[safeUser] = worker;

        worker.on('exit', () => {
            console.log(`🏁 Workspace creation process finished for ${safeUser}.`);
            delete workspaceWorkers[safeUser];
        });


        // child.unref(); // Keep attached to process group

        res.json({
            success: true,
            message: 'Workspace creation started in background',
            count: domains.length
        });

    } catch (error) {
        console.error('Error starting workspace creation:', error);
        res.status(500).json({ error: error.message });
    }
});

// Validated OTP Retrieval via SFTP
app.post('/api/otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });

        console.log(`[OTP] Fetching secret for ${email} from SFTP...`);

        // Load config for SSH
        let config = {};
        try {
            const configPath = path.join(__dirname, 'config.json');
            if (fs.existsSync(configPath)) {
                config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        } catch (e) {
            console.warn('[OTP] Config load failed, using env/defaults');
        }

        let secret = null;
        const localPath = path.join(process.cwd(), 'secrets', `${email}_secret.txt`);
        
        if (fs.existsSync(localPath)) {
            console.log(`[OTP] Found secret locally: ${localPath}`);
            secret = fs.readFileSync(localPath, 'utf8').trim();
        } else {
            console.log(`[OTP] Local secret not found at ${localPath}. Trying SFTP...`);
            const ssh = new SSHUploader({
                host: config.sftpHost || process.env.SSH_HOST || '46.224.9.127',
                port: parseInt(config.sftpPort || process.env.SSH_PORT || '22'),
                username: config.sftpUser || process.env.SSH_USER || 'root',
                password: config.sftpPassword || process.env.SSH_PASSWORD || '',
                basePath: config.sftpPath || process.env.SSH_BASE_PATH || '/home/brightmindscampus'
            });
            secret = await ssh.downloadSecretKey(email);
        }
        
        if (!secret) throw new Error('Secret not found locally or on SFTP');

        console.log(`[OTP] Generating TOTP for secret: ${secret.trim()}`);

        // Manual TOTP (HMAC-SHA1)
        const key = secret.trim().replace(/=+$/, '').toUpperCase();
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        let bits = "";
        for (let i = 0; i < key.length; i++) {
            const val = alphabet.indexOf(key[i]);
            if (val === -1) continue;
            bits += val.toString(2).padStart(5, '0');
        }

        const bytes = [];
        for (let i = 0; i + 8 <= bits.length; i += 8) {
            bytes.push(parseInt(bits.substr(i, 8), 2));
        }

        const keyBuf = Buffer.from(bytes);
        const epoch = Math.floor(Date.now() / 1000);
        const timeStep = 30;
        const counter = Math.floor(epoch / timeStep);

        const buf = Buffer.alloc(8);
        buf.writeBigInt64BE(BigInt(counter), 0);

        const hmac = crypto.createHmac('sha1', keyBuf);
        hmac.update(buf);
        const digest = hmac.digest();

        const offset = digest[digest.length - 1] & 0xf;
        const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
        const token = code.toString().padStart(6, '0');

        console.log(`[OTP] Generated successfully for ${email}`);

        res.json({ success: true, otp: token });
    } catch (error) {
        console.error('[OTP] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Batch Actions
app.patch('/api/accounts/collection', (req, res) => {
    try {
        const { emails, collection } = req.body;
        if (!emails || !Array.isArray(emails)) return res.status(400).json({ error: 'Invalid emails list' });

        const metadata = getMetadata();
        emails.forEach(email => {
            if (!metadata[email]) metadata[email] = {};
            metadata[email].collection = collection;
            metadata[email].timestamp = metadata[email].timestamp || Date.now();
            // Ensure createdAt exists
            if (!metadata[email].createdAt) {
                metadata[email].createdAt = new Date().toISOString();
            }
        });

        // Force save to file
        const metadataPath = path.join(__dirname, 'accounts_metadata.json');
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

        console.log(`✅ Updated collection for ${emails.length} accounts to: ${collection}`);
        res.json({ success: true });
    } catch (e) {
        console.error('Collection update error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Move Accounts from Results to Queue
app.post('/api/accounts/move', async (req, res) => {
    try {
        const { emails } = req.body;
        if (!emails || !Array.isArray(emails) || emails.length === 0) {
            return res.status(400).json({ error: 'Invalid emails list' });
        }

        const resultPath = path.join(__dirname, 'result_accounts.txt');
        const queuePath = path.join(__dirname, 'accounts.txt');
        const metadataPath = path.join(__dirname, 'accounts_metadata.json');

        // 1. Read Files
        let results = [];
        if (fs.existsSync(resultPath)) {
            // Split by newline and trim EACH line to remove \r
            results = fs.readFileSync(resultPath, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0);
        }

        let queue = [];
        if (fs.existsSync(queuePath)) {
            queue = fs.readFileSync(queuePath, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0);
        }

        let metadata = {};
        if (fs.existsSync(metadataPath)) {
            metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        }

        console.log(`[Move] Request to move ${emails.length} emails:`, emails);
        console.log(`[Move] Current Result Accounts: ${results.length}`);

        // 2. Identify Accounts to Move
        const toMove = results.filter(line => {
            const email = line.split(':')[0].trim();
            const isMatch = emails.includes(email);
            if (isMatch) console.log(`[Move] Matched: ${email}`);
            return isMatch;
        });

        if (toMove.length === 0) {
            console.log('[Move] No matching accounts found in results file.');
            return res.json({ success: true, moved: 0, message: 'No matching accounts found in results.' });
        }

        // 3. Update Lists
        // Filter out lines where the email matches one of the moved emails
        const newResults = results.filter(line => {
            const email = line.split(':')[0].trim();
            return !emails.includes(email);
        });

        const newQueue = [...queue, ...toMove]; // Append to queue

        console.log(`[Move] Moving ${toMove.length} accounts.`);
        console.log(`[Move] Old Results: ${results.length} -> New Results: ${newResults.length}`);
        console.log(`[Move] Old Queue: ${queue.length} -> New Queue: ${newQueue.length}`);

        // 4. Update Metadata: Remove from metadata completely so they appear as new/pending
        emails.forEach(email => {
            if (metadata[email]) delete metadata[email];
        });

        // 5. Remove from Redis Queue (CRITICAL FIX: Fixes "Ghost" Completed Status)
        // We must remove the old 'completed' job so it doesn't override the file status
        try {
            // Get ALL jobs to be safe
            const jobs = await prepQueue.getJobs(['completed', 'failed', 'active', 'waiting', 'delayed'], 0, 5000);

            const normalizedEmails = emails.map(e => e.trim().toLowerCase());

            const jobsToRemove = jobs.filter(job => {
                if (!job.data || !job.data.userEmail) return false;
                const jobEmail = job.data.userEmail.trim().toLowerCase();
                return normalizedEmails.includes(jobEmail);
            });

            if (jobsToRemove.length > 0) {
                console.log(`[Move] Cleaning up ${jobsToRemove.length} stale jobs from Queue...`);
                for (const job of jobsToRemove) {
                    try {
                        const isActive = await job.isActive();
                        if (isActive) {
                            console.warn(`[Move] Job ${job.id} is active - skipping queue removal to avoid lock error`);
                            continue;
                        }
                        await job.remove();
                    } catch (e) {
                        console.error(`[Move] Error removing job ${job.id}:`, e.message);
                    }
                }
                console.log(`[Move] Cleanup loop finished.`);
            } else {
                console.log(`[Move] No stale jobs found for these emails.`);
            }
        } catch (queueErr) {
            console.error('[Move] Error cleaning up queue:', queueErr);
        }

        // 6. Write Files
        fs.writeFileSync(resultPath, newResults.join('\n'));
        fs.writeFileSync(queuePath, newQueue.join('\n'));
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

        console.log(`[Move] Moved ${toMove.length} accounts from Results to Queue.`);
        res.json({ success: true, moved: toMove.length });

    } catch (e) {
        console.error('Move Accounts Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/accounts/check-login', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });

        console.log(`🔍 Checking Existence for: ${email}`);
        const verifier = new AccountVerifier();
        const result = await verifier.checkExistence(email);

        res.json({
            success: true,
            exists: result.exists,
            error: result.error
        });
    } catch (e) {
        console.error('Check Login Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/accounts/check-status', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        console.log(`[CheckStatus] Checking status for ${email}`);
        const result = await checkStatus({ email, password });
        res.json({ success: true, status: result.status, details: result.details });
    } catch (e) {
        console.error('Check Status Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/accounts', (req, res) => {
    try {
        const { emails } = req.body;
        if (!emails || !Array.isArray(emails)) return res.status(400).json({ error: 'Invalid emails list' });

        const filesToClean = [
            'result_accounts.txt',
            'accounts.txt',
            'accounts-noverify.txt'
        ];

        filesToClean.forEach(fileName => {
            const filePath = path.join(__dirname, fileName);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n');
                const filteredLines = lines.filter(line => {
                    const email = line.split(':')[0]?.trim();
                    return !emails.includes(email);
                });
                fs.writeFileSync(filePath, filteredLines.join('\n'));
            }
        });

        // Also clean metadata
        const metadata = getMetadata();
        emails.forEach(email => delete metadata[email]);
        saveMetadata(metadata);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ── Hero SMS Phone Verification ───────────────────────────────────────────────
const readConfig = () => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {}
    return {};
};

// Country IDs for Hero SMS (SMS-Activate protocol)
// Indonesia=6, Colombia=44
const HERO_GEO_MAP = { 'ID': 6, 'CO': 44 };



// GET logs for a specific account email
app.get('/api/logs', (req, res) => {
    const email = (req.query.email || '').toLowerCase().trim();
    if (!email) return res.json([]);
    const logs = accountLogs[email] || [];
    res.json(logs);
});

// GET all emails that have logs (for debugging)
app.get('/api/logs/accounts', (req, res) => {
    res.json(Object.keys(accountLogs));
});

// POST: manually start/restart the verification worker
app.post('/api/worker/restart', (req, res) => {
    if (activeWorker && activeWorker.exitCode === null) {
        activeWorker.kill('SIGKILL');
        activeWorker = null;
    }
    startWorker();
    res.json({ success: true, message: 'Worker (re)started' });
});

// ── Domain Status (Cloudflare + Spam/Inbox tracking) ──────────────────────────
const DOMAIN_STATUSES_FILE = path.join(__dirname, 'domain_statuses.json');

function loadDomainStatuses() {
    try {
        if (fs.existsSync(DOMAIN_STATUSES_FILE)) {
            const data = JSON.parse(fs.readFileSync(DOMAIN_STATUSES_FILE, 'utf8'));
            let migrated = false;
            for (const key in data) {
                if (typeof data[key] === 'string') {
                    data[key] = { domainStatus: data[key], isUsed: false };
                    migrated = true;
                }
            }
            if (migrated) fs.writeFileSync(DOMAIN_STATUSES_FILE, JSON.stringify(data, null, 2));
            return data;
        }
    } catch {}
    return {};
}

function saveDomainStatuses(statuses) {
    fs.writeFileSync(DOMAIN_STATUSES_FILE, JSON.stringify(statuses, null, 2));
}

app.get('/api/domains/cloudflare', async (req, res) => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (!fs.existsSync(configPath)) return res.status(400).json({ error: 'config.json not found — configure Cloudflare in Settings.' });
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const cfEmail = config.cloudflareEmail;
        const cfKey = config.cloudflareKey;
        if (!cfKey) return res.status(400).json({ error: 'Cloudflare API key not configured in Settings.' });
        const headers = cfEmail
            ? { 'X-Auth-Email': cfEmail, 'X-Auth-Key': cfKey, 'Content-Type': 'application/json' }
            : { 'Authorization': `Bearer ${cfKey}`, 'Content-Type': 'application/json' };
        let allZones = [], page = 1;
        while (true) {
            const r = await axios.get(`https://api.cloudflare.com/client/v4/zones?per_page=50&page=${page}`, { headers });
            const data = r.data;
            if (!data.success) return res.status(500).json({ error: data.errors?.[0]?.message || 'Cloudflare API error' });
            allZones = allZones.concat(data.result || []);
            if (page >= (data.result_info?.total_pages || 1)) break;
            page++;
        }
        const statuses = loadDomainStatuses();
        const domains = allZones.map(z => {
            const record = statuses[z.name] || {};
            return {
                id: z.id,
                name: z.name,
                cfStatus: z.status,
                domainStatus: record.domainStatus || 'Inbox',
                isUsed: record.isUsed || false,
                nameServers: z.name_servers || [],
                createdOn: z.created_on,
            };
        });
        res.json({ success: true, domains });
    } catch (e) {
        res.status(500).json({ error: e.response?.data?.errors?.[0]?.message || e.message });
    }
});

// GET /api/domains/:zoneId/txt-records — list TXT records for a zone
app.get('/api/domains/:zoneId/txt-records', async (req, res) => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (!fs.existsSync(configPath)) return res.status(400).json({ error: 'Cloudflare not configured.' });
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const cfEmail = config.cloudflareEmail;
        const cfKey = config.cloudflareKey;
        if (!cfKey) return res.status(400).json({ error: 'Cloudflare API key not configured.' });
        const headers = cfEmail
            ? { 'X-Auth-Email': cfEmail, 'X-Auth-Key': cfKey, 'Content-Type': 'application/json' }
            : { 'Authorization': `Bearer ${cfKey}`, 'Content-Type': 'application/json' };
        const r = await axios.get(
            `https://api.cloudflare.com/client/v4/zones/${req.params.zoneId}/dns_records?type=TXT&per_page=100`,
            { headers }
        );
        if (!r.data.success) return res.status(500).json({ error: r.data.errors?.[0]?.message || 'Cloudflare error' });
        const records = (r.data.result || []).map(rec => ({
            id: rec.id, name: rec.name, content: rec.content, ttl: rec.ttl, modified: rec.modified_on
        }));
        res.json({ success: true, records });
    } catch (e) {
        res.status(500).json({ error: e.response?.data?.errors?.[0]?.message || e.message });
    }
});

// PUT /api/domains/:zoneId/txt-records/:recordId — update TXT record content
app.put('/api/domains/:zoneId/txt-records/:recordId', async (req, res) => {
    try {
        const { name, content, ttl } = req.body;
        if (!name || content === undefined) return res.status(400).json({ error: 'name and content required' });
        const configPath = path.join(__dirname, 'config.json');
        if (!fs.existsSync(configPath)) return res.status(400).json({ error: 'Cloudflare not configured.' });
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const cfEmail = config.cloudflareEmail;
        const cfKey = config.cloudflareKey;
        if (!cfKey) return res.status(400).json({ error: 'Cloudflare API key not configured.' });
        const headers = cfEmail
            ? { 'X-Auth-Email': cfEmail, 'X-Auth-Key': cfKey, 'Content-Type': 'application/json' }
            : { 'Authorization': `Bearer ${cfKey}`, 'Content-Type': 'application/json' };
        const r = await axios.put(
            `https://api.cloudflare.com/client/v4/zones/${req.params.zoneId}/dns_records/${req.params.recordId}`,
            { type: 'TXT', name, content, ttl: ttl || 1 },
            { headers }
        );
        if (!r.data.success) return res.status(500).json({ error: r.data.errors?.[0]?.message || 'Cloudflare error' });
        res.json({ success: true, record: r.data.result });
    } catch (e) {
        res.status(500).json({ error: e.response?.data?.errors?.[0]?.message || e.message });
    }
});

// POST /api/domains/:zoneId/txt-records — add new TXT record
app.post('/api/domains/:zoneId/txt-records', async (req, res) => {
    try {
        const { name, content, ttl } = req.body;
        if (!name || content === undefined) return res.status(400).json({ error: 'name and content required' });
        const configPath = path.join(__dirname, 'config.json');
        if (!fs.existsSync(configPath)) return res.status(400).json({ error: 'Cloudflare not configured.' });
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const cfEmail = config.cloudflareEmail;
        const cfKey = config.cloudflareKey;
        if (!cfKey) return res.status(400).json({ error: 'Cloudflare API key not configured.' });
        const headers = cfEmail
            ? { 'X-Auth-Email': cfEmail, 'X-Auth-Key': cfKey, 'Content-Type': 'application/json' }
            : { 'Authorization': `Bearer ${cfKey}`, 'Content-Type': 'application/json' };
        const r = await axios.post(
            `https://api.cloudflare.com/client/v4/zones/${req.params.zoneId}/dns_records`,
            { type: 'TXT', name, content, ttl: ttl || 1 },
            { headers }
        );
        if (!r.data.success) return res.status(500).json({ error: r.data.errors?.[0]?.message || 'Cloudflare error' });
        res.json({ success: true, record: r.data.result });
    } catch (e) {
        res.status(500).json({ error: e.response?.data?.errors?.[0]?.message || e.message });
    }
});

app.patch('/api/domains/status', (req, res) => {
    try {
        const { domainName, domainStatus } = req.body;
        if (!domainName || !['Spam', 'Inbox'].includes(domainStatus))
            return res.status(400).json({ error: 'domainName and domainStatus (Spam|Inbox) required' });
        const statuses = loadDomainStatuses();
        const current = statuses[domainName] || { isUsed: false };
        statuses[domainName] = { ...current, domainStatus };
        saveDomainStatuses(statuses);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch('/api/domains/used', (req, res) => {
    try {
        const { domainName, isUsed } = req.body;
        if (!domainName || typeof isUsed !== 'boolean')
            return res.status(400).json({ error: 'domainName and isUsed (boolean) required' });
        const statuses = loadDomainStatuses();
        const current = statuses[domainName] || { domainStatus: 'Inbox' };
        statuses[domainName] = { ...current, isUsed };
        saveDomainStatuses(statuses);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// POST /api/domains/bulk-add — Add domains to Cloudflare + update NS at registrar
app.post('/api/domains/bulk-add', async (req, res) => {
    const { domains, provider } = req.body;
    if (!Array.isArray(domains) || domains.length === 0)
        return res.status(400).json({ error: 'domains array required' });
    if (!['namecheap', 'spaceship', 'nicnames'].includes(provider))
        return res.status(400).json({ error: 'provider must be namecheap, spaceship, or nicnames' });

    const configPath = path.join(__dirname, 'config.json');
    if (!fs.existsSync(configPath)) return res.status(400).json({ error: 'config.json not found' });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const cfEmail = config.cloudflareEmail;
    const cfKey = config.cloudflareKey;
    if (!cfKey) return res.status(400).json({ error: 'Cloudflare API key not configured' });

    const cfHeaders = cfEmail
        ? { 'X-Auth-Email': cfEmail, 'X-Auth-Key': cfKey, 'Content-Type': 'application/json' }
        : { 'Authorization': `Bearer ${cfKey}`, 'Content-Type': 'application/json' };

    const results = [];

    for (const domain of domains) {
        const trimmed = domain.trim().toLowerCase();
        if (!trimmed) continue;
        const row = { domain: trimmed, cfStatus: 'pending', ns: [], providerStatus: 'pending', error: null };

        try {
            // Step 1: Add zone to Cloudflare
            let cfZone = null;
            try {
                const cfRes = await axios.post('https://api.cloudflare.com/client/v4/zones',
                    { name: trimmed, jump_start: false },
                    { headers: cfHeaders }
                );
                if (cfRes.data.success) {
                    cfZone = cfRes.data.result;
                } else {
                    const errMsg = cfRes.data.errors?.[0]?.message || 'Cloudflare error';
                    // Zone already exists — fetch it
                    const fetchRes = await axios.get(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(trimmed)}`, { headers: cfHeaders });
                    if (fetchRes.data.success && fetchRes.data.result?.length > 0) {
                        cfZone = fetchRes.data.result[0];
                    } else {
                        throw new Error(errMsg);
                    }
                }
            } catch (cfErr) {
                if (cfErr.response?.data?.errors?.[0]?.message?.toLowerCase().includes('already exists') ||
                    cfErr.response?.data?.errors?.[0]?.code === 1061) {
                    // Zone already exists — try to fetch
                    const fetchRes = await axios.get(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(trimmed)}`, { headers: cfHeaders });
                    if (fetchRes.data.success && fetchRes.data.result?.length > 0) {
                        cfZone = fetchRes.data.result[0];
                    } else {
                        throw cfErr;
                    }
                } else {
                    throw cfErr;
                }
            }

            row.cfStatus = cfZone.status || 'pending';
            row.ns = cfZone.name_servers || [];

            if (row.ns.length < 2) throw new Error('Cloudflare did not return nameservers');
            const ns1 = row.ns[0];
            const ns2 = row.ns[1];

            // Step 2: Update NS at registrar
            if (provider === 'namecheap') {
                const ncKey = config.namecheapKey || 'c3c4ffea41644db3a4e72988da4b2160';
                const ncUser = config.namecheapUser || 'M2diafox';
                const ncIp = config.namecheapIp || '105.155.16.113';
                // Parse SLD + TLD
                const parts = trimmed.split('.');
                const tld = parts[parts.length - 1];
                const sld = parts.slice(0, -1).join('.');
                const ncUrl = `https://api.namecheap.com/xml.response?ApiUser=${ncUser}&ApiKey=${ncKey}&UserName=${ncUser}&Command=namecheap.domains.dns.setCustom&ClientIp=${ncIp}&SLD=${encodeURIComponent(sld)}&TLD=${encodeURIComponent(tld)}&Nameservers=${encodeURIComponent(ns1 + ',' + ns2)}`;
                const ncRes = await axios.get(ncUrl);
                const xmlText = typeof ncRes.data === 'string' ? ncRes.data : '';
                if (xmlText.includes('Status="ERROR"') || xmlText.includes("Status='ERROR'")) {
                    const errMatch = xmlText.match(/<Error[^>]*>([^<]+)<\/Error>/i);
                    throw new Error('Namecheap: ' + (errMatch?.[1]?.trim() || 'Unknown error'));
                }
                row.providerStatus = 'updated';

            } else if (provider === 'spaceship') {
                const ssKey = config.spaceshipKey || 'psQNwshvy0XZIc5OUFve';
                const ssSecret = config.spaceshipSecret || 'FqfoDiNw73Dv2So8iXKazJyYmEEozTgZ43cQQ07ZRCMGjrvIVSt9ut6Ez6QgAILP';
                const ssRes = await axios.put(
                    `https://spaceship.dev/api/v1/domains/${trimmed}/nameservers`,
                    { provider: 'custom', hosts: [ns1, ns2] },
                    {
                        headers: {
                            'X-API-Key': ssKey,
                            'X-API-Secret': ssSecret,
                            'Content-Type': 'application/json'
                        },
                        validateStatus: null
                    }
                );
                if (ssRes.status >= 400) {
                    const errMsg = ssRes.data?.detail || ssRes.data?.message || ssRes.data?.error || JSON.stringify(ssRes.data) || `HTTP ${ssRes.status}`;
                    throw new Error(`Spaceship: ${errMsg}`);
                }
                row.providerStatus = 'updated';

            } else if (provider === 'nicnames') {
                const nnKey = config.nicnamesKey;
                if (!nnKey) throw new Error('Nicnames API key not configured in Settings');
                const nnRes = await axios.patch(
                    `https://api.nicnames.com/v2/domains/${trimmed}/nameservers`,
                    { nameservers: [ns1, ns2] },
                    {
                        headers: {
                            'Authorization': `Bearer ${nnKey}`,
                            'Content-Type': 'application/json'
                        },
                        validateStatus: null
                    }
                );
                if (nnRes.status >= 400) {
                    const errMsg = nnRes.data?.message || nnRes.data?.error || `HTTP ${nnRes.status}`;
                    throw new Error(`Nicnames: ${errMsg}`);
                }
                row.providerStatus = 'updated';
            }

        } catch (e) {
            row.error = e.response?.data?.errors?.[0]?.message || e.response?.data?.message || e.message;
            row.providerStatus = 'failed';
            if (!row.cfStatus || row.cfStatus === 'pending') row.cfStatus = 'failed';
        }

        results.push(row);
    }

    res.json({ success: true, results });
});


// Start server
const server = app.listen(PORT, async () => {
    console.log(`\n🚀 Dashboard Server Running!`);
    // Auto-start worker if there are pending/active jobs
    try {
        const waiting = await prepQueue.getWaiting();
        const active  = await prepQueue.getActive();
        if ((waiting.length + active.length) > 0) {
            console.log(`[Boot] Found ${waiting.length} waiting + ${active.length} active jobs — auto-starting worker.`);
            startWorker();
        }
    } catch (e) { /* non-blocking */ }
    console.log(`\n📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔌 API: http://localhost:${PORT}/api`);
    console.log(`\n✨ Ready to manage your workspace automation!\n`);
    server.timeout = 900000; // 15 min — bulk domain operations can take several minutes

    // Initialize Scheduler for Telegram Notifications (Every 30 mins)
    let lastAccountCount = getResultCount();
    console.log(`[Scheduler] Tracking starts at ${lastAccountCount} accounts.`);

    setInterval(async () => {
        try {
            const configPath = path.join(__dirname, 'config.json');
            if (!fs.existsSync(configPath)) return;

            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (!config.telegramToken || !config.telegramChatId) return;

            const currentCount = getResultCount();
            const delta = currentCount - lastAccountCount;

            console.log(`[Scheduler] Checking... Current: ${currentCount}, Last: ${lastAccountCount}, Delta: ${delta}`);

            if (delta > 0) {
                const msg = `📊 *Update (5min)*\n\n✅ New Accounts: *${delta}*\n📈 Total Verified: *${currentCount}*`;
                await sendTelegramMessage(config.telegramToken, config.telegramChatId, msg);
                console.log(`[Scheduler] Notification sent. Delta: +${delta}`);
                lastAccountCount = currentCount;
            } else {
                lastAccountCount = currentCount;
            }
        } catch (e) {
            console.error('[Scheduler] Error:', e.message);
        }
    }, 5 * 60 * 1000); // Check every 5 minutes
});



// ═══════════════════════════════════════════════════════════════════════
// ── ACCOUNT MANAGER API (Google Admin SDK) ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// Google Admin SDK helper - build JWT auth from service account JSON
async function getAdminClient(keyFilePath, scopes) {
    try {
        const { google } = await import('googleapis');
        const keyData = JSON.parse(fs.readFileSync(keyFilePath, 'utf8'));
        const auth = new google.auth.JWT({
            email: keyData.client_email,
            key: keyData.private_key,
            scopes: scopes,
            subject: keyData.client_email.replace('automation-sa@', '').replace(/\.iam\.gserviceaccount\.com$/, '').replace(/-[a-z0-9]{3,10}$/, '') // fallback
        });
        return { google, auth, keyData };
    } catch (e) {
        throw new Error(`Failed to load service key: ${e.message}`);
    }
}

// ── S3 Key Fetch Helper (always reads directly from S3, no disk cache) ──
async function getKeyData(adminEmail) {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');

    const s3 = new S3Client({
        region: process.env.AWS_REGION || 'eu-west-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
        }
    });
    const bucket = process.env.AWS_BUCKET_NAME || 'json-files-gw';
    const s3Key = `workspace-keys/${adminEmail}.json`;

    console.log(`[Manage] 🔍 Fetching S3 key directly: s3://${bucket}/${s3Key}`);
    const command = new GetObjectCommand({ Bucket: bucket, Key: s3Key });
    const response = await s3.send(command);

    const chunks = [];
    for await (const chunk of response.Body) chunks.push(chunk);
    const jsonContent = Buffer.concat(chunks).toString('utf8');
    const keyData = JSON.parse(jsonContent);
    console.log(`[Manage] ✅ S3 key loaded for: ${adminEmail} (client: ${keyData.client_email})`);
    return keyData;
}

// Legacy compat — still used by fetch-key endpoint
async function fetchKeyFromS3(adminEmail) {
    const keyData = await getKeyData(adminEmail);
    const jsonContent = JSON.stringify(keyData, null, 2);
    const tmpDir = path.join(__dirname, 'tmp', 'manage-keys');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const localPath = path.join(tmpDir, `${adminEmail.replace('@', '_at_').replace(/\./g, '_')}.json`);
    fs.writeFileSync(localPath, jsonContent);
    return { localPath, keyData };
}

// Deduplicate standard files based on email address
app.post('/api/manage/deduplicate', (req, res) => {
    try {
        const filesToDeduplicate = ['accounts.txt', 'result_accounts.txt', 'created_users.txt'];
        const results = {};
        for (const file of filesToDeduplicate) {
            const filePath = path.join(__dirname, file);
            if (!fs.existsSync(filePath)) continue;

            const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim().length > 0);
            const uniqueLines = [];
            const seenEmails = new Set();
            for (const line of lines) {
                const email = line.trim().split(':')[0]?.trim().toLowerCase();
                if (email && !seenEmails.has(email)) {
                    seenEmails.add(email);
                    uniqueLines.push(line.trim());
                }
            }
            if (uniqueLines.length < lines.length) {
                fs.writeFileSync(filePath, uniqueLines.join('\n') + '\n');
                results[file] = { removed: lines.length - uniqueLines.length, remaining: uniqueLines.length };
            } else {
                results[file] = { removed: 0, remaining: uniqueLines.length };
            }
        }
        res.json({ success: true, results });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// List accounts from result_accounts.txt
app.get('/api/manage/accounts', (req, res) => {

    try {
        const resultAccountsPath = path.join(__dirname, 'result_accounts.txt');
        if (!fs.existsSync(resultAccountsPath)) return res.json([]);

        const metadataPath = path.join(__dirname, 'accounts_metadata.json');
        let metadata = {};
        if (fs.existsSync(metadataPath)) {
            try {
                metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            } catch (err) { }
        }

        const lines = fs.readFileSync(resultAccountsPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
        const seen = new Set();
        const accounts = [];
        for (const line of lines) {
            const parts = line.split(':');
            const email = parts[0]?.trim();
            const password = parts[1]?.trim() || '';
            if (!email || !email.includes('@') || seen.has(email)) continue;
            seen.add(email);
            const domain = email.split('@')[1];
            // Check if key is already cached locally
            const tmpDir = path.join(__dirname, 'tmp', 'manage-keys');
            const localPath = path.join(tmpDir, `${email.replace('@', '_at_').replace(/\./g, '_')}.json`);
            const cached = fs.existsSync(localPath);
            const collection = metadata[email] ? metadata[email].collection || 'Uncategorized' : 'Uncategorized';
            accounts.push({ email, password, domain, cached, collection });
        }

        res.json(accounts);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Fetch key from S3 for specific account
app.post('/api/manage/fetch-key', async (req, res) => {
    try {
        const { adminEmail } = req.body;
        if (!adminEmail) return res.status(400).json({ error: 'adminEmail required' });

        const { localPath, keyData } = await fetchKeyFromS3(adminEmail);
        res.json({ success: true, cached: true, clientEmail: keyData.client_email, projectId: keyData.project_id });
    } catch (e) {
        console.error(`[Manage] ❌ S3 fetch error for ${req.body?.adminEmail}: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});



// Get workspace info (users list, domains list) for a specific account
app.post('/api/manage/workspace-info', async (req, res) => {
    try {
        const { adminEmail } = req.body;
        if (!adminEmail) return res.status(400).json({ error: 'adminEmail required' });

        const { google } = await import('googleapis');
        const keyData = await getKeyData(adminEmail);
        const auth = new google.auth.JWT({
            email: keyData.client_email,
            key: keyData.private_key,
            scopes: [
                'https://www.googleapis.com/auth/admin.directory.user',
                'https://www.googleapis.com/auth/admin.directory.domain',
            ],
            subject: adminEmail
        });

        const admin = google.admin({ version: 'directory_v1', auth });

        const [usersRes, domainsRes] = await Promise.allSettled([
            admin.users.list({ customer: 'my_customer', maxResults: 100, orderBy: 'email' }),
            admin.domains.list({ customer: 'my_customer' })
        ]);

        const users = usersRes.status === 'fulfilled'
            ? (usersRes.value.data.users || []).map(u => ({
                email: u.primaryEmail,
                name: u.name?.fullName,
                status: u.suspended ? 'suspended' : 'active',
                isAdmin: u.isAdmin,
                creationTime: u.creationTime
            }))
            : [];

        const domains = domainsRes.status === 'fulfilled'
            ? (domainsRes.value.data.domains || []).map(d => ({
                domainName: d.domainName,
                isPrimary: d.isPrimary,
                verified: d.verified,
                creationTime: d.creationTime
            }))
            : [];

        res.json({ users, domains, usersError: usersRes.reason?.message, domainsError: domainsRes.reason?.message });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bulk Get Workspace info for multiple accounts
app.post('/api/manage/workspace-info-bulk', async (req, res) => {
    try {
        const { emails } = req.body;
        if (!emails || !Array.isArray(emails)) return res.status(400).json({ error: 'emails array required' });

        const results = {};
        const { google } = await import('googleapis');

        // Process in small batches to avoid too many S3 / Google API calls at once
        const BATCH_SIZE = 5;
        for (let i = 0; i < emails.length; i += BATCH_SIZE) {
            const batch = emails.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (adminEmail) => {
                try {
                    const keyData = await getKeyData(adminEmail);
                    const auth = new google.auth.JWT({
                        email: keyData.client_email,
                        key: keyData.private_key,
                        scopes: [
                            'https://www.googleapis.com/auth/admin.directory.user',
                            'https://www.googleapis.com/auth/admin.directory.domain',
                        ],
                        subject: adminEmail
                    });

                    const admin = google.admin({ version: 'directory_v1', auth });
                    const [usersRes, domainsRes] = await Promise.allSettled([
                        admin.users.list({ customer: 'my_customer', maxResults: 100, orderBy: 'email' }),
                        admin.domains.list({ customer: 'my_customer' })
                    ]);

                    results[adminEmail] = {
                        users: usersRes.status === 'fulfilled' ? (usersRes.value.data.users || []).map(u => ({
                            email: u.primaryEmail, name: u.name?.fullName, status: u.suspended ? 'suspended' : 'active', isAdmin: u.isAdmin
                        })) : [],
                        domains: domainsRes.status === 'fulfilled' ? (domainsRes.value.data.domains || []).map(d => ({
                            domainName: d.domainName, verified: d.verified, isPrimary: d.isPrimary
                        })) : [],
                        error: usersRes.status === 'rejected' ? usersRes.reason?.message : (domainsRes.status === 'rejected' ? domainsRes.reason?.message : null)
                    };
                } catch (e) {
                    results[adminEmail] = { error: e.message, users: [], domains: [] };
                }
            }));
        }

        res.json({ results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bulk create users in a workspace
app.post('/api/manage/create-users', async (req, res) => {
    try {
        const { adminEmail, users, proxyString } = req.body;
        // users: [{ firstName, lastName, password, username }]
        if (!adminEmail || !Array.isArray(users) || users.length === 0) {
            return res.status(400).json({ error: 'adminEmail, users[] required' });
        }

        const { google } = await import('googleapis');
        let HttpsProxyAgent;
        try {
            const mod = await import('https-proxy-agent');
            HttpsProxyAgent = mod.HttpsProxyAgent;
        } catch (err) {
            console.warn('[Manage] https-proxy-agent module not found, proxy will be ignored');
        }

        const keyData = await getKeyData(adminEmail);
        const defaultDomain = adminEmail.split('@')[1];

        const jwtOptions = {
            email: keyData.client_email,
            key: keyData.private_key,
            scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
            subject: adminEmail
        };

        let agent = undefined;
        if (proxyString && HttpsProxyAgent) {
            const p = proxyString.split(':');
            let proxyUrl = '';
            if (p.length === 4) {
                // ip:port:user:pass
                const [ip, port, user, pass] = p;
                proxyUrl = `http://${user}:${pass}@${ip}:${port}`;
            } else if (p.length === 2) {
                // ip:port
                proxyUrl = `http://${p[0]}:${p[1]}`;
            } else {
                // assume full url or fallback
                proxyUrl = proxyString.startsWith('http') ? proxyString : `http://${proxyString}`;
            }
            agent = new HttpsProxyAgent(proxyUrl);
        }

        const auth = new google.auth.JWT(jwtOptions);
        const googleOptions = { version: 'directory_v1', auth };

        // Pass the agent globally or specifically for google workspace API reqs
        if (agent) {
            auth.additionalOptions = { httpsAgent: agent, httpAgent: agent };
            google.options({ httpAgent: agent, httpsAgent: agent });
            console.log(`[Manage] 🌐 Using Proxy for User Creation: ${proxyString.split(':')[0]}***`);
        }

        const admin = google.admin(googleOptions);

        const results = [];
        for (const user of users) {
            const userDomain = user.domain || req.body.targetDomain || defaultDomain;
            const primaryEmail = `${user.username}@${userDomain}`;
            try {
                await admin.users.insert({
                    requestBody: {
                        primaryEmail,
                        name: {
                            givenName: user.firstName || user.username,
                            familyName: user.lastName || 'User'
                        },
                        password: user.password,
                        changePasswordAtNextLogin: false
                    }
                });
                results.push({ email: primaryEmail, status: 'created', password: user.password });
                console.log(`[Manage] ✅ Created user: ${primaryEmail}`);

                // Save to created_users.txt
                try {
                    const createdUsersPath = path.join(__dirname, 'created_users.txt');
                    fs.appendFileSync(createdUsersPath, `${primaryEmail}:${user.password}\n`);
                } catch (saveErr) {
                    console.warn(`[Manage] Could not save to created_users.txt: ${saveErr.message}`);
                }
            } catch (err) {
                results.push({ email: primaryEmail, status: 'error', error: err.message });
                console.error(`[Manage] ❌ Failed to create ${primaryEmail}: ${err.message}`);
            }
        }

        // Reset global google options if modified
        if (agent) {
            google.options({ httpAgent: null, httpsAgent: null });
        }

        const created = results.filter(r => r.status === 'created').length;
        const failed = results.filter(r => r.status === 'error').length;
        res.json({ success: true, created, failed, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Add a domain to a workspace
app.post('/api/manage/add-domain', async (req, res) => {
    try {
        const { adminEmail, domainName } = req.body;
        if (!adminEmail || !domainName) {
            return res.status(400).json({ error: 'adminEmail, domainName required' });
        }

        const { google } = await import('googleapis');
        const keyData = await getKeyData(adminEmail);

        const auth = new google.auth.JWT({
            email: keyData.client_email,
            key: keyData.private_key,
            scopes: ['https://www.googleapis.com/auth/admin.directory.domain'],
            subject: adminEmail
        });

        const admin = google.admin({ version: 'directory_v1', auth });

        await admin.domains.insert({
            customer: 'my_customer',
            requestBody: { domainName }
        });

        console.log(`[Manage] ✅ Domain added: ${domainName} to ${adminEmail}`);

        // === Auto-verify via Cloudflare & Site Verification API ===
        try {
            const siteVerification = google.siteVerification({
                version: 'v1',
                auth: new google.auth.JWT({
                    email: keyData.client_email,
                    key: keyData.private_key,
                    scopes: ['https://www.googleapis.com/auth/siteverification'],
                    subject: adminEmail
                })
            });

            console.log(`[Manage] 📡 Fetching Google Site Verification Token...`);
            const tokenRes = await siteVerification.webResource.getToken({
                requestBody: {
                    verificationMethod: 'DNS_TXT',
                    site: { identifier: domainName, type: 'INET_DOMAIN' }
                }
            });
            const txtRecord = tokenRes.data.token;
            console.log(`[Manage] 📝 Token received: ${txtRecord}`);

            const configPath = path.join(__dirname, 'config.json');
            let config = {};
            if (fs.existsSync(configPath)) {
                config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }

            if (config.cloudflareEmail || config.dynuApiKey) {
                const { detectDnsProvider, upsertDnsTxt } = await import('./services/dnsProvider.js');
                const det = await detectDnsProvider(domainName, config);
                if (det.provider) {
                    const icon = det.provider === 'cloudflare' ? '☁️' : '🌐';
                    console.log(`[Manage] ${icon} Detected ${det.provider.toUpperCase()} for ${domainName}`);
                    const dnsRes = await upsertDnsTxt(domainName, txtRecord, config, (m) => console.log(`[Manage] ${m}`));

                    if (dnsRes.success) {
                        console.log(`[Manage] ✅ TXT Record added to ${dnsRes.provider.toUpperCase()}! Waiting 10s for propagation...`);

                        await new Promise(r => setTimeout(r, 10000));

                        console.log(`[Manage] 🔄 Triggering Google Site Verification Check...`);
                        await siteVerification.webResource.insert({
                            verificationMethod: 'DNS_TXT',
                            requestBody: {
                                site: { identifier: domainName, type: 'INET_DOMAIN' }
                            }
                        });
                        console.log(`[Manage] 🎉 Google Site Verification Completed for ${domainName}!`);
                        
                        // Force Google Workspace to sync
                        const authDir = new google.auth.JWT({
                            email: keyData.client_email,
                            key: keyData.private_key,
                            scopes: ['https://www.googleapis.com/auth/admin.directory.domain'],
                            subject: adminEmail
                        });
                        const adminDir = google.admin({ version: 'directory_v1', auth: authDir });
                        for (let i = 0; i < 5; i++) {
                            if (i > 0) await new Promise(r => setTimeout(r, 6000));
                            const domRes = await adminDir.domains.get({ customer: 'my_customer', domainName });
                            if (domRes.data.verified) break;
                        }
                    } else {
                        console.log(`[Manage] ⚠️ DNS upsert warning: ${dnsRes.error}`);
                    }
                } else {
                    console.log(`[Manage] ⚠️ No Cloudflare or Dynu zone found for ${domainName}, skipping auto-verification.`);
                }
            } else {
                console.log(`[Manage] ⚠️ DNS config missing in config.json. Skipping auto-verification.`);
            }
        } catch (verErr) {
            console.error(`[Manage] ⚠️ Auto-verification error: ${verErr.message}`);
        }
        // ==========================================================

        res.json({ success: true, domainName });
    } catch (e) {
        console.error(`[Manage] ❌ Add domain error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Re-trigger domain verification (for domains added but still pending)
app.post('/api/manage/verify-domain', async (req, res) => {
    try {
        const { adminEmail, domainName } = req.body;
        if (!adminEmail || !domainName) return res.status(400).json({ error: 'adminEmail, domainName required' });

        const { google } = await import('googleapis');
        const keyData = await getKeyData(adminEmail);

        const siteVerification = google.siteVerification({
            version: 'v1',
            auth: new google.auth.JWT({
                email: keyData.client_email,
                key: keyData.private_key,
                scopes: ['https://www.googleapis.com/auth/siteverification'],
                subject: adminEmail
            })
        });

        // Step 1: Get the exact verification token Google expects
        const tokenRes = await siteVerification.webResource.getToken({
            requestBody: {
                verificationMethod: 'DNS_TXT',
                site: { identifier: domainName, type: 'INET_DOMAIN' }
            }
        });
        const txtToken = tokenRes.data.token;
        console.log(`[Verify] Token for ${domainName}: ${txtToken}`);

        // Step 2: Upsert the TXT record on whichever DNS provider owns the zone
        const configPath = path.join(__dirname, 'config.json');
        let config = {};
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        if (config.cloudflareEmail || config.dynuApiKey) {
            try {
                const { upsertDnsTxt } = await import('./services/dnsProvider.js');
                const dnsRes = await upsertDnsTxt(domainName, txtToken, config, (m) => console.log(`[Verify] ${m}`));
                if (dnsRes.success && !dnsRes.already) {
                    console.log(`[Verify] TXT record added to ${dnsRes.provider.toUpperCase()} for ${domainName}`);
                    // Wait for DNS propagation
                    await new Promise(r => setTimeout(r, 10000));
                } else if (dnsRes.success) {
                    console.log(`[Verify] Correct TXT record already present in ${dnsRes.provider.toUpperCase()} for ${domainName}`);
                } else {
                    console.warn(`[Verify] DNS upsert warning: ${dnsRes.error}`);
                }
            } catch (dnsErr) {
                console.warn(`[Verify] DNS upsert warning: ${dnsErr.message}`);
            }
        }

        // Step 3: Trigger Google Site Verification with retries for DNS propagation
        let verified = false;
        let lastError = null;
        for (let i = 0; i < 4; i++) {
            try {
                if (i > 0) {
                    console.log(`[Verify] Attempt ${i + 1} for ${domainName}, waiting 15s...`);
                    await new Promise(r => setTimeout(r, 15000));
                }
                await siteVerification.webResource.insert({
                    verificationMethod: 'DNS_TXT',
                    requestBody: {
                        site: { identifier: domainName, type: 'INET_DOMAIN' }
                    }
                });
                verified = true;
                break;
            } catch (e) {
                lastError = e;
                const errMsg = e.response?.data?.error?.message || e.message;
                console.warn(`[Verify] Attempt ${i + 1} failed: ${errMsg}`);
            }
        }

        if (!verified) {
            throw lastError || new Error('Verification failed after retries');
        }

        // Step 4: Force Google Workspace to sync
        let syncVerified = false;
        try {
            const authDir = new google.auth.JWT({
                email: keyData.client_email,
                key: keyData.private_key,
                scopes: ['https://www.googleapis.com/auth/admin.directory.domain'],
                subject: adminEmail
            });
            const adminDir = google.admin({ version: 'directory_v1', auth: authDir });

            for (let i = 0; i < 5; i++) {
                if (i > 0) {
                    console.log(`[Verify] Waiting for Directory API sync for ${domainName}, attempt ${i+1}...`);
                    await new Promise(r => setTimeout(r, 6000));
                }
                const domRes = await adminDir.domains.get({ customer: 'my_customer', domainName });
                if (domRes.data.verified) {
                    syncVerified = true;
                    break;
                }
            }
        } catch (syncErr) {
            console.warn(`[Verify] Directory API sync check failed for ${domainName}: ${syncErr.message}`);
        }

        if (!syncVerified) {
            throw new Error('Workspace is still syncing verification. This can take up to a few hours. Try clicking Verify Now later, or verify manually in Google Admin Console.');
        }

        console.log(`[Verify] ✅ Verification completed for ${domainName}`);
        res.json({ success: true, domainName });
    } catch (e) {
        const errMsg = e.response?.data?.error?.message || e.response?.data?.error || e.errors?.[0]?.message || e.message;
        console.error(`[Verify] ❌ ${errMsg}`);
        res.status(500).json({ error: errMsg });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// ── DYNU DOMAINS ────────────────────────────────────────────────────────
// Base domains are manually entered on the Dynu Domains page. Each base
// domain gets a unique generated subdomain (e.g. `x7k2q9.example.com`) that
// is added to a Workspace account as a domain alias, then verified through
// whatever DNS provider owns the zone (Cloudflare or Dynu).
// ═══════════════════════════════════════════════════════════════════════
const DYNU_DOMAINS_PATH = path.join(__dirname, 'dynu_domains.json');

function readDynuDomainsStore() {
    if (!fs.existsSync(DYNU_DOMAINS_PATH)) return { baseDomains: [], provisioned: [] };
    try { return JSON.parse(fs.readFileSync(DYNU_DOMAINS_PATH, 'utf8')); }
    catch (e) { return { baseDomains: [], provisioned: [] }; }
}

function writeDynuDomainsStore(store) {
    fs.writeFileSync(DYNU_DOMAINS_PATH, JSON.stringify(store, null, 2));
}

// List stored base domains + provisioned subdomains
app.get('/api/dynu/domains', (req, res) => {
    res.json(readDynuDomainsStore());
});

// Return the Dynu Domains activity log buffer (latest last)
app.get('/api/dynu/logs', (req, res) => {
    res.json(dynuLogBuffer);
});

// Store base domains (manually entered; merged, deduplicated)
app.post('/api/dynu/domains', (req, res) => {
    try {
        const { baseDomains } = req.body;
        if (!baseDomains || !Array.isArray(baseDomains)) return res.status(400).json({ error: 'baseDomains array required' });
        const store = readDynuDomainsStore();
        for (const d of baseDomains) {
            const clean = String(d).trim().toLowerCase();
            if (clean.includes('.') && !store.baseDomains.includes(clean)) store.baseDomains.push(clean);
        }
        writeDynuDomainsStore(store);
        res.json({ success: true, baseDomains: store.baseDomains });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Remove a base domain and its provisioned subdomains
app.delete('/api/dynu/domains', (req, res) => {
    try {
        const { baseDomain } = req.body;
        const store = readDynuDomainsStore();
        store.baseDomains = store.baseDomains.filter(d => d !== baseDomain);
        store.provisioned = store.provisioned.filter(p => p.baseDomain !== baseDomain);
        writeDynuDomainsStore(store);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Manual "Clear" button: remove every provisioned subdomain from the list.
// Base domains are kept.
app.delete('/api/dynu/domains/provisioned', (req, res) => {
    try {
        const store = readDynuDomainsStore();
        const count = store.provisioned.length;
        store.provisioned = [];
        writeDynuDomainsStore(store);
        dynuLog('INFO', `🧹 Cleared ${count} provisioned subdomain(s) (manual Clear)`);
        res.json({ success: true, cleared: count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Manual "Clear" button: empty the Dynu activity log buffer.
app.delete('/api/dynu/logs', (req, res) => {
    dynuLogBuffer.length = 0;
    res.json({ success: true });
});

// Construct a Dynu API client from the saved config, or null when no key set.
async function getDynuService() {
    const configPath = path.join(__dirname, 'config.json');
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const dynuKey = (config.dynuApiKey || '').trim();
    if (!dynuKey) return null;
    const { default: DynuService } = await import('./services/dynuService.js');
    return new DynuService(dynuKey);
}

// Provision a unique subdomain under `cleanBase` for `adminEmail` and return
// the outcome. Shared by the single and bulk provision endpoints.
async function provisionSubdomain(adminEmail, cleanBase) {
    const configPath = path.join(__dirname, 'config.json');
    let config = {};
    if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    dynuLog('INFO', `▶️ Provision start | admin=${adminEmail} | base=${cleanBase}`);

    const dynuKey = (config.dynuApiKey || '').trim();
    if (!dynuKey) {
        dynuLog('ERROR', `❌ Dynu API key is EMPTY — set 'dynuApiKey' in Settings before provisioning (all Dynu API calls will be rejected)`);
    } else {
        dynuLog('INFO', `🔑 Dynu API key configured (${dynuKey.length} chars)`);
    }

    const { google } = await import('googleapis');
    const keyData = await getKeyData(adminEmail);

    // 1) Generate a unique subdomain under the base domain
    const prefix = Math.random().toString(36).slice(2, 8).toLowerCase();
    const subdomain = `${prefix}.${cleanBase}`;
    dynuLog('INFO', `📍 Generated subdomain: ${subdomain}`);

    // 2) Add the subdomain to the Workspace account as a domain alias
    const auth = new google.auth.JWT({
        email: keyData.client_email,
        key: keyData.private_key,
        scopes: ['https://www.googleapis.com/auth/admin.directory.domain'],
        subject: adminEmail
    });
    const admin = google.admin({ version: 'directory_v1', auth });
    await admin.domains.insert({ customer: 'my_customer', requestBody: { domainName: subdomain } });
    dynuLog('INFO', `✅ Subdomain added to Workspace: ${subdomain} (${adminEmail})`);

    // 3) Fetch the exact verification token Google expects
    const siteVerification = google.siteVerification({
        version: 'v1',
        auth: new google.auth.JWT({
            email: keyData.client_email,
            key: keyData.private_key,
            scopes: ['https://www.googleapis.com/auth/siteverification'],
            subject: adminEmail
        })
    });
    const tokenRes = await siteVerification.webResource.getToken({
        requestBody: { verificationMethod: 'DNS_TXT', site: { identifier: subdomain, type: 'INET_DOMAIN' } }
    });
    const txtToken = tokenRes.data.token;
    dynuLog('INFO', `📝 Verification token received for ${subdomain}`);

    // 4) Auto-detect the DNS provider (Cloudflare first, then Dynu) & upsert TXT
    const { detectDnsProvider, upsertDnsTxt } = await import('./services/dnsProvider.js');
    dynuLog('INFO', `🔎 Detecting DNS provider for ${subdomain}...`);
    const det = await detectDnsProvider(subdomain, config);
    let provider = det.provider;
    let verified = false;
    let dynuHost = null;

    if (det.provider) {
        dynuLog('INFO', `🌐 Provider detected: ${det.provider}${det.zoneName ? ` (zone: ${det.zoneName})` : ''}${det.freeDomain ? ' (Dynu free domain)' : ''}`);
    } else {
        dynuLog('INFO', `🌐 No zone match yet for ${subdomain} — checking Dynu dynamic-DNS ownership`);
    }

    // 4a) For Dynu — or when no provider matched and a Dynu key exists —
    //     create the Dynamic DNS host for the generated subdomain (API
    //     equivalent of "Add Dynamic DNS" in the dashboard). Dynu free
    //     domains (dynu.net, dynuddns.net, ...) have no apex zone in the
    //     account, so the host must exist before TXT records can be placed.
    const needDynuHost = det.provider === 'dynu' || (!det.provider && !!(config.dynuApiKey || '').trim());
    if (needDynuHost) {
        const dynuService = det.dynu?.service || (await getDynuService());
        if (dynuService) {
            // Apex A-record IP: explicit override from config, else the
            // server's current public IP.
            const apexIp = (config.dynuApexIp || '').trim() || await dynuService.getPublicIp();
            dynuLog('INFO', `🏠 Creating Dynamic DNS host ${subdomain} in Dynu (POST /v2/dns)...${apexIp ? ` | A record -> ${apexIp}` : ' | no IP available for A record'}`);
            const hostRes = await dynuService.ensureHost(subdomain, apexIp);
            if (hostRes.success) {
                provider = 'dynu';
                dynuHost = { created: true, already: !!hostRes.already, zoneId: hostRes.zoneId || null };
                if (hostRes.aRecord) {
                    if (hostRes.aRecord.error) {
                        dynuLog('WARN', `⚠️ Could not set A record for ${subdomain}: ${hostRes.aRecord.error}`);
                    } else {
                        dynuLog('INFO', `✅ A record -> ${hostRes.aRecord.ip} for ${subdomain}${hostRes.aRecord.already ? ' (already)' : ''}`);
                    }
                }
                dynuLog('INFO', `✅ Dynamic DNS host ready: ${subdomain}${hostRes.already ? ' (already existed)' : ''}${hostRes.zoneId ? ` [zoneId=${hostRes.zoneId}]` : ''}`);
            } else {
                dynuLog('ERROR', `❌ Could not create Dynamic DNS host for ${subdomain}: ${hostRes.error}`);
            }
        }
    }

    if (provider) {
        dynuLog('INFO', `✏️ Upserting TXT record for ${subdomain}...`);
        const dnsRes = await upsertDnsTxt(subdomain, txtToken, config, (m) => dynuLog('INFO', m));
        if (dnsRes.success) {
            dynuLog('INFO', `✅ TXT record ${dnsRes.already ? 'already present' : 'added'} for ${subdomain}`);
            if (!dnsRes.already) await new Promise(r => setTimeout(r, 10000));
            // 5) Trigger Google Site Verification with retries
            for (let i = 0; i < 4; i++) {
                try {
                    if (i > 0) await new Promise(r => setTimeout(r, 15000));
                    await siteVerification.webResource.insert({
                        verificationMethod: 'DNS_TXT',
                        requestBody: { site: { identifier: subdomain, type: 'INET_DOMAIN' } }
                    });
                    verified = true;
                    dynuLog('INFO', `✅ Google verification succeeded for ${subdomain} (attempt ${i + 1})`);
                    break;
                } catch (e) {
                    const errMsg = e.response?.data?.error?.message || e.message;
                    dynuLog('WARN', `⚠️ webResource.insert attempt ${i + 1} failed: ${errMsg}`);
                }
            }
        } else {
            dynuLog('ERROR', `❌ TXT upsert failed: ${dnsRes.error}`);
        }
    } else {
        dynuLog('WARN', `⚠️ Subdomain ${subdomain} added but NOT verified — no DNS zone found`);
    }

    // 6) Persist to the store
    const store = readDynuDomainsStore();
    if (!store.baseDomains.includes(cleanBase)) store.baseDomains.push(cleanBase);
    store.provisioned.push({
        baseDomain: cleanBase,
        subdomain,
        adminEmail,
        provider,
        verified,
        dynuHost,
        createdAt: new Date().toISOString()
    });
    writeDynuDomainsStore(store);

    dynuLog(verified ? 'INFO' : 'WARN', `🏁 Provision finished for ${subdomain} | provider=${provider || 'none'} | verified=${verified} | dynuHost=${dynuHost ? (dynuHost.already ? 'existing' : 'created') : 'not-created'}`);
    return { success: true, subdomain, provider, verified, dynuHost };
}

// Provision a single workspace account.
app.post('/api/dynu/provision', async (req, res) => {
    try {
        const { adminEmail, baseDomain } = req.body;
        if (!adminEmail || !baseDomain) return res.status(400).json({ error: 'adminEmail, baseDomain required' });

        const cleanBase = String(baseDomain).trim().toLowerCase();
        if (!cleanBase.includes('.')) return res.status(400).json({ error: 'Invalid base domain' });

        const result = await provisionSubdomain(adminEmail, cleanBase);
        return res.json(result);
    } catch (e) {
        const errMsg = e.response?.data?.error?.message || e.response?.data?.error || e.message;
        dynuLog('ERROR', `❌ Provision error: ${errMsg}`);
        res.status(500).json({ error: errMsg });
    }
});

// Bulk provision: paste multiple workspace accounts; each gets its own unique
// subdomain, processed sequentially. Mode 'single' puts every account under the
// same base domain; mode 'rotate' cycles accounts through a list of base
// domains (account i -> baseDomains[i % baseDomains.length]).
app.post('/api/dynu/provision/bulk', async (req, res) => {
    try {
        const { adminEmails, baseDomain, baseDomains, mode = 'single' } = req.body;
        const emails = (Array.isArray(adminEmails) ? adminEmails : [])
            .map(e => String(e).trim().toLowerCase())
            .filter(e => e.includes('@'));
        if (!emails.length) return res.status(400).json({ error: 'adminEmails (non-empty) required' });

        // Resolve the domain list for this run.
        let domains;
        if (mode === 'rotate') {
            domains = (Array.isArray(baseDomains) ? baseDomains : [])
                .map(d => String(d).trim().toLowerCase())
                .filter(d => d.includes('.'));
            if (!domains.length) return res.status(400).json({ error: 'rotate mode requires baseDomains (non-empty)' });
        } else {
            if (!baseDomain) return res.status(400).json({ error: 'baseDomain required (single mode)' });
            const clean = String(baseDomain).trim().toLowerCase();
            if (!clean.includes('.')) return res.status(400).json({ error: 'Invalid base domain' });
            domains = [clean];
        }

        dynuLog('INFO', `🚀 Bulk provision start | mode=${mode} | accounts=${emails.length} | domains=${domains.length}${mode === 'rotate' ? ` (${domains.join(', ')})` : ` (${domains[0]})`}`);

        const results = [];
        for (let i = 0; i < emails.length; i++) {
            const email = emails[i];
            // Rotation: each account picks the next domain in sequence.
            const target = domains[i % domains.length];
            dynuLog('INFO', `🚀 Bulk ${i + 1}/${emails.length} | ${email} | -> ${target}`);
            try {
                const r = await provisionSubdomain(email, target);
                results.push({ email, baseDomain: target, ...r });
            } catch (e) {
                const errMsg = e.response?.data?.error?.message || e.response?.data?.error || e.message;
                dynuLog('ERROR', `❌ Bulk provision failed for ${email}: ${errMsg}`);
                results.push({ email, baseDomain: target, success: false, error: errMsg });
            }
        }

        const okCount = results.filter(r => r.success).length;
        dynuLog('INFO', `🚀 Bulk provision finished | mode=${mode} | ok=${okCount}/${results.length}`);
        res.json({ success: true, mode, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// ── BULK WORKSPACE USER CREATION (Puppeteer per account) ────────────────
// Picks result accounts, opens each one's Google Admin in a real browser,
// navigates to the "Bulk add users" page and creates N users per account.
// Concurrency-limited. Logs land in the Dynu activity log + per-email logs.
// ═══════════════════════════════════════════════════════════════════════

const bulkUserJob = {
    running: false,
    stopRequested: false,
    startedAt: null,
    finishedAt: null,
    total: 0,
    done: 0,
    ok: 0,
    failed: 0,
    concurrency: 2,
    usersPerAccount: 9,
    accounts: [],   // [{ email, password, targetDomain, status, usersCreated, error, startedAt, finishedAt }]
};

function parseProxyLine(line) {
    const s = String(line || '').trim();
    if (!s || s.startsWith('#')) return null;
    const [host, port, user, pass] = s.split(':');
    if (!host || !port) return null;
    return { host, port: parseInt(port, 10) || 0, user, pass };
}

function getBulkProxyPool() {
    const fromEnv = String(process.env.PROXY_LIST || '').split('\n').map(parseProxyLine).filter(Boolean);
    if (fromEnv.length) return fromEnv;
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
        if (cfg.proxiesEnabled && cfg.proxiesList) {
            return String(cfg.proxiesList).split('\n').map(parseProxyLine).filter(Boolean);
        }
    } catch { }
    return [];
}

function readResultPasswordMap() {
    const map = new Map();
    const p = path.join(__dirname, 'result_accounts.txt');
    if (!fs.existsSync(p)) return map;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf(':');
        if (i > 0) map.set(t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).trim());
    }
    return map;
}

// Parse manually pasted lines: `email:password` or `email:password:domain`.
// Password may be omitted (falls back to result_accounts.txt on the server).
function parseRawBulkAccounts(text) {
    const out = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(':');
        if (parts.length < 2) continue;
        const email = parts[0].trim();
        if (!email.includes('@')) continue;
        let password = parts.slice(1).join(':');
        let targetDomain = '';
        const last = parts[parts.length - 1];
        if (parts.length >= 3 && /^@?[\w.-]+\.[a-zA-Z]{2,}$/.test(last)) {
            targetDomain = last.replace(/^@/, '');
            password = parts.slice(1, -1).join(':');
        }
        out.push({ email, password, targetDomain });
    }
    return out;
}

function getBulkHeadless() {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
        return cfg.headlessMode !== false;
    } catch { return true; }
}

async function runBulkUserJob() {
    if (bulkUserJob.running) return;
    bulkUserJob.running = true;
    bulkUserJob.stopRequested = false;
    bulkUserJob.startedAt = new Date().toISOString();
    bulkUserJob.finishedAt = null;
    bulkUserJob.done = 0;
    bulkUserJob.ok = 0;
    bulkUserJob.failed = 0;

    const { GoogleWorkspaceUserCreator, Logger, HeroSMSAPI } = await import('./services/bulkUserCreation.js');

    // Per-thread logger: mirrors the module's Logger but also keeps a buffer we
    // can read back to surface the real failure reason in the Dynu activity log.
    class BulkThreadLogger extends Logger {
        constructor(acc) {
            super();
            this.buf = [];
            this.acc = acc;
        }
        write(level, ...args) {
            const msg = args.map(a => (a instanceof Error ? (a.stack || a.message) : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
            this.buf.push({ ts: new Date().toISOString(), level, msg });
            if (this.buf.length > 300) this.buf.shift();
            console.log(`[${this.acc.email}] [${level}] ${msg}`);
        }
    }

    // Hero-SMS provider (same key/url the rest of the app uses)
    let heroSms = null;
    let skipSms = true;
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
        if (cfg.heroSmsKey) {
            heroSms = new HeroSMSAPI(cfg.heroSmsKey, cfg.heroSmsUrl || 'https://hero-sms.com/stubs/handler_api.php');
            skipSms = false;
        }
    } catch { }

    const proxyPool = getBulkProxyPool();
    const accounts = bulkUserJob.accounts;
    const concurrency = Math.max(1, bulkUserJob.concurrency);
    const headless = getBulkHeadless();
    dynuLog('INFO', `👥 Bulk user creation start | accounts=${accounts.length} | concurrency=${concurrency} | users/account=${bulkUserJob.usersPerAccount} | proxies=${proxyPool.length} | headless=${headless} | sms=${skipSms ? 'OFF' : 'ON'}`);

    let nextIndex = 0;
    const worker = async () => {
        while (!bulkUserJob.stopRequested) {
            const idx = nextIndex++;
            if (idx >= accounts.length) break;
            const acc = accounts[idx];
            if (!acc.password) {
                acc.status = 'failed';
                acc.error = 'no password available for this account';
                acc.finishedAt = new Date().toISOString();
                bulkUserJob.failed++;
                bulkUserJob.done++;
                dynuLog('ERROR', `👥 [${idx + 1}/${accounts.length}] ❌ ${acc.email} — ${acc.error}`);
                continue;
            }
            acc.status = 'running';
            acc.startedAt = new Date().toISOString();
            const proxy = proxyPool.length ? proxyPool[idx % proxyPool.length] : null;
            dynuLog('INFO', `👥 [${idx + 1}/${accounts.length}] ▶️ ${acc.email}${acc.targetDomain ? ` -> ${acc.targetDomain}` : ''} | thread start${proxy ? ` | proxy ${proxy.host}:${proxy.port}` : ' | no proxy'}`);
            try {
                const logger = new BulkThreadLogger(acc);
                const creator = new GoogleWorkspaceUserCreator(acc.email, acc.password, {
                    threadId: idx + 1,
                    headless,
                    logger,
                    skipSms,
                    heroSms,
                    usersCount: bulkUserJob.usersPerAccount,
                    targetDomain: acc.targetDomain || '',
                });
                const ok = await creator.run(proxy);
                acc.usersCreated = creator.usersCreated;
                if (ok) {
                    acc.status = 'done';
                    acc.error = null;
                    bulkUserJob.ok++;
                    dynuLog('INFO', `👥 [${idx + 1}/${accounts.length}] ✅ ${acc.email} — ${creator.usersCreated} users created`);
                } else {
                    acc.status = 'failed';
                    const lastIssue = [...logger.buf].reverse().find(l => l.level === 'ERROR' || l.level === 'WARN');
                    acc.error = lastIssue ? lastIssue.msg.replace(/^.*?\] [ ]?/, '') : 'login or user creation failed';
                    bulkUserJob.failed++;
                    dynuLog('ERROR', `👥 [${idx + 1}/${accounts.length}] ❌ ${acc.email} — ${acc.error}`);
                    for (const l of logger.buf.slice(-12)) dynuLog(l.level === 'ERROR' ? 'WARN' : 'INFO', `👥 [${idx + 1}] ${l.msg}`);
                }
            } catch (e) {
                acc.status = 'failed';
                acc.error = e.message;
                bulkUserJob.failed++;
                dynuLog('ERROR', `👥 [${idx + 1}/${accounts.length}] ❌ ${acc.email} — ${e.message}`);
            } finally {
                acc.finishedAt = new Date().toISOString();
                bulkUserJob.done++;
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, () => worker()));

    bulkUserJob.finishedAt = new Date().toISOString();
    bulkUserJob.running = false;
    dynuLog('INFO', `👥 Bulk user creation finished | ok=${bulkUserJob.ok} | failed=${bulkUserJob.failed} | ${bulkUserJob.done}/${bulkUserJob.total}`);
}

// Start a bulk user-creation job.
// Body: { accounts: [{ email, password?, targetDomain? }], rawText?: "email:password[:domain]\n...", concurrency?, usersPerAccount?, targetDomain? }
app.post('/api/dynu/users/bulk', async (req, res) => {
    try {
        if (bulkUserJob.running) return res.status(409).json({ error: 'A bulk user-creation job is already running' });
        const { accounts: rawAccounts, rawText, concurrency, usersPerAccount } = req.body || {};
        const source = Array.isArray(rawAccounts) ? rawAccounts : (rawText ? parseRawBulkAccounts(rawText) : []);
        if (!source.length) return res.status(400).json({ error: 'accounts (non-empty array) or rawText required' });

        const passwordMap = readResultPasswordMap();
        const bodyTarget = String(req.body?.targetDomain || '').trim();
        const accounts = [];
        const seen = new Set();
        for (const a of source) {
            const email = String(a.email || '').trim().toLowerCase();
            if (!email.includes('@') || seen.has(email)) continue;
            seen.add(email);
            const password = String(a.password || '').trim() || passwordMap.get(email) || '';
            accounts.push({
                email,
                password,
                targetDomain: String(a.targetDomain || bodyTarget || '').trim(),
                status: 'queued',
                usersCreated: 0,
                error: null,
                startedAt: null,
                finishedAt: null,
            });
        }
        if (!accounts.length) return res.status(400).json({ error: 'No valid accounts provided' });

        bulkUserJob.accounts = accounts;
        bulkUserJob.total = accounts.length;
        bulkUserJob.concurrency = Math.min(Math.max(parseInt(concurrency, 10) || 2, 1), 10);
        bulkUserJob.usersPerAccount = Math.min(Math.max(parseInt(usersPerAccount, 10) || 9, 1), 500);

        dynuLog('INFO', `👥 Bulk user creation queued | accounts=${accounts.length} | concurrency=${bulkUserJob.concurrency} | users/account=${bulkUserJob.usersPerAccount}`);
        res.json({ success: true, total: accounts.length, concurrency: bulkUserJob.concurrency, usersPerAccount: bulkUserJob.usersPerAccount });
        runBulkUserJob();   // fire-and-forget
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/dynu/users/bulk/status', (req, res) => {
    res.json({
        running: bulkUserJob.running,
        stopRequested: bulkUserJob.stopRequested,
        startedAt: bulkUserJob.startedAt,
        finishedAt: bulkUserJob.finishedAt,
        total: bulkUserJob.total,
        done: bulkUserJob.done,
        ok: bulkUserJob.ok,
        failed: bulkUserJob.failed,
        concurrency: bulkUserJob.concurrency,
        usersPerAccount: bulkUserJob.usersPerAccount,
        accounts: bulkUserJob.accounts,
    });
});

app.post('/api/dynu/users/bulk/stop', (req, res) => {
    if (!bulkUserJob.running) return res.json({ success: true, alreadyStopped: true });
    bulkUserJob.stopRequested = true;
    dynuLog('WARN', `⏹️ Stop requested for bulk user creation (${bulkUserJob.done}/${bulkUserJob.total} done)`);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// ── DYNU DOMAIN MANAGER (live API operations) ───────────────────────────
// List domains, list records, add records, delete records. Mirrors the
// Cloudflare "Domains" page but for Dynu.
// ═══════════════════════════════════════════════════════════════════════

app.get('/api/dynu/manage/domains', async (req, res) => {
    try {
        const svc = await getDynuService();
        if (!svc) return res.status(400).json({ success: false, error: "Dynu API key not set — configure it in Settings" });
        const domains = await svc.listZones();
        res.json({ success: true, domains });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Delete one or many Dynu domains (zones) from the DNS service.
// Removes the domain and all of its records.
app.delete('/api/dynu/manage/domains', async (req, res) => {
    try {
        const { zoneIds } = req.body;
        const ids = (Array.isArray(zoneIds) ? zoneIds : [zoneIds]).map(Number).filter(n => Number.isInteger(n) && n > 0);
        if (!ids.length) return res.status(400).json({ success: false, error: 'zoneIds array required' });
        const svc = await getDynuService();
        if (!svc) return res.status(400).json({ success: false, error: "Dynu API key not set — configure it in Settings" });
        const results = [];
        for (const zoneId of ids) {
            const ok = await svc.deleteZone(zoneId);
            results.push({ zoneId, success: ok });
        }
        const okCount = results.filter(r => r.success).length;
        res.json({ success: true, ok: okCount, results });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/dynu/manage/records', async (req, res) => {
    try {
        const { zoneId } = req.query;
        if (!zoneId) return res.status(400).json({ success: false, error: 'zoneId required' });
        const svc = await getDynuService();
        if (!svc) return res.status(400).json({ success: false, error: "Dynu API key not set — configure it in Settings" });
        const records = await svc.listAllRecords(zoneId);
        res.json({ success: true, records });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/dynu/manage/records', async (req, res) => {
    try {
        const { zoneId, record } = req.body;
        if (!zoneId || !record?.recordType) return res.status(400).json({ success: false, error: 'zoneId and record.recordType required' });
        const svc = await getDynuService();
        if (!svc) return res.status(400).json({ success: false, error: "Dynu API key not set — configure it in Settings" });
        const result = await svc.addRecord(zoneId, record);
        if (!result.success) return res.status(400).json({ success: false, error: result.error });
        res.json({ success: true, record: result.record });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/dynu/manage/records', async (req, res) => {
    try {
        const { zoneId, recordId } = req.body;
        if (!zoneId || !recordId) return res.status(400).json({ success: false, error: 'zoneId, recordId required' });
        const svc = await getDynuService();
        if (!svc) return res.status(400).json({ success: false, error: "Dynu API key not set — configure it in Settings" });
        const ok = await svc.deleteRecord(zoneId, recordId);
        res.json({ success: ok });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// ── VERIFY UNVERIFIED DOMAINS (browser automation via Workspace UI) ─────
// Logs into each admin account (one session per account), retrieves the
// unverified domains through the Directory API, then uses the Workspace
// getsetup codes link for every unverified domain in the SAME session,
// ticking the "Come back here and confirm…" checkbox and pressing Confirm.
// ═══════════════════════════════════════════════════════════════════════
const domainVerifyJobs = new Map(); // jobId -> { job state }
let domainVerifyCounter = 0;

// Look up the password for an admin email from the known account files
function lookupAccountPassword(adminEmail) {
    const files = ['result_accounts.txt', 'accounts.txt'];
    for (const file of files) {
        const filePath = path.join(__dirname, file);
        if (!fs.existsSync(filePath)) continue;
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            const parts = line.split(':');
            if (parts[0]?.trim().toLowerCase() === adminEmail.toLowerCase() && parts[1]) {
                return parts.slice(1).join(':').trim();
            }
        }
    }
    return null;
}

// Fetch all unverified domain names for an admin account via Directory API
async function getUnverifiedDomains(adminEmail, keyData, log = () => {}) {
    const { google } = await import('googleapis');
    const auth = new google.auth.JWT({
        email: keyData.client_email,
        key: keyData.private_key,
        scopes: ['https://www.googleapis.com/auth/admin.directory.domain'],
        subject: adminEmail
    });
    const admin = google.admin({ version: 'directory_v1', auth });
    const res = await admin.domains.list({ customer: 'my_customer' });
    const domains = (res.data.domains || []).map(d => ({
        domainName: d.domainName,
        verified: d.verified,
        isPrimary: d.isPrimary
    }));
    const unverified = domains.filter(d => !d.verified).map(d => d.domainName);
    log(`[Job] ${adminEmail}: ${domains.length} domain(s), ${unverified.length} unverified`);
    return unverified;
}

async function runDomainVerifyJob(job) {
    const pushLog = (m) => {
        job.logs.push(m);
        console.log(`[DomainVerify] ${m}`);
    };
    const concurrency = Math.max(1, Math.min(parseInt(job.concurrency) || 1, 10));
    pushLog(`Job starting — ${job.entries.length} account(s), concurrency ${concurrency}`);

    job.doneCount = 0;

    const processEntry = async (entry) => {
        if (job.stopRequested) return;
        const accResult = { adminEmail: entry.adminEmail, domains: [], error: null };

        try {
            pushLog(`[${entry.adminEmail}] Starting…`);
            const keyData = await getKeyData(entry.adminEmail);
            const unverified = await getUnverifiedDomains(entry.adminEmail, keyData, pushLog);

            if (unverified.length === 0) {
                accResult.note = 'No unverified domains found';
                pushLog(`[${entry.adminEmail}] No unverified domains`);
            } else {
                const password = entry.password || lookupAccountPassword(entry.adminEmail);
                const botRes = await runDomainVerifyBot(
                    { email: entry.adminEmail, password },
                    {
                        adminEmail: entry.adminEmail,
                        unverifiedDomains: unverified,
                        keyData,
                        log: pushLog,
                        shouldStop: () => job.stopRequested
                    }
                );
                accResult.domains = botRes.results || [];
                if (botRes.error) accResult.error = botRes.error;
                pushLog(`[${entry.adminEmail}] Done — ${accResult.domains.filter(d => d.status === 'verified').length}/${accResult.domains.length} verified`);
            }
        } catch (e) {
            accResult.error = e.message;
            pushLog(`[${entry.adminEmail}] Error: ${e.message}`);
        }
        job.results.push(accResult);
        job.doneCount++;
    };

    // Worker pool: up to `concurrency` accounts processed at the same time
    let nextIndex = 0;
    const runners = [];
    for (let i = 0; i < concurrency; i++) {
        runners.push((async () => {
            while (!job.stopRequested) {
                const idx = nextIndex++;
                if (idx >= job.entries.length) break;
                const entry = job.entries[idx];
                job.current = { index: idx + 1, total: job.entries.length, adminEmail: entry.adminEmail };
                await processEntry(entry);
            }
        })());
    }
    await Promise.all(runners);

    if (job.status !== 'stopped') job.status = 'completed';
    job.doneAt = Date.now();
    console.log(`[DomainVerify] Job ${job.jobId} ${job.status}`);
}

// Start a domain-verification job
app.post('/api/manage/domain-verify/start', async (req, res) => {
    try {
        const { entries, concurrency } = req.body;
        if (!entries || !Array.isArray(entries) || entries.length === 0) {
            return res.status(400).json({ error: 'entries[] required (adminEmail + optional password)' });
        }

        // Resolve concurrency: explicit → config.json → default 1
        let resolvedConcurrency = concurrency;
        if (!resolvedConcurrency) {
            try {
                const configPath = path.join(__dirname, 'config.json');
                if (fs.existsSync(configPath)) {
                    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    if (cfg.concurrency) resolvedConcurrency = parseInt(cfg.concurrency);
                }
            } catch (e) { /* ignore */ }
        }
        resolvedConcurrency = Math.max(1, Math.min(parseInt(resolvedConcurrency) || 1, 10));

        domainVerifyCounter++;
        const jobId = `dv_${Date.now().toString(36)}_${domainVerifyCounter}`;
        const job = {
            jobId,
            status: 'running',
            concurrency: resolvedConcurrency,
            startedAt: Date.now(),
            entries: entries.map(e => ({ adminEmail: e.adminEmail, password: e.password || null })),
            results: [],
            logs: [],
            current: null,
            doneCount: 0,
            stopRequested: false
        };
        domainVerifyJobs.set(jobId, job);

        runDomainVerifyJob(job); // fire-and-forget; progress read via /status

        res.json({ success: true, jobId, concurrency: resolvedConcurrency });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Poll job status
app.get('/api/manage/domain-verify/status', (req, res) => {
    const job = domainVerifyJobs.get(req.query.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
        jobId: job.jobId,
        status: job.status,
        concurrency: job.concurrency,
        startedAt: job.startedAt,
        doneAt: job.doneAt,
        current: job.current,
        results: job.results,
        logs: job.logs.slice(-300)
    });
});

// Request a graceful stop
app.post('/api/manage/domain-verify/stop', (req, res) => {
    const job = domainVerifyJobs.get(req.body.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.stopRequested = true;
    res.json({ success: true });
});

// Retry a single failed account (e.g. LOGIN_FAILED) synchronously — returns the
// result so the UI can render it immediately without starting a new bulk job.
app.post('/api/manage/domain-verify/retry-one', async (req, res) => {
    try {
        const { adminEmail, password } = req.body;
        if (!adminEmail) return res.status(400).json({ error: 'adminEmail required' });
        const pushLog = (m) => console.log(`[DomainVerify:retry] ${m}`);
        const keyData = await getKeyData(adminEmail);
        const unverified = await getUnverifiedDomains(adminEmail, keyData, pushLog);
        const accResult = { adminEmail, domains: [], error: null };

        if (unverified.length === 0) {
            accResult.note = 'No unverified domains found';
        } else {
            const pwd = password || lookupAccountPassword(adminEmail);
            const botRes = await runDomainVerifyBot(
                { email: adminEmail, password: pwd },
                { adminEmail, unverifiedDomains: unverified, keyData, log: pushLog }
            );
            accResult.domains = botRes.results || [];
            if (botRes.error) accResult.error = botRes.error;
        }
        res.json({ success: true, result: accResult });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Shared helper: delete a domain with retry + delay to handle Google propagation lag
// Remove all aliases belonging to domainName from any user in allUsers.
// allUsers must be fetched with projection:'full' so the aliases field is present.
async function removeAliasesOnDomain(admin, allUsers, domainName) {
    const removed = [];
    const aliasErrors = [];
    for (const user of allUsers) {
        const domainAliases = (user.aliases || []).filter(a => a.endsWith('@' + domainName));
        for (const alias of domainAliases) {
            try {
                await admin.users.aliases.delete({ userKey: user.primaryEmail, alias });
                removed.push(alias);
                console.log(`[AliasClean] Removed alias ${alias} from ${user.primaryEmail}`);
            } catch (e) {
                aliasErrors.push({ alias, error: e.message });
                console.warn(`[AliasClean] Failed to remove alias ${alias}: ${e.message}`);
            }
        }
    }
    return { removed, aliasErrors };
}

// admin: optional user-scoped admin client — if provided, re-fetches and strips aliases on every attempt
async function deleteDomainWithRetry(google, keyData, adminEmail, domainName, admin = null, retries = 10, delayMs = 8000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        await new Promise(r => setTimeout(r, delayMs));
        // Re-fetch users and strip any remaining aliases before each deletion attempt
        if (admin) {
            try {
                let freshUsers = [], fp = null;
                do {
                    const r = await admin.users.list({ customer: 'my_customer', maxResults: 500, pageToken: fp, projection: 'full' });
                    freshUsers = freshUsers.concat(r.data.users || []);
                    fp = r.data.nextPageToken;
                } while (fp);
                const { removed } = await removeAliasesOnDomain(admin, freshUsers, domainName);
                if (removed.length > 0)
                    console.log(`[DomainDelete] Attempt ${attempt}: cleared ${removed.length} alias(es) on @${domainName}`);
            } catch (e) {
                console.warn(`[DomainDelete] Alias cleanup attempt ${attempt} failed: ${e.message}`);
            }
        }
        try {
            const domainAuth = new google.auth.JWT({
                email: keyData.client_email,
                key: keyData.private_key,
                scopes: ['https://www.googleapis.com/auth/admin.directory.domain'],
                subject: adminEmail
            });
            const adminDomain = google.admin({ version: 'directory_v1', auth: domainAuth });
            await adminDomain.domains.delete({ customer: 'my_customer', domainName });
            return { deleted: true, error: null };
        } catch (e) {
            console.warn(`[DomainDelete] Attempt ${attempt}/${retries} for ${domainName}: ${e.message}`);
            if (attempt === retries) return { deleted: false, error: e.message };
        }
    }
}

// Shared core: migrate users from sourceDomain → targetDomain then delete sourceDomain.
// Creates its own fresh JWT + admin client so the code path is identical for individual and bulk.
async function migrateAndDeleteCore(google, keyData, adminEmail, sourceDomain, targetDomain) {
    const auth = new google.auth.JWT({
        email: keyData.client_email,
        key: keyData.private_key,
        scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
        subject: adminEmail
    });
    const admin = google.admin({ version: 'directory_v1', auth });

    // Fetch all users with full projection (needed for aliases field)
    let allUsers = [], pageToken = null;
    do {
        const r = await admin.users.list({ customer: 'my_customer', maxResults: 500, pageToken, projection: 'full' });
        allUsers = allUsers.concat(r.data.users || []);
        pageToken = r.data.nextPageToken;
    } while (pageToken);

    const toMigrate = allUsers.filter(u =>
        u.primaryEmail.endsWith('@' + sourceDomain) &&
        u.primaryEmail !== adminEmail &&
        !u.isAdmin
    );
    console.log(`[MigrateCore] ${sourceDomain} → ${targetDomain}: ${toMigrate.length} users to migrate`);

    const migrationErrors = [];
    const movedUsers = [];
    for (const user of toMigrate) {
        const newEmail = `${user.primaryEmail.split('@')[0]}@${targetDomain}`;
        try {
            await admin.users.update({ userKey: user.primaryEmail, requestBody: { primaryEmail: newEmail } });
            movedUsers.push({ from: user.primaryEmail, to: newEmail });
        } catch (e) {
            migrationErrors.push({ user: user.primaryEmail, error: e.message });
            console.error(`[MigrateCore] Failed: ${user.primaryEmail} → ${newEmail}: ${e.message}`);
        }
    }

    let domainDeleted = false, domainError = null;
    if (migrationErrors.length > 0) {
        domainError = `${migrationErrors.length} user(s) failed to migrate — domain not deleted`;
    } else {
        // deleteDomainWithRetry re-fetches users and strips aliases on every attempt
        const result = await deleteDomainWithRetry(google, keyData, adminEmail, sourceDomain, admin);
        domainDeleted = result.deleted;
        domainError = result.error;
        if (domainDeleted) console.log(`[MigrateCore] ✅ ${sourceDomain} deleted`);
        else console.warn(`[MigrateCore] ❌ ${sourceDomain} delete failed: ${domainError}`);
    }

    return { movedCount: movedUsers.length, total: toMigrate.length, domainDeleted, domainError, errors: migrationErrors };
}


// Migrate all users from sourceDomain to targetDomain, then delete sourceDomain
app.post('/api/manage/migrate-and-delete-domain', async (req, res) => {
    try {
        const { adminEmail, sourceDomain, targetDomain: providedTarget } = req.body;
        if (!adminEmail || !sourceDomain)
            return res.status(400).json({ error: 'adminEmail and sourceDomain required' });

        const { google } = await import('googleapis');
        const keyData = await getKeyData(adminEmail);

        // Resolve target: use provided, or auto-detect primary domain
        let targetDomain = providedTarget;
        if (!targetDomain) {
            try {
                const domainAuth = new google.auth.JWT({
                    email: keyData.client_email, key: keyData.private_key,
                    scopes: ['https://www.googleapis.com/auth/admin.directory.domain.readonly'],
                    subject: adminEmail
                });
                const domainAdmin = google.admin({ version: 'directory_v1', auth: domainAuth });
                const dr = await domainAdmin.domains.list({ customer: 'my_customer' });
                const primary = (dr.data.domains || []).find(d => d.isPrimary);
                targetDomain = primary ? primary.domainName : adminEmail.split('@')[1];
            } catch {
                targetDomain = adminEmail.split('@')[1];
            }
        }

        if (sourceDomain === targetDomain)
            return res.status(400).json({ error: 'sourceDomain and targetDomain must be different' });

        const result = await migrateAndDeleteCore(google, keyData, adminEmail, sourceDomain, targetDomain);

        res.json({ success: true, sourceDomain, targetDomain, ...result });
    } catch (e) {
        console.error(`[MigrateDomain] ❌ ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Delete all users whose primaryEmail is on domainName (clears the domain of all non-admin users)
app.post('/api/manage/delete-domain-aliases', async (req, res) => {
    try {
        const { adminEmail, domainName } = req.body;
        if (!adminEmail || !domainName) return res.status(400).json({ error: 'adminEmail, domainName required' });

        const { google } = await import('googleapis');
        const keyData = await getKeyData(adminEmail);
        const auth = new google.auth.JWT({
            email: keyData.client_email,
            key: keyData.private_key,
            scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
            subject: adminEmail
        });
        const admin = google.admin({ version: 'directory_v1', auth });

        // List ALL users and filter by domain in code (domain param unreliable for subdomains)
        let allUsers = [], pageToken = null;
        do {
            const r = await admin.users.list({ customer: 'my_customer', maxResults: 500, pageToken });
            allUsers = allUsers.concat(r.data.users || []);
            pageToken = r.data.nextPageToken;
        } while (pageToken);

        const toDelete = allUsers.filter(u =>
            u.primaryEmail.endsWith('@' + domainName) &&
            u.primaryEmail !== adminEmail &&
            !u.isAdmin
        );

        console.log(`[DeleteDomainUsers] Found ${toDelete.length} users on @${domainName}`);
        let deletedCount = 0;
        const errors = [];

        for (const user of toDelete) {
            try {
                await admin.users.delete({ userKey: user.primaryEmail });
                deletedCount++;
                console.log(`[DeleteDomainUsers] Deleted ${user.primaryEmail}`);
            } catch (e) {
                errors.push({ user: user.primaryEmail, error: e.message });
            }
        }

        res.json({ success: true, deletedCount, total: toDelete.length, errors });
    } catch (e) {
        console.error(`[DeleteDomainUsers] ❌ ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Bulk add domains across multiple admin accounts (batches of 5 concurrent)
app.post('/api/manage/bulk-add-domains-multi', async (req, res) => {
    try {
        const { pairs } = req.body;
        if (!Array.isArray(pairs) || pairs.length === 0)
            return res.status(400).json({ error: 'pairs array required' });

        const { google } = await import('googleapis');
        const results = [];
        const BATCH = 5;

        for (let i = 0; i < pairs.length; i += BATCH) {
            const batch = pairs.slice(i, i + BATCH);
            const batchResults = await Promise.allSettled(batch.map(async ({ adminEmail, domainName }) => {
                try {
                    const keyData = await getKeyData(adminEmail);
                    const auth = new google.auth.JWT({
                        email: keyData.client_email,
                        key: keyData.private_key,
                        scopes: ['https://www.googleapis.com/auth/admin.directory.domain'],
                        subject: adminEmail
                    });
                    const admin = google.admin({ version: 'directory_v1', auth });
                    await admin.domains.insert({
                        customer: 'my_customer',
                        requestBody: { domainName }
                    });
                    return { adminEmail, domainName, status: 'added' };
                } catch (e) {
                    return { adminEmail, domainName, status: 'error', error: e.message };
                }
            }));

            for (const r of batchResults) {
                results.push(r.status === 'fulfilled' ? r.value : { adminEmail: batch[batchResults.indexOf(r)]?.adminEmail, domainName: batch[batchResults.indexOf(r)]?.domainName, status: 'error', error: r.reason?.message || 'Unknown error' });
            }
            console.log(`[BulkAddDomains] ${Math.min(i + BATCH, pairs.length)}/${pairs.length} done`);
        }

        res.json({ results });
    } catch (e) {
        console.error(`[BulkAddDomains] ❌ ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Bulk migrate & delete domains across multiple admin accounts (sequential to avoid rate limits)
app.post('/api/manage/bulk-migrate-domains', async (req, res) => {
    try {
        const { triples } = req.body;
        if (!Array.isArray(triples) || triples.length === 0)
            return res.status(400).json({ error: 'triples array required' });

        const { google } = await import('googleapis');
        const results = [];

        for (let i = 0; i < triples.length; i++) {
            const { adminEmail, sourceDomain, targetDomain } = triples[i];
            console.log(`[BulkMigrateDomains] ${i + 1}/${triples.length}: ${sourceDomain} → ${targetDomain} (${adminEmail})`);
            try {
                const keyData = await getKeyData(adminEmail);
                const r = await migrateAndDeleteCore(google, keyData, adminEmail, sourceDomain, targetDomain);
                results.push({ adminEmail, sourceDomain, targetDomain, ...r });
            } catch (e) {
                console.error(`[BulkMigrateDomains] Error on ${sourceDomain}: ${e.message}`);
                results.push({ adminEmail, sourceDomain, targetDomain, movedCount: 0, total: 0, domainDeleted: false, error: e.message });
            }
        }

        console.log(`[BulkMigrateDomains] All ${triples.length} operations complete`);
        res.json({ results });
    } catch (e) {
        console.error(`[BulkMigrateDomains] ❌ ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Smart bulk auto-migrate: given account + optional sourceDomain, auto-detects non-primary domains,
// migrates all users to the primary domain, and deletes each non-primary domain.
app.post('/api/manage/bulk-auto-migrate', async (req, res) => {
    try {
        const { entries } = req.body; // [{adminEmail, sourceDomain?}]
        if (!Array.isArray(entries) || entries.length === 0)
            return res.status(400).json({ error: 'entries array required' });

        const { google } = await import('googleapis');
        const results = [];

        for (let i = 0; i < entries.length; i++) {
            const { adminEmail, sourceDomain } = entries[i];
            if (!adminEmail) { results.push({ adminEmail, error: 'adminEmail required' }); continue; }
            console.log(`[AutoMigrate] ${i + 1}/${entries.length}: ${adminEmail}${sourceDomain ? ' → ' + sourceDomain : ' (auto-detect)'}`);
            try {
                const keyData = await getKeyData(adminEmail);

                // Resolve the actual primary domain
                let primaryDomainName = adminEmail.split('@')[1];
                try {
                    const domainReadAuth = new google.auth.JWT({
                        email: keyData.client_email,
                        key: keyData.private_key,
                        scopes: ['https://www.googleapis.com/auth/admin.directory.domain.readonly'],
                        subject: adminEmail
                    });
                    const adminDomainRead = google.admin({ version: 'directory_v1', auth: domainReadAuth });
                    const domainsRes = await adminDomainRead.domains.list({ customer: 'my_customer' });
                    const primaryDomain = (domainsRes.data.domains || []).find(d => d.isPrimary);
                    if (primaryDomain) primaryDomainName = primaryDomain.domainName;
                } catch (e) {
                    console.warn(`[AutoMigrate] Cannot read domains for ${adminEmail}: ${e.message}`);
                }

                // List users to find which non-primary domains exist
                const authTmp = new google.auth.JWT({
                    email: keyData.client_email, key: keyData.private_key,
                    scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
                    subject: adminEmail
                });
                const adminTmp = google.admin({ version: 'directory_v1', auth: authTmp });
                let allUsers = [], allUsersPage = null;
                do {
                    const r = await adminTmp.users.list({ customer: 'my_customer', maxResults: 500, pageToken: allUsersPage });
                    allUsers = allUsers.concat(r.data.users || []);
                    allUsersPage = r.data.nextPageToken;
                } while (allUsersPage);

                const uniqueDomains = [...new Set(allUsers.map(u => u.primaryEmail.split('@')[1]))];

                const domainsToProcess = sourceDomain
                    ? (sourceDomain !== primaryDomainName ? [sourceDomain] : [])
                    : uniqueDomains.filter(d => d !== primaryDomainName);

                if (domainsToProcess.length === 0) {
                    results.push({ adminEmail, primaryDomain: primaryDomainName, domains: [], note: sourceDomain ? 'Source domain not found or is primary' : 'No non-primary domains found' });
                    continue;
                }

                // Use migrateAndDeleteCore for each domain — same code path as individual
                const domainResults = [];
                for (const domainName of domainsToProcess) {
                    const r = await migrateAndDeleteCore(google, keyData, adminEmail, domainName, primaryDomainName);
                    domainResults.push({ domain: domainName, ...r });
                }

                results.push({ adminEmail, primaryDomain: primaryDomainName, domains: domainResults });
            } catch (e) {
                console.error(`[AutoMigrate] Error on ${adminEmail}: ${e.message}`);
                results.push({ adminEmail, error: e.message });
            }
        }

        res.json({ results });
    } catch (e) {
        console.error(`[AutoMigrate] ❌ ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Migrate users only (no domain deletion): move primaryEmail from source → target domain
app.post('/api/manage/migrate-users-only', async (req, res) => {
    try {
        const { adminEmail, targetDomain, sourceDomain } = req.body;
        if (!adminEmail) return res.status(400).json({ error: 'adminEmail required' });

        const { google } = await import('googleapis');
        const keyData = await getKeyData(adminEmail);
        // Use only user scope — no domain scope needed, avoids JWT rejection if domain DWD not authorized
        const auth = new google.auth.JWT({
            email: keyData.client_email,
            key: keyData.private_key,
            scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
            subject: adminEmail
        });
        const admin = google.admin({ version: 'directory_v1', auth });

        // Resolve target: provided → next available non-primary non-source → primary → admin email domain
        let resolvedTarget = targetDomain;
        let primaryDomainName = adminEmail.split('@')[1];
        if (!resolvedTarget) {
            try {
                const domainReadAuth = new google.auth.JWT({
                    email: keyData.client_email,
                    key: keyData.private_key,
                    scopes: ['https://www.googleapis.com/auth/admin.directory.domain.readonly'],
                    subject: adminEmail
                });
                const adminDomainRead = google.admin({ version: 'directory_v1', auth: domainReadAuth });
                const domainsRes = await adminDomainRead.domains.list({ customer: 'my_customer' });
                const allDomains = domainsRes.data.domains || [];
                const primary = allDomains.find(d => d.isPrimary);
                if (primary) primaryDomainName = primary.domainName;
                // Next available: verified, not primary, not the source domain
                const next = allDomains.find(d => d.verified && !d.isPrimary && d.domainName !== sourceDomain);
                resolvedTarget = next ? next.domainName : primaryDomainName;
            } catch (e) {
                console.warn(`[MigrateUsersOnly] Cannot read domains: ${e.message}`);
                resolvedTarget = primaryDomainName;
            }
        }

        // List ALL users once and filter in code — domain param unreliable for subdomains
        let allWorkspaceUsers = [], pageToken2 = null;
        do {
            const r = await admin.users.list({ customer: 'my_customer', maxResults: 500, pageToken: pageToken2 });
            allWorkspaceUsers = allWorkspaceUsers.concat(r.data.users || []);
            pageToken2 = r.data.nextPageToken;
        } while (pageToken2);

        // Resolve which domains to process
        let domainsToProcess;
        if (sourceDomain) {
            domainsToProcess = sourceDomain !== resolvedTarget ? [sourceDomain] : [];
        } else {
            const uniqueDomains = [...new Set(allWorkspaceUsers.map(u => u.primaryEmail.split('@')[1]))];
            domainsToProcess = uniqueDomains.filter(d => d !== resolvedTarget);
        }

        const domainResults = [];
        for (const domainName of domainsToProcess) {
            const toMigrate = allWorkspaceUsers.filter(u =>
                u.primaryEmail.endsWith('@' + domainName) &&
                u.primaryEmail !== adminEmail &&
                !u.isAdmin
            );
            let movedCount = 0;
            const errors = [];

            for (const user of toMigrate) {
                const username = user.primaryEmail.split('@')[0];
                try {
                    await admin.users.update({
                        userKey: user.primaryEmail,
                        requestBody: { primaryEmail: `${username}@${resolvedTarget}` }
                    });
                    movedCount++;
                } catch (e) {
                    errors.push({ user: user.primaryEmail, error: e.message });
                }
            }

            console.log(`[MigrateUsersOnly] ${domainName} → ${resolvedTarget}: moved ${movedCount}/${toMigrate.length}`);
            domainResults.push({ domain: domainName, movedCount, total: toMigrate.length, errors });
        }

        res.json({ success: true, adminEmail, targetDomain: resolvedTarget, domains: domainResults });
    } catch (e) {
        console.error(`[MigrateUsersOnly] ❌ ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Bulk migrate users only (no domain deletion)
app.post('/api/manage/bulk-migrate-users-only', async (req, res) => {
    try {
        const { entries } = req.body; // [{adminEmail, targetDomain?}]
        if (!Array.isArray(entries) || entries.length === 0)
            return res.status(400).json({ error: 'entries array required' });

        const { google } = await import('googleapis');
        const results = [];

        for (let i = 0; i < entries.length; i++) {
            const { adminEmail, targetDomain } = entries[i];
            if (!adminEmail) { results.push({ adminEmail, error: 'adminEmail required' }); continue; }
            console.log(`[BulkMigrateUsersOnly] ${i + 1}/${entries.length}: ${adminEmail}${targetDomain ? ' → ' + targetDomain : ' (auto-detect)'}`);
            try {
                const keyData = await getKeyData(adminEmail);
                // User scope only — no domain scope to avoid JWT rejection if domain DWD not set up
                const auth = new google.auth.JWT({
                    email: keyData.client_email,
                    key: keyData.private_key,
                    scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
                    subject: adminEmail
                });
                const admin = google.admin({ version: 'directory_v1', auth });

                // Resolve target: provided → next available non-primary → primary → admin email domain
                let resolvedTarget = targetDomain;
                let primaryNameBulk = adminEmail.split('@')[1];
                if (!resolvedTarget) {
                    try {
                        const domainReadAuth = new google.auth.JWT({
                            email: keyData.client_email,
                            key: keyData.private_key,
                            scopes: ['https://www.googleapis.com/auth/admin.directory.domain.readonly'],
                            subject: adminEmail
                        });
                        const adminDomainRead = google.admin({ version: 'directory_v1', auth: domainReadAuth });
                        const domainsRes = await adminDomainRead.domains.list({ customer: 'my_customer' });
                        const allDoms = domainsRes.data.domains || [];
                        const primary = allDoms.find(d => d.isPrimary);
                        if (primary) primaryNameBulk = primary.domainName;
                        // Next available: verified, not primary — source is per-domain so we use primary as first fallback
                        const next = allDoms.find(d => d.verified && !d.isPrimary);
                        resolvedTarget = next ? next.domainName : primaryNameBulk;
                    } catch (e) {
                        console.warn(`[BulkMigrateUsersOnly] Cannot read domains for ${adminEmail}: ${e.message}`);
                        resolvedTarget = primaryNameBulk;
                    }
                }

                // List ALL users once and filter in code
                let allWorkspaceUsers = [], pageTokenBulk = null;
                do {
                    const r = await admin.users.list({ customer: 'my_customer', maxResults: 500, pageToken: pageTokenBulk });
                    allWorkspaceUsers = allWorkspaceUsers.concat(r.data.users || []);
                    pageTokenBulk = r.data.nextPageToken;
                } while (pageTokenBulk);

                const uniqueDomains = [...new Set(allWorkspaceUsers.map(u => u.primaryEmail.split('@')[1]))];
                const domainsToProcess = uniqueDomains.filter(d => d !== resolvedTarget);

                if (domainsToProcess.length === 0) {
                    results.push({ adminEmail, targetDomain: resolvedTarget, domains: [], note: 'No non-target domains to migrate' });
                    continue;
                }

                const domainResults = [];
                for (const domainName of domainsToProcess) {
                    const toMigrate = allWorkspaceUsers.filter(u =>
                        u.primaryEmail.endsWith('@' + domainName) &&
                        u.primaryEmail !== adminEmail &&
                        !u.isAdmin
                    );
                    let movedCount = 0;
                    const errors = [];

                    for (const user of toMigrate) {
                        const username = user.primaryEmail.split('@')[0];
                        try {
                            await admin.users.update({
                                userKey: user.primaryEmail,
                                requestBody: { primaryEmail: `${username}@${resolvedTarget}` }
                            });
                            movedCount++;
                        } catch (e) {
                            errors.push({ user: user.primaryEmail, error: e.message });
                        }
                    }

                    console.log(`[BulkMigrateUsersOnly] ${domainName} → ${resolvedTarget}: moved ${movedCount}/${toMigrate.length}`);
                    domainResults.push({ domain: domainName, movedCount, total: toMigrate.length, errors });
                }

                results.push({ adminEmail, targetDomain: resolvedTarget, domains: domainResults });
            } catch (e) {
                console.error(`[BulkMigrateUsersOnly] Error on ${adminEmail}: ${e.message}`);
                results.push({ adminEmail, error: e.message });
            }
        }

        res.json({ results });
    } catch (e) {
        console.error(`[BulkMigrateUsersOnly] ❌ ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Bulk Change Users Domain (skips admin)
app.post('/api/manage/bulk-change-users-domain', async (req, res) => {
    try {
        const { entries } = req.body; // [{adminEmail, targetDomain}]
        if (!Array.isArray(entries) || entries.length === 0)
            return res.status(400).json({ error: 'entries array required' });

        const { google } = await import('googleapis');
        const results = [];

        for (let i = 0; i < entries.length; i++) {
            const { adminEmail, targetDomain } = entries[i];
            if (!adminEmail || !targetDomain) { 
                results.push({ adminEmail, error: 'adminEmail and targetDomain required' }); 
                continue; 
            }
            console.log(`[BulkChangeUsersDomain] ${i + 1}/${entries.length}: ${adminEmail} → Move users to ${targetDomain}`);
            
            try {
                const keyData = await getKeyData(adminEmail);
                const auth = new google.auth.JWT({
                    email: keyData.client_email,
                    key: keyData.private_key,
                    scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
                    subject: adminEmail
                });
                const admin = google.admin({ version: 'directory_v1', auth });

                let allWorkspaceUsers = [], pageTokenBulk = null;
                do {
                    const r = await admin.users.list({ customer: 'my_customer', maxResults: 500, pageToken: pageTokenBulk });
                    allWorkspaceUsers = allWorkspaceUsers.concat(r.data.users || []);
                    pageTokenBulk = r.data.nextPageToken;
                } while (pageTokenBulk);

                // Filter out the admin themselves
                const toMigrate = allWorkspaceUsers.filter(u => u.primaryEmail !== adminEmail);
                
                let movedCount = 0;
                const errors = [];

                for (const user of toMigrate) {
                    const username = user.primaryEmail.split('@')[0];
                    const currentDomain = user.primaryEmail.split('@')[1];
                    if (currentDomain === targetDomain) {
                        continue; // Already on target domain
                    }
                    try {
                        await admin.users.update({
                            userKey: user.primaryEmail,
                            requestBody: { primaryEmail: `${username}@${targetDomain}` }
                        });
                        movedCount++;
                    } catch (e) {
                        errors.push({ user: user.primaryEmail, error: e.message });
                    }
                }

                console.log(`[BulkChangeUsersDomain] Moved ${movedCount}/${toMigrate.length} users to ${targetDomain}`);
                results.push({ adminEmail, targetDomain, movedCount, total: toMigrate.length, errors });
            } catch (e) {
                console.error(`[BulkChangeUsersDomain] Error on ${adminEmail}: ${e.message}`);
                results.push({ adminEmail, error: e.message });
            }
        }

        res.json({ results });
    } catch (e) {
        console.error(`[BulkChangeUsersDomain] ❌ ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/manage/bulk-change-specific-users-domain', async (req, res) => {
    try {
        const { entries } = req.body; // [{adminEmail, userEmail, targetDomain}]
        if (!Array.isArray(entries) || entries.length === 0)
            return res.status(400).json({ error: 'entries array required' });

        const { google } = await import('googleapis');
        const results = [];

        // Group by adminEmail to avoid multiple authentications
        const grouped = {};
        for (const entry of entries) {
            if (!entry.userEmail || !entry.targetDomain) continue;
            let admin = entry.adminEmail;
            if (!admin) {
                const domain = entry.userEmail.split('@')[1];
                admin = `admin@${domain}`;
            }
            if (!grouped[admin]) grouped[admin] = [];
            grouped[admin].push({ userEmail: entry.userEmail, targetDomain: entry.targetDomain });
        }

        for (const [adminEmail, users] of Object.entries(grouped)) {
            console.log(`[BulkChangeSpecificUsers] Auth as ${adminEmail} for ${users.length} users...`);
            try {
                const keyData = await getKeyData(adminEmail);
                const auth = new google.auth.JWT({
                    email: keyData.client_email,
                    key: keyData.private_key,
                    scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
                    subject: adminEmail
                });
                const admin = google.admin({ version: 'directory_v1', auth });

                let movedCount = 0;
                const errors = [];

                for (const { userEmail, targetDomain } of users) {
                    const username = userEmail.split('@')[0];
                    const currentDomain = userEmail.split('@')[1];
                    if (currentDomain === targetDomain) {
                        continue;
                    }
                    try {
                        await admin.users.update({
                            userKey: userEmail,
                            requestBody: { primaryEmail: `${username}@${targetDomain}` }
                        });
                        movedCount++;
                    } catch (e) {
                        errors.push({ user: userEmail, error: e.message });
                    }
                }

                results.push({ adminEmail, usersProcessed: users.length, movedCount, errors });
            } catch (e) {
                console.error(`[BulkChangeSpecificUsers] Error on ${adminEmail}: ${e.message}`);
                results.push({ adminEmail, error: e.message });
            }
        }

        res.json({ results });
    } catch (e) {
        console.error(`[BulkChangeSpecificUsers] ❌ ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Edit user in workspace
app.post('/api/manage/edit-user', async (req, res) => {
    try {
        const { adminEmail, oldEmail, newEmail, firstName, lastName } = req.body;
        if (!adminEmail || !oldEmail || !newEmail) return res.status(400).json({ error: 'Missing required fields' });

        const { google } = await import('googleapis');
        const keyData = await getKeyData(adminEmail);
        const auth = new google.auth.JWT({
            email: keyData.client_email,
            key: keyData.private_key,
            scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
            subject: adminEmail
        });
        const admin = google.admin({ version: 'directory_v1', auth });

        await admin.users.update({
            userKey: oldEmail,
            requestBody: {
                primaryEmail: newEmail,
                name: {
                    givenName: firstName || newEmail.split('@')[0],
                    familyName: lastName || 'User'
                }
            }
        });

        res.json({ success: true, newEmail });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete a user from workspace
app.delete('/api/manage/user', async (req, res) => {
    try {
        const { adminEmail, userEmail } = req.body;
        if (!adminEmail || !userEmail) return res.status(400).json({ error: 'adminEmail, userEmail required' });

        const { google } = await import('googleapis');
        const keyData = await getKeyData(adminEmail);
        const auth = new google.auth.JWT({
            email: keyData.client_email,
            key: keyData.private_key,
            scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
            subject: adminEmail
        });

        const admin = google.admin({ version: 'directory_v1', auth });
        await admin.users.delete({ userKey: userEmail });

        console.log(`[Manage] 🗑️ Deleted user: ${userEmail} by ${adminEmail}`);
        res.json({ success: true, deleted: userEmail });
    } catch (e) {
        console.error(`[Manage] ❌ Delete user error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Delete all suspended users in a workspace
app.delete('/api/manage/users/suspended', async (req, res) => {
    try {
        const { adminEmail } = req.body;
        if (!adminEmail) return res.status(400).json({ error: 'adminEmail required' });

        const { google } = await import('googleapis');
        const keyData = await getKeyData(adminEmail);
        const auth = new google.auth.JWT({
            email: keyData.client_email,
            key: keyData.private_key,
            scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
            subject: adminEmail
        });

        const admin = google.admin({ version: 'directory_v1', auth });

        // Fetch all users
        const usersRes = await admin.users.list({ customer: 'my_customer', maxResults: 500 });
        const users = usersRes.data.users || [];

        const suspendedUsers = users.filter(u => u.suspended && !u.isAdmin);
        const results = { success: 0, failed: 0, errors: [] };

        for (const user of suspendedUsers) {
            try {
                await admin.users.delete({ userKey: user.primaryEmail });
                console.log(`[Manage] 🗑️ Deleted suspended user: ${user.primaryEmail}`);
                results.success++;
            } catch (err) {
                console.error(`[Manage] ❌ Failed to delete suspended ${user.primaryEmail}: ${err.message}`);
                results.failed++;
                results.errors.push({ email: user.primaryEmail, error: err.message });
            }
        }

        res.json({ success: true, deletedCount: results.success, failedCount: results.failed, errors: results.errors });
    } catch (e) {
        console.error(`[Manage] ❌ Delete suspended users error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Get OTP for a specific email
app.post('/api/get-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'email required' });

        const { getOTPForAccount } = await import('./generateOTP.cjs');
        const otp = await getOTPForAccount(email);
        res.json({ success: true, otp });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ====== Bulk Random User Creation ======
const FIRST_NAMES = ['James','John','Robert','Michael','William','David','Richard','Joseph','Thomas','Charles','Christopher','Daniel','Matthew','Anthony','Donald','Mark','Paul','Steven','Andrew','Kenneth','Joshua','Kevin','Brian','George','Timothy','Ronald','Edward','Jason','Jeffrey','Ryan','Jacob','Gary','Nicholas','Eric','Jonathan','Stephen','Larry','Justin','Scott','Brandon','Benjamin','Samuel','Raymond','Gregory','Frank','Alexander','Patrick','Raymond','Jack','Dennis','Jerry','Tyler','Aaron','Jose','Adam','Henry','Nathan','Zachary','Douglas','Peter','Kyle','Noah','Ethan','Jeremy','Christian','Walter','Keith','Austin','Roger','Terry','Sean','Gerald','Carl','Dylan','Harold','Jordan','Jesse','Bryan','Lawrence','Arthur','Gabriel','Bruce','Logan','Billy','Joe','Alan','Juan','Elijah','Willie','Albert','Wayne','Randy','Mason','Vincent','Liam','Roy','Bobby','Caleb','Bradley'];
const LAST_NAMES = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores','Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts','Phillips','Evans','Turner','Torres','Parker','Collins','Edwards','Stewart','Flores','Morris','Nguyen','Murphy','Rivera','Cook','Rogers','Morgan','Peterson','Cooper','Reed','Bailey','Bell','Gomez','Kelly','Howard','Ward','Cox','Diaz','Richardson','Wood','Watson','Brooks','Bennett','Gray','James','Reyes','Cruz','Hughes','Price','Myers','Long','Foster','Sanders','Ross','Morales','Powell','Sullivan','Russell','Ortiz','Jenkins','Gutierrez','Perry'];

app.post('/api/manage/create-users-random', async (req, res) => {
    try {
        const { adminEmail, adminPassword, count } = req.body;
        if (!adminEmail || !count || count < 1) return res.status(400).json({ error: 'adminEmail and count required' });

        const { google } = await import('googleapis');
        const domain = adminEmail.split('@')[1];
        const keyData = await getKeyData(adminEmail);

        const auth = new google.auth.JWT({
            email: keyData.client_email,
            key: keyData.private_key,
            scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
            subject: adminEmail
        });
        const admin = google.admin({ version: 'directory_v1', auth });

        const created = [];
        const failed = [];
        const usedUsernames = new Set();

        for (let i = 0; i < count; i++) {
            const fn = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
            const ln = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
            let base = `${fn.toLowerCase()}.${ln.toLowerCase()}`;
            let username = base;
            let attempt = 0;
            while (usedUsernames.has(username)) {
                attempt++;
                username = `${base}${Math.floor(Math.random() * 90) + 10}`;
                if (attempt > 20) { username = `${base}${Date.now() % 9999}`; break; }
            }
            usedUsernames.add(username);
            const primaryEmail = `${username}@${domain}`;
            const password = adminPassword || 'ChangeMe@2025!';

            try {
                await admin.users.insert({
                    requestBody: {
                        primaryEmail,
                        name: { givenName: fn, familyName: ln },
                        password,
                        changePasswordAtNextLogin: false,
                        suspended: false
                    }
                });
                created.push({ email: primaryEmail, password, firstName: fn, lastName: ln });
                // Save to created_users.txt
                try { fs.appendFileSync(path.join(__dirname, 'created_users.txt'), `${primaryEmail}:${password}\n`); } catch {}
                console.log(`[BulkCreate] ✅ ${primaryEmail}`);
            } catch (err) {
                failed.push({ email: primaryEmail, error: err.message });
                console.error(`[BulkCreate] ❌ ${primaryEmail}: ${err.message}`);
            }
        }

        res.json({ success: true, adminEmail, created, failed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ====== List Workspace Users (active + suspended) ======
app.post('/api/manage/list-workspace-users', async (req, res) => {
    try {
        const { emails } = req.body;
        if (!Array.isArray(emails) || emails.length === 0) return res.status(400).json({ error: 'emails array required' });

        const { google } = await import('googleapis');

        const fetchUsers = async (adminEmail) => {
            try {
                const keyData = await getKeyData(adminEmail);
                const auth = new google.auth.JWT({
                    email: keyData.client_email,
                    key: keyData.private_key,
                    scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
                    subject: adminEmail
                });
                const admin = google.admin({ version: 'directory_v1', auth });
                const allUsers = [];
                let pageToken;
                do {
                    const r = await admin.users.list({ customer: 'my_customer', maxResults: 500, pageToken });
                    allUsers.push(...(r.data.users || []));
                    pageToken = r.data.nextPageToken;
                } while (pageToken);

                const nonAdmins = allUsers.filter(u => !u.isAdmin);
                const active = nonAdmins.filter(u => !u.suspended).map(u => u.primaryEmail);
                const suspended = nonAdmins.filter(u => u.suspended).map(u => u.primaryEmail);
                return { adminEmail, active, suspended, error: null };
            } catch (e) {
                return { adminEmail, active: [], suspended: [], error: e.message };
            }
        };

        // Process in batches of 5 concurrently
        const results = [];
        for (let i = 0; i < emails.length; i += 5) {
            const batch = emails.slice(i, i + 5);
            const batchResults = await Promise.all(batch.map(fetchUsers));
            results.push(...batchResults);
        }

        res.json({ success: true, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ====== Bulk User Count ======
app.post('/api/manage/bulk-user-counts', async (req, res) => {
    try {
        const { emails } = req.body; // array of admin email strings
        if (!Array.isArray(emails) || emails.length === 0) return res.status(400).json({ error: 'emails array required' });

        const { google } = await import('googleapis');

        const fetchCount = async (adminEmail) => {
            try {
                const keyData = await getKeyData(adminEmail);
                const auth = new google.auth.JWT({
                    email: keyData.client_email,
                    key: keyData.private_key,
                    scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
                    subject: adminEmail
                });
                const admin = google.admin({ version: 'directory_v1', auth });
                let count = 0;
                let pageToken;
                do {
                    const r = await admin.users.list({ customer: 'my_customer', maxResults: 500, pageToken });
                    const users = r.data.users || [];
                    count += users.filter(u => !u.isAdmin).length;
                    pageToken = r.data.nextPageToken;
                } while (pageToken);
                return { email: adminEmail, count };
            } catch (e) {
                return { email: adminEmail, count: null, error: e.message };
            }
        };

        // Process in batches of 8 concurrently
        const results = [];
        for (let i = 0; i < emails.length; i += 8) {
            const batch = emails.slice(i, i + 8);
            const batchResults = await Promise.all(batch.map(fetchCount));
            results.push(...batchResults);
        }

        res.json({ success: true, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ====== Age 18+ Access Setting ======
app.post('/api/manage/set-age-18plus', async (req, res) => {
    try {
        const { adminEmail, adminPassword } = req.body;
        if (!adminEmail || !adminPassword) return res.status(400).json({ error: 'adminEmail and adminPassword required' });
        const { setAge18Plus } = await import('./setAge18Plus.cjs');
        const result = await setAge18Plus(adminEmail, adminPassword, true);
        res.json(result);
    } catch (e) {
        console.error(`[Age18+] ❌ ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ====== S3 JSON Management ======
app.post('/api/s3/search', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'email required' });

        const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({
            region: process.env.AWS_REGION || 'eu-west-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
            }
        });
        const bucket = process.env.AWS_BUCKET_NAME || 'json-files-gw';
        const s3Key = `workspace-keys/${email}.json`;

        try {
            await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));
            res.json({ exists: true, key: s3Key });
        } catch (err) {
            if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
                res.json({ exists: false });
            } else {
                throw err;
            }
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/s3/download', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'email required' });

        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({
            region: process.env.AWS_REGION || 'eu-west-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
            }
        });
        const bucket = process.env.AWS_BUCKET_NAME || 'json-files-gw';
        const s3Key = `workspace-keys/${email}.json`;

        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
        const chunks = [];
        for await (const chunk of response.Body) chunks.push(Buffer.from(chunk));
        const content = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.json({ success: true, content });
    } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
            return res.status(404).json({ error: 'Key not found in S3' });
        }
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/s3/upload', async (req, res) => {
    try {
        const { email, jsonContent } = req.body;
        if (!email || !jsonContent) return res.status(400).json({ error: 'email and jsonContent required' });

        let parsed;
        try {
            parsed = JSON.parse(jsonContent);
            if (!parsed.client_email || !parsed.private_key) throw new Error('Invalid JSON format');
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON format or missing client_email/private_key' }); // Custom message format
        }

        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({
            region: process.env.AWS_REGION || 'eu-west-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
            }
        });
        const bucket = process.env.AWS_BUCKET_NAME || 'json-files-gw';
        const s3Key = `workspace-keys/${email}.json`;

        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: s3Key,
            Body: jsonContent,
            ContentType: 'application/json',
            ACL: 'public-read'
        }));

        // Remove local cache if exists so the new key is pulled from S3 next time
        const tmpDir = path.join(__dirname, 'tmp', 'manage-keys');
        const localPath = path.join(tmpDir, `${email.replace('@', '_at_').replace(/\./g, '_')}.json`);
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

        console.log(`[Upload] ✅ Uploaded JSON for ${email} to S3 (${s3Key})`);
        res.json({ success: true, key: s3Key });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/s3/delete', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'email required' });

        const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({
            region: process.env.AWS_REGION || 'eu-west-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
            }
        });
        const bucket = process.env.AWS_BUCKET_NAME || 'json-files-gw';
        const s3Key = `workspace-keys/${email}.json`;

        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key }));

        // Remove local cache if exists
        const tmpDir = path.join(__dirname, 'tmp', 'manage-keys');
        const localPath = path.join(tmpDir, `${email.replace('@', '_at_').replace(/\./g, '_')}.json`);
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

        console.log(`[Manage] 🗑️ Deleted JSON for ${email} from S3 (${s3Key})`);
        res.json({ success: true, key: s3Key });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/s3/bulk-search', async (req, res) => {
    try {
        const { emails } = req.body;
        if (!Array.isArray(emails) || emails.length === 0) return res.status(400).json({ error: 'emails array required' });

        const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({
            region: process.env.AWS_REGION || 'eu-west-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
            }
        });
        const bucket = process.env.AWS_BUCKET_NAME || 'json-files-gw';

        const results = await Promise.all(emails.map(async (email) => {
            try {
                await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `workspace-keys/${email}.json` }));
                return { email, exists: true };
            } catch (err) {
                return { email, exists: false };
            }
        }));

        res.json({ results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/s3/bulk-download-zip', async (req, res) => {
    try {
        const { emails } = req.body;
        if (!Array.isArray(emails) || emails.length === 0) return res.status(400).json({ error: 'emails array required' });

        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const { zipSync } = await import('fflate');

        const s3 = new S3Client({
            region: process.env.AWS_REGION || 'eu-west-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
            }
        });
        const bucket = process.env.AWS_BUCKET_NAME || 'json-files-gw';

        const files = {};
        for (const email of emails) {
            try {
                const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `workspace-keys/${email}.json` }));
                const chunks = [];
                for await (const chunk of response.Body) chunks.push(Buffer.from(chunk));
                files[`${email}.json`] = new Uint8Array(Buffer.concat(chunks));
            } catch (err) {
                console.warn(`[BulkZip] Skipping ${email}: ${err.message}`);
            }
        }

        if (Object.keys(files).length === 0) {
            return res.status(404).json({ error: 'No files found in S3 for the given emails' });
        }

        const zipped = zipSync(files, { level: 6 });
        const buf = Buffer.from(zipped);

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="workspace-keys.zip"');
        res.setHeader('Content-Length', buf.length);
        res.send(buf);
    } catch (e) {
        console.error('[BulkZip]', e.message);
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

app.get('/api/app-passwords/list', (req, res) => {
    try {
        // Read from created_users.txt (workspace users), or fallback to result_accounts.txt (admin accounts)
        const createdUsersPath = path.join(__dirname, 'created_users.txt');
        const filePath = fs.existsSync(createdUsersPath) ? createdUsersPath : path.join(__dirname, 'result_accounts.txt');

        const accountsStr = fs.readFileSync(filePath, 'utf8');
        const lines = accountsStr.split('\n').filter(line => line.trim() !== '');
        const accounts = lines.map((line, index) => {
            const colonIdx = line.indexOf(':');
            const email = line.substring(0, colonIdx).trim();
            const password = line.substring(colonIdx + 1).trim();
            return { id: `acc-${index}`, email, password, status: 'pending' };
        }).filter(a => a.email && a.password);
        res.json(accounts);
    } catch (error) {
        res.status(500).json({ error: 'Failed to read accounts' });
    }
});

// Upload custom users list (email:password per line)
app.post('/api/app-passwords/upload-list', (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: 'content required' });

        const lines = content.split('\n').map(l => l.trim()).filter(l => l.includes(':'));
        const accounts = lines.map((line, index) => {
            const colonIdx = line.indexOf(':');
            const email = line.substring(0, colonIdx).trim();
            const password = line.substring(colonIdx + 1).trim();
            return { id: `upload-${index}`, email, password, status: 'pending' };
        }).filter(a => a.email && a.password);

        // Save to created_users.txt (overwrite)
        const createdUsersPath = path.join(__dirname, 'created_users.txt');
        fs.writeFileSync(createdUsersPath, lines.join('\n') + '\n');

        res.json({ success: true, imported: accounts.length, accounts });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Clear the created_users.txt list
app.delete('/api/app-passwords/list', (req, res) => {
    try {
        const createdUsersPath = path.join(__dirname, 'created_users.txt');
        fs.writeFileSync(createdUsersPath, '');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.post('/api/app-passwords/generate', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { generateAppPassword } = await import('./setupAppPassword.cjs');
        const { saveToServer } = await import('./sshUploader.cjs');

        const result = await generateAppPassword(email, password, false);

        if (result.success && result.appPassword && result.secretKey) {
            try {
                await saveToServer(email, result.appPassword, result.secretKey);
                console.log(`[App Passwords] ✅ Saved to 46.224.9.127 for ${email}`);
            } catch (err) {
                console.error(`[App Passwords] ⚠️ Save to server failed: ${err.message}`);
            }
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


app.get('/api/app-passwords/otp', async (req, res) => {
    const { secret } = req.query;
    try {
        const { authenticator } = await import('otplib');
        const otp = authenticator.generate(secret);
        res.json({ success: true, otp });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── PHONE VERIFY ACCOUNTS ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const PHONE_VERIFY_FILE = path.join(__dirname, 'account_verfy_phone.txt');
const PHONE_VERIFY_META = path.join(__dirname, 'account_verfy_phone_meta.json');
const MAX_PHONE_ATTEMPTS = 3;

// In-memory browser sessions: email → { browser, page, attempt, activationId, phone, apiKey, baseUrl, country }
const phoneVerifySessions = new Map();

// On startup: reset stuck 'verifying' accounts → 'queued' (sessions lost on restart)
try {
    if (fs.existsSync(PHONE_VERIFY_META)) {
        const meta = JSON.parse(fs.readFileSync(PHONE_VERIFY_META, 'utf8'));
        let changed = false;
        for (const email of Object.keys(meta)) {
            if (meta[email].status === 'verifying') { meta[email].status = 'queued'; changed = true; }
        }
        if (changed) { fs.writeFileSync(PHONE_VERIFY_META, JSON.stringify(meta, null, 2)); console.log('[PhoneVerify] Reset verifying → queued on startup'); }
    }
} catch (e) { console.error('[PhoneVerify] startup reset error:', e.message); }


// ── File helpers ───────────────────────────────────────────────────────────────
const readPhoneAccounts = () => {
    const meta = fs.existsSync(PHONE_VERIFY_META)
        ? JSON.parse(fs.readFileSync(PHONE_VERIFY_META, 'utf8')) : {};
    if (!fs.existsSync(PHONE_VERIFY_FILE)) return [];
    return fs.readFileSync(PHONE_VERIFY_FILE, 'utf8')
        .split('\n').map(l => l.trim()).filter(l => l.includes(':') && l.includes('@'))
        .map((line, idx) => {
            const colonIdx = line.indexOf(':');
            const email = line.substring(0, colonIdx).trim();
            const password = line.substring(colonIdx + 1).trim();
            const m = meta[email] || {};
            return { id: m.id || `pv-${idx}-${email}`, email, password, status: m.status || 'queued', addedAt: m.addedAt || new Date().toISOString(), verifiedBy: m.verifiedBy };
        });
};

const updatePhoneMeta = (email, fields) => {
    const meta = fs.existsSync(PHONE_VERIFY_META) ? JSON.parse(fs.readFileSync(PHONE_VERIFY_META, 'utf8')) : {};
    meta[email] = { ...(meta[email] || {}), ...fields };
    fs.writeFileSync(PHONE_VERIFY_META, JSON.stringify(meta, null, 2));
};

// ── Hero SMS helpers ───────────────────────────────────────────────────────────
const getHeroConfig = () => {
    const cfg = fs.existsSync(path.join(__dirname, 'config.json'))
        ? JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) : {};
    return { apiKey: cfg.heroSmsKey || process.env.HERO_SMS_KEY, baseUrl: cfg.heroSmsUrl || 'https://hero-sms.com/stubs/handler_api.php' };
};
const GEO_COUNTRY = { ID: '6', CO: '11', US: '187', RU: '0', IN: '22', BR: '73', MX: '44' };

const heroGetNumber = async (apiKey, baseUrl, country) => {
    const resp = await axios.get(baseUrl, { params: { api_key: apiKey, action: 'getNumber', service: 'go', country } });
    const data = String(resp.data).trim();
    if (data.startsWith('ACCESS_NUMBER')) { const p = data.split(':'); return { success: true, activationId: p[1], phone: p[2] }; }
    
    if (data.startsWith('BANNED:')) return { success: false, error: 'This GEO is temporarily blocked by Hero SMS. Please select a different GEO.' };
    if (data === 'NO_NUMBERS') return { success: false, error: 'No numbers available for this GEO. Please select a different GEO.' };
    if (data === 'NO_BALANCE') return { success: false, error: 'Hero SMS balance is empty. Please top up.' };
    
    return { success: false, error: data };
};
const heroCancelNumber = async (apiKey, baseUrl, activationId) => {
    await axios.get(baseUrl, { params: { api_key: apiKey, action: 'setStatus', id: activationId, status: 8 } }).catch(() => {});
};
const heroGetStatus = async (apiKey, baseUrl, activationId) => {
    const resp = await axios.get(baseUrl, { params: { api_key: apiKey, action: 'getStatus', id: activationId } });
    return String(resp.data).trim();
};
const heroGetBalance = async (apiKey, baseUrl) => {
    const resp = await axios.get(baseUrl, { params: { api_key: apiKey, action: 'getBalance' } });
    const data = String(resp.data).trim();
    if (data.startsWith('ACCESS_BALANCE:')) return { success: true, balance: data.split(':')[1] };
    if (!isNaN(parseFloat(data))) return { success: true, balance: data }; 
    return { success: false, error: data };
};

// ── GET /api/phone-verify/balance ─────────────────────────────────────────────
app.get('/api/phone-verify/balance', async (req, res) => {
    try {
        const { apiKey, baseUrl } = getHeroConfig();
        if (!apiKey) return res.json({ success: false, error: 'Hero SMS API key not configured' });
        const result = await heroGetBalance(apiKey, baseUrl);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── GET /api/phone-verified-accounts ──────────────────────────────────────────
app.get('/api/phone-verified-accounts', (req, res) => {
    try {
        const { user } = req.query;
        let accounts = readPhoneAccounts();
        if (user && user !== 'admin' && user !== 'global') {
            accounts = accounts.filter(a => a.verifiedBy === user);
        }
        res.json(accounts);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── DELETE /api/phone-verified-accounts ───────────────────────────────────────
app.delete('/api/phone-verified-accounts', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'email required' });
        const s = phoneVerifySessions.get(email);
        if (s?.browser) await s.browser.close().catch(() => {});
        phoneVerifySessions.delete(email);
        if (fs.existsSync(PHONE_VERIFY_FILE)) {
            const lines = fs.readFileSync(PHONE_VERIFY_FILE, 'utf8').split('\n')
                .filter(l => l.trim() && !l.startsWith(email + ':') && l.trim() !== email);
            fs.writeFileSync(PHONE_VERIFY_FILE, lines.join('\n') + (lines.length ? '\n' : ''));
        }
        if (fs.existsSync(PHONE_VERIFY_META)) {
            const m = JSON.parse(fs.readFileSync(PHONE_VERIFY_META, 'utf8'));
            delete m[email];
            fs.writeFileSync(PHONE_VERIFY_META, JSON.stringify(m, null, 2));
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/accounts/verify-phone/bulk ──────────────────────────────────────
app.post('/api/accounts/verify-phone/bulk', (req, res) => {
    try {
        const { accounts, verifiedBy } = req.body;
        if (!accounts?.length) return res.status(400).json({ error: 'accounts array required' });
        const existing = new Set();
        if (fs.existsSync(PHONE_VERIFY_FILE))
            fs.readFileSync(PHONE_VERIFY_FILE, 'utf8').split('\n').filter(l => l.includes('@')).forEach(l => existing.add(l.split(':')[0].trim()));
        
        // Build domain to password map from result_accounts.txt
        const domainToPassword = new Map();
        try {
            const resultPath = path.join(__dirname, 'result_accounts.txt');
            if (fs.existsSync(resultPath)) {
                fs.readFileSync(resultPath, 'utf8').split('\n').forEach(line => {
                    const parts = line.split(':');
                    if (parts.length >= 2 && parts[0].includes('@')) {
                        const domain = parts[0].split('@')[1].trim();
                        domainToPassword.set(domain, parts[1].trim());
                    }
                });
            }
        } catch(e) {}

        const meta = fs.existsSync(PHONE_VERIFY_META) ? JSON.parse(fs.readFileSync(PHONE_VERIFY_META, 'utf8')) : {};
        let queued = 0, skipped = 0;
        const newLines = [];
        for (const a of accounts) {
            let pwd = a.password;
            if (!pwd || pwd.trim() === '') {
                const domain = a.email.split('@')[1];
                if (domain) pwd = domainToPassword.get(domain);
            }
            if (!a.email || !pwd) continue;
            if (existing.has(a.email)) { skipped++; continue; }
            newLines.push(`${a.email}:${pwd}`);
            const username = a.verifiedBy || verifiedBy || 'ALL';
            meta[a.email] = { id: `pv-${Date.now()}-${a.email}`, status: 'queued', addedAt: new Date().toISOString(), verifiedBy: username };
            queued++;
        }
        if (newLines.length) fs.appendFileSync(PHONE_VERIFY_FILE, newLines.join('\n') + '\n');
        fs.writeFileSync(PHONE_VERIFY_META, JSON.stringify(meta, null, 2));
        res.json({ success: true, queued, skipped });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/phone-verify/start ──────────────────────────────────────────────
// 1. Launch browser  2. Login Gmail  3. Get Hero SMS number  4. Enter number in Google
app.post('/api/phone-verify/start', async (req, res) => {
    const { email, password, geo = 'ID' } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    // Close any existing session
    const existing = phoneVerifySessions.get(email);
    if (existing?.browser) await existing.browser.close().catch(() => {});
    phoneVerifySessions.delete(email);

    // Immediately mark as verifying so frontend doesn't re-queue it
    updatePhoneMeta(email, { status: 'verifying' });

    const { apiKey, baseUrl } = getHeroConfig();
    if (!apiKey) return res.status(400).json({ error: 'Hero SMS API key not configured in Settings' });

    let browser;
    try {
        const bot = await import('./phoneVerifyBot.js');

        // Step 1-2: Launch + Login
        console.log(`[PhoneVerify] Starting browser session for ${email}`);
        browser = await bot.launchBrowser();
        let page;
        try {
            const loginRes = await bot.doGoogleLogin(browser, email, password);
            page = loginRes.page;
            
            if (!loginRes.requiresVerification) {
                console.log(`[PhoneVerify] ${email} logged in directly with no verification required.`);
                await browser.close().catch(() => {});
                updatePhoneMeta(email, { status: 'done', note: 'No verification required' });
                return res.json({ success: true, doneDirectly: true, message: 'Logged in without verification' });
            }
        } catch (loginErr) {
            await browser.close().catch(() => {});
            const isNotFound = loginErr.message === 'ACCOUNT_NOT_FOUND';
            updatePhoneMeta(email, { status: isNotFound ? 'account_not_found' : 'failed' });
            return res.json({ success: false, error: loginErr.message });
        }

        // Step 3: Get Hero SMS number (attempt 1)
        const country = GEO_COUNTRY[geo] || GEO_COUNTRY['ID'];
        const sms = await heroGetNumber(apiKey, baseUrl, country);
        if (!sms.success) {
            await browser.close().catch(() => {});
            updatePhoneMeta(email, { status: 'failed' });
            return res.json({ success: false, error: `Hero SMS: ${sms.error}` });
        }

        // Step 4: Enter phone in Google
        try {
            await bot.enterPhoneNumber(page, sms.phone);
            
            // Store session
            phoneVerifySessions.set(email, { browser, page, attempt: 1, activationId: sms.activationId, phone: sms.phone, apiKey, baseUrl, country });
            updatePhoneMeta(email, { status: 'verifying', activationId: sms.activationId, phone: sms.phone });

            console.log(`[PhoneVerify] ✅ Number entered for ${email}: ${sms.phone} (attempt 1)`);
            res.json({ success: true, activationId: sms.activationId, phone: sms.phone, attempt: 1 });
            
        } catch (phoneErr) {
            await heroCancelNumber(apiKey, baseUrl, sms.activationId);
            if (phoneErr.message === 'PHONE_REJECTED') {
                // Keep browser open for retry
                phoneVerifySessions.set(email, { browser, page, attempt: 1, activationId: sms.activationId, phone: sms.phone, apiKey, baseUrl, country });
                updatePhoneMeta(email, { status: 'verifying' });
                return res.json({ success: true, phoneRejected: true, error: `Phone rejected` });
            } else {
                await browser.close().catch(() => {});
                updatePhoneMeta(email, { status: 'failed' });
                return res.json({ success: false, error: `Phone entry: ${phoneErr.message}` });
            }
        }

    } catch (e) {
        console.error(`[PhoneVerify] start error for ${email}:`, e.message);
        if (browser) await browser.close().catch(() => {});
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/phone-verify/code ────────────────────────────────────────────────
// Poll Hero SMS. If code received → enter it in browser → close session
app.get('/api/phone-verify/code', async (req, res) => {
    const { activationId, email } = req.query;
    if (!activationId) return res.status(400).json({ error: 'activationId required' });
    const { apiKey, baseUrl } = getHeroConfig();
    if (!apiKey) return res.status(400).json({ error: 'Hero SMS not configured' });

    try {
        const data = await heroGetStatus(apiKey, baseUrl, activationId);
        console.log(`[PhoneVerify] Status for ${activationId}: ${data}`);

        if (data.startsWith('STATUS_OK')) {
            const code = data.split(':')[1];
            // Confirm to Hero SMS
            axios.get(baseUrl, { params: { api_key: apiKey, action: 'setStatus', id: activationId, status: 6 } }).catch(() => {});

            // Enter code in browser
            if (email) {
                const session = phoneVerifySessions.get(email);
                if (session?.page) {
                    const bot = await import('./phoneVerifyBot.js');
                    await bot.enterSmsCode(session.page, code).catch(e => console.error('[PhoneVerify] enterSmsCode error:', e.message));
                    await session.browser.close().catch(() => {});
                    phoneVerifySessions.delete(email);
                }
                updatePhoneMeta(email, { status: 'done', smsCode: code });
            }
            return res.json({ status: 'received', code });
        }
        if (data === 'STATUS_CANCEL') {
            if (email) updatePhoneMeta(email, { status: 'failed' });
            return res.json({ status: 'cancelled' });
        }
        if (data === 'STATUS_WAIT_CODE') return res.json({ status: 'waiting' });
        return res.json({ status: 'waiting', raw: data });

    } catch (e) {
        console.error('[PhoneVerify] code poll error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/phone-verify/retry-number ───────────────────────────────────────
// Cancel current Hero SMS number, get new one, enter it in still-open browser
app.post('/api/phone-verify/retry-number', async (req, res) => {
    const { email, oldActivationId } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    const session = phoneVerifySessions.get(email);
    if (!session) return res.json({ success: false, error: 'No active session found — restart verification' });

    const nextAttempt = (session.attempt || 1) + 1;
    if (nextAttempt > MAX_PHONE_ATTEMPTS) {
        await session.browser.close().catch(() => {});
        phoneVerifySessions.delete(email);
        updatePhoneMeta(email, { status: 'failed' });
        return res.json({ success: false, error: `Max ${MAX_PHONE_ATTEMPTS} attempts reached`, maxReached: true });
    }

    const { apiKey, baseUrl, country } = session;
    try {
        // Cancel old number
        if (oldActivationId) await heroCancelNumber(apiKey, baseUrl, oldActivationId);

        // Get new number
        const sms = await heroGetNumber(apiKey, baseUrl, country);
        if (!sms.success) return res.json({ success: false, error: `Hero SMS: ${sms.error}` });

        // Enter new number in still-open browser
        const bot = await import('./phoneVerifyBot.js');
        await bot.retryWithNewPhone(session.page, sms.phone);

        // Update session
        session.attempt = nextAttempt;
        session.activationId = sms.activationId;
        session.phone = sms.phone;
        phoneVerifySessions.set(email, session);
        updatePhoneMeta(email, { activationId: sms.activationId, phone: sms.phone });

        console.log(`[PhoneVerify] 🔄 Retry attempt ${nextAttempt} for ${email}: ${sms.phone}`);
        res.json({ success: true, activationId: sms.activationId, phone: sms.phone, attempt: nextAttempt });

    } catch (e) {
        console.error('[PhoneVerify] retry-number error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/phone-verify/close-session ──────────────────────────────────────
app.post('/api/phone-verify/close-session', async (req, res) => {
    const { email, status } = req.body;
    if (email) {
        const s = phoneVerifySessions.get(email);
        if (s?.browser) await s.browser.close().catch(() => {});
        phoneVerifySessions.delete(email);
        if (status) updatePhoneMeta(email, { status });
    }
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────

// Catch-all to serve React for client-side routing
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, 'Frontend', 'dist', 'index.html'));
});

// ─────────────────────────────────────────────────────────────────────────────

// Graceful shutdown
// Graceful shutdown
const shutdownHandler = async () => {
    console.log('🛑 Shutting down server and workers...');
    if (activeWorker) {
        console.log('Killing active worker process...');
        try {
            activeWorker.kill('SIGTERM');
        } catch (e) {}
    }
    await prepQueue.close();
    process.exit(0);
};

process.on('SIGTERM', shutdownHandler);
process.on('SIGINT', shutdownHandler);
