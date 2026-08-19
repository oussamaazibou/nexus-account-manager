import { AccountVerifier } from '../services/verification/AccountVerifier.js';
import { Worker, Job } from 'bullmq';
import { GCloudRunner } from '../services/gcloud/GCloudRunner.js';
import { S3Uploader } from '../services/aws/S3Uploader.js';
import { SSHUploader } from '../services/ssh/SSHUploader.js';
import { Logger, withLogContext } from '../utils/logger.js';
import path from 'path';
import fs from 'fs';
import * as puppeteer from 'puppeteer'; // Verify if this causes issues or if types are needed

// Emails currently being processed across ALL jobs/workers — prevents two jobs from
// racing the same account (checkout vs domain-verify). Module-level so it survives
// worker re-instantiation.
const inFlightAccounts = new Set<string>();

interface PrepJobData {
    projectId: string;
    userEmail: string;
    userPassword?: string;
    saName: string;
    saDisplayName?: string;
    orgId?: string;
    jobId?: string;
    headless?: boolean;
    mode?: string; // 'phone-only' → skip everything except phone verification
}

export class PrepWorker {
    private worker: Worker;
    private s3: S3Uploader;
    private ssh: SSHUploader;
    private isSshConfigured: boolean;
    private verifier: AccountVerifier;
    private currentConcurrency: number = 1;

