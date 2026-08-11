import * as puppeteer from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import thirtyTwo from 'thirty-two';
import crypto from 'crypto';
import UserAgent from 'user-agents';
import { Logger } from '../../utils/logger.js';
import { SSHUploader } from '../../services/ssh/SSHUploader.js';

// Services
import SMSService from '../../../services/smsService.js';
import CaptchaService from '../../../services/captchaService.js';
import CloudflareService from '../../../services/cloudflareService.js';
import { detectDnsProvider, upsertDnsTxt, upsertDnsMx } from '../../../services/dnsProvider.js';


const HEADLESS = true; // Use headless for production/automation
const SMS_API_KEY = '52f6060efdA770541bf3e867A6ccbdAb';
const CAPTCHA_API_KEY = '4a8189e5ca7d59ebcd481b14387f58e4';
const CF_EMAIL = 'abdo.charhamane@gmail.com';
const CF_API_KEY = '541da7b4fd89331cc0abe3cf712b1786e35ce';

export class AccountVerifier {
    private smsService: any;
    private captchaService: any;
    private cloudflareService: any;
    private sshUploader: SSHUploader | null = null;

    constructor() {
        const config = this.loadConfig();

        // Use config values or fallback to constants
        const smsKey = config.heroSmsKey || SMS_API_KEY;
        this.smsService = new SMSService(smsKey);

        this.captchaService = new CaptchaService(CAPTCHA_API_KEY);

        const cfEmail = config.cloudflareEmail || CF_EMAIL;
        const cfKey = config.cloudflareKey || CF_API_KEY;
        this.cloudflareService = new CloudflareService(cfEmail, cfKey);

        // SFTP Setup
        if (config.sftpHost) {
            this.sshUploader = new SSHUploader({
                host: config.sftpHost,
                port: parseInt(config.sftpPort || '22'),
                username: config.sftpUser || 'root',
                password: config.sftpPassword || '',
                basePath: config.sftpPath || '/home/brightmindscampus'
            });
        }
    }

