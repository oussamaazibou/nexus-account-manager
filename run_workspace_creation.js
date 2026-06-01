
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Google from './createWorkspaceScript.js';
import axios from 'axios';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const API_STATS_URL = 'http://localhost:4000/api/internal/update-stats';
const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 1;
const WORKSPACE_USER = process.env.WORKSPACE_USER || 'global';

// Load proxy list from config.json or env vars
const loadProxies = () => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const envProxyOverride = process.env.USE_PROXY === 'true';
            
            if ((config.proxiesEnabled || envProxyOverride) && config.proxiesList && config.proxiesList.trim()) {
                const lines = config.proxiesList.split('\n').map(l => l.trim()).filter(Boolean);
                const proxies = lines.map(line => {
                    const parts = line.split(':');
                    if (parts.length >= 4) {
                        const [host, port, user, pass] = parts;
                        return {
                            format: `${host}:${port}`,
                            host, port, user, pass
                        };
                    } else if (parts.length === 2) {
                        const [host, port] = parts;
                        return { format: `${host}:${port}`, host, port };
                    }
                    return null;
                }).filter(Boolean);
                if (proxies.length > 0) {
                    console.log(`[PROXY] Loaded ${proxies.length} proxies from config.json`);
                    return proxies;
                }
            }
        }
    } catch (e) {
        console.error('[PROXY] Failed to load proxy list:', e.message);
    }

    // Fallback: Single proxy from env vars
    const useProxy = process.env.USE_PROXY === 'true';
    if (useProxy && process.env.PROXY_HOST) {
        const { PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD } = process.env;
        console.log(`[PROXY] Using env-var proxy: ${PROXY_HOST}:${PROXY_PORT}`);
        return [{ 
            format: `${PROXY_HOST}:${PROXY_PORT}`, 
            host: PROXY_HOST, 
            port: PROXY_PORT,
            user: PROXY_USERNAME,
            pass: PROXY_PASSWORD
        }];
    }

    console.log('[PROXY] No proxy configured — running without proxy');
    return [];
};

const PROXY_LIST = loadProxies();
let proxyIndex = 0;

const getNextProxy = () => {
    if (PROXY_LIST.length === 0) return null;
    const proxy = PROXY_LIST[proxyIndex % PROXY_LIST.length];
    proxyIndex++;
    return proxy;
};


// Stats State
const stats = {
    batchCurrent: 0,
    batchTotal: 0,
    successful: 0,
    failed: 0,
    antiSpamBlocked: 0,
    failureRate: 0,
    antiSpamRate: 0,
    activeThreads: 0
};

// Update backend helper
const updateBackend = async () => {
    try {
        // Calculate rates
        const totalProcessed = stats.successful + stats.failed;
        if (totalProcessed > 0) {
            stats.failureRate = parseFloat(((stats.failed / totalProcessed) * 100).toFixed(2));
            stats.antiSpamRate = parseFloat(((stats.antiSpamBlocked / totalProcessed) * 100).toFixed(2));
        }

        await axios.post(API_STATS_URL, { user: WORKSPACE_USER, stats });
    } catch (e) {
        // Silently fail stats update to not interrupt process
    }
};

async function processDomain(domain, threadId) {
    stats.activeThreads++;
    await updateBackend();

    console.log(`\n==================================================`);
    console.log(`[Thread ${threadId}] Starting Process for Domain: ${domain}`);
    console.log(`==================================================`);

    let google = null;
    try {
        google = new Google(getNextProxy());
        await google.createAccount(domain, threadId);

        console.log(`\n✅ [Thread ${threadId}] Successfully processed: ${domain}`);
        stats.successful++;

        // Send Telegram Notification
        try {
            const email = google.createdEmail || google.username ? `${google.username}@${domain}` : domain;
            await axios.post('http://localhost:4000/api/internal/notify', {
                message: `✨ *Workspace Created Successfully*\n\n🌐 Domain: \`${domain}\`\n📧 Email: \`${email}\`\n👤 Operator: \`${WORKSPACE_USER}\`\n⏰ Time: ${new Date().toLocaleTimeString('en-US')}`
            });
        } catch (e) {
            // Silently ignore telegram broadcast fails
        }
    } catch (err) {
        console.error(`\n❌ [Thread ${threadId}] Failed to process ${domain}:`, err.message);
        stats.failed++;

        // Check for anti-spam or specific errors if possible
        if (err.message && (err.message.includes('429') || err.message.includes('spam') || err.message.includes('verify'))) {
            stats.antiSpamBlocked++;
        }
    } finally {
        if (google && google.closeBrowser) {
            try {
                await google.closeBrowser();
            } catch (closeErr) {
                console.error(`[Thread ${threadId}] Error closing browser:`, closeErr.message);
            }
        }
        stats.activeThreads--;
        await updateBackend();
    }
}

async function run() {
    try {
        console.log('--- Workspace Creation Runner Started ---');
        console.log(`Concurrency Level: ${CONCURRENCY}`);

        // Read domains
        const domainsFile = process.env.DOMAINS_FILE || 'domains.txt';
        const domainsPath = path.join(__dirname, domainsFile);
        if (!fs.existsSync(domainsPath)) {
            throw new Error(`Domains file not found at ${domainsPath}`);
        }

        const domainsContent = fs.readFileSync(domainsPath, 'utf-8');
        const domains = domainsContent.replace(/\r\n/g, '\n').split('\n').filter(d => d.trim().length > 0);

        console.log(`Found ${domains.length} domains to process`);

        // Initialize Stats
        stats.batchTotal = Math.ceil(domains.length / CONCURRENCY);
        await updateBackend();

        // Process in Batches
        for (let i = 0; i < domains.length; i += CONCURRENCY) {
            stats.batchCurrent = Math.floor(i / CONCURRENCY) + 1;
            await updateBackend();

            const batch = domains.slice(i, i + CONCURRENCY);
            console.log(`\n>>> Starting Batch ${stats.batchCurrent}/${stats.batchTotal} (${batch.length} domains) <<<`);

            const promises = batch.map((domain, index) => {
                const threadId = i + index + 1;
                return processDomain(domain.trim(), threadId);
            });

            await Promise.all(promises);

            console.log(`\n>>> Completed Batch ${stats.batchCurrent} <<<`);

            // Wait slightly between batches
            if (i + CONCURRENCY < domains.length) {
                console.log('Waiting 5 seconds before next batch...');
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        console.log('\n--- Runner Completed All Jobs ---');
        process.exit(0);

    } catch (e) {
        console.error('Fatal Runner Error:', e);
        process.exit(1);
    }
}

// Global error handlers
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

run();