    private loadConcurrency(): number {
        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                const val = parseInt(config.concurrency || '18');
                return Math.max(1, Math.min(18, val));
            }
        } catch (e) { }
        return 18;
    }

    constructor(redisConnection: any) {
        let config: any = {};
        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        } catch (e) { Logger.warn('Failed to load config'); }

        this.currentConcurrency = this.loadConcurrency();
        Logger.info(`🔧 Worker starting with concurrency: ${this.currentConcurrency}`);

        this.s3 = new S3Uploader();

        // Use Config for SSH if available, else Env
        const sshHost = config.sftpHost || process.env.SSH_HOST;
        this.isSshConfigured = !!sshHost;
        this.ssh = new SSHUploader({
            host: sshHost || '46.224.9.127',
            port: parseInt(config.sftpPort || process.env.SSH_PORT || '22'),
            username: config.sftpUser || process.env.SSH_USER || 'root',
            password: config.sftpPassword || process.env.SSH_PASSWORD || '',
            basePath: config.sftpPath || process.env.SSH_BASE_PATH || '/home/brightmindscampus'
        });

        this.verifier = new AccountVerifier();

        this.worker = new Worker('prep-queue', async (job: Job<PrepJobData>) => {
            // Set the per-job log context so EVERY Logger line inside this job
            // carries the account email → server.js routes it into the live
            // Process Log panel for this account.
            return withLogContext({ email: job.data.userEmail }, async () => {
            // ── IN-FLIGHT DEDUP ────────────────────────────────────────────────
            // The same account can be enqueued twice (accounts.txt bulk + manual/API
            // + Telegram). With concurrency up to 18, two jobs for one email run
            // PARALLEL browser flows that fight over the same page (e.g. one doing
            // checkout while the other clicks "Verify domain" in the Admin Console).
            // Guard: only one job per email may process at a time. A duplicate job
            // completes as a no-op; once the active job finishes, new jobs for that
            // email run normally again.
            const inFlightKey = (job.data.userEmail || '').trim().toLowerCase();
            if (inFlightKey) {
                if (inFlightAccounts.has(inFlightKey)) {
                    Logger.warn(`⏭️ Job ${job.id} SKIPPED — account ${inFlightKey} is already being processed by another job (in-flight dedup).`);
                    return;
                }
                inFlightAccounts.add(inFlightKey);
            }
            try {
            // Re-read concurrency before each job and update if changed
            const freshConcurrency = this.loadConcurrency();
            if (freshConcurrency !== this.currentConcurrency) {
                Logger.info(`🔄 Concurrency changed: ${this.currentConcurrency} → ${freshConcurrency}`);
                this.currentConcurrency = freshConcurrency;
                this.worker.concurrency = freshConcurrency;
            }

            Logger.info(`Processing Job ${job.id}`, job.data);
            
            // Add jitter delay (0-5s) to avoid simultaneous browser start
            const jitter = Math.floor(Math.random() * 5000);
            Logger.info(`⏳ Jitter delay for ${job.id}: ${jitter}ms`);
            await new Promise(r => setTimeout(r, jitter));

            const jobDataWithId = { ...job.data, jobId: job.id };
            await this.processJob(jobDataWithId);
            } finally {
                if (inFlightKey) inFlightAccounts.delete(inFlightKey);
            }
            });
        }, {
            connection: redisConnection,
            concurrency: this.currentConcurrency,
            // ── Anti-stall config for long browser automation jobs ──
            // lockDuration: max time a job can run before BullMQ considers it stalled
            lockDuration: 10 * 60 * 1000,       // 10 minutes
            // lockRenewTime: renew lock every N ms to keep job alive
            lockRenewTime: 3 * 60 * 1000,        // renew every 3 min
            // stalledInterval: how often BullMQ checks for stalled jobs
            stalledInterval: 60 * 1000,           // check every 60s (default 30s)
            // maxStalledCount: allow 1 stall before failing
            maxStalledCount: 1,
        });

        this.worker.on('completed', job => {
            Logger.info(`Job ${job.id} completed!`);
        });

        this.worker.on('failed', (job, err) => {
            Logger.error(`Job ${job?.id} failed`, err);
        });

        this.worker.on('stalled', (jobId) => {
            Logger.warn(`⚠️ Job ${jobId} stalled — kaykun browser automation tawil bzaf`);
        });
    }

    private async processJob(data: PrepJobData) {
        let { projectId, userEmail, userPassword, saName, saDisplayName, mode } = data;
        
        // Enforce Google Cloud Project ID constraints (max 30 chars, lowercase, alphanumeric, hyphens)
        projectId = projectId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (projectId.length > 30) {
            projectId = projectId.substring(0, 30).replace(/-$/, '');
        }

        const headless = true; // Force true for VPS environment
        let { orgId } = data;
        const jobId = parseInt(data.jobId || "1");

        // ── PHONE-ONLY MODE ───────────────────────────────────────────────────
        if (mode === 'phone-only') {
            Logger.info(`📱 [Mode: phone-only] Running phone verification only for ${userEmail}`);
            if (!userPassword) throw new Error('Password required for phone-only mode');
            const result = await this.verifier.phoneVerifyOnly(userEmail, userPassword);
            if (!result.success) {
                if (result.error === 'ACCOUNT_NOT_FOUND') {
                    await this.markAsNoActive(userEmail);
                    throw new Error('NO_ACTIVE: Account does not exist on Google');
                }
                throw new Error(result.error || 'Phone verification failed');
            }
            Logger.info(`✅ [Mode: phone-only] Done for ${userEmail}`);
            return; // Stop here — do NOT run gcloud or any other step
        }
        // ─────────────────────────────────────────────────────────────────────

        // ISOLATE GCLOUD CONFIGURATION
        const configDir = path.resolve(process.cwd(), 'tmp', `gcloud-config-${jobId}`);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        const gcloud = new GCloudRunner();
        gcloud.setConfigDir(configDir);

        // -1. PRE-FLIGHT VERIFICATION (skip if gcloud-only mode)
        if (mode !== 'gcloud-only') {
            Logger.info("Step -1: Pre-flight Account Verification");
            if (userPassword) {
                try {
                    Logger.info(`Starting verification for ${userEmail}...`);
                    const verificationResult = await this.verifier.verify(userEmail, userPassword, jobId, headless);
                    if (!verificationResult.success) {
                        // Special case: account does not exist on Google at all
                        if (verificationResult.error === 'ACCOUNT_NOT_FOUND') {
                            await this.markAsNoActive(userEmail);
                            throw new Error('NO_ACTIVE: Account does not exist on Google');
                        }
                        throw new Error(verificationResult.error || `Account verification failed for ${userEmail}`);
                    }
                    Logger.info("✅ Account Verified successfully.");
                    
                    // Check if domain verification was skipped (already verified)
                    if (verificationResult.domainAlreadyVerified) {
                        Logger.info(`⚡ Domain was already verified — skipping extra verification steps`);
                    }
                } catch (verifyError: any) {
                    Logger.error("Account Verification Failed (BLOCKING)", verifyError.message);
                    this.saveFailedAccount(userEmail, userPassword);
                    throw verifyError;
                }
            }
        } else {
            Logger.info(`⚡ [gcloud-only] Skipping domain verification for ${userEmail} — already verified`);
        }

        // 0. Authenticate
        Logger.info("Step 0: Authenticate with user account");
        if (userPassword) {
            try {
                // Pre-fetch SA key from S3 if available — gcloudAuth will use it instead of browser OAuth
                const safeEmail = userEmail.replace('@', '_at_').replace(/\./g, '_');
                const tmpKeyPath = path.join(process.cwd(), 'tmp', 'manage-keys', `${safeEmail}.json`);
                if (!fs.existsSync(tmpKeyPath)) {
                    try {
                        const keyData = await this.s3.downloadJson(`workspace-keys/${userEmail}.json`);
                        if (keyData) {
                            const tmpDir = path.join(process.cwd(), 'tmp', 'manage-keys');
                            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                            fs.writeFileSync(tmpKeyPath, JSON.stringify(keyData, null, 2));
                            Logger.info(`✅ SA key pre-fetched from S3 for ${userEmail}`);
                        }
                    } catch (s3Err: any) {
                        Logger.info(`ℹ️ No SA key on S3 for ${userEmail} — will use browser OAuth`);
                    }
                } else {
                    Logger.info(`✅ SA key already cached locally for ${userEmail}`);
                }

                const { gcloudAuthLogin } = await import('../../gcloudAuth.cjs') as any;
                await gcloudAuthLogin(userEmail, userPassword, jobId, configDir, headless as any);

                const activeAccount = await gcloud.getActiveAccount();
                const activeLower = activeAccount.trim().toLowerCase();
                const isServiceAccount = activeLower.endsWith('.iam.gserviceaccount.com');
                
                if (activeLower !== userEmail.toLowerCase() && !isServiceAccount) {
                    throw new Error(`Auth mismatch! Expected ${userEmail}, got ${activeAccount}`);
                }
                Logger.info(`gcloud authenticated successfully as ${activeAccount}`);
            } catch (authError: any) {
                Logger.error("gcloud auth failed", authError.message);
                this.saveFailedAccount(userEmail, userPassword);
                throw authError;
            }
        }

        // 0.1 Cloud Console Access
        Logger.info("Step 0.1: Checking Cloud Console Access");
        if (userPassword) {
            try {
                const { checkAndActivateCloudConsole } = await import('../../checkCloudConsole.cjs') as any;
                await checkAndActivateCloudConsole(userEmail, userPassword, headless as any);
            } catch (consoleErr: any) {
                Logger.warn("Cloud Console activation failed (non-blocking)", consoleErr.message);
            }
        }

        // We no longer wait for gcloud organizations list because it's too slow.
        // We will create the project immediately and fetch the Org ID from its ancestors.

        // 1. Project Init
        Logger.info("Step 1: Init Project");
        await gcloud.createProject(projectId, `Proj-${projectId.substring(0, 15)}`, orgId);

        if (!orgId) {
            try {
                Logger.info("Fetching Organization ID from newly created project...");
                orgId = await gcloud.getOrgIdFromProject(projectId);
                Logger.info(`✅ Found Organization ID from project ancestors: ${orgId}`);
            } catch (e: any) {
                Logger.warn(`⚠️ Could not determine Organization ID from project: ${e.message}`);
            }
        }

        // 2. Enable APIs
        await gcloud.enableApis(projectId);

        // 3. Service Account
        await gcloud.createServiceAccount(projectId, saName, saDisplayName || 'Automation SA');

        // 4. Org Policies
        if (orgId) {
            try {
                await gcloud.addIamPolicyBinding(orgId, userEmail, 'roles/orgpolicy.policyAdmin');
                await gcloud.addIamPolicyBinding(orgId, userEmail, 'roles/resourcemanager.organizationAdmin');
                await gcloud.disableKeyCreationRestriction(orgId, projectId);
            } catch (e: any) {
                Logger.error("Org Policy failed (non-blocking)", e.message);
            }
        }

        // 5. Service Account Key
        Logger.info("Step 5: Generate Key");
        const saEmail = `${saName}@${projectId}.iam.gserviceaccount.com`;
        const domain = userEmail.split('@')[1];
        const keyPath = path.resolve(process.cwd(), `${domain}.json`);
        await gcloud.createKey(projectId, saEmail, keyPath);

        // 6. Upload Key
        await this.s3.uploadFile(`workspace-keys/${userEmail}.json`, keyPath);

        // --- BROWSER AUTOMATION (DWD + Authenticator + 2SV) ---
        if (userPassword) {
            Logger.info("Starting Browser Automation steps...");
            const puppeteer = (await import('puppeteer')).default;
            const UserAgent = (await import('user-agents')).default;
            const userAgent = new UserAgent({ deviceCategory: 'desktop' });

            // ── Auto-tiling: same 2×2 grid as verify sessions ──────────────
            const SCREEN_W = 1920;
            const SCREEN_H = 1040;
            const COLS = 2;
            const tileW = Math.floor(SCREEN_W / COLS);
            const tileH = Math.floor(SCREEN_H / COLS);
            const idx = (jobId - 1) % (COLS * COLS);
            const col = idx % COLS;
            const row = Math.floor(idx / COLS);
            const posX = col * tileW;
            const posY = row * tileH;
            Logger.info(`🪟 [DWD/SDK] Session ${jobId} → tile [${col},${row}] pos=(${posX},${posY}) size=${tileW}×${tileH}`);
            // ────────────────────────────────────────────────────────────────

            const browser = await puppeteer.launch({
                headless: headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    `--user-agent=${userAgent.toString()}`,
                    `--window-size=${tileW},${tileH}`,
                    `--window-position=${posX},${posY}`
                ],
                ignoreDefaultArgs: ['--enable-automation']
            });

            try {
                const { addDomainWideDelegation } = await import('../../addDomainWideDelegation.cjs') as any;
                await addDomainWideDelegation(userEmail, userPassword, saEmail, browser as any, configDir);
 
                const { default: setupAuthenticator } = await import('../../setupAuthenticator.cjs') as any;
                const secretKey = await (setupAuthenticator as any)(userEmail, userPassword, browser as any);
 
                if (secretKey) {
                    if (this.isSshConfigured) {
                        try {
                            await (this.ssh as any).uploadSecretKey(userEmail, secretKey);
                        } catch (sshErr: any) {
                            Logger.warn(`[SSH] Failed to upload secret key to SSH/SFTP (will save locally): ${sshErr.message}`);
                        }
                    } else {
                        Logger.info(`[SSH] SSH/SFTP not configured — secret key saved locally only.`);
                    }
                    const localPath = path.join(process.cwd(), 'secrets', `${userEmail}_secret.txt`);
                    if (!fs.existsSync(path.dirname(localPath))) {
                        fs.mkdirSync(path.dirname(localPath), { recursive: true });
                    }
                    fs.writeFileSync(localPath, secretKey);
                }
 
                const { default: configure2SVPolicy } = await import('../../configure2SVPolicy.cjs') as any;
                await (configure2SVPolicy as any)(userEmail, userPassword, browser as any);

            } catch (browserError: any) {
                Logger.error("Browser Automation failed", browserError.message);
            } finally {
                await browser.close();
            }
        }

        // Cleanup
        try { fs.unlinkSync(keyPath); } catch (e) { }
        Logger.info(`Workspace Prep Complete for ${userEmail}`);

        // --- SUCCESS HANDLER: Move from accounts.txt to result_accounts.txt ---
        if (userPassword) {
            try {
                const resultPath = path.resolve(process.cwd(), 'result_accounts.txt');
                const accountsPath = path.resolve(process.cwd(), 'accounts.txt');

                // 1. Append to result_accounts.txt
                const resultLine = `${userEmail}:${userPassword}\n`;
                fs.appendFileSync(resultPath, resultLine);
                Logger.info(`✅ Saved ${userEmail} to result_accounts.txt`);

                // 2. Remove from accounts.txt
                if (fs.existsSync(accountsPath)) {
                    const content = fs.readFileSync(accountsPath, 'utf8');
                    const lines = content.split('\n');
                    const newLines = lines.filter(line => !line.trim().startsWith(userEmail));

                    if (lines.length !== newLines.length) {
                        fs.writeFileSync(accountsPath, newLines.join('\n'));
                        Logger.info(`🗑️ Removed ${userEmail} from accounts.txt`);
                    }
                }
            } catch (fileErr: any) {
                Logger.error(`Failed to update account files for ${userEmail}: ${fileErr.message}`);
            }
        }
    }

    private async markAsNoActive(email: string) {
        Logger.warn(`⚠️ [ACCOUNT_NOT_FOUND] Account ${email} does not exist on Google.`);
        try {
            await fetch('http://127.0.0.1:4000/api/accounts/status', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email, status: 'ACCOUNT_NOT_FOUND' })
            }).catch((e) => Logger.error('Failed to notify API of ACCOUNT_NOT_FOUND status:', e.message));
        } catch (e: any) {
            Logger.error('Error in markAsNoActive fetch:', e.message);
        }
    }

    private saveFailedAccount(email: string, password?: string) {
        try {
            const line = `${email}:${password || ''}\n`;
            fs.appendFileSync(path.resolve(process.cwd(), 'accounts-noverify.txt'), line);
            Logger.info(`📝 Saved failed account to accounts-noverify.txt`);
        } catch (e) {
            Logger.error(`Failed to write to accounts-noverify.txt: ${e}`);
        }
    }
}