    private loadConfig(): any {
        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            }
        } catch (e: any) { Logger.warn('Failed to load config: ' + e.message); }
        return {};
    }

    private pickProxy(): { arg: string; user?: string; pass?: string } | null {
        const config = this.loadConfig();
        if (!config.proxiesEnabled || !config.proxiesList) return null;
        const lines = config.proxiesList.split('\n').map((l: string) => l.trim()).filter(Boolean);
        if (lines.length === 0) return null;
        const proxy = lines[Math.floor(Math.random() * lines.length)];

        // Always http:// — credentials go via page.authenticate() not in the URL.
        // socks5 with auth is unsupported in Chromium/Puppeteer without a local proxy tunnel.
        const parts = proxy.split(':');
        if (parts.length < 2) return null;
        const [host, port, user, pass] = parts;
        Logger.info(`🌐 Proxy: http://${host}:${port} (auth: ${user ? 'yes' : 'no'})`);
        return {
            arg: `--proxy-server=http://${host}:${port}`,
            user: user || undefined,
            pass: pass || undefined
        };
    }

    private isProxyError(msg: string): boolean {
        return msg.includes('ERR_PROXY_CONNECTION_FAILED') ||
               msg.includes('ERR_SOCKS_CONNECTION_FAILED') ||
               msg.includes('ERR_NO_SUPPORTED_PROXIES') ||
               msg.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
               msg.includes('ERR_PROXY_AUTH_UNSUPPORTED') ||
               msg.includes('ERR_NAME_NOT_RESOLVED') ||
               msg.includes('ERR_CONNECTION_TIMED_OUT') ||
               msg.includes('ERR_INTERNET_DISCONNECTED');
    }

    async checkExistence(email: string): Promise<{ exists: boolean; error?: string }> {
        Logger.info(`🕵️ Checking existence for: ${email}`);
        let browser: any = null;
        try {
            const proxy = this.pickProxy();
            const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
            if (proxy) launchArgs.push(proxy.arg);

            const userAgent = new UserAgent({ deviceCategory: 'desktop' });
            browser = await puppeteer.launch({
                headless: true,
                args: launchArgs
            });

            const page = await browser.newPage();
            if (proxy?.user && proxy?.pass) await page.authenticate({ username: proxy.user, password: proxy.pass });
            await page.setUserAgent(userAgent.toString());
            await page.goto('https://accounts.google.com/signin/v2/identifier?hl=en&flowName=GlifWebSignIn&flowEntry=ServiceLogin', { waitUntil: 'networkidle2' });

            await page.waitForSelector('input[type="email"], input[name="identifier"], #identifierId');
            
            // Speed optimization: Use direct typing for existence check (no jitter needed for simple existence check)
            const emailInput = await page.$('input[type="email"], input[name="identifier"], #identifierId');
            await emailInput.click({ clickCount: 3 }); await page.keyboard.press('Backspace');
            await emailInput.type(email, { delay: 10 }); 
            await page.keyboard.press('Enter');

            // Wait for reaction
            const result = await Promise.race([
                page.waitForSelector('input[type="password"]', { visible: true, timeout: 8000 }).then(() => 'exists'),
                page.waitForSelector('#captchaimg', { visible: true, timeout: 8000 }).then(() => 'exists'),
                page.waitForFunction(() => {
                    const body = document.body.innerText;
                    return body.includes("Couldn't find your Google Account") ||
                        body.includes("Enter a valid email") ||
                        body.includes("too many failed attempts");
                }, { timeout: 8000 }).then(() => 'not_found'),
                new Promise(resolve => setTimeout(() => resolve('timeout'), 8000))
            ]).catch(() => 'timeout');


            // Only sleep if we really need to (avoiding arbitrary 1s wait)
            if (result === 'timeout') {
                await new Promise(r => setTimeout(r, 500));
            }

            // On timeout: only check page text if we're still on accounts.google.com identifier page
            // to avoid false positives from proxy error pages
            const currentUrl = page.url();
            const isOnGoogleAuth = currentUrl.includes('accounts.google.com');

            if (result === 'timeout' && !isOnGoogleAuth) {
                // Proxy geo-blocked or redirected — cannot determine, assume exists
                Logger.warn(`⚠️ [checkExistence] Proxy redirected away from Google for ${email} (${currentUrl.substring(0, 80)}) — assuming EXISTS`);
                return { exists: true, error: 'Proxy geo-issue — assuming exists' };
            }

            const pageText = await page.evaluate(() => document.body.innerText);

            if (isOnGoogleAuth && (
                pageText.includes("Couldn't find your Google Account") ||
                pageText.includes("Enter a valid email") ||
                pageText.includes("couldn't find") ||
                pageText.includes("doesn't exist"))) {
                Logger.warn(`❌ Account ${email} does not exist.`);
                return { exists: false };
            }

            if (result === 'exists') {
                Logger.info(`✅ Account ${email} exists.`);
                return { exists: true };
            } else if (result === 'not_found') {
                Logger.warn(`❌ Account ${email} does not exist.`);
                return { exists: false };
            } else {
                // Timeout with no clear signal — assume exists to avoid false ACCOUNT_NOT_FOUND
                Logger.warn(`⚠️ [checkExistence] Timeout for ${email} — assuming EXISTS to avoid false rejection`);
                return { exists: true, error: 'Check timed out — assumed exists' };
            }

        } catch (error: any) {
            // Proxy errors (ERR_PROXY_CONNECTION_FAILED etc.) must NOT mark accounts as not found
            if (this.isProxyError(error.message)) {
                Logger.warn(`⚠️ [checkExistence] Proxy error for ${email}: ${error.message} — assuming EXISTS`);
                return { exists: true, error: `Proxy error: ${error.message}` };
            }
            Logger.error(`❌ Existence check failed: ${error.message}`);
            return { exists: false, error: error.message };
        } finally {
            if (browser) await browser.close();
        }
    }

    private async humanLikeType(element: any, text: string) {
        for (const char of text) {
            await element.type(char, { delay: Math.random() * 30 + 20 }); // Faster but still human-ish (down from 100+50)
        }
    }

    private async formatPhoneNumberForInput(number: string) {
        if (number.startsWith('+')) return number;
        return '+' + number;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Check if domain is already verified in Google Admin Console
    // ─────────────────────────────────────────────────────────────────────────
    private async isDomainVerified(page: any, fullDomain: string, rootDomain: string, subDomain: string): Promise<boolean> {
        try {
            Logger.info(`🔍 Checking if domain ${fullDomain} is already verified...`);
            
            // Navigate to domains management page
            await page.goto('https://admin.google.com/ac/domains/manage?hl=en', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
            await new Promise(r => setTimeout(r, 4000));
            
            const isVerified = await page.evaluate((domainName: string) => {
                const bodyText = document.body.innerText.toLowerCase();
                
                // If the domain is not even on the page, it's definitely not verified/present
                if (!bodyText.includes(domainName.toLowerCase())) {
                    return false;
                }

                // 1. Try to inspect DOM rows (tables or grid rows)
                const rows = Array.from(document.querySelectorAll('tr, div[role="row"], li, div.layout-row'));
                for (const row of rows) {
                    const rowText = (row.textContent || '').toLowerCase();
                    const hasDomain = rowText.includes(domainName.toLowerCase());
                    const isTestAlias = rowText.includes(domainName.toLowerCase() + '.test-google-a.com');

                    if (hasDomain && !isTestAlias && rowText.length < 500) {
                        // Check if there is an exact cell/link matching the domain to avoid false matches
                        const subElements = Array.from(row.querySelectorAll('a, span, div, td'));
                        const hasExactMatch = subElements.some(el => (el.textContent || '').trim().toLowerCase() === domainName.toLowerCase());

                        if (hasExactMatch || rowText.startsWith(domainName.toLowerCase()) || rowText.includes(' ' + domainName.toLowerCase() + ' ') || rowText.includes('\n' + domainName.toLowerCase())) {
                            // Check status in this specific row/card
                            const isNotVerif = rowText.includes('not verified') || rowText.includes('unverified') || rowText.includes('verify') || rowText.includes('set up') || rowText.includes('progress') || rowText.includes('pending');
                            const isVerif = rowText.includes('verified') || rowText.includes('active') || rowText.includes('primary domain') || rowText.includes('secondary domain') || rowText.includes('✓');
                            
                            if (isVerif && !isNotVerif) {
                                return true;
                            }
                            if (isNotVerif) {
                                return false;
                            }
                        }
                    }
                }

                // 2. Surrounding text analysis fallback
                const index = bodyText.indexOf(domainName.toLowerCase());
                if (index !== -1) {
                    // Check if it's the test-google-a.com alias
                    const isTestAlias = bodyText.substring(index).startsWith(domainName.toLowerCase() + '.test-google-a.com');
                    if (isTestAlias) {
                        // Look if there's another occurrence of the domain name
                        const nextIndex = bodyText.indexOf(domainName.toLowerCase(), index + 1);
                        if (nextIndex === -1) return false;
                    }
                    
                    const startIdx = Math.max(0, index - 150);
                    const endIdx = Math.min(bodyText.length, index + domainName.length + 150);
                    const context = bodyText.substring(startIdx, endIdx);
                    
                    const isNotVerif = context.includes('not verified') || context.includes('unverified') || context.includes('verify') || context.includes('set up') || context.includes('progress') || context.includes('pending');
                    const isVerif = context.includes('verified') || context.includes('active') || context.includes('primary domain') || context.includes('secondary domain') || context.includes('✓');
                    
                    if (isVerif && !isNotVerif) {
                        return true;
                    }
                }
                
                return false;
            }, fullDomain);
            
            if (isVerified) {
                Logger.info(`✅ Found '${fullDomain}' with verified status in Admin Console`);
                return true;
            }
            
            Logger.info(`ℹ️ Domain ${fullDomain} is not yet verified`);
            return false;
        } catch (error: any) {
            Logger.warn(`⚠️ Could not determine if domain is verified: ${error.message}`);
            return false; // Assume not verified if check fails — proceed with verification
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phone-Only Verification: Login → detect phone page → SMS verify → done
    // ─────────────────────────────────────────────────────────────────────────
    async phoneVerifyOnly(email: string, password: string, headless: boolean = HEADLESS): Promise<{ success: boolean; error?: string }> {
        Logger.info(`📱 [phoneVerifyOnly] Starting for: ${email}`);
        let browser: any = null;
        try {
            const proxy = this.pickProxy();
            const userAgent = new UserAgent({ deviceCategory: 'desktop' });
            browser = await puppeteer.launch({
                headless: headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--window-size=960,520',
                    '--window-position=0,0',
                    ...(proxy ? [proxy.arg] : [])
                ],
                ignoreDefaultArgs: ['--enable-automation']
            });

            const page = await browser.newPage();
            if (proxy?.user && proxy?.pass) await page.authenticate({ username: proxy.user, password: proxy.pass });
            await page.setUserAgent(userAgent.toString());
            await page.setViewport({ width: 960, height: 520 });
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

            // Step 1: Navigate and login
            Logger.info(`📱 [phoneVerifyOnly] Navigating to Google sign-in...`);
            await page.goto('https://accounts.google.com/signin/v2/identifier?hl=en&flowName=GlifWebSignIn&flowEntry=ServiceLogin', { waitUntil: 'networkidle2' });

            await page.waitForSelector('input[type="email"], input[name="identifier"], #identifierId', { visible: true, timeout: 30000 });
            const emailInput = await page.$('input[type="email"], input[name="identifier"], #identifierId');
            if (emailInput) {
                await this.humanLikeType(emailInput, email);
            } else {
                throw new Error('Email input not found');
            }
            await page.keyboard.press('Enter');
            
            // ── WAIT FOR RESPONSE: Password, Error, or Captcha ──
            Logger.info(`⏳ Waiting for response after email entry for ${email}...`);
            const responseType = await Promise.race([
                page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 }).then(() => 'password'),
                page.waitForSelector('input[name="ca"], input[aria-label*="captcha" i]', { visible: true, timeout: 10000 }).then(() => 'captcha'),
                page.waitForFunction(() => {
                    const text = document.body.innerText.toLowerCase();
                    return text.includes("couldn't find your google account") ||
                           text.includes("could not find your google account") ||
                           text.includes("no google account found") ||
                           text.includes("enter a valid email") ||
                           text.includes("this account was recently deleted");
                }, { timeout: 10000 }).then(() => 'not_found'),
            ]).catch(() => 'timeout');

            if (responseType === 'not_found') {
                Logger.warn(`⚠️ ACCOUNT_NOT_FOUND detected for ${email}`);
                if (browser) await browser.close();
                return { success: false, error: 'ACCOUNT_NOT_FOUND' };
            }

            if (responseType === 'timeout') {
                Logger.info(`⏱️ Response timeout for ${email} — running aggressive existence check...`);
                if (await this.isAccountNotFound(page)) {
                    Logger.warn(`⚠️ ACCOUNT_NOT_FOUND detected for ${email}`);
                    if (browser) await browser.close();
                    return { success: false, error: 'ACCOUNT_NOT_FOUND' };
                }
                Logger.info(`🔍 Aggressive check found nothing — proceeding as if account exists`);
            }

            // Enter password
            const passInput = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 }).catch(() => null);
            if (!passInput) throw new Error('Password input not found');
            await this.humanLikeType(passInput, password);
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 3000));

            // Step 2: Check what kind of challenge we're on
            Logger.info(`📱 [phoneVerifyOnly] Checking challenge type on: ${page.url()}`);
            const currentUrl = page.url();

            // Detect 2FA / Authenticator challenge (not a phone number page)
            const isAuthenticatorPage = currentUrl.includes('/challenge/iap') ||
                currentUrl.includes('/challenge/totp') ||
                currentUrl.includes('/challenge/ipp');

            if (isAuthenticatorPage) {
                Logger.warn(`⚠️ [phoneVerifyOnly] Detected Google Authenticator/2FA page — not a phone number prompt. Skipping SMS.`);
                await browser.close().catch(() => { });
                return { success: false, error: 'Account requires Google Authenticator (2FA), not SMS phone verification.' };
            }

            // Also check page text to detect Authenticator
            const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
            const isAuthenticatorByText = pageText.toLowerCase().includes('authenticator app') ||
                pageText.toLowerCase().includes('google authenticator') ||
                pageText.toLowerCase().includes('enter code from') ||
                pageText.toLowerCase().includes('verification app');

            if (isAuthenticatorByText) {
                Logger.warn(`⚠️ [phoneVerifyOnly] Page content shows Authenticator app challenge — not phone SMS. Skipping.`);
                await browser.close().catch(() => { });
                return { success: false, error: 'Account requires Google Authenticator (2FA), not SMS phone verification.' };
            }

            const phoneInput = await page.waitForSelector('input[type="tel"][name="phoneNumber"], input[name="phoneNumber"]', { visible: true, timeout: 10000 }).catch(() => null)
                ?? await page.waitForSelector('input[type="tel"]', { visible: true, timeout: 5000 }).catch(() => null);

            if (!phoneInput) {
                // Maybe already logged in (no phone needed)
                if (currentUrl.includes('myaccount.google.com') || currentUrl.includes('admin.google.com')) {
                    Logger.info(`✅ [phoneVerifyOnly] Already logged in — no phone verification needed.`);
                    return { success: true };
                }
                throw new Error(`Phone input not found. Current URL: ${currentUrl}`);
            }

            // Step 3: SMS geo-fallback (Indonesia → Colombia)
            const geoList = [
                { country: '6', name: 'Indonesia' },
                { country: '33', name: 'Colombia' }
            ];
            let geoIndex = 0;
            let geoFailures = 0;
            let phoneSuccess = false;
            const maxAttempts = 6;
            let attempts = 0;

            while (!phoneSuccess && attempts < maxAttempts) {
                attempts++;
                const currentGeo = geoList[geoIndex];
                Logger.info(`📱 [phoneVerifyOnly] Attempt ${attempts}/${maxAttempts} — Geo: ${currentGeo.name}`);

                try {
                    // Fresh phone input ref each attempt
                    await page.waitForSelector('input[type="tel"]', { visible: true, timeout: 8000 }).catch(() => null);
                    const freshPhoneInput = await page.$('input[type="tel"]').catch(() => null);
                    if (!freshPhoneInput) { Logger.warn('Phone input gone, stopping.'); break; }

                    const numberResult = await this.smsService.getNumber(currentGeo.country);
                    if (!numberResult.success) throw new Error(numberResult.error);

                    const { id: activationId, number } = numberResult;
                    Logger.info(`📱 Got number: ${number} (${currentGeo.name})`);
                    const inputPhone = await this.formatPhoneNumberForInput(number);

                    // Type number
                    let phoneRejected = false;
                    try {
                        await freshPhoneInput.click({ clickCount: 3 });
                        await page.keyboard.press('Backspace');
                        await this.humanLikeType(freshPhoneInput, inputPhone);
                        await page.keyboard.press('Enter');
                        await new Promise(r => setTimeout(r, 5000));

                        // Check rejection
                        const phoneError = await page.evaluate(() => {
                            const text = document.body.innerText.toLowerCase();
                            if (text.includes("phone number can't be used for verification")) return "cant_be_used";
                            if (text.includes("too many unsuccessful attempts")) return "too_many_attempts";
                            if (text.includes("phone number has already been used")) return "already_used";
                            if (text.includes("this number format is not recognized")) return "bad_format";
                            if (text.includes("couldn't send a verification code")) return "send_failed";
                            return null;
                        }).catch(() => null);

                        if (phoneError) {
                            geoFailures++;
                            Logger.warn(`⚠️ Rejected [${phoneError}]: ${number} (${currentGeo.name}) — ${geoFailures}/3`);
                            await this.smsService.cancelNumber(activationId).catch(() => { });
                            if (geoFailures >= 3 && geoIndex < geoList.length - 1) {
                                geoIndex++; geoFailures = 0;
                                Logger.info(`🌍 Switching → ${geoList[geoIndex].name}`);
                            }
                            phoneRejected = true;
                        }
                    } catch (navErr: any) {
                        if (navErr.message?.includes('context') || navErr.message?.includes('navigat') || navErr.message?.includes('detached')) {
                            Logger.info(`✅ Navigation after phone submit — number likely accepted`);
                            await new Promise(r => setTimeout(r, 3000));
                        } else throw navErr;
                    }

                    if (phoneRejected) continue;

                    // Notify provider
                    await this.smsService.setStatus(activationId, 1);

                    // Wait for OTP input
                    const codeSelectors = [
                        'input[name="code"]',
                        'input[type="tel"]:not([name="phoneNumber"])',
                        'input[jsname="YPqjbf"]',
                        'input[aria-label="Enter code"]',
                        'input[autocomplete="one-time-code"]'
                    ];
                    let smsCodeInput: any = null;
                    for (const sel of codeSelectors) {
                        smsCodeInput = await page.waitForSelector(sel, { visible: true, timeout: 8000 }).catch(() => null);
                        if (smsCodeInput) { Logger.info(`✅ Code input found: ${sel}`); break; }
                    }

                    if (smsCodeInput) {
                        Logger.info(`⏳ Waiting for SMS code (up to 120s)...`);
                        const startTime = Date.now();
                        let codeResult: { success: boolean, code?: string, error?: string } = { success: false, error: 'TIMEOUT' };
                        let hitPageError = false;

                        while (Date.now() - startTime < 120000) {
                            // Check SMS service
                            const status = await this.smsService.checkStatus(activationId);
                            if (status.includes('STATUS_OK')) {
                                codeResult = { success: true, code: status.split(':')[1] };
                                break;
                            } else if (status === 'STATUS_CANCEL') {
                                codeResult = { success: false, error: 'Activation cancelled' };
                                break;
                            }

                            // Check Page for errors (Try another way, etc)
                            const pageState = await page.evaluate(() => {
                                const text = document.body.innerText.toLowerCase();
                                const isSendingError = text.includes("there was a problem sending") ||
                                    text.includes("try again") ||
                                    text.includes("request a new code");

                                // Find "Try another way" button
                                const tryAnotherWay = Array.from(document.querySelectorAll('button, span[role="button"]'))
                                    .find(b => b.textContent?.toLowerCase().includes("try another way"));

                                if (isSendingError) {
                                    if (tryAnotherWay) { (tryAnotherWay as HTMLElement).click(); return "error_and_clicked"; }
                                    return "error_only";
                                }
                                return "ok";
                            }).catch(() => "ok");

                            if (pageState !== "ok") {
                                Logger.warn(`⚠️ SMS sending error detected: ${pageState}`);
                                await this.smsService.cancelNumber(activationId).catch(() => { });
                                hitPageError = true;
                                break;
                            }

                            await new Promise(r => setTimeout(r, 5000));
                        }

                        if (hitPageError) {
                            Logger.info(`🔄 Retrying with another attempt due to page error...`);
                            // Reset for next attempt
                            await new Promise(r => setTimeout(r, 3000));
                            continue;
                        }

                        if (codeResult.success && codeResult.code) {
                            Logger.info(`✅ Got SMS code: ${codeResult.code}`);
                            await smsCodeInput.click({ clickCount: 3 });
                            await page.keyboard.down('Control');
                            await page.keyboard.press('A');
                            await page.keyboard.up('Control');
                            await page.keyboard.press('Backspace');
                            await new Promise(r => setTimeout(r, 300));
                            await this.humanLikeType(smsCodeInput, codeResult.code);
                            await page.keyboard.press('Enter');
                            await this.smsService.confirmSuccess(activationId);
                            phoneSuccess = true;
                            Logger.info(`✅ [phoneVerifyOnly] Phone verified successfully for ${email}`);
                        } else {
                            geoFailures++;
                            Logger.warn(`❌ No SMS code (${codeResult.error}) — ${geoFailures}/3`);
                            await this.smsService.cancelNumber(activationId);
                            if (geoFailures >= 3 && geoIndex < geoList.length - 1) {
                                geoIndex++; geoFailures = 0;
                                Logger.info(`🌍 Switching → ${geoList[geoIndex].name}`);
                            }
                        }
                    } else {
                        geoFailures++;
                        Logger.warn(`❌ Code input selector not found — ${geoFailures}/3`);
                        await this.smsService.cancelNumber(activationId);
                        if (geoFailures >= 3 && geoIndex < geoList.length - 1) {
                            geoIndex++; geoFailures = 0;
                            Logger.info(`🌍 Switching → ${geoList[geoIndex].name}`);
                        }
                    }
                } catch (e: any) { Logger.warn(`Phone attempt error: ${e.message}`); }
            }

            if (!phoneSuccess) throw new Error('Phone verification failed after all attempts');
            return { success: true };

        } catch (err: any) {
            Logger.error(`📱 [phoneVerifyOnly] Failed for ${email}: ${err.message}`);
            return { success: false, error: err.message };
        } finally {
            if (browser) await browser.close().catch(() => { });
        }
    }

    async verify(email: string, password: string, tilingId: number = 1, headless: boolean = HEADLESS): Promise<{ success: boolean; email?: string; password?: string; error?: string; domainAlreadyVerified?: boolean }> {
        Logger.info(`🚀 Starting Verification for: ${email}`);

        // Window sizing for tiling (if needed, mimicking basic tiling or just use standard)
        // const windowArgs = `--window-position=${(tilingId % 3) * 400},0`; 

        let browser: any = null;
        try {
            // ── Auto-tiling: position each browser window in its own screen tile ──
            // Screen: 1920×1080, 2 columns grid
            const SCREEN_W = 1920;
            const SCREEN_H = 1040; // leave 40px for taskbar
            const COLS = 2;
            const tileW = Math.floor(SCREEN_W / COLS);
            const tileH = Math.floor(SCREEN_H / COLS); // rows = COLS for square grid
            const idx = (tilingId - 1) % (COLS * COLS); // 0-based index wrapping
            const col = idx % COLS;
            const row = Math.floor(idx / COLS);
            const posX = col * tileW;
            const posY = row * tileH;
            Logger.info(`🪟 Session ${tilingId} → tile [col=${col} row=${row}] pos=(${posX},${posY}) size=${tileW}×${tileH}`);
            // ──────────────────────────────────────────────────────────────────────

            const proxy = this.pickProxy();
            const userAgent = new UserAgent({ deviceCategory: 'desktop' });
            browser = await puppeteer.launch({
                headless: headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    `--window-size=${tileW},${tileH}`,
                    `--window-position=${posX},${posY}`,
                    ...(proxy ? [proxy.arg] : [])
                ],
                ignoreDefaultArgs: ['--enable-automation']
            });

            let page = await browser.newPage();
            if (proxy?.user && proxy?.pass) await page.authenticate({ username: proxy.user, password: proxy.pass });
            await page.setUserAgent(userAgent.toString());
            await page.setViewport({ width: tileW, height: tileH });
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

            // Navigation — fallback to direct if proxy fails
            const GOOGLE_SIGN_IN = 'https://accounts.google.com/signin/v2/identifier?hl=en&flowName=GlifWebSignIn&flowEntry=ServiceLogin';
            try {
                await page.goto(GOOGLE_SIGN_IN, { waitUntil: 'networkidle2' });
            } catch (navErr: any) {
                if (proxy && this.isProxyError(navErr.message || '')) {
                    Logger.warn(`⚠️ Proxy unreachable (${(navErr.message || '').split(' at ')[0]}), falling back to direct connection`);
                    await browser.close();
                    browser = await puppeteer.launch({
                        headless: headless,
                        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', `--window-size=${tileW},${tileH}`, `--window-position=${posX},${posY}`],
                        ignoreDefaultArgs: ['--enable-automation']
                    });
                    page = await browser.newPage();
                    await page.setUserAgent(userAgent.toString());
                    await page.setViewport({ width: tileW, height: tileH });
                    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
                    await page.goto(GOOGLE_SIGN_IN, { waitUntil: 'networkidle2' });
                } else {
                    throw navErr;
                }
            }

            // Email
            Logger.info(`✍️ Entering email for ${email}...`);
            await page.waitForSelector('input[type="email"], input[name="identifier"], #identifierId', { visible: true, timeout: 30000 });
            const emailInput = await page.$('input[type="email"], input[name="identifier"], #identifierId');
            if (emailInput) {
                await this.humanLikeType(emailInput, email);
            } else {
                throw new Error('Email input not found');
            }
            await page.keyboard.press('Enter');
 
            // ── WAIT FOR RESPONSE: Password, Error, or Captcha ──
            Logger.info(`⏳ Waiting for response after email entry for ${email}...`);
            const responseType = await Promise.race([
                page.waitForSelector('input[type="password"]', { visible: true, timeout: 30000 }).then(() => 'password'),
                page.waitForSelector('input[name="ca"], input[aria-label*="captcha" i]', { visible: true, timeout: 30000 }).then(() => 'captcha'),
                page.waitForFunction(() => {
                    const text = document.body.innerText.toLowerCase();
                    return text.includes("couldn't find your google account") ||
                           text.includes("could not find your google account") ||
                           text.includes("no google account found") ||
                           text.includes("enter a valid email") ||
                           text.includes("this account was recently deleted");
                }, { timeout: 30000 }).then(() => 'not_found'),
            ]).catch(() => 'timeout');

            if (responseType === 'not_found') {
                Logger.warn(`⚠️ ACCOUNT_NOT_FOUND detected for ${email}`);
                if (browser) await browser.close();
                return { success: false, error: 'ACCOUNT_NOT_FOUND' };
            }

            if (responseType === 'timeout') {
                Logger.info(`⏱️ Response timeout for ${email} — running aggressive existence check...`);
                if (await this.isAccountNotFound(page)) {
                    Logger.warn(`⚠️ ACCOUNT_NOT_FOUND detected for ${email}`);
                    if (browser) await browser.close();
                    return { success: false, error: 'ACCOUNT_NOT_FOUND' };
                }
                Logger.info(`🔍 Aggressive check found nothing — proceeding as if account exists`);
            }

            // Password / Captcha Loop
            let captchaAttempts = 0;
            const maxCaptchaAttempts = 4;
            const captchaInputSelector = 'input[name="ca"], input[aria-label*="captcha" i], input[aria-label="Type the text you hear or see"]';

            while (captchaAttempts < maxCaptchaAttempts) {
                // Wait to see if password or captcha is displayed
                const result = await Promise.race([
                    page.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 }).then(() => 'password'),
                    page.waitForSelector(captchaInputSelector, { visible: true, timeout: 15000 }).then(() => 'captcha'),
                ]).catch(() => 'timeout');

                if (result === 'password') {
                    break;
                }

                if (result === 'captcha') {
                    captchaAttempts++;
                    Logger.warn(`⚠️ Image Captcha detected for ${email} (Attempt ${captchaAttempts}/${maxCaptchaAttempts})`);

                    const captchaImg = await page.$('#captchaimg')
                        || await page.$('div#captcha-box img')
                        || await page.$('img[src*="captcha"]')
                        || await page.$('img[alt*="captcha" i]')
                        || await page.$('form img');

                    if (captchaImg) {
                        try {
                            const box = await captchaImg.boundingBox();
                            if (!box) {
                                Logger.warn('[Captcha] Zero dimensions for image, pressing enter to refresh...');
                                await page.keyboard.press('Enter');
                                await new Promise(r => setTimeout(r, 3000));
                                continue;
                            }
                            const base64Image = await captchaImg.screenshot({ encoding: 'base64' });
                            const solution = await this.captchaService.solveImageCaptcha(base64Image);
                            if (solution.success) {
                                Logger.info(`✅ Captcha solved: ${solution.solution}`);
                                const captchaField = await page.$(captchaInputSelector);
                                if (captchaField) {
                                    await captchaField.click({ clickCount: 3 });
                                    await page.keyboard.press('Backspace');
                                    await this.humanLikeType(captchaField, solution.solution);
                                    await page.keyboard.press('Enter');
                                    await new Promise(r => setTimeout(r, 4000));
                                }
                            } else {
                                Logger.warn(`⚠️ Captcha solve failed: ${solution.error || 'unknown'}`);
                                await new Promise(r => setTimeout(r, 2000));
                            }
                        } catch (err: any) {
                            Logger.warn(`⚠️ Captcha handling error: ${err.message}`);
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    } else {
                        Logger.warn(`⚠️ Captcha input found but captcha image not found — pressing enter to refresh`);
                        await page.keyboard.press('Enter');
                        await new Promise(r => setTimeout(r, 3000));
                    }
                } else {
                    Logger.warn(`⚠️ Timeout/unknown state waiting for password or captcha`);
                    break;
                }
            }

            // Password Input
            Logger.info(`✍️ Entering password...`);
            await page.waitForSelector('input[type="password"]', { visible: true, timeout: 20000 });
            await new Promise(r => setTimeout(r, 2000));
            await this.humanLikeType(await page.$('input[type="password"]'), password);
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 3000));

            // FLOW HANDLING
            let isOnLoginFlow = true;
            let attemptsCheck = 0;
            const maxCheckAttempts = 20;
            let lastSeenUrl = '';
            let sameUrlCount = 0;

            while (isOnLoginFlow && attemptsCheck < maxCheckAttempts) {
                attemptsCheck++;
                if (page.isClosed()) throw new Error('Page closed unexpectedly');

                const currentUrl = page.url();
                Logger.info(`🔄 Checking state (Attempt ${attemptsCheck}): ${currentUrl}`);

                // Stuck detection — same URL 4 times in a row → break
                if (currentUrl === lastSeenUrl) {
                    sameUrlCount++;
                    if (sameUrlCount >= 4) {
                        Logger.warn(`⚠️ Stuck on same URL for ${sameUrlCount} attempts, breaking flow loop`);
                        break;
                    }
                } else {
                    sameUrlCount = 0;
                    lastSeenUrl = currentUrl;
                }

                if (currentUrl.includes('myaccount.google.com') ||
                    currentUrl.includes('admin.google.com') ||
                    currentUrl.includes('workspace.google.com')) {
                    Logger.info(`✅ Authentication Successful!`);
                    isOnLoginFlow = false;
                    break;
                }

                // ── Google Authenticator (TOTP) Logic ──────────────
                const otpInputCheck = await page.$('input[name="totpPin"], input[id*="totp"], input[id*="otp"]').catch(() => null);
                if (otpInputCheck) {
                    Logger.info(`🔑 Authenticator (OTP) request detected for ${email}`);
                    try {
                        let otpCode: string | null = null;
                        if (this.sshUploader) {
                            Logger.info(`📡 Downloading TOTP secret from SFTP for ${email}...`);
                            const secret = await this.sshUploader.downloadSecretKey(email);
                            if (secret) {
                                otpCode = this.generateTOTP(secret);
                            }
                        } else {
                            Logger.warn(`⚠️ SSHUploader not configured. Cannot fetch TOTP secret.`);
                        }

                        if (otpCode) {
                            Logger.info(`✅ Generated OTP from internal API: ${otpCode}`);

                            // Clear and enter OTP
                            await otpInputCheck.click({ clickCount: 3 });
                            await page.keyboard.press('Backspace');
                            await this.humanLikeType(otpInputCheck, otpCode);
                            await new Promise(r => setTimeout(r, 1000));

                            // submit
                            await page.keyboard.press('Enter');
                            await new Promise(r => setTimeout(r, 4000));
                            continue;
                        }
                    } catch (otpErr: any) {
                        Logger.warn(`⚠️ Auto-OTP failed: ${otpErr.message}`);
                    }
                }

                // Phone Verification Logic
                // NOTE: Check for tel input fresh each time — do NOT cache the element reference
                // across the outer while-loop iterations, as the page may re-render.
                const phoneInputCheck = await page.$('input[type="tel"]').catch(() => null);
                if (phoneInputCheck) {
                    Logger.warn(`⚠️ Phone verification detected for ${email}`);
                    let phoneSuccess = false;
                    let attempts = 0;
                    const maxAttempts = 6; // 3 per geo

                    // Geo fallback: start with Indonesia (6), switch to Colombia (33) after 3 failures
                    const geoList = [
                        { country: '6', name: 'Indonesia' },
                        { country: '33', name: 'Colombia' }
                    ];
                    let geoIndex = 0;
                    let geoFailures = 0;

                    while (!phoneSuccess && attempts < maxAttempts) {
                        attempts++;
                        const currentGeo = geoList[geoIndex];
                        Logger.info(`📱 Phone attempt ${attempts}/${maxAttempts} — Geo: ${currentGeo.name} (${currentGeo.country}), geo failures: ${geoFailures}`);
                        try {
                            // Re-query FRESH element on every attempt — the previous reference
                            // becomes detached when Google re-renders the page after Enter.
                            await page.waitForSelector('input[type="tel"]', { visible: true, timeout: 8000 }).catch(() => null);
                            const phoneInput = await page.$('input[type="tel"]').catch(() => null);
                            if (!phoneInput) {
                                Logger.warn(`Phone input not found on attempt ${attempts}, page may have navigated away`);
                                break;
                            }

                            // Get Number from current geo
                            const numberResult = await this.smsService.getNumber(currentGeo.country);
                            if (!numberResult.success) throw new Error(numberResult.error);

                            const { id: activationId, number } = numberResult;
                            Logger.info(`📱 Got number: ${number}`);
                            const inputPhone = await this.formatPhoneNumberForInput(number);

                            // Clear the field and type the number using fresh reference
                            // Wrap in try-catch: Google may navigate (destroy context) if number is accepted
                            let phoneRejected = false;
                            try {
                                await phoneInput.click({ clickCount: 3 });
                                await page.keyboard.press('Backspace');
                                await this.humanLikeType(phoneInput, inputPhone);
                                await page.keyboard.press('Enter');

                                await new Promise(r => setTimeout(r, 5000));

                                // Check for ALL Google phone rejection messages
                                const phoneError = await page.evaluate(() => {
                                    const text = document.body.innerText.toLowerCase();
                                    if (text.includes("phone number can't be used for verification")) return "cant_be_used";
                                    if (text.includes("too many unsuccessful attempts")) return "too_many_attempts";
                                    if (text.includes("phone number has already been used")) return "already_used";
                                    if (text.includes("this number format is not recognized")) return "bad_format";
                                    if (text.includes("couldn't send a verification code")) return "send_failed";
                                    return null;
                                }).catch(() => null);

                                if (phoneError) {
                                    geoFailures++;
                                    Logger.warn(`⚠️ Phone rejected [${phoneError}]: ${number} (${currentGeo.name}) — geoFailures: ${geoFailures}/3`);
                                    await this.smsService.cancelNumber(activationId).catch(() => { });
                                    if (geoFailures >= 3 && geoIndex < geoList.length - 1) {
                                        geoIndex++;
                                        geoFailures = 0;
                                        Logger.info(`🌍 Switching geo → ${geoList[geoIndex].name} (${geoList[geoIndex].country})`);
                                    }
                                    phoneRejected = true;
                                }
                            } catch (navErr: any) {
                                // "Execution context was destroyed" = Google navigated → number accepted!
                                if (navErr.message?.includes('context') || navErr.message?.includes('navigat') || navErr.message?.includes('detached')) {
                                    Logger.info(`✅ Navigation detected after phone submit — number likely accepted`);
                                    await new Promise(r => setTimeout(r, 3000));
                                } else {
                                    throw navErr; // Re-throw unknown errors
                                }
                            }

                            if (phoneRejected) continue;

                            // ✅ CRITICAL: Tell SMS provider the number was accepted → triggers OTP send
                            Logger.info(`📤 Notifying SMS provider to send OTP for activation ${activationId}...`);
                            const readyStatus = await this.smsService.setStatus(activationId, 1);
                            Logger.info(`📤 SMS provider notified (status 1): ${readyStatus}`);

                            // Wait for SMS code input on the page.
                            // Google /challenge/iap uses input[type="tel"] for the code field (NOT input[name="code"]).
                            // We try multiple selectors to handle different Google page layouts.
                            Logger.info(`🔍 Looking for code input on page: ${page.url()}`);
                            const codeSelectors = [
                                'input[name="code"]',
                                'input[type="tel"]:not([name="phoneNumber"])',
                                'input[jsname="YPqjbf"]',
                                'input[aria-label="Enter code"]',
                                'input[autocomplete="one-time-code"]'
                            ];

                            let smsCodeObj: any = null;
                            for (const sel of codeSelectors) {
                                smsCodeObj = await page.waitForSelector(sel, { visible: true, timeout: 8000 }).catch(() => null);
                                if (smsCodeObj) {
                                    Logger.info(`✅ Found code input with selector: ${sel}`);
                                    break;
                                }
                            }

                            if (smsCodeObj) {
                                Logger.info(`⏳ Waiting for SMS code from provider (up to 120s)...`);
                                
                                // Capture screenshot for debugging as requested by user
                                const ssPath = path.join(process.cwd(), 'debug_screenshots', `phone_verify_wait_${Date.now()}.png`);
                                await page.screenshot({ path: ssPath }).catch(() => {});
                                Logger.info(`📸 Saved screenshot to: ${ssPath}`);

                                const codeResult = await this.smsService.waitForCode(activationId, 120);
                                Logger.info(`📩 SMS provider response: ${JSON.stringify(codeResult)}`);
                                if (codeResult.success) {
                                    Logger.info(`✅ Got SMS code: ${codeResult.code}`);
                                    // Clear any pre-filled content (e.g. "G-" prefix Google adds)
                                    await smsCodeObj.click({ clickCount: 3 });
                                    await page.keyboard.down('Control');
                                    await page.keyboard.press('A');
                                    await page.keyboard.up('Control');
                                    await page.keyboard.press('Backspace');
                                    await new Promise(r => setTimeout(r, 300));
                                    // Type the code
                                    await this.humanLikeType(smsCodeObj, codeResult.code);
                                    await page.keyboard.press('Enter');
                                    await this.smsService.confirmSuccess(activationId);
                                    phoneSuccess = true;
                                } else {
                                    geoFailures++;
                                    Logger.warn(`❌ No SMS code received (reason: ${codeResult.error}), cancelling ${number} (${currentGeo.name}) — geoFailures: ${geoFailures}/3`);
                                    await this.smsService.cancelNumber(activationId);
                                    if (geoFailures >= 3 && geoIndex < geoList.length - 1) {
                                        geoIndex++;
                                        geoFailures = 0;
                                        Logger.info(`🌍 Switching geo → ${geoList[geoIndex].name} (${geoList[geoIndex].country})`);
                                    }
                                }
                            } else {
                                geoFailures++;
                                Logger.warn(`❌ SMS code input not found after submitting ${number} (${currentGeo.name}), cancelling — geoFailures: ${geoFailures}/3`);
                                await this.smsService.cancelNumber(activationId);
                                if (geoFailures >= 3 && geoIndex < geoList.length - 1) {
                                    geoIndex++;
                                    geoFailures = 0;
                                    Logger.info(`🌍 Switching geo → ${geoList[geoIndex].name} (${geoList[geoIndex].country})`);
                                }
                            }
                        } catch (e: any) { Logger.warn(`Phone attempt failed: ${e.message}`); }
                    }
                    if (!phoneSuccess) throw new Error("Phone verification failed after retries");
                }


                // ── Additional Info page (recovery email/phone prompt) ─────────
                // This is NOT a TOS page — Google asks for recovery info.
                // Must find Skip/Not now, NOT click input#confirm (that's a text field).
                if (currentUrl.includes('additionalinformation') || currentUrl.includes('additional-information')) {
                    Logger.info(`📋 Additional info page — looking for Skip/Not now...`);
                    try {
                        await new Promise(r => setTimeout(r, 2000));
                        const skipped = await page.evaluate(() => {
                            const all = Array.from(document.querySelectorAll('button, div[role="button"], a, span[role="button"]')) as HTMLElement[];
                            const skipBtn = all.find(b => {
                                const t = (b.innerText || b.textContent || '').trim().toLowerCase();
                                return t === 'skip' || t === 'not now' || t === 'remind me later' || t === 'cancel' ||
                                       t === 'skip for now' || t === 'maybe later' || t === 'dismiss';
                            });
                            if (skipBtn) { (skipBtn as any).click(); return 'skip'; }
                            // fallback: click primary submit button (may advance past page)
                            const submit = document.querySelector('button[type="submit"], button[jsname="LgbsSe"], input[type="submit"]') as HTMLElement;
                            if (submit) { submit.click(); return 'submit'; }
                            return null;
                        });
                        Logger.info(skipped ? `✅ Additional info: ${skipped}` : `⚠️ No skip/submit button found`);
                        await Promise.race([
                            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }),
                            new Promise(r => setTimeout(r, 8000))
                        ]).catch(() => {});
                        Logger.info(`🔄 After additional info: ${page.url()}`);
                    } catch (e: any) { Logger.warn(`Additional info error: ${e.message}`); }
                    continue;
                }

                // ── Consent / Speedbump Handler ────────────────────────────────
                const currentUrl2 = page.url();
                if (currentUrl2.includes('speedbump') || currentUrl2.includes('gaplustos')) {
                    Logger.info(`📋 TOS page — targeting input#confirm...`);
                    try {
                        await new Promise(r => setTimeout(r, 3000));
                        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                        await new Promise(r => setTimeout(r, 2000));

                        let tosClicked = false;

                        // Strategy 1: Direct selector or Text Match
                        let confirmBtn = await page.$('input#confirm, input[name="confirm"], input[type="submit"][value="I understand"], button#confirm, span.RveJvd.snByac, button[jsname="LgbsSe"]');
                        if (!confirmBtn) {
                            // find button that contains 'understand', 'accept', or 'agree'
                            const handles = await page.$$('button, span, div[role="button"]');
                            for (const handle of handles) {
                                const text = await handle.evaluate((el: any) => (el.textContent || '').trim().toLowerCase());
                                if (text.includes('understand') || text.includes('accept') || text.includes('agree')) {
                                    confirmBtn = handle as any;
                                    break;
                                }
                            }
                        }

                        if (confirmBtn) {
                            await (confirmBtn as any).evaluate((e: any) => e.scrollIntoView({ block: 'center' }));
                            await new Promise(r => setTimeout(r, 500));
                            const box = await confirmBtn.boundingBox();
                            if (box && box.width > 0) {
                                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                                Logger.info(`✅ TOS: mouse.click on input#confirm at (${Math.round(box.x + box.width / 2)}, ${Math.round(box.y + box.height / 2)})`);
                                tosClicked = true;
                            } else {
                                await confirmBtn.click();
                                Logger.info(`✅ TOS: .click() on input#confirm`);
                                tosClicked = true;
                            }
                        }

                        // Strategy 2: Submit the form directly
                        if (!tosClicked) {
                            tosClicked = await page.evaluate(() => {
                                const inp = document.querySelector('input[type="submit"]') as HTMLInputElement;
                                if (inp) { inp.click(); return true; }
                                const form = document.querySelector('form');
                                if (form) { form.submit(); return true; }
                                return false;
                            });
                            if (tosClicked) Logger.info(`✅ TOS: Clicked via form submit`);
                        }

                        // Strategy 3: Scroll to bottom and coordinate click
                        if (!tosClicked) {
                            Logger.warn(`⚠️ input#confirm not found — coordinate click`);
                            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                            await new Promise(r => setTimeout(r, 1000));
                            const viewport = page.viewport();
                            const vw = viewport?.width || 1366;
                            const vh = viewport?.height || 768;
                            await page.mouse.click(vw / 2, vh - 80);
                            Logger.info(`🖱️ Clicked at (${vw / 2}, ${vh - 80})`);
                        }

                        await Promise.race([
                            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }),
                            new Promise(r => setTimeout(r, 10000))
                        ]).catch(() => { });

                        Logger.info(`🔄 After TOS: ${page.url()}`);
                        continue;
                    } catch (tosErr: any) {
                        Logger.warn(`TOS error: ${tosErr.message}`);
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                }


                // Handle generic Continue/Verify/Accept buttons
                try {
                    const clicked = await page.evaluate(() => {
                        const els = Array.from(document.querySelectorAll('button, div[role="button"]')) as HTMLElement[];
                        const btn = els.find(b => {
                            const t = b.innerText?.trim().toLowerCase() || '';
                            const rect = b.getBoundingClientRect();
                            const visible = rect.width > 0 && rect.height > 0;
                            return visible && (t === 'continue' || t === 'next' || t === 'verify' || t === 'i understand' || t === 'accept');
                        });
                        if (btn) { btn.click(); return true; }
                        return false;
                    });
                    if (clicked) {
                        Logger.info(`✅ Clicked generic continue/accept button`);
                        await new Promise(r => setTimeout(r, 3000));
                        continue;
                    }
                } catch (e: any) { /* ignore */ }

                await new Promise(r => setTimeout(r, 2000));
            }


            // DOMAIN VERIFICATION CHECK
            // If we are at admin.google.com, we are good.
            // If we are at 'domain verification' page, we might need to handle it.
            // For 'Prep' stage, if the account is logged in, we mark it as success?
            // The user wants 'result_accounts.txt' to contain verified accounts (ready for use).
            // If account needs domain verification, it is NOT ready?
            // verifyAccounts.js did domain verification.
            // AccountVerifier here should probably just return true if login worked, OR implement domain verify.
            // Given the complexity and potential for breakage, I will check if we are at admin console.
            // If we are at domain setup, I will attempt to click through "Get Started".

            const finalUrl = page.url();
            const isSuccess =
                finalUrl.includes('admin.google.com') ||
                finalUrl.includes('workspace.google.com') ||
                finalUrl.includes('myaccount.google.com') ||
                finalUrl.includes('speedbump');

            if (isSuccess) {
                Logger.info(`✅ Login/Verification Flow Complete: ${email} (at: ${finalUrl})`);

                // ── FULL DOMAIN VERIFICATION (CLOUDFLARE / DYNU) ─────────────────
                try {
                    const fullDomain = email.split('@')[1]; // e.g. prime-learn.belvynteam.my.id
                    const parts = fullDomain.split('.');
                    // Smart zone detection: try from most specific to least specific
                    // Handles multi-part TLDs like my.id, co.uk, com.br
                    // e.g. parts = ['prime-learn', 'belvynteam', 'my', 'id']
                    // tries: belvynteam.my.id → my.id → id  (stops at first found zone)
                    let rootDomain = parts.slice(-2).join('.');
                    let subDomain = parts.slice(0, -2).join('.');
                    // Pre-scan for correct zone (progressive: most specific → least specific)
                    const triedCandidates: string[] = [];
                    for (let i = parts.length - 2; i >= 1; i--) {
                        const candidate = parts.slice(i).join('.');
                        triedCandidates.push(candidate);
                        const found = await this.cloudflareService.getZoneId(candidate);
                        if (found) {
                            rootDomain = candidate;
                            subDomain = parts.slice(0, i).join('.');
                            break;
                        }
                    }
                    Logger.info(`[${email}] 🔍 Checking domain verification status: fullDomain=${fullDomain} root=${rootDomain}`);

                    // ── CHECK IF DOMAIN IS ALREADY VERIFIED ──────────────────────────
                    const isAlreadyVerified = await this.isDomainVerified(page, fullDomain, rootDomain, subDomain);
                    if (isAlreadyVerified) {
                        Logger.info(`✅ Domain already verified in Google Admin Console — skipping verification step`);
                        await browser.close();
                        return { success: true, email, password };
                    }
                    Logger.info(`ℹ️ Domain not yet verified — proceeding with verification workflow`);

                    // ── Debug screenshots directory
                    const screenshotDir = 'debug_screenshots';
                    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
                    const saveScreenshot = async (name: string) => {
                        try {
                            await page.screenshot({ path: `${screenshotDir}/${name}.png` });
                            Logger.info(`📸 Screenshot saved: ${screenshotDir}/${name}.png`);
                        } catch (e: any) {
                            Logger.warn(`⚠️ Failed to save screenshot ${name}: ${e.message}`);
                        }
                    };

                    // Step 1: Navigate to domain management
                    Logger.info(`🌐 Navigating to Admin Console Domains...`);
                    await page.goto('https://admin.google.com/ac/domains/manage?hl=en', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
                    await new Promise(r => setTimeout(r, 4000));
                    await saveScreenshot('01_domains_page');

                    // Step 2: Find & MOUSE-CLICK "Verify domain" — SPA link (href='#' needs real mouse click)
                    Logger.info(`🔗 Clicking "Verify domain" with mouse.click...`);
                    let verifyClicked = false;
                    const allPageElements = await page.$$('a, button, span, div[role="button"]');
                    for (const el of allPageElements) {
                        try {
                            const elText = await el.evaluate((e: any) => (e.innerText || e.textContent || '').trim().toLowerCase());
                            if (elText === 'verify domain' || elText === 'verify your domain' || elText === 'verify') {
                                const box = await el.boundingBox();
                                if (box && box.width > 0) {
                                    await el.evaluate((e: any) => e.scrollIntoView({ block: 'center' }));
                                    await new Promise(r => setTimeout(r, 400));
                                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                                    Logger.info(`✅ Mouse-clicked "Verify domain" element (text='${elText}')`);
                                    verifyClicked = true;
                                    break;
                                }
                            }
                        } catch (e) { /* skip */ }
                    }
                    if (!verifyClicked) {
                        Logger.warn(`⚠️ No 'Verify domain' element found — trying direct verify URL`);
                        await page.goto(`https://admin.google.com/ac/domains/verify?hl=en`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
                    }

                    // Poll for URL/page change after SPA click
                    const urlBeforeWizard = page.url();
                    for (let i = 0; i < 12; i++) {
                        await new Promise(r => setTimeout(r, 1000));
                        const now = page.url();
                        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
                        if (now !== urlBeforeWizard || bodyText.includes('google-site-verification=') || bodyText.includes('TXT') || bodyText.includes('Select your domain') || bodyText.includes('domain host')) {
                            Logger.info(`📔 Page changed after ${i + 1}s: ${now}`);
                            break;
                        }
                    }
                    await saveScreenshot('02_after_verify_click');

                    // Step 3: Wizard loop — navigate steps precisely
                    for (let wizardStep = 0; wizardStep < 5; wizardStep++) {
                        Logger.info(`🧙 Wizard step ${wizardStep} — URL: ${page.url()}`);
                        await saveScreenshot(`03_wizard_step_${wizardStep}`);

                        const bodyText = (await page.evaluate(() => document.body.innerText).catch(() => '')).toLowerCase();
                        
                        // Force English if not already
                        if (!page.url().includes('hl=en')) {
                            const newUrl = page.url().includes('?') ? (page.url() + '&hl=en') : (page.url() + '?hl=en');
                            Logger.info(`🇬🇧 Forcing English on setup page: ${newUrl}`);
                            await page.goto(newUrl, { waitUntil: 'networkidle2' });
                            await new Promise(r => setTimeout(r, 2000));
                        }

                        const hasVerificationCode = await page.evaluate(() => {
                            const body = document.body.innerText.toLowerCase();
                            if (body.includes('google-site-verification') || body.includes('txt record') || body.includes('txt verification')) {
                                return true;
                            }
                            const inputs = Array.from(document.querySelectorAll('input, textarea')) as HTMLInputElement[];
                            return inputs.some(i => (i.value || '').includes('google-site-verification='));
                        }).catch(() => false);

                        if (page.url().includes('/codes') || hasVerificationCode) {
                            Logger.info(`✅ TXT page detected at wizard step ${wizardStep} (URL: ${page.url()})`);
                            break;
                        }
                        if (bodyText.includes('select your domain host') || bodyText.includes('domain host') || bodyText.includes('choose which method')) {
                            Logger.info(`🔧 Domain host/method selection — clicking first option/checkbox + Continue`);
                            const cb = await page.$('input[type="checkbox"], [role="checkbox"], [role="radio"]');
                            if (cb) { await cb.click(); await new Promise(r => setTimeout(r, 800)); }
                        }

                        // Find precise wizard button: button OR plain <a> link, text < 35 chars
                        const wizardKeywords = ['next', 'continue', 'begin', 'proceed', 'start', 'set up', 'get txt', 'go to', 'open', 'get started', 'verify', 'ready', 'i\'m ready', 'choose', 'select'];
                        let stepClicked = false;
                        // Include plain <a> tags — workspace.google.com/getsetup uses <a> links (not role="button")
                        const stepBtns = await page.$$('button, a[role="button"], div[role="button"], a');
                        for (const btn of stepBtns) {
                            const btnTxt = await btn.evaluate((e: any) => (e.innerText || e.textContent || '').trim().toLowerCase());
                            const isVis = await btn.evaluate((e: any) => e.offsetParent !== null && e.getBoundingClientRect().width > 0).catch(() => false);
                            if (isVis && btnTxt.length < 35 && wizardKeywords.some(k => btnTxt.includes(k))) {
                                const bBox = await btn.boundingBox();
                                if (bBox) {
                                    await btn.evaluate((e: any) => e.scrollIntoView({ block: 'center' }));
                                    await new Promise(r => setTimeout(r, 400));
                                    await page.mouse.click(bBox.x + bBox.width / 2, bBox.y + bBox.height / 2);
                                    Logger.info(`🖱️ Wizard step ${wizardStep}: clicked "${btnTxt}"`);
                                    stepClicked = true;
                                    await new Promise(r => setTimeout(r, 4000));
                                    break;
                                }
                            }
                        }
                        if (!stepClicked) { Logger.info(`ℹ️ No more wizard buttons at step ${wizardStep}`); break; }
                    } // END wizard for-loop

                    // If wizard loop exited but we're still on /dnshost, navigate directly to /codes
                    if (page.url().includes('/dnshost')) {
                        const codesUrl = page.url().replace('/dnshost', '/codes');
                        Logger.info(`🔀 Still on dnshost after wizard — navigating directly to codes page: ${codesUrl}`);
                        await page.goto(codesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                    }

                    // Step 4: Extract TXT record — 3 attempts with scroll (OUTSIDE wizard loop)
                    await saveScreenshot('04_before_txt_extract');
                    Logger.info(`🔍 Extracting TXT record — URL: ${page.url()}`);
                    let txtRecord: string | null = null;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                        await new Promise(r => setTimeout(r, 1500));
                        txtRecord = await page.evaluate(() => {
                            // 1. Precise copy-value attribute (Modern Google setup)
                            const copyEl = document.querySelector('[data-copy-value]');
                            if (copyEl) {
                                const val = copyEl.getAttribute('data-copy-value');
                                if (val && val.includes('google-site-verification=')) return val;
                            }
                            
                            // 2. Strong text indicator
                            const strongEl = document.querySelector('strong.const-text') as HTMLElement;
                            if (strongEl?.innerText && strongEl.innerText.includes('google-site-verification=')) return strongEl.innerText.trim();
                            
                            // 3. Search inputs/textareas
                            const inputs = Array.from(document.querySelectorAll('input, textarea')) as HTMLInputElement[];
                            const inp = inputs.find(i => (i.value || '').includes('google-site-verification='));
                            if (inp) return inp.value.trim();
                            
                            // 4. Code / Pre tags (sometimes used for dev instructions)
                            const codes = Array.from(document.querySelectorAll('code, pre')) as HTMLElement[];
                            const codeMatch = codes.find(c => c.innerText.includes('google-site-verification='));
                            if (codeMatch) {
                                const match = codeMatch.innerText.match(/google-site-verification=[\w-]+/);
                                if (match) return match[0];
                            }

                            // 5. Global regex search in visible text
                            const match = document.body.innerText.match(/google-site-verification=[^ \n\t\r<"']+/);
                            return match ? match[0] : null;
                        }).catch(() => null);
                        if (txtRecord) { Logger.info(`📝 TXT Record (attempt ${attempt + 1}): ${txtRecord}`); break; }
                        Logger.warn(`⚠️ TXT not found attempt ${attempt + 1} — URL: ${page.url()}`);
                        await saveScreenshot(`04b_txt_attempt_${attempt + 1}`);
                    }


                    if (txtRecord) {
                        Logger.info(`📝 TXT Record: ${txtRecord}`);

                        // Step 5: Add TXT record to whichever DNS provider owns the zone
                        // (Cloudflare first, Dynu fallback — see services/dnsProvider.js)
                        // recordName: use full domain (the unique subdomain for Dynu)
                        const recordName = fullDomain;
                        // Strip any surrounding quotes to prevent literal quotes in the record
                        const cleanedTxtRecord = txtRecord.replace(/^["']|["']$/g, '');
                        const dnsConfig = this.loadConfig();
                        const dnsLog = (msg: string) => Logger.info(`[${email}] ${msg}`);

                        // Report which DNS provider owns the zone before touching
                        // anything. upsertDnsTxt below creates the Dynu zone/host
                        // itself (free dynamic-DNS host OR apex zone for a
                        // registered domain on Dynu nameservers) when missing.
                        try {
                            const det = await detectDnsProvider(recordName, dnsConfig);
                            if (det.provider) {
                                Logger.info(`[${email}] 🌐 DNS provider for ${recordName}: ${det.provider.toUpperCase()}${det.zoneName ? ` (zone: ${det.zoneName})` : ''}${det.freeDomain ? ' (Dynu free domain)' : ''}`);
                            } else {
                                Logger.info(`[${email}] 🌐 No DNS provider detected for ${recordName} — DNS auto-verification will be skipped`);
                            }
                        } catch (detErr: any) {
                            Logger.warn(`[${email}] ⚠️ DNS provider detection failed: ${detErr.message}`);
                        }

                        Logger.info(`[${email}] 📡 Adding TXT to DNS provider for name="${recordName}"...`);
                        const addResult = await upsertDnsTxt(recordName, cleanedTxtRecord, dnsConfig, dnsLog);

                        if (addResult.success) {
                            if (addResult.already) {
                                Logger.info(`ℹ️ TXT record already exists on ${addResult.provider} — proceeding with MX and verification...`);
                            } else {
                                Logger.info(`✅ TXT record added on ${addResult.provider}!`);
                            }

                            // --- ADD MX RECORD FOR GOOGLE WORKSPACE MAIL SERVER ---
                            Logger.info(`📡 Adding MX for name="${recordName}" -> SMTP.GOOGLE.COM (Priority 1) on ${addResult.provider}...`);
                            try {
                                const mxResult = await upsertDnsMx(recordName, dnsConfig, dnsLog);
                                if (mxResult.success) {
                                    Logger.info(`✅ MX record added on ${mxResult.provider}!`);
                                } else {
                                    Logger.warn(`⚠️ ${mxResult.provider || 'DNS'} MX add failed: ${mxResult.error}`);
                                }
                            } catch (mxErr: any) {
                                Logger.warn(`⚠️ Failed to add MX record: ${mxErr.message}`);
                            }

                            Logger.info(`⏳ Waiting 15s for initial DNS propagation...`);
                            await new Promise(r => setTimeout(r, 15000));

                            // Retry loop to verify domain (handles DNS propagation lag)
                            let verificationSuccessful = false;
                            for (let verifyAttempt = 0; verifyAttempt < 4; verifyAttempt++) {
                                Logger.info(`🖱️ Clicking final Verify button (Attempt ${verifyAttempt + 1}/4)...`);
                                
                                // Step 6: Check all confirmation checkboxes if present (Evaluated to prevent Puppeteer click hangs)
                                try {
                                    const clickedCount = await page.evaluate(() => {
                                        const selectors = [
                                            'input[type="checkbox"]',
                                            '[role="checkbox"]',
                                            '[class*="checkbox" i]',
                                            '[id*="checkbox" i]'
                                        ];
                                        
                                        const elements = new Set<HTMLElement>();
                                        selectors.forEach(sel => {
                                            document.querySelectorAll(sel).forEach(el => elements.add(el as HTMLElement));
                                        });

                                        const labels = ['i added', 'i have added', 'i saved', 'i have saved', 'i logged', 'i opened', 'added the txt', 'saved the txt'];
                                        document.querySelectorAll('span, div, label, p').forEach(el => {
                                            const txt = (el.textContent || '').toLowerCase();
                                            if (labels.some(l => txt.includes(l))) {
                                                const cb = el.querySelector('input, [role="checkbox"]') || el.closest('label, div[role="button"]') || el;
                                                elements.add(cb as HTMLElement);
                                            }
                                        });

                                        let clicked = 0;
                                        elements.forEach(el => {
                                            try {
                                                const rect = el.getBoundingClientRect();
                                                const isVisible = rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
                                                if (!isVisible) return;

                                                const isChecked = el.getAttribute('aria-checked') === 'true' || 
                                                                  (el as HTMLInputElement).checked === true ||
                                                                  el.classList.contains('is-checked') ||
                                                                  el.classList.contains('checked');
                                                
                                                if (!isChecked) {
                                                    el.click();
                                                    clicked++;
                                                }
                                            } catch (err) { }
                                        });
                                        return clicked;
                                    });
                                    if (clickedCount > 0) {
                                        Logger.info(`☑️ Checked ${clickedCount} confirmation checkboxes`);
                                        await new Promise(r => setTimeout(r, 1500));
                                    }
                                } catch (checkboxErr) {
                                    /* ignore */
                                }

                                // Step 7: Click final Verify button
                                const verified = await page.evaluate(() => {
                                    const buttons = Array.from(document.querySelectorAll('button, div[role="button"]')) as HTMLElement[];
                                    const btn = buttons.find(b => {
                                        const t = (b.innerText || '').toLowerCase();
                                        return (t.includes('verify') || t.includes('continue') || t.includes('activate') || t.includes('confirm')) && b.offsetParent !== null;
                                    });
                                    if (btn) { btn.click(); return true; }
                                    return false;
                                });

                                if (verified) {
                                    Logger.info(`✅ Final Verify clicked! Waiting 15s for response...`);
                                    await new Promise(r => setTimeout(r, 15000));
                                    await saveScreenshot('05_after_verify_response');
                                    
                                    const currentUrl = page.url();
                                    const pageTextRaw = await page.evaluate(() => document.body.innerText).catch(() => '');
                                    const pageText = pageTextRaw.toLowerCase();
                                    Logger.info(`[Verify Response Text]: ${pageTextRaw.substring(0, 1000).replace(/\n+/g, ' ')}`);

                                    const hasFailureText = pageText.includes("couldn't verify") || pageText.includes("could not verify") || pageText.includes("failed") || pageText.includes("try again") || pageText.includes("error") || pageText.includes("incorrect");
                                    const hasSuccessText = pageText.includes('verified') || pageText.includes('congratulations') || pageText.includes('success') || pageText.includes('active') || pageText.includes('welcome') || pageText.includes('set up');
                                    
                                    // If page navigated away from codes page, or contains success text, AND does not contain failure text, verification succeeded!
                                    if ((!currentUrl.includes('/codes') || hasSuccessText) && !hasFailureText) {
                                        Logger.info(`🏁 Domain verification complete and successful! Final URL: ${currentUrl}`);
                                        verificationSuccessful = true;
                                        break;
                                    } else {
                                        Logger.warn(`⚠️ Verification not propagation/failed yet. URL is still: ${currentUrl}. Retrying in 20s...`);
                                        await new Promise(r => setTimeout(r, 20000));
                                    }
                                } else {
                                    Logger.warn(`⚠️ Final Verify button not found or not clickable`);
                                    break;
                                }
                            }

                            if (!verificationSuccessful) {
                                Logger.warn(`⚠️ Verification loop completed but URL is still /codes (might require manual check or more propagation time)`);
                            }
                        } else {
                            Logger.warn(`⚠️ TXT add failed on DNS provider: ${addResult.error}`);
                        }
                    } else {
                        Logger.warn(`⚠️ TXT record not found on Admin Console page`);
                    }
                } catch (cfErr: any) {
                    Logger.warn(`Domain verification failed (non-blocking): ${cfErr.message}`);
                }
                // ──────────────────────────────────────────────────

                // AUTO-HANDLE GOOGLE CLOUD CONSOLE TOS (after domain verification)
                try {
                    Logger.info(`📋 Checking for Google Cloud Console TOS after domain verification...`);
                    await this.handleCloudConsoleTOS(page);
                } catch (tosErr: any) {
                    Logger.warn(`⚠️ Cloud Console TOS handling failed (non-blocking): ${tosErr.message}`);
                }

                await browser.close();
                return { success: true, email, password };
            } else {
                Logger.warn(`❓ Verification ended at: ${finalUrl}`);
                await browser.close();
                return { success: false, error: 'Ended at ' + finalUrl };
            }

        } catch (error: any) {
            Logger.error(`❌ Verification Failed: ${error.message}`);
            if (browser) await browser.close();
            return { success: false, error: error.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────────
    // Auto-handle Google Cloud Console TOS modal after domain verification
    // ─────────────────────────────────────────────────────────────────────────────────
    private async handleCloudConsoleTOS(page: any): Promise<boolean> {
        try {
            Logger.info(`🔍 Looking for Cloud Console TOS modal...`);
            
            // Check for TOS elements
            const tosElements = await page.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                return {
                    hasTermsText: text.includes('terms of service') && text.includes('i agree'),
                    hasModalOverlay: !!document.querySelector('[role="dialog"], .goog-net-backdrop, .modal'),
                    checkboxes: document.querySelectorAll('input[type="checkbox"]').length
                };
            }).catch(() => null);
            
            if (!tosElements || !tosElements.hasTermsText) {
                Logger.info(`ℹ️ No TOS modal detected`);
                return false;
            }
            
            Logger.info(`📋 TOS modal detected! Attempting to accept...`);
            
            // Step 1: Find and click the TOS checkbox
            const checkboxClicked = await page.evaluate(() => {
                const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
                const tosCheckbox = checkboxes.find(cb => {
                    const parent = cb.closest('label, div') as HTMLElement | null;
                    const parentText = (parent?.innerText || '').toLowerCase();
                    return parentText.includes('i agree') || parentText.includes('terms');
                });
                
                if (tosCheckbox && !tosCheckbox.checked) {
                    tosCheckbox.click();
                    return true;
                }
                return !!tosCheckbox?.checked;
            }).catch(() => false);
            
            if (checkboxClicked) {
                Logger.info(`☑️ TOS checkbox accepted`);
                await new Promise(r => setTimeout(r, 1500));
            }
            
            // Step 2: Find and click the Agree/Confirm button
            const buttonClicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
                const agreeBtn = buttons.find(b => {
                    const text = (b.innerText || b.textContent || '').trim().toLowerCase();
                    return (text === 'i agree' || text === 'agree' || text === 'confirm' || text === 'accept') && 
                           b.offsetParent !== null;
                });
                
                if (agreeBtn) {
                    const box = agreeBtn.getBoundingClientRect();
                    if (box.width > 0 && box.height > 0) {
                        (agreeBtn as any).click();
                        return true;
                    }
                }
                return false;
            }).catch(() => false);
            
            if (buttonClicked) {
                Logger.info(`✅ TOS Agree button clicked`);
                await new Promise(r => setTimeout(r, 5000));
                Logger.info(`🏁 Cloud Console TOS completed`);
                return true;
            }
            return false;
            
        } catch (error: any) {
            Logger.warn(`⚠️ TOS handler error: ${error.message}`);
            return false;
        }
    }

    private generateTOTP(secret: string): string {
        try {
            // Decode Base32 to key bytes
            const key = thirtyTwo.decode(secret);

            // Calculate counter (30-second window)
            const time = Math.floor(Date.now() / 1000 / 30);

            // Create 8-byte buffer for the counter (big-endian)
            const timeBuffer = Buffer.alloc(8);
            // Since time fits in 32 bits (until 2106), put it in the lower 4 bytes
            timeBuffer.writeUInt32BE(0, 0);
            timeBuffer.writeUInt32BE(time, 4);

            // HMAC-SHA1
            const hmac = crypto.createHmac('sha1', key);
            hmac.update(timeBuffer);
            const hmacResult = hmac.digest();

            // Dynamic truncation
            const offset = hmacResult[hmacResult.length - 1] & 0xf;
            const binary =
                ((hmacResult[offset] & 0x7f) << 24) |
                ((hmacResult[offset + 1] & 0xff) << 16) |
                ((hmacResult[offset + 2] & 0xff) << 8) |
                (hmacResult[offset + 3] & 0xff);

            const otp = (binary % 1000000);

            return otp.toString().padStart(6, '0');
        } catch (error: any) {
            Logger.error(`Error generating TOTP: ${error.message}`);
            throw error;
        }
    }

    private async isAccountNotFound(page: any): Promise<boolean> {
        const currentUrl = page.url();
        if (!currentUrl.includes('accounts.google.com')) {
            Logger.warn(`⚠️ [isAccountNotFound] Not on Google auth page (${currentUrl.substring(0, 80)}) — returning false to avoid false positive`);
            return false;
        }

        await new Promise(r => setTimeout(r, 2000));
        return await page.evaluate(() => {
            if (!window.location.href.includes('accounts.google.com')) return false;

            const bodyText = (document.body.innerText || document.body.textContent || "").toLowerCase();

            // 1. Specific Google "account not found" text patterns only
            const hasErrorKeywords = bodyText.includes("couldn't find your google account") ||
                                     bodyText.includes("could not find your google account") ||
                                     bodyText.includes("enter a valid email") ||
                                     bodyText.includes("doesn't exist") ||
                                     bodyText.includes("don't recognize") ||
                                     bodyText.includes("introuvable") ||
                                     bodyText.includes("no se ha podido encontrar");

            if (hasErrorKeywords) return true;

            // 2. CSS-based detection (Google standard error classes)
            // o6Ybe is the common class for the error div below the input
            const errorDivs = document.querySelectorAll('.o6Ybe, [aria-live="assertive"], [role="alert"]');
            for (const div of Array.from(errorDivs)) {
                const txt = (div.textContent || "").toLowerCase();
                if (txt.length > 5 && (txt.includes("account") || txt.includes("find") || txt.includes("email"))) {
                    return true;
                }
            }

            // 3. Page State check: if we are still on the identifier page and there is an error message visible
            const isStillOnIdentifier = window.location.href.includes('identifier');
            const hasErrorMessage = !!document.querySelector('div[jsname="B34EJ"]');
            if (isStillOnIdentifier && hasErrorMessage) return true;

            return false;
        }).catch(() => false);
    }
}
