const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function gcloudAuthLogin(email, password, tilingId = 1, configDir = null, headless = true, keyFilePath = null) {
    console.log(`[gcloud Auth] Authenticating ${email} (Service Account mode)...`);

    const isWindows = process.platform === 'win32';
    const gcloudPath = process.env.GCLOUD_PATH || (isWindows ? 'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd' : 'gcloud');
    const env = { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' };
    if (configDir) { env.CLOUDSDK_CONFIG = configDir; console.log(`[gcloud Auth] Using Isolated Config: ${configDir}`); }

    const runGcloud = (args, timeoutMs = 60000) => {
        return new Promise((resolve, reject) => {
            console.log(`[gcloud Auth] Running: gcloud ${args.join(' ')}`);
            const cmd = isWindows ? 'cmd.exe' : gcloudPath;
            const cmdArgs = isWindows ? ['/c', `"${gcloudPath}"`, ...args] : args;
            const proc = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: isWindows, env });
            let stdout = '', stderr = '';
            proc.stdout.on('data', d => { stdout += d.toString(); });
            proc.stderr.on('data', d => { stderr += d.toString(); });
            const timer = setTimeout(() => { proc.kill(); reject(new Error(`gcloud ${args[0]} timed out`)); }, timeoutMs);
            proc.on('close', code => {
                clearTimeout(timer);
                if (code === 0 || stderr.includes('Activated service account credentials')) resolve(stdout.trim());
                else reject(new Error(`gcloud ${args[0]} failed (code ${code}): ${stderr.trim()}`));
            });
            proc.on('error', err => { clearTimeout(timer); reject(err); });
        });
    };

    let resolvedKeyFile = keyFilePath;
    if (!resolvedKeyFile) {
        const safeEmail = email.replace('@', '_at_').replace(/\./g, '_');
        const tmpKeyPath = path.join(__dirname, 'tmp', 'manage-keys', `${safeEmail}.json`);
        if (fs.existsSync(tmpKeyPath)) { resolvedKeyFile = tmpKeyPath; console.log(`[gcloud Auth] Found cached key: ${tmpKeyPath}`); }
    }

    if (resolvedKeyFile && fs.existsSync(resolvedKeyFile)) {
        console.log(`[gcloud Auth] Using service account key: ${resolvedKeyFile}`);
        try {
            await runGcloud(['auth', 'activate-service-account', `--key-file=${resolvedKeyFile}`], 60000);
            console.log(`[gcloud Auth] Service account activated for ${email}`);
            try {
                const keyData = JSON.parse(fs.readFileSync(resolvedKeyFile, 'utf8'));
                if (keyData.project_id) { await runGcloud(['config', 'set', 'project', keyData.project_id], 30000); console.log(`[gcloud Auth] Project set: ${keyData.project_id}`); }
            } catch (e) { console.warn(`[gcloud Auth] Could not set project: ${e.message}`); }
            return;
        } catch (err) {
            console.error(`[gcloud Auth] Service account failed: ${err.message} — falling back to browser flow`);
        }
    } else {
        console.warn(`[gcloud Auth] No key file for ${email} — using browser OAuth fallback`);
    }

    const puppeteer = require('puppeteer');
    const CaptchaService = require('./services/captchaService.js').default;
    const UserAgent = require('user-agents');
    const configPath = path.join(__dirname, 'config.json');
    let config = {};
    try { if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {}
    const captchaService = new CaptchaService(config.captchaKey || process.env.CAPTCHA_API_KEY || '');

    const chromeCandidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ].filter(Boolean);
    const executablePath = chromeCandidates.find(p => fs.existsSync(p));

    const launchOptions = {
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-blink-features=AutomationControlled','--lang=en-US','--window-size=1280,800']
    };
    if (executablePath) {
        launchOptions.executablePath = executablePath;
        console.log(`[gcloud Auth] Using Chrome executable: ${executablePath}`);
    }

    const browser = await puppeteer.launch(launchOptions);

    try {
        const page = await browser.newPage();
        await page.setUserAgent(new UserAgent({ deviceCategory: 'desktop' }).toString());
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await page.setViewport({ width: 1280, height: 800 });

        const spawnCmd = isWindows ? 'cmd.exe' : gcloudPath;
        const spawnArgs = isWindows ? ['/c', `"${gcloudPath}"`, 'auth', 'login', '--no-launch-browser'] : ['auth', 'login', '--no-launch-browser'];
        const authProcess = spawn(spawnCmd, spawnArgs, { stdio: ['pipe','pipe','pipe'], windowsVerbatimArguments: isWindows, env });

        let authUrl = '', stdoutBuffer = '', stderrBuffer = '';
        const extractUrl = (text) => {
            const m = text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s"']+/);
            if (m) return m[0];
            const m2 = text.match(/https:\/\/accounts\.google\.com[^\s]+/);
            if (m2 && m2[0].includes('oauth2')) return m2[0];
            return null;
        };
        authProcess.stdout.on('data', d => { stdoutBuffer += d.toString(); const u = extractUrl(stdoutBuffer); if (u && !authUrl) { authUrl = u; } });
        authProcess.stderr.on('data', d => { stderrBuffer += d.toString(); const u = extractUrl(stderrBuffer); if (u && !authUrl) { authUrl = u; } });

        for (let i = 0; i < 60; i++) { if (authUrl) break; await new Promise(r => setTimeout(r, 500)); }
        if (!authUrl) throw new Error('Could not capture gcloud auth URL');

        authUrl += (authUrl.includes('?') ? '&' : '?') + 'hl=en';
        try {
            await page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        } catch (navErr) {
            if ((navErr.message || '').includes('ERR_NAME_NOT_RESOLVED')) {
                authProcess.kill();
                throw new Error('DNS_FAIL: ERR_NAME_NOT_RESOLVED — proxy machi khaddam wla DNS mashi configured');
            }
            // Non-fatal nav error (networkidle2 timeout) — page may still be usable
        }

        try {
            const emailInput = await page.waitForSelector('input[type="email"], input[name="identifier"], #identifierId', { visible: true, timeout: 15000 });
            if (emailInput) { 
                await emailInput.click({ clickCount: 3 }); await page.keyboard.press('Backspace');
                await emailInput.type(email); 
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 4000)); 
            }
        } catch (e) {
            console.warn('[gcloud Auth] Could not find email input or already passed:', e.message);
        }

        let captchaAttempts = 0, isCaptchaResolved = false;
        while (!isCaptchaResolved && captchaAttempts < 3) {
            captchaAttempts++;
            const result = await Promise.race([
                page.waitForSelector('input[type="password"]', { visible: true, timeout: 30000 }).then(() => 'password'),
                page.waitForSelector('#captchaimg', { visible: true, timeout: 30000 }).then(() => 'captcha'),
                page.waitForSelector('input[name="ca"]', { visible: true, timeout: 30000 }).then(() => 'captcha'),
                page.waitForSelector('input[aria-label="Type the text you hear or see"]', { visible: true, timeout: 30000 }).then(() => 'captcha')
            ]).catch(() => 'timeout');

            if (result === 'password') { isCaptchaResolved = true; break; }
            if (result === 'captcha') {
                const captchaImg = await page.$('#captchaimg') || await page.$('img[src*="captcha"]');
                const captchaInput = await page.$('input[name="ca"], input[aria-label="Type the text you hear or see"]');
                if (captchaImg && captchaInput) {
                    const bbox = await captchaImg.boundingBox();
                    if (bbox && bbox.width > 0) {
                        const base64Image = await captchaImg.screenshot({ encoding: 'base64' });
                        const solution = await captchaService.solveImageCaptcha(base64Image);
                        if (solution.success) {
                            await captchaInput.click({ clickCount: 3 }); await page.keyboard.press('Backspace');
                            for (const char of solution.solution) await captchaInput.type(char, { delay: Math.random() * 100 + 50 });
                            await page.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 4000));
                            if (!await page.$('#captchaimg')) isCaptchaResolved = true;
                        }
                    } else { console.warn('[gcloud Auth] CAPTCHA image 0 dimensions, skipping'); await page.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 2000)); }
                }
            } else if (captchaAttempts === 3) throw new Error('Timeout waiting for Password/CAPTCHA');
        }

        if (isCaptchaResolved) {
            await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
            await new Promise(r => setTimeout(r, 1000));
            await page.type('input[type="password"]', password);
            await page.click('#passwordNext');
            console.log('[gcloud Auth] Checking for OTP...');
            const { handleOTPIfRequested } = require('./autoOTPHandler.cjs');
            await new Promise(r => setTimeout(r, 3000));
            await handleOTPIfRequested(page, email, 10000);
        } else { throw new Error('Failed to resolve Login/CAPTCHA flow.'); }

        let verificationCode = '';
        const getCode = async () => await page.evaluate(() => {
            const re = /^4\/[0-9a-zA-Z_-]{20,}/;
            for (const t of document.querySelectorAll('textarea')) if (t.value && re.test(t.value)) return t.value;
            for (const el of document.querySelectorAll('code,samp,pre,kbd,.kHXSqf')) { const tx = el.innerText||el.textContent||''; if (re.test(tx.trim())) return tx.trim(); }
            const m = document.body.innerText.match(/4\/[0-9a-zA-Z_-]{20,}/); return m ? m[0] : '';
        });

        for (let i = 0; i < 60; i++) {
            try { verificationCode = await getCode(); } catch(e) {}
            if (verificationCode) { console.log(`[gcloud Auth] FOUND CODE: ${verificationCode.substring(0,10)}...`); break; }
            try {
                await page.evaluate(() => {
                    const btn = Array.from(document.querySelectorAll('button,span[role="button"]')).find(b => {
                        const t = (b.innerText||b.textContent||'').toLowerCase();
                        if (t.includes('cancel')||t.includes('deny')||t.includes('back')) return false;
                        return t.includes('allow')||t.includes('continue')||t.includes('trus')||t.includes('confir')||t.includes('accept')||t.includes('autoriser');
                    });
                    if (btn && btn.offsetParent !== null && !btn.disabled) { btn.click(); return true; }
                    return false;
                });
            } catch(e) {}
            await new Promise(r => setTimeout(r, 2000));
        }

        if (!verificationCode) {
            // disabled screenshot
            authProcess.kill();
            throw new Error('gcloud auth failed: could not capture OAuth verification code (screenshot saved)');
        }

        authProcess.stdin.write(verificationCode + '\n');
        authProcess.stdin.end();

        return new Promise((resolve, reject) => {
            // 180s timeout after writing the code — gcloud should respond quickly
            const timeout = setTimeout(() => { authProcess.kill(); reject(new Error('Auth process timed out (180s after code submission)')); }, 180000);
            authProcess.on('close', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(`gcloud auth exited with code ${code}`)); });
            authProcess.on('error', err => { clearTimeout(timeout); reject(err); });
        });
    } finally { await browser.close(); }
}

function cleanupOldScreenshots(dir = __dirname, keepLast = 20) {
    try {
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.png') && (f.startsWith('gcloud-auth-failure')||f.startsWith('auth-timeout')||f.startsWith('dwd-debug')||f.startsWith('2fa-error')||f.startsWith('2fa-security')))
            .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        const toDelete = files.slice(keepLast);
        for (const f of toDelete) fs.unlinkSync(path.join(dir, f.name));
        if (toDelete.length > 0) console.log(`[Cleanup] Deleted ${toDelete.length} old screenshots`);
    } catch (e) { console.warn('[Cleanup] Failed:', e.message); }
}

module.exports = { gcloudAuthLogin, cleanupOldScreenshots };
