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

// Module-level counter used to alternate the starting SMS geo on rotation runs.
let phoneVerifyGeoRotate = 0;

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

            // Step 3: SMS geo selection (manual or rotation between Colombia ↔ Indonesia)
            const cfg = this.loadConfig();
            const smsGeo = (cfg.smsGeo || '').toUpperCase();
            const GEO_ALL = [
                { country: '6', name: 'Indonesia' },
                { country: '33', name: 'Colombia' }
            ];
            const GEO_BY_CODE: Record<string, { country: string; name: string }> = { ID: GEO_ALL[0], CO: GEO_ALL[1] };
            let geoList;
            if (smsGeo === 'ID') geoList = [GEO_BY_CODE.ID];
            else if (smsGeo === 'CO') geoList = [GEO_BY_CODE.CO];
            else if (smsGeo === 'ROTATE') { geoList = [...GEO_ALL]; if (++phoneVerifyGeoRotate % 2 === 0) geoList.reverse(); }
            else geoList = [...GEO_ALL];
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

                // ── CHECKOUT / TRIAL START (if landed on /checkout) ──────────────
                // If the account landed on /checkout it means the trial was NEVER
                // activated. Proceeding to domain verify/OTP will always fail and the
                // account will bounce right back to /checkout. So if checkout cannot
                // be completed, abort this job immediately with a clear error.
                if (finalUrl.includes('/checkout')) {
                    Logger.info(`💳 Account landed on checkout page — handling trial start + address + payment...`);
                    let checkoutOk = false;
                    try {
                        checkoutOk = await this.handleCheckoutWithRetry(page, email, password);
                        if (checkoutOk) {
                            Logger.info(`✅ Checkout/trial flow completed`);
                        } else {
                            Logger.warn(`⚠️ Checkout/trial flow did not complete cleanly`);
                        }
                    } catch (checkoutErr: any) {
                        Logger.warn(`⚠️ Checkout handling failed: ${checkoutErr.message}`);
                    }
                    if (!checkoutOk) {
                        Logger.error(`⛔ Checkout NOT completed — trial was not activated. Aborting job (account will keep bouncing back to /checkout).`);
                        await this.saveCheckoutDebugState(page, email, 'consider_retry_later');
                        if (browser) await browser.close().catch(() => { });
                        return { success: false, email, password, error: 'CHECKOUT_NOT_COMPLETED: trial was not activated — retry later' };
                    }
                }

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
                    await page.goto('https://admin.google.com/ac/domains/manage?hl=en', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
                    // Wait for page content to actually render (Admin Console is a heavy SPA — give it time)
                    await page.waitForFunction(() => {
                        const txt = (document.body && document.body.innerText) || '';
                        return txt.length > 100 && !/sign in|login|choose an account/i.test(txt);
                    }, { timeout: 30000 }).catch(() => { });
                    await new Promise(r => setTimeout(r, 8000));
                    await saveScreenshot('01_domains_page');

                    // Check if redirected to sign-in
                    const currentUrl = page.url();
                    if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
                        Logger.warn(`⚠️ Redirected to sign-in — re-navigating to domains page`);
                        await page.goto('https://admin.google.com/ac/domains/manage?hl=en', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
                        await page.waitForFunction(() => {
                            const txt = (document.body && document.body.innerText) || '';
                            return txt.length > 100 && !/sign in|login|choose an account/i.test(txt);
                        }, { timeout: 30000 }).catch(() => { });
                        await new Promise(r => setTimeout(r, 8000));
                        await saveScreenshot('01b_domains_page_retry');
                    }

                    // Step 2: Find & MOUSE-CLICK "Verify domain" — try multiple selectors and text patterns
                    Logger.info(`🔗 Looking for "Verify domain" element...`);
                    let verifyClicked = false;

                    // 2a: Try all visible text-containing elements (broader search)
                    const textPatterns = ['verify domain', 'verify your domain', 'verify', 'start verification', 'begin verification', 'get started', 'set up', 'manage'];
                    const allSelectors = 'a, button, span, div[role="button"], td, li, [role="link"], [role="tab"]';
                    const allPageElements = await page.$$(allSelectors);
                    for (const el of allPageElements) {
                        try {
                            const elText = await el.evaluate((e: any) => (e.innerText || e.textContent || '').trim().toLowerCase());
                            if (textPatterns.some(p => elText === p || elText.startsWith(p))) {
                                const box = await el.boundingBox();
                                if (box && box.width > 0 && box.height > 0) {
                                    await el.evaluate((e: any) => e.scrollIntoView({ block: 'center' }));
                                    await new Promise(r => setTimeout(r, 400));
                                    const freshBox = await el.boundingBox();
                                    if (freshBox) {
                                        await page.mouse.click(freshBox.x + freshBox.width / 2, freshBox.y + freshBox.height / 2);
                                        Logger.info(`✅ Mouse-clicked "Verify domain" element (text='${elText}')`);
                                        verifyClicked = true;
                                        break;
                                    }
                                }
                            }
                        } catch (e) { /* skip */ }
                    }

                    // 2b: If not found, try finding the domain name in the list and clicking it to get to domain details page
                    if (!verifyClicked) {
                        Logger.info(`🔍 Trying to find domain in list and navigate to its settings...`);
                        const domainName = fullDomain;
                        const listElements = await page.$$('a, td, tr, [role="row"], [role="link"]');
                        for (const el of listElements) {
                            try {
                                const elText = await el.evaluate((e: any) => (e.innerText || e.textContent || '').trim().toLowerCase());
                                if (elText.includes(domainName.toLowerCase())) {
                                    const box = await el.boundingBox();
                                    if (box && box.width > 0 && box.height > 0) {
                                        await el.evaluate((e: any) => e.scrollIntoView({ block: 'center' }));
                                        await new Promise(r => setTimeout(r, 300));
                                        const freshBox = await el.boundingBox();
                                        if (freshBox) {
                                            await page.mouse.click(freshBox.x + freshBox.width / 2, freshBox.y + freshBox.height / 2);
                                            Logger.info(`✅ Clicked domain "${domainName}" in list`);
                                            await new Promise(r => setTimeout(r, 4000));
                                            await saveScreenshot('01c_domain_detail');
                                            break;
                                        }
                                    }
                                }
                            } catch (e) { /* skip */ }
                        }
                        // Now look for "Verify" on the domain detail page
                        const detailElements = await page.$$(allSelectors);
                        for (const el of detailElements) {
                            try {
                                const elText = await el.evaluate((e: any) => (e.innerText || e.textContent || '').trim().toLowerCase());
                                if (textPatterns.some(p => elText === p || elText.startsWith(p))) {
                                    const box = await el.boundingBox();
                                    if (box && box.width > 0 && box.height > 0) {
                                        await el.evaluate((e: any) => e.scrollIntoView({ block: 'center' }));
                                        await new Promise(r => setTimeout(r, 300));
                                        const freshBox = await el.boundingBox();
                                        if (freshBox) {
                                            await page.mouse.click(freshBox.x + freshBox.width / 2, freshBox.y + freshBox.height / 2);
                                            Logger.info(`✅ Mouse-clicked "Verify domain" on detail page (text='${elText}')`);
                                            verifyClicked = true;
                                            break;
                                        }
                                    }
                                }
                            } catch (e) { /* skip */ }
                        }
                    }

                    // 2c: Direct verify URL fallback
                    if (!verifyClicked) {
                        Logger.warn(`⚠️ No 'Verify domain' element found — trying direct verify URL`);
                        await page.goto(`https://admin.google.com/ac/domains/verify?hl=en`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
                        await new Promise(r => setTimeout(r, 4000));
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
    // ════════════════════════════════════════════════════════════════════════════════
    // RUN SETUP: Checkout / Trial Start / Address / NetBanking / Payment
    // ════════════════════════════════════════════════════════════════════════════════

    private generateIndianAddress() {
        const STATES = ['Maharashtra','Karnataka','Tamil Nadu','Delhi','Telangana','Gujarat','Rajasthan','Uttar Pradesh','Kerala','Madhya Pradesh','Punjab','Haryana','Bihar','Odisha','Jharkhand','Chhattisgarh','Himachal Pradesh','Uttarakhand','Goa','Andhra Pradesh','Chandigarh','Puducherry'];
        const CITIES: Record<string,string[]> = { 'Maharashtra':['Mumbai','Pune','Nagpur','Thane','Nashik'],'Karnataka':['Bangalore','Mysore','Mangalore'],'Tamil Nadu':['Chennai','Coimbatore','Madurai'],'Delhi':['New Delhi','Dwarka','Rohini'],'Telangana':['Hyderabad','Warangal'],'Gujarat':['Ahmedabad','Surat','Vadodara'],'Rajasthan':['Jaipur','Jodhpur','Udaipur'],'Uttar Pradesh':['Lucknow','Kanpur','Noida'],'Kerala':['Kochi','Thiruvananthapuram','Kozhikode'],'Madhya Pradesh':['Bhopal','Indore','Jabalpur'],'Punjab':['Chandigarh','Ludhiana','Amritsar'],'Haryana':['Gurugram','Faridabad','Panipat'],'Bihar':['Patna','Gaya'],'Odisha':['Bhubaneswar','Cuttack'],'Jharkhand':['Ranchi','Jamshedpur'],'Chhattisgarh':['Raipur','Bhilai'],'Himachal Pradesh':['Shimla','Manali'],'Uttarakhand':['Dehradun','Haridwar'],'Goa':['Panaji','Margao'],'Andhra Pradesh':['Visakhapatnam','Vijayawada'] };
        const STREETS = ['MG Road','Park Street','Station Road','Gandhi Road','Nehru Street','Civil Lines','Main Road','Cross Road','Brigade Road','Commercial Street','Residency Road','Anna Salai','Linking Road','SV Road','Mall Road','Ring Road','Park Avenue','Marine Drive','Cunningham Road','Lavelle Road','Richmond Road','Infantry Road','Sardar Patel Road','Cathedral Road','Sector 18','Velachery Main Road','OMR','ECR','Connaught Place','Banjara Hills Road 12'];
        const LANDMARKS = ['Near Bus Stand','Opposite City Mall','Behind Railway Station','Near Metro Station','Opposite Park','Near Temple','Near Hospital','Near School','Near Market','Opposite Bank','Near Police Station','Behind Post Office','Near Airport','Near Lake','Near Garden','Opposite Mall','Behind Petrol Pump','Near Highway'];
        const PIN_PREFIXES: Record<string,string[]> = { 'Maharashtra':['400','410','411','421'],'Karnataka':['560','561','570'],'Tamil Nadu':['600','601','620'],'Delhi':['110'],'Telangana':['500','501'],'Gujarat':['380','390'],'Rajasthan':['302','303'],'Uttar Pradesh':['201','226'],'Kerala':['680','682','695'],'Madhya Pradesh':['462','452'],'Punjab':['140','141','160'],'Haryana':['122','121'],'Bihar':['800','801'],'Odisha':['751','753'],'Jharkhand':['834','831'],'Chhattisgarh':['492','493'],'Himachal Pradesh':['171','176'],'Uttarakhand':['248','249'],'Goa':['403','404'],'Andhra Pradesh':['520','521','530'],'Chandigarh':['160'],'Puducherry':['605'] };
        const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
        const state = pick(STATES);
        const city = pick(CITIES[state] || [state]);
        const pin = pick(PIN_PREFIXES[state] || ['110']) + String(Math.floor(Math.random() * 900) + 100);
        const houseNum = Math.floor(Math.random() * 500) + 1;
        const street = pick(STREETS);
        const landmark = pick(LANDMARKS);
        return { state, city, pin, addressLine1: `${houseNum}, ${street}`, addressLine2: landmark };
    }

    private async fillInputInFrames(page: any, label: string, placeholders: string[], value: string): Promise<boolean> {
        for (const frame of page.frames()) {
            try {
                const elements = await frame.$$('input, textarea');
                for (const el of elements) {
                    const matched = await el.evaluate((input: any, phList: string[], lbl: string) => {
                        const gvt = (n: any) => (n.textContent || n.innerText || '').trim().toLowerCase();
                        const ariaLab = (input.getAttribute('aria-label') || '').toLowerCase();
                        const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
                        const nameAttr = (input.getAttribute('name') || '').toLowerCase();
                        const idAttr = (input.id || '').toLowerCase();
                        const parts = [ariaLab, placeholder, nameAttr, idAttr];
                        if (input.id) { for (const l of document.querySelectorAll(`label[for="${input.id}"]`)) parts.push(l.textContent || ''); }
                        const anc = input.closest('label'); if (anc) parts.push(anc.textContent || '');
                        const lb = input.getAttribute('aria-labelledby');
                        if (lb) { for (const id of lb.split(/\s+/).filter(Boolean)) { const e = document.getElementById(id); if (e) parts.push(e.textContent || ''); } }
                        const txt = parts.join(' ').toLowerCase();
                        if (['organization','company','business','firm','legal name','contact name','recipient'].some(w => txt.includes(w))) return false;
                        const ll = lbl.toLowerCase();
                        if (ll.includes('pin')||ll.includes('zip')||ll.includes('postal')) { if (['apt','suite','street','address','city','state','country'].some(w => txt.includes(w))) return false; }
                        else if (ll.includes('city')||ll.includes('town')) { if (['state','country','zip','pin','postal','street','address'].some(w => txt.includes(w))) return false; }
                        else if (ll.includes('apt')||ll.includes('suite')||ll.includes('landmark')||ll.includes('line 2')) { if (['pin','zip','postal','city','state','country','street','address line 1'].some(w => txt.includes(w))) return false; }
                        else if (ll.includes('street')||ll.includes('line 1')||ll.includes('address')) { if (['pin','zip','postal','city','state','country','apt','suite','line 2'].some(w => txt.includes(w))) return false; }
                        const attrs = [placeholder,ariaLab,nameAttr,idAttr].map(a => (a||'').toLowerCase());
                        if (phList.some(ph => attrs.some(a => a.includes(ph.toLowerCase())))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
                        if (lb) { for (const id of lb.trim().split(/\s+/)) { const e = document.getElementById(id); if (e && phList.some(ph => gvt(e).includes(ph.toLowerCase()))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; } } }
                        if (input.id) { for (const e of document.querySelectorAll(`label[for="${input.id}"]`)) { if (phList.some(ph => gvt(e).includes(ph.toLowerCase()))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; } } }
                        return false;
                    }, placeholders, label);
                    if (matched) {
                        const box = await el.boundingBox();
                        if (box) {
                            await el.evaluate((e: any) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
                            await new Promise(r => setTimeout(r, 150));
                            const fb = await el.boundingBox();
                            if (fb) {
                                await el.evaluate((e: any) => { e.click(); e.focus(); }).catch(() => {});
                                await new Promise(r => setTimeout(r, 50));
                                await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2, { clickCount: 3 }).catch(() => {});
                                await new Promise(r => setTimeout(r, 100));
                                await el.evaluate((e: any) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
                                await el.type(String(value), { delay: Math.random() * 30 + 30 });
                                await el.evaluate((e: any) => e.dispatchEvent(new Event('blur', { bubbles: true })));
                                return true;
                            }
                        }
                    }
                }
            } catch (e) { /* skip frame */ }
        }
        return false;
    }

    private async selectFromComboboxInFrame(frame: any, value: string, labels: string[]): Promise<boolean> {
        try {
            const dropdowns = await frame.$$('select, [role="combobox"], [role="listbox"], [role="button"], input[aria-haspopup="listbox"], [aria-expanded]');
            for (const el of dropdowns) {
                const matched = await el.evaluate((input: any, keywords: string[]) => {
                    const gvt = (n: any) => (n.textContent || n.innerText || '').trim().toLowerCase();
                    const attrs = [input.getAttribute('placeholder'),input.getAttribute('aria-label'),input.getAttribute('name'),input.id,input.className,input.tagName].map(a => (a||'').toLowerCase());
                    if (keywords.some(ph => attrs.some(a => a.includes(ph.toLowerCase())))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
                    const lb = input.getAttribute('aria-labelledby');
                    if (lb) { for (const id of lb.trim().split(/\s+/)) { const l = document.getElementById(id); if (l && keywords.some(ph => gvt(l).includes(ph.toLowerCase()))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; } } }
                    if (input.id) { for (const l of document.querySelectorAll(`label[for="${input.id}"]`)) { if (keywords.some(ph => gvt(l).includes(ph.toLowerCase()))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; } } }
                    if (keywords.some(ph => { const lph = ph.toLowerCase(); let p = input.parentElement; let d = 0; while (p && d < 5) { if (gvt(p).includes(lph)) return true; p = p.parentElement; d++; } return false; })) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
                    return false;
                }, labels);
                if (matched) {
                    const tagName = await el.evaluate((e: any) => e.tagName.toLowerCase());
                    if (tagName === 'select') {
                        const ok = await el.evaluate((e: any, v: string) => {
                            const opts = [...e.querySelectorAll('option')];
                            const m = opts.find((o: any) => (o.textContent||'').trim().toLowerCase().includes(v.toLowerCase()));
                            if (m) { e.value = m.value; e.dispatchEvent(new Event('change',{bubbles:true})); e.dispatchEvent(new Event('input',{bubbles:true})); return m.textContent.trim(); }
                            return null;
                        }, value);
                        if (ok) return true;
                    } else {
                        try {
                            const box = await el.boundingBox();
                            if (box) {
                                await el.click({ delay: Math.random() * 50 + 50 });
                                await frame.waitForSelector('[role="listbox"] [role="option"], [role="option"]', { timeout: 5000 }).catch(() => {});
                                await new Promise(r => setTimeout(r, 500));
                                const options = await frame.$$('[role="listbox"] [role="option"], [role="option"]');
                                for (const opt of options) {
                                    const txt = await opt.evaluate((o: any) => (o.textContent||'').trim());
                                    if (txt.toLowerCase().includes(value.toLowerCase())) { await opt.click({ delay: Math.random() * 50 + 50 }); return true; }
                                }
                                await frame.keyboard.type(value, { delay: Math.random() * 30 + 30 });
                                await new Promise(r => setTimeout(r, 400));
                                await frame.keyboard.press('Enter');
                                return true;
                            }
                        } catch (e) { /* skip */ }
                    }
                }
            }
        } catch (e) { /* skip */ }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Timeout-safe evaluate: page/frame.evaluate can hang forever on busy SPAs
    // (workspace.google.com checkout). Never blocks the worker.
    // ─────────────────────────────────────────────────────────────────────────
    private async safeEval(target: any, fn: any, arg?: any, timeout = 6000): Promise<any> {
        try {
            return await Promise.race([
                target.evaluate(fn, arg),
                new Promise(resolve => setTimeout(() => resolve('__CHECKOUT_TIMEOUT__'), timeout))
            ]);
        } catch (e) { return null; }
    }

    private async safe$$(target: any, selector: string, timeout = 5000): Promise<any[]> {
        try {
            return await Promise.race([
                target.$$(selector),
                new Promise(resolve => setTimeout(() => resolve([]), timeout))
            ]);
        } catch (e) { return []; }
    }

private async waitForCheckoutFormToLoad(page: any, timeout = 35000): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            for (const frame of page.frames()) {
                const found = await this.safeEval(frame, () => {
                    const txt = (document.body && document.body.innerText) || '';
                    const hasInputs = !!document.querySelector('input[placeholder*="Street" i], input[placeholder*="City" i], input[placeholder*="address" i]');
                    return /contact information|payment method|add payment|add name and address/i.test(txt) || hasInputs;
                }, undefined, 3000);
                if (found) return true;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        return false;
    }


    async runSetup(email: string, password: string, headless: boolean = HEADLESS): Promise<{ success: boolean; error?: string }> {
        Logger.info(`🚀 [runSetup] Starting checkout/trial setup for: ${email}`);
        let browser: any = null;
        try {
            const proxy = this.pickProxy();
            const userAgent = new UserAgent({ deviceCategory: 'desktop' });
            const SCREEN_W = 1920, SCREEN_H = 1040, COLS = 2;
            const tileW = Math.floor(SCREEN_W / COLS), tileH = Math.floor(SCREEN_H / COLS);
            const tileIdx = Math.floor(Math.random() * 4);
            const col = tileIdx % COLS, row = Math.floor(tileIdx / COLS);

            browser = await puppeteer.launch({
                headless,
                args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled',
                    `--window-size=${tileW},${tileH}`,`--window-position=${col*tileW},${row*tileH}`,
                    ...(proxy ? [proxy.arg] : [])],
                ignoreDefaultArgs: ['--enable-automation']
            });

            let page = await browser.newPage();
            if (proxy?.user && proxy?.pass) await page.authenticate({ username: proxy.user, password: proxy.pass });
            await page.setUserAgent(userAgent.toString());
            await page.setViewport({ width: tileW, height: tileH });
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

            // Step 1: Login via checkout handoff
            const checkoutUrl = 'https://workspace.google.com/checkout?uj=2606-checkoutentry-signup-coreflow-accountredirect';
            const loginUrl = `https://accounts.google.com/v3/signin/identifier?Email=${encodeURIComponent(email)}&continue=${encodeURIComponent(checkoutUrl)}&service=CPanel&sacu=1&skipvpage=true&flowName=GlifWebSignIn&flowEntry=ServiceLogin`;
            Logger.info(`🔗 [runSetup] Navigating to checkout login handoff...`);
            await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            const passInput = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 }).catch(() => null);
            if (passInput) {
                await this.humanLikeType(passInput, password);
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 5000));
            }

            // Handle post-login challenges
            for (let i = 0; i < 15; i++) {
                const url = page.url();
                if (url.includes('/checkout') || url.includes('admin.google.com') || url.includes('workspace.google.com/u')) break;

                // TOTP
                const otpInput = await page.$('input[name="totpPin"], input[id*="totp"], input[id*="otp"]').catch(() => null);
                if (otpInput && this.sshUploader) {
                    try {
                        const secret = await this.sshUploader.downloadSecretKey(email);
                        if (secret) {
                            const otpCode = this.generateTOTP(secret);
                            await otpInput.click({ clickCount: 3 }); await page.keyboard.press('Backspace');
                            await this.humanLikeType(otpInput, otpCode);
                            await page.keyboard.press('Enter');
                            await new Promise(r => setTimeout(r, 4000)); continue;
                        }
                    } catch (e) { /* skip */ }
                }

                // Speedbump / TOS
                if (url.includes('speedbump') || url.includes('gaplustos') || url.includes('workspacetermsofservice')) {
                    try {
                        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                        await new Promise(r => setTimeout(r, 1000));
                        const clicked = await page.evaluate(() => {
                            const btns = Array.from(document.querySelectorAll('button, span, div[role="button"]')) as HTMLElement[];
                            const btn = btns.find(b => { const t = (b.innerText||'').trim().toLowerCase(); return t.includes('understand') || t.includes('accept') || t.includes('agree'); });
                            if (btn) { (btn as any).click(); return true; }
                            const inp = document.querySelector('input#confirm, input[type="submit"]') as HTMLInputElement;
                            if (inp) { inp.click(); return true; }
                            return false;
                        });
                        if (clicked) await new Promise(r => setTimeout(r, 3000));
                    } catch (e) { /* skip */ }
                }

                // Generic continue
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, div[role="button"]')) as HTMLElement[];
                    const btn = btns.find(b => { const t = (b.innerText||'').trim().toLowerCase(); const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (t === 'continue' || t === 'next' || t === 'i understand' || t === 'accept'); });
                    if (btn) btn.click();
                }).catch(() => {});
                await new Promise(r => setTimeout(r, 3000));
            }

            // Step 2: Wait for checkout page
            Logger.info(`⏳ [runSetup] Waiting for checkout page...`);
            let onCheckout = false;
            for (let i = 0; i < 60; i++) {
                const url = page.url();
                if (url.includes('/checkout') || url.includes('admin.google.com')) { onCheckout = true; break; }
                const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
                if (/checkout|trial|sign up|billing|payment/i.test(bodyText)) { onCheckout = true; break; }
                await new Promise(r => setTimeout(r, 1000));
            }
            if (!onCheckout) {
                await page.goto(checkoutUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 5000));
            }

            if (page.url().includes('admin.google.com')) {
                Logger.info(`✅ [runSetup] Already on Admin Console — trial active. Skipping.`);
                await browser.close(); return { success: true };
            }

            // Step 3: Click "Start a trial"
            Logger.info(`🎯 [runSetup] Looking for "Start a trial"...`);
            for (let attempt = 0; attempt < 5; attempt++) {
                const clicked = await page.evaluate(() => {
                    const texts = ['start a trial','start your free trial','start free trial','begin trial','start trial'];
                    const els = Array.from(document.querySelectorAll('button, a, [role="button"], span')) as HTMLElement[];
                    for (const el of els) {
                        const t = (el.innerText||el.textContent||'').trim().toLowerCase();
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0 && texts.some(tt => t === tt || t.includes(tt))) { el.click(); return true; }
                    }
                    return false;
                });
                if (clicked) { Logger.info(`✅ [runSetup] Clicked "Start a trial"`); await new Promise(r => setTimeout(r, 5000)); break; }
                await new Promise(r => setTimeout(r, 3000));
            }

            // Step 4: Wait for payment/contact form
            Logger.info(`⏳ [runSetup] Waiting for payment contact section...`);
            const formLoaded = await this.waitForCheckoutFormToLoad(page, 30000);
            Logger.info(formLoaded ? `✅ [runSetup] Payment sections visible` : `⚠️ [runSetup] Payment section wait timed out`);
            await new Promise(r => setTimeout(r, 2000));

            // Step 5: Terms gate
            if (page.url().includes('accounts.google.com')) {
                for (const frame of page.frames()) {
                    try {
                        const allBtns = await frame.$$('button, a, [role="button"], span');
                        for (const btn of allBtns) {
                            const txt = await btn.evaluate((el: any) => (el.textContent||'').replace(/\s+/g,' ').trim());
                            if (/^agree and continue$|^agree & continue$/i.test(txt)) {
                                const box = await btn.boundingBox();
                                if (box && box.width > 0 && box.height > 0) {
                                    await btn.evaluate((el: any) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
                                    await new Promise(r => setTimeout(r, 400));
                                    const fb = await btn.boundingBox();
                                    if (fb) { await page.mouse.click(fb.x+fb.width/2, fb.y+fb.height/2); Logger.info(`✅ [runSetup] Clicked terms gate`); await new Promise(r => setTimeout(r, 4000)); break; }
                                }
                            }
                        }
                    } catch (e) { /* skip */ }
                }
            }

            // Step 6: Fill Indian address (5 attempts)
            let addressSaved = false;
            for (let attempt = 1; attempt <= 5 && !addressSaved; attempt++) {
                const addr = this.generateIndianAddress();
                Logger.info(`🏠 [runSetup] Filling address (${attempt}/5): ${addr.city}, ${addr.state} ${addr.pin}`);
                await this.fillInputInFrames(page, 'Street', ['Street address','Address line 1','Street','Address'], addr.addressLine1);
                await new Promise(r => setTimeout(r, 300));
                try { await this.fillInputInFrames(page, 'Address Line 2', ['Apt, suite','Suite','Landmark','Address line 2','Address 2'], addr.addressLine2); } catch(e){}
                await new Promise(r => setTimeout(r, 200));
                await this.fillInputInFrames(page, 'City', ['City','Town','Locality'], addr.city);
                await new Promise(r => setTimeout(r, 300));
                await this.fillInputInFrames(page, 'PIN', ['Pin code','PIN code','Zip code','Postal code','Pincode','ZIP','Postal'], addr.pin);
                await new Promise(r => setTimeout(r, 300));
                for (let s = 0; s < 3; s++) { for (const frame of page.frames()) { if (await this.selectFromComboboxInFrame(frame, addr.state, ['state','province','region','state or region'])) { break; } } break; }
                await new Promise(r => setTimeout(r, 500));

                // Save
                for (const frame of page.frames()) {
                    try {
                        const btns = await frame.$$('button, a, [role="button"]');
                        for (const btn of btns) {
                            const txt = await btn.evaluate((el: any) => (el.textContent||'').replace(/\s+/g,' ').trim());
                            if (/^(Save|Save address|Apply|OK|Done|Confirm|Continue|Next)$/i.test(txt)) {
                                const box = await btn.boundingBox();
                                if (box && box.width > 0 && box.height > 0) {
                                    await btn.evaluate((el: any) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
                                    await new Promise(r => setTimeout(r, 200));
                                    const fb = await btn.boundingBox();
                                    if (fb) { await page.mouse.click(fb.x+fb.width/2, fb.y+fb.height/2); Logger.info(`💾 [runSetup] Save clicked: "${txt}"`); addressSaved = true; break; }
                                }
                            }
                        }
                    } catch(e){}
                    if (addressSaved) break;
                }
                await new Promise(r => setTimeout(r, 3000));

                // Verify: check if inputs still visible
                const stillOpen = await page.frames().reduce(async (acc, frame) => {
                    if (await acc) return true;
                    try {
                        return await frame.evaluate(() => {
                            const inputs = [...document.querySelectorAll('input, textarea')];
                            return inputs.some(i => { const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
                        });
                    } catch(e) { return false; }
                }, Promise.resolve(false));
                if (!stillOpen) { Logger.info(`✅ [runSetup] Address saved successfully`); break; }
                Logger.warn(`⚠️ [runSetup] Address form still open, retrying...`);
            }

            // Step 7: NetBanking — "Add payment method" → "Pay with NetBanking" → pick bank
            Logger.info(`💳 [runSetup] Selecting NetBanking payment...`);

            // Click "Add payment method"
            let addPaymentClicked = false;
            for (const frame of page.frames()) {
                try {
                    const btns = await frame.$$('button, [role="button"], a, span');
                    for (const btn of btns) {
                        const txt = await btn.evaluate((el: any) => (el.textContent||'').replace(/\s+/g,' ').trim().toLowerCase());
                        if (txt === 'add payment method') {
                            await btn.evaluate((el: any) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
                            await new Promise(r => setTimeout(r, 300));
                            await btn.click().catch(async () => { await btn.evaluate((el: any) => el.click()); });
                            addPaymentClicked = true; Logger.info(`✅ [runSetup] Clicked "Add payment method"`); break;
                        }
                    }
                } catch(e){}
                if (addPaymentClicked) break;
            }
            if (addPaymentClicked) await new Promise(r => setTimeout(r, 3000));

            // Click "Pay with NetBanking"
            let netBankingClicked = false;
            for (let retry = 0; retry < 3 && !netBankingClicked; retry++) {
                for (const frame of page.frames()) {
                    try {
                        const btns = await frame.$$('[role="option"], [role="button"], button, span, div');
                        for (const btn of btns) {
                            const txt = await btn.evaluate((el: any) => (el.textContent||'').replace(/\s+/g,' ').trim().toLowerCase());
                            if (txt === 'pay with netbanking') {
                                await btn.evaluate((el: any) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
                                await new Promise(r => setTimeout(r, 200));
                                await btn.click().catch(async () => { await btn.evaluate((el: any) => el.click()); });
                                netBankingClicked = true; Logger.info(`✅ [runSetup] Clicked "Pay with NetBanking"`); break;
                            }
                        }
                    } catch(e){}
                    if (netBankingClicked) break;
                }
                if (!netBankingClicked) await new Promise(r => setTimeout(r, 2000));
            }
            await new Promise(r => setTimeout(r, 3000));

            // Pick a bank
            const banks = ['HDFC Bank','ICICI Bank','State Bank of India','Axis Bank','Kotak Mahindra Bank','YES Bank','IDFC FIRST Bank','Punjab National Bank','Bank of Baroda','Canara Bank'];
            let bankSelected = false;
            for (const bank of banks) {
                for (const frame of page.frames()) {
                    bankSelected = await this.selectFromComboboxInFrame(frame, bank, ['bank','choose bank','select bank','select your bank','net banking bank','select a bank']);
                    if (bankSelected) { Logger.info(`🏦 [runSetup] Bank selected: ${bank}`); break; }
                    try {
                        const btns = await frame.$$('button, a, [role="option"], [role="radio"], li, div, span');
                        for (const btn of btns) {
                            const txt = await btn.evaluate((el: any) => (el.textContent||'').replace(/\s+/g,' ').trim());
                            if (txt.toLowerCase() === bank.toLowerCase()) {
                                const box = await btn.boundingBox();
                                if (box && box.width > 0 && box.height > 0) { await btn.click().catch(async () => { await btn.evaluate((el: any) => el.click()); }); bankSelected = true; break; }
                            }
                        }
                    } catch(e){}
                    if (bankSelected) break;
                }
                if (bankSelected) break;
            }
            await new Promise(r => setTimeout(r, 2000));

            // Save payment
            for (const frame of page.frames()) {
                try {
                    const btns = await frame.$$('button, a, [role="button"]');
                    for (const btn of btns) {
                        const txt = await btn.evaluate((el: any) => (el.textContent||'').replace(/\s+/g,' ').trim());
                        if (/^(Save|Add|Done|Confirm|Save payment method)$/i.test(txt)) {
                            const box = await btn.boundingBox();
                            if (box && box.width > 0 && box.height > 0) {
                                await btn.evaluate((el: any) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
                                await new Promise(r => setTimeout(r, 200));
                                await btn.click().catch(async () => { await btn.evaluate((el: any) => el.click()); });
                                Logger.info(`💾 [runSetup] Payment saved: "${txt}"`); break;
                            }
                        }
                    }
                } catch(e){}
            }
            await new Promise(r => setTimeout(r, 2000));

            // Step 8: Click Checkout / Agree and continue
            Logger.info(`💳 [runSetup] Clicking checkout/agree button...`);
            let checkoutClicked = false;
            for (const frame of page.frames()) {
                try {
                    const btns = await frame.$$('button, a, [role="button"], span');
                    for (const btn of btns) {
                        const txt = await btn.evaluate((el: any) => (el.textContent||'').replace(/\s+/g,' ').trim().toLowerCase());
                        if (txt === 'checkout' || txt === 'agree and continue' || txt === 'agree & continue') {
                            await btn.evaluate((el: any) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
                            await new Promise(r => setTimeout(r, 200));
                            await btn.click().catch(async () => { await btn.evaluate((el: any) => el.click()); });
                            checkoutClicked = true; Logger.info(`✅ [runSetup] Checkout clicked`); break;
                        }
                    }
                } catch(e){}
                if (checkoutClicked) break;
            }

            if (checkoutClicked) {
                await new Promise(r => setTimeout(r, 10000));
                // Close any popup pages
                const pages = await browser.pages();
                for (const p of pages) {
                    if (p !== page && !p.isClosed()) {
                        Logger.info(`📄 [runSetup] Closing popup: ${p.url()}`);
                        await p.close().catch(() => {});
                    }
                }
                // Re-click checkout if popup was closed
                for (const frame of page.frames()) {
                    try {
                        const btns = await frame.$$('button, a, [role="button"], span');
                        for (const btn of btns) {
                            const txt = await btn.evaluate((el: any) => (el.textContent||'').replace(/\s+/g,' ').trim().toLowerCase());
                            if (txt === 'checkout' || txt === 'agree and continue' || txt === 'agree & continue') {
                                await btn.click().catch(async () => { await btn.evaluate((el: any) => el.click()); });
                                Logger.info(`✅ [runSetup] Re-clicked checkout after popup`); break;
                            }
                        }
                    } catch(e){}
                }
                await new Promise(r => setTimeout(r, 5000));
            }

            // Step 9: Monitor redirect to getupgrade
            Logger.info(`⏳ [runSetup] Monitoring redirect to getupgrade...`);
            for (let i = 0; i < 25; i++) {
                if (page.url().includes('getupgrade')) { Logger.info(`✅ [runSetup] Reached getupgrade page`); break; }
                await new Promise(r => setTimeout(r, 1000));
            }
            // If not redirected, try manual navigation
            if (!page.url().includes('getupgrade') && !page.url().includes('admin.google.com')) {
                await page.goto('https://workspace.google.com/u/0/getupgrade', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            }

            Logger.info(`🏁 [runSetup] Setup complete for ${email} — URL: ${page.url()}`);
            await browser.close();
            return { success: true };
        } catch (error: any) {
            Logger.error(`❌ [runSetup] Failed for ${email}: ${error.message}`);
            if (browser) await browser.close().catch(() => {});
            return { success: false, error: error.message };
        }
    }


    // ─────────────────────────────────────────────────────────────────────────────────
    // Handle Checkout: Start trial → Address → NetBanking → Payment → Done
    // Called from verify() when login lands on /checkout URL
    // ─────────────────────────────────────────────────────────────────────────────────
    private async handleCheckoutWithRetry(page: any, email: string, password: string = '', attempts: number = 3): Promise<boolean> {
        for (let attempt = 1; attempt <= attempts; attempt++) {
            Logger.info(`🔄 [Checkout] Attempt ${attempt}/${attempts} for ${email} — URL: ${page.url().substring(0, 100)}`);
            try {
                const ok = await this.handleCheckout(page, email, password);
                if (ok) {
                    Logger.info(`✅ [Checkout] Attempt ${attempt} succeeded — now at: ${page.url().substring(0, 100)}`);
                    return true;
                }
            } catch (e: any) {
                Logger.warn(`⚠️ [Checkout] Attempt ${attempt} errored: ${e.message}`);
            }
            if (attempt < attempts) {
                Logger.info(`🔁 [Checkout] Waiting 5s before retry...`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
        Logger.error(`❌ [Checkout] All ${attempts} attempts failed for ${email}`);
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Save checkout debug state (URL + page text + visible buttons) so the reason
    // for a failed checkout can be diagnosed from the server.
    // ─────────────────────────────────────────────────────────────────────────────
    private async saveCheckoutDebugState(page: any, email: string, name: string): Promise<void> {
        try {
            const dir = 'debug_checkout';
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const file = `${dir}/${name}_${safeEmail}_${stamp}.json`;
            const state: any = {
                name,
                email,
                timestamp: new Date().toISOString(),
                url: page.url(),
                bodyText: (await this.safeEval(page, () => document.body ? document.body.innerText : '').catch(() => '')) || '',
                frames: []
            };
            for (const frame of page.frames()) {
                try {
                    const info = await this.safeEval(frame, () => {
                        const isVis = (el: any) => el.isConnected && el.getBoundingClientRect().width > 0;
                        const norm = (t: any) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        return {
                            url: location.href,
                            buttons: [...document.querySelectorAll('button, [role="button"], [role="option"], a')]
                                .filter(isVis)
                                .slice(0, 40)
                                .map((el: any) => ({ text: String(el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 80), role: el.getAttribute('role') }))
                        };
                    }, undefined, 4000);
                    if (info) state.frames.push(info);
                } catch (e) { }
            }
            try { await page.screenshot({ path: `${dir}/${name}_${safeEmail}_${stamp}.png`, fullPage: false }); } catch (e) { }
            fs.writeFileSync(file, JSON.stringify(state, null, 2));
            Logger.warn(`📦 Checkout debug state saved: ${file}`);
        } catch (e: any) {
            Logger.warn(`⚠️ Failed to save checkout debug state: ${e.message}`);
        }
    }

    private async handleCheckout(page: any, email: string = '', password: string = ''): Promise<boolean> {
        const tag = `[Checkout] [${email}]`;
        const log = (msg: string) => Logger.info(`${tag} ${msg}`);
        const warn = (msg: string) => Logger.warn(`${tag} ${msg}`);
        const browser: any = page.browser();
        const rnd = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
        const humanDelay = (min: number, max: number) => new Promise<void>(r => setTimeout(r, rnd(min, max)));

        // Heartbeat: always show live progress even if the page JS is busy.
        const heartbeat = setInterval(() => {
            try {
                Logger.info(`${tag} ⏳ heartbeat — still working... URL: ${(page.url() || '').substring(0, 120)}`);
            } catch (e) { }
        }, 8000);
        const stopHeartbeat = () => clearInterval(heartbeat);

        // Timeout-safe helpers (page/frame evaluate can hang forever on the busy checkout SPA).
        const safeEval = (target: any, fn: any, arg?: any, timeout = 6000) => this.safeEval(target, fn, arg, timeout);
        const safeEvalHandle = async (target: any, fn: any, arg?: any, timeout = 6000) => {
            try {
                return await Promise.race([
                    target.evaluateHandle(fn, arg),
                    new Promise(resolve => setTimeout(() => resolve(null), timeout))
                ]);
            } catch (e) { return null; }
        };

        // Iterate ALL pages + frames (checkout SPA often uses separate pages/popups).
        const getUsableFrames = async () => {
            const out: { frame: any; page: any }[] = [];
            try {
                const pages = await browser.pages();
                for (const p of pages) {
                    if (p.isClosed()) continue;
                    try { out.push({ frame: p.mainFrame(), page: p }); } catch (e) { }
                    try {
                        for (const f of p.frames()) {
                            if (f !== p.mainFrame() && !f.isDetached()) out.push({ frame: f, page: p });
                        }
                    } catch (e) { }
                }
            } catch (e) { }
            return out;
        };

        // Find the clickable ancestor of an EXACT text node (TextWalker approach from the reference).
        const findClickableByText = async (exactText: string) => {
            const frames = await getUsableFrames();
            for (const { frame, page: fp } of frames) {
                try {
                    const handle = await safeEvalHandle(frame, (tgt: string) => {
                        const isVis = (el: any) => {
                            if (!el || !el.isConnected) return false;
                            const st = window.getComputedStyle(el);
                            if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || st.opacity === '0') return false;
                            if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
                            if (el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
                            if (el.closest('[inert]')) return false;
                            const r = el.getBoundingClientRect();
                            return r.width > 0 && r.height > 0;
                        };
                        const norm = (t: any) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null) as any;
                        let n: any;
                        while ((n = walker.nextNode())) {
                            if (norm(n.nodeValue) === tgt) {
                                let curr: any = n.parentElement;
                                let clickable: any = null;
                                while (curr && curr !== document.body) {
                                    if (isVis(curr)) {
                                        const tag = curr.tagName.toLowerCase();
                                        const role = curr.getAttribute('role');
                                        const tab = curr.getAttribute('tabindex');
                                        const isBtnLike = tag === 'button' || role === 'button' ||
                                            (role === 'option') ||
                                            (tag === 'a' && curr.hasAttribute('href')) ||
                                            (tag === 'input' && (curr.type === 'button' || curr.type === 'submit')) ||
                                            (tab !== null && tab !== '-1');
                                        if (isBtnLike) {
                                            const isMarker = role === 'option' || curr.getAttribute('aria-haspopup') === 'listbox';
                                            if (!clickable || isMarker) clickable = curr;
                                            if (isMarker) break;
                                        }
                                    }
                                    curr = curr.parentElement;
                                }
                                if (clickable) return clickable;
                            }
                        }
                        return null;
                    }, exactText);
                    const el = handle ? handle.asElement() : null;
                    if (el) return { handle, frame, page: fp };
                    if (handle) await handle.dispose().catch(() => { });
                } catch (e) { }
            }
            return null;
        };

        // Dump every visible button/option — shown verbatim in the Process Log on failure.
        const dumpVisible = async (why: string) => {
            const frames = await getUsableFrames();
            for (const { frame } of frames) {
                try {
                    const els = await safeEval(frame, () => {
                        const isVis = (el: any) => el.isConnected && el.getBoundingClientRect().width > 0;
                        const norm = (t: any) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        return [...document.querySelectorAll('button, [role="button"], [role="option"], a, [role="listbox"] *')]
                            .filter(isVis)
                            .slice(0, 50)
                            .map((el: any) => ({
                                text: String(el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 70),
                                role: el.getAttribute('role'),
                                selected: el.getAttribute('aria-selected'),
                                expanded: el.getAttribute('aria-expanded')
                            }));
                    });
                    if (Array.isArray(els) && els.length) {
                        for (const e of els) {
                            if (e && e.text) log(`🔍 ${why} — visible: text="${e.text}" role=${e.role} selected=${e.selected} expanded=${e.expanded}`);
                        }
                    }
                } catch (e) { }
            }
        };

        // Compare previous vs current page URLs for popup detection.
        let lastCheckoutPage: any = null;

        try {
            // ── Step 1: Confirm we are on the checkout page ──
            const currentUrl = page.url();
            log(`Evaluating state — URL: ${currentUrl.substring(0, 140)}`);
            const pageText: string = (await safeEval(page, () => document.body.innerText)) || '';
            log(`Page body length: ${pageText.length} chars`);

            const isOnCheckout = /\/checkout(\b|\/|[\?#])/.test(currentUrl) ||
                /checkout|trial|sign up|billing|payment/i.test(pageText);

            if (!isOnCheckout) {
                log(`⚠️ Not on checkout page (${currentUrl.substring(0, 80)}) — skipping checkout handling`);
                stopHeartbeat();
                return true;
            }

            if (currentUrl.includes('admin.google.com')) {
                log(`🎉 Already on Admin Console — trial active. Skipping.`);
                stopHeartbeat();
                return true;
            }

            log(`✅ CONFIRMED on checkout page. Starting trial flow...`);
            await humanDelay(2000, 3000);

            // ── Step 2: Click "Start a trial" (native mouse clicks, retries + fallback) ──
            // 2a) Wait for plan page to render
            try {
                await page.waitForFunction(
                    () => {
                        const txt = (document.body && document.body.innerText) || '';
                        return /start\s+a\s+trial/i.test(txt) || /try\s+at\s+no\s+cost/i.test(txt) ||
                            /starter|business starter/i.test(txt) || /compare\s+plans/i.test(txt);
                    },
                    { timeout: 20000 }
                );
                log(`✅ Plan page rendered (found trial/plan text)`);
            } catch (e) {
                warn(`⚠️ Plan page load wait timed out`);
            }
            await humanDelay(1000, 1500);

            // 2b) Dismiss cookie consent dialog
            try {
                const cookieBtns = await page.$$('button, a, [role="button"]');
                for (const btn of cookieBtns) {
                    const txt = await btn.evaluate((el: any) => (el.textContent || '').trim().toLowerCase()).catch(() => '');
                    if (txt === 'no thanks' || txt === 'agree' || txt === 'accept all') {
                        const box = await btn.boundingBox();
                        if (box && box.width > 0 && box.height > 0) {
                            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                            log(`🍪 Cookie consent dismissed via native click: "${txt}"`);
                            await humanDelay(1500, 2000);
                            break;
                        }
                    }
                }
            } catch (e) { }

            // Trial button matchers — must cover BOTH "Start a trial" AND
            // "Try at no cost for 14 days" (current Google plan page).
            const TRIAL_RE = /^(start\s+a\s+trial|start\s+your\s+free\s+trial|start\s+free\s+trial|begin\s+trial|start\s+trial|try\s+at\s+no\s+cost(\s+for\s+14\s+days)?|try\s+at\s+no\s+cost\s+for\s+[\d\s]*\s*days|activate\s+trial)$/i;
            const TRIAL_SUBSTR = ['start a trial', 'start your free trial', 'start free trial', 'begin trial', 'start trial', 'try at no cost', 'try at no cost for 14 days', 'activate trial'];

            // 2c) Find + click the trial button using native mouse
            let started = false;
            for (let attempt = 1; attempt <= 3 && !started; attempt++) {
                let foundTrialBtn: any = null;
                let foundTrialText = '';
                try {
                    const allBtns = await page.$$('button, a, [role="button"], span');
                    for (const btn of allBtns) {
                        const txt = await btn.evaluate((el: any) => (el.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '');
                        if (TRIAL_RE.test(txt) || TRIAL_SUBSTR.some(v => txt.toLowerCase() === v || txt.toLowerCase().includes(v))) {
                            const box = await btn.boundingBox();
                            if (box && box.width > 40 && box.height > 20) {
                                foundTrialBtn = btn;
                                foundTrialText = txt;
                                break;
                            }
                        }
                    }
                    if (!foundTrialBtn) {
                        // Also scan <div>/<section> clickable cards (Google uses card-style plan buttons)
                        const frameList = await getUsableFrames();
                        for (const { frame } of frameList) {
                            const elHandle = await safeEvalHandle(frame, () => {
                                const vals = ['start a trial', 'your free trial', 'free trial', 'begin trial', 'start trial', 'try at no cost', 'try it free'];
                                const els = Array.from(document.querySelectorAll('[role="button"], div[tabindex], button, a, span')) as HTMLElement[];
                                for (const e of els) {
                                    const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
                                    if (t.length > 5 && t.length < 60) {
                                        const tl = t.toLowerCase();
                                        if (vals.some(v => tl === v || tl.includes(v))) {
                                            const r = e.getBoundingClientRect();
                                            if (r.width > 40 && r.height > 20) { e.click(); return t; }
                                        }
                                    }
                                }
                                return null;
                            });
                            const asEl = elHandle ? elHandle.asElement() : null;
                            const val = elHandle ? await elHandle.jsonValue().catch(() => null) : null;
                            if (asEl && val) {
                                started = true;
                                log(`▶️ Trial button clicked (frame-scan fallback): "${val}"`);
                                await humanDelay(2000, 3000);
                            }
                            if (elHandle) await elHandle.dispose().catch(() => { });
                            if (started) break;
                        }
                    }
                    if (foundTrialBtn && !started) {
                        const box = await foundTrialBtn.boundingBox();
                        if (box && box.width > 0 && box.height > 0) {
                            await foundTrialBtn.evaluate((el: any) => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => { });
                            await humanDelay(300, 600);
                            const freshBox = await foundTrialBtn.boundingBox();
                            if (freshBox) {
                                const cx = freshBox.x + freshBox.width / 2;
                                const cy = freshBox.y + freshBox.height / 2;
                                await page.mouse.move(cx, cy, { steps: 5 });
                                await humanDelay(80, 160);
                                await page.mouse.click(cx, cy, { delay: Math.random() * 60 + 40 });
                                started = true;
                                log(`▶️ Trial/plan button clicked via native mouse at (${cx.toFixed(0)}, ${cy.toFixed(0)}) text="${foundTrialText}"`);
                                break;
                            }
                        }
                    }
                } catch (e: any) {
                    warn(`⚠️ Start trial attempt ${attempt} error: ${e.message}`);
                }
                if (!started && attempt < 3) {
                    warn(`⚠️ Trial button attempt ${attempt}/3 failed, retrying...`);
                    await humanDelay(1500, 2500);
                }
            }

            // 2d) Fallback: click by any trial-ish text across all pages/frames
            if (!started) {
                warn(`⚠️ Native click failed, falling back to text-based trial click`);
                const frames = await getUsableFrames();
                for (const { frame, page: fp } of frames) {
                    try {
                        const clicked = await safeEval(frame, () => {
                            const vals = ['start a trial', 'start your free trial', 'start free trial', 'begin trial', 'start trial', 'try at no cost for 14 days', 'try at no cost', 'activate trial', 'start'];
                            const els = Array.from(document.querySelectorAll('button, a, [role="button"], span, div[tabindex], li')) as HTMLElement[];
                            for (const e of els) {
                                const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
                                if (t.length < 2 || t.length > 60) continue;
                                const tl = t.toLowerCase();
                                if (vals.some(v => tl === v || tl.includes(v))) {
                                    const r = e.getBoundingClientRect();
                                    if (r.width > 0 && r.height > 0) { e.scrollIntoView({ block: 'center', behavior: 'instant' }); e.click(); return t; }
                                }
                            }
                            return null;
                        }, undefined, 5000);
                        if (clicked) {
                            started = true;
                            log(`▶️ Start trial clicked via text fallback on page ${fp.url().substring(0, 80)}: "${clicked}"`);
                            await humanDelay(2000, 3000);
                            break;
                        }
                    } catch (e) { }
                }
            }

            if (!started) {
                warn(`❌ Trial button could not be clicked — dumping visible buttons`);
                await dumpVisible('start_trial_failed');
            } else {
                log(`✅ Trial button clicked`);
            }

            // ── Step 3: Wait for payment page contact section to load (past "Verifying...") ──
            log(`⏳ Waiting for payment page contact section to load...`);
            try {
                await page.waitForFunction(
                    () => {
                        const body = (document.body && document.body.innerText) || '';
                        const url = location.href || '';
                        return /add name and address|contact information|street address|add name/i.test(body) ||
                            !!document.querySelector('input[placeholder*="Street" i], input[placeholder*="City" i], input[placeholder*="address" i]') ||
                            !/\/checkout/.test(url);
                    },
                    { timeout: 30000 }
                );
                log(`✅ Payment page contact section loaded: ${page.url().substring(0, 140)}`);
            } catch (e) {
                warn(`⚠️ Payment page contact section wait timed out: ${page.url().substring(0, 100)}`);
            }
            await humanDelay(1000, 2000);

            // ── Step 3.5: If bounced to sign-in again, re-auth once ──
            const bouncedAgain: boolean = (await safeEval(page, () => /accounts\.google\.com\/v3\/signin/.test(location.href || ''))) === true;
            if (bouncedAgain) {
                warn(`⚠️ Bounced to Google sign-in again — re-authenticating for checkout`);
                log(`🔁 Attempting re-auth (email=${email})...`);
                const reauthOk = await this.reauthForCheckout(page, email, password);
                if (reauthOk) log(`✅ Re-authenticated for checkout`);
                else warn(`⚠️ Re-auth failed, continuing anyway`);
                await humanDelay(2000, 3000);
            }

            // ── Step 4: Address fill + NetBanking checkout flow (retryable) ──
            const MAX_ATTEMPTS = 3;
            let flowCompleted = false;
            for (let flowAttempt = 1; flowAttempt <= MAX_ATTEMPTS && !flowCompleted; flowAttempt++) {
                log(`🔄 Address + NetBanking flow attempt ${flowAttempt}/${MAX_ATTEMPTS}`);

                if (flowAttempt > 1) {
                    log(`⏳ Waiting before address/payment retry...`);
                    await humanDelay(2000, 3000);
                    const bouncedRetry: boolean = (await safeEval(page, () => /accounts\.google\.com\/v3\/signin/.test(location.href || ''))) === true;
                    if (bouncedRetry) {
                        log(`🔄 Re-authenticating before flow retry...`);
                        await this.reauthForCheckout(page, email, password);
                        await humanDelay(1500, 2500);
                    }
                }

                // 4a) Open address popup + fill Indian address
                let addrSaved = false;
                try {
                    addrSaved = await this.enterIndianAddressInPopup(page, browser, log, warn, humanDelay, safeEval, safeEvalHandle, getUsableFrames, findClickableByText, dumpVisible);
                } catch (e: any) {
                    warn(`⚠️ Address fill threw on attempt ${flowAttempt}: ${e.message}`);
                }
                if (!addrSaved) {
                    warn(`⚠️ Address form did not confirm saved on attempt ${flowAttempt} — retrying`);
                    continue;
                }

                // 4b) NetBanking + checkout
                try {
                    const nbResult = await this.selectNetBankingAndCheckout(page, browser, log, warn, humanDelay, safeEval, safeEvalHandle, getUsableFrames, findClickableByText, dumpVisible);
                    if (nbResult && nbResult.status === 'success') {
                        flowCompleted = true;
                        log(`🏁 Checkout flow complete — final URL: ${page.url().substring(0, 140)}`);
                    } else {
                        warn(`⚠️ NetBanking checkout did not confirm success on attempt ${flowAttempt}`);
                    }
                } catch (e: any) {
                    warn(`⚠️ NetBanking checkout failed on attempt ${flowAttempt}: ${e.message}`);
                }
            }

            if (!flowCompleted) {
                warn(`⚠️ Address + NetBanking flow did not complete after ${MAX_ATTEMPTS} attempts`);
                await dumpVisible('after_payment_failed');
            }

            log(`🏁 Checkout flow finished — final URL: ${page.url().substring(0, 140)}`);
            stopHeartbeat();
            if (lastCheckoutPage && !lastCheckoutPage.isClosed()) lastCheckoutPage.close().catch(() => { });
            return flowCompleted;
        } catch (error: any) {
            warn(`❌ Checkout flow error: ${error.message}`);
            await dumpVisible('checkout_caught_error');
            stopHeartbeat();
            if (lastCheckoutPage && !lastCheckoutPage.isClosed()) lastCheckoutPage.close().catch(() => { });
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Re-authenticate if Google bounced the checkout to the sign-in page.
    // ─────────────────────────────────────────────────────────────────────────────
    private async reauthForCheckout(page: any, email: string, password: string): Promise<boolean> {
        const tag = `[Checkout] [${email}]`;
        const log = (msg: string) => Logger.info(`${tag} ${msg}`);
        const warn = (msg: string) => Logger.warn(`${tag} ${msg}`);
        try {
            const CHECKOUT_URL = 'https://workspace.google.com/checkout?uj=2606-checkoutentry-signup-coreflow-accountredirect';
            const loginHandoff = `https://accounts.google.com/v3/signin/identifier?Email=${encodeURIComponent(email)}&continue=${encodeURIComponent(CHECKOUT_URL)}&service=CPanel&sacu=1&skipvpage=true&flowName=GlifWebSignIn&flowEntry=ServiceLogin`;
            await page.goto(loginHandoff, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
            await page.waitForSelector('input[type="email"], input[type="text"]', { visible: true, timeout: 15000 }).catch(() => null);
            await page.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 }).catch(() => null);
            const passInput = await page.$('input[type="password"]');
            if (!passInput) {
                log(`❗ Password field not shown during re-auth`);
                return false;
            }
            await this.humanLikeType(passInput, password);
            log(`✍️ Re-entered password for checkout re-auth`);
            const submit = await page.$('[type="submit"], #submit, button[type="submit"]').catch(() => null);
            if (submit) await submit.click().catch(() => { });
            await page.waitForFunction(() => !/accounts\.google\.com\/v3\/signin/.test(location.href || ''), { timeout: 20000 }).then(() => {
                log(`✅ Re-auth navigated away from sign-in: ${page.url().substring(0, 100)}`);
            }).catch(() => warn(`⚠️ Re-auth did not navigate away within 20s`));
            return !/accounts\.google\.com\/v3\/signin/.test(page.url());
        } catch (e: any) {
            warn(`⚠️ reauthForCheckout error: ${e.message}`);
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Open the Contact information popup and fill the Indian address.
    // Ported from #enterIndianAddressInPopup in createBusinessTrialWorkspaceScript.js
    // ─────────────────────────────────────────────────────────────────────────────
    private async enterIndianAddressInPopup(
        page: any, browser: any,
        log: (m: string) => void, warn: (m: string) => void,
        humanDelay: (a: number, b: number) => Promise<void>,
        safeEval: (t: any, f: any, a?: any, to?: number) => Promise<any>,
        safeEvalHandle: (t: any, f: any, a?: any, to?: number) => Promise<any>,
        getUsableFrames: () => Promise<{ frame: any; page: any }[]>,
        findClickableByText: (s: string) => Promise<any>,
        dumpVisible: (w: string) => Promise<void>
    ): Promise<boolean> {
        log(`🏠 Handling Contact information section`);

        // ── Step 0: "Agree and continue" terms gate (only if on accounts.google.com) ──
        const isOnGoogleAccounts: boolean = (await safeEval(page, () => location.href || '')).includes('accounts.google.com');
        if (isOnGoogleAccounts) {
            log(`⚠️ On accounts.google.com — looking for "Agree and continue" terms gate`);
            let termsClicked = false;
            for (let f = 0; f < 3 && !termsClicked; f++) {
                const frames = await getUsableFrames();
                for (const { frame } of frames) {
                    try {
                        const allBtns = await frame.$$('button, a, [role="button"], span');
                        for (const btn of allBtns) {
                            const txt = await btn.evaluate((el: any) => (el.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '');
                            if (/^agree and continue$|^agree & continue$/i.test(txt)) {
                                const box = await btn.boundingBox();
                                if (box && box.width > 0 && box.height > 0) {
                                    await btn.evaluate((el: any) => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => { });
                                    await humanDelay(300, 500);
                                    const fb = await btn.boundingBox();
                                    if (fb) {
                                        await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2, { steps: 4 });
                                        await humanDelay(80, 150);
                                        await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
                                        log(`✅ Clicked "Agree and continue" terms button`);
                                        termsClicked = true;
                                        await humanDelay(3000, 4500);
                                        break;
                                    }
                                }
                            }
                        }
                    } catch (e) { }
                    if (termsClicked) break;
                }
                if (!termsClicked) await humanDelay(500, 1000);
            }
        } else {
            log(`ℹ️ Already on billing page, skipping terms gate click`);
        }

        // ── Step 1: Wait for Contact information / Payment method section ──
        log(`⏳ Waiting for Contact information / Payment method section...`);
        const formLoaded = await this.waitForCheckoutFormToLoad(page, 30000);
        if (formLoaded) log(`✅ Payment page sections visible in frame(s)`);
        else warn(`⚠️ Payment page section wait timed out`);
        await humanDelay(1000, 1800);

        // ── Step 2: Check if address already set ("Change" link, no inputs) ──
        let addressAlreadySet = false;
        const frames = await getUsableFrames();
        for (const { frame } of frames) {
            try {
                const isSet = await safeEval(frame, () => {
                    const txt = (document.body && document.body.innerText) || '';
                    const hasChange = /\bchange\b/i.test(txt);
                    const hasContactSection = /contact information/i.test(txt);
                    const inputs = [...document.querySelectorAll('input, textarea')];
                    const hasAddressInputs = inputs.some((input: any) => {
                        const rect = input.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) return false;
                        const attrs = [input.getAttribute('placeholder'), input.getAttribute('aria-label'), input.getAttribute('name'), input.id, input.className].map((a: any) => (a || '').toLowerCase());
                        return attrs.some((a: any) => a.includes('street') || a.includes('address') || a.includes('city') || a.includes('locality') || a.includes('pin') || a.includes('zip') || a.includes('postal'));
                    });
                    return hasContactSection && hasChange && !hasAddressInputs;
                }, undefined, 3500);
                if (isSet === true) { addressAlreadySet = true; break; }
            } catch (e) { }
        }
        if (addressAlreadySet) {
            log(`✅ Address already set (detected "Change" link) — skipping address fill`);
            await humanDelay(500, 800);
            return true;
        }

        // ── Step 3: Trigger address inputs if not visible ──
        let hasInputsNow = false;
        const frames2 = await getUsableFrames();
        for (const { frame } of frames2) {
            try {
                const present = await safeEval(frame, () => {
                    const inputs = [...document.querySelectorAll('input, textarea')];
                    return inputs.some((input: any) => {
                        const rect = input.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) return false;
                        const attrs = [input.getAttribute('placeholder'), input.getAttribute('aria-label'), input.getAttribute('name'), input.id, input.className].map((a: any) => (a || '').toLowerCase());
                        return attrs.some((a: any) => a.includes('street') || a.includes('address') || a.includes('city') || a.includes('locality') || a.includes('pin') || a.includes('zip') || a.includes('postal'));
                    });
                }, undefined, 3500);
                if (present === true) { hasInputsNow = true; break; }
            } catch (e) { }
        }

        if (!hasInputsNow) {
            log(`ℹ️ No address inputs visible — looking for Add/Edit trigger in frames`);
            // Reference behaviour: click interactive elements (button/a/[role=button]/[tabindex])
            // ONLY, preferring the one inside the "contact information" heading container.
            const frameList = await getUsableFrames();
            let triggered = false;
            let frameUrl = '';
            for (const { frame } of frameList) {
                try {
                    triggered = await safeEval(frame, () => {
                        const norm = (t: any) => String(t || '').replace(/\s+/g, ' ').trim();
                        const labels = ['add name and address', 'add name', 'add address', 'edit address', 'add', 'edit', 'change', '+'];
                        const isInteract = (el: any) => {
                            const tag = el.tagName.toLowerCase();
                            const role = el.getAttribute && el.getAttribute('role');
                            return tag === 'button' || role === 'button' ||
                                (tag === 'a' && el.hasAttribute && el.hasAttribute('href')) ||
                                (tag === 'input' && (el.type === 'button' || el.type === 'submit')) ||
                                (el.getAttribute && el.getAttribute('tabindex') !== null && el.getAttribute('tabindex') !== '-1');
                        };
                        const clickMatch = (el: any) => {
                            const t = norm(el.textContent);
                            const lc = t.toLowerCase();
                            const aLabel = norm(el.getAttribute && el.getAttribute('aria-label'));
                            const title = norm(el.getAttribute && el.getAttribute('title'));
                            const hit = labels.some(l => {
                                const ll = l.toLowerCase();
                                return lc === ll || aLabel === ll || title === ll;
                            }) ||
                                (lc.includes('add name and address') || lc.includes('add name') || lc.includes('add address') || lc.includes('edit address') ||
                                    aLabel.includes('add name') || aLabel.includes('add address'));
                            if (hit) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.click(); return true; } }
                            return false;
                        };
                        // Strategy B (reference): find "contact information" heading, walk to container, click interactive inside
                        const allEls = [...document.querySelectorAll('*')];
                        let headingEl: any = null;
                        for (const el of allEls) {
                            const t = (el.childNodes.length <= 3 ? el.textContent || '' : '').trim();
                            if (/^contact information$/i.test(t) && el.getBoundingClientRect().width > 0) { headingEl = el; break; }
                        }
                        if (headingEl) {
                            let container: any = headingEl;
                            for (let i = 0; i < 8 && container.parentElement; i++) container = container.parentElement;
                            const inner = [...container.querySelectorAll('button, a, [role="button"], [tabindex="0"]')];
                            for (const el of inner) {
                                if (clickMatch(el)) return true;
                            }
                        }
                        // Strategy A (interactive-only, DOM order)
                        const clickables = [...document.querySelectorAll('button, a, [role="button"], [tabindex="0"], [aria-haspopup]')];
                        for (const el of clickables) {
                            if (!isInteract(el)) continue;
                            if (clickMatch(el)) return true;
                        }
                        return false;
                    }, undefined, 5000);
                    if (triggered === true) { frameUrl = frame.url(); break; }
                } catch (e) { }
            }

            if (triggered === true) {
                log(`✅ Triggered "Add name and address" / address form open (frame=${frameUrl.substring(0, 80)})`);
                await humanDelay(2000, 3000);
            } else {
                warn(`⚠️ No interactive "Add name and address" trigger found in any frame`);
            }
        }

        // ── Step 4: Fill each field with retry (reference: fillInputInFramesWithRetry) ──
        const fillInputInFrames = async (label: string, placeholders: string[], value: string): Promise<boolean> => {
            const aframes = await getUsableFrames();
            for (const { frame } of aframes) {
                try {
                    const elements = await frame.$$('input, textarea');
                    for (const el of elements) {
                        const matched = await safeEval(el, (input: any, [phList, lbl]: [string[], string]) => {
                            const getVisibleText = (node: any) => (node.textContent || node.innerText || '').trim().toLowerCase();
                            const ariaLab = (input.getAttribute('aria-label') || '').toLowerCase();
                            const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
                            const nameAttr = (input.getAttribute('name') || '').toLowerCase();
                            const idAttr = (input.id || '').toLowerCase();
                            const parts = [ariaLab, placeholder, nameAttr, idAttr];
                            if (input.id) { for (const l of document.querySelectorAll(`label[for="${input.id}"]`)) parts.push(l.textContent || ''); }
                            const anc = input.closest('label'); if (anc) parts.push(anc.textContent || '');
                            const ariaLabBy = input.getAttribute('aria-labelledby');
                            if (ariaLabBy) { for (const id of ariaLabBy.split(/\s+/).filter(Boolean)) { const e = document.getElementById(id); if (e) parts.push(e.textContent || ''); } }
                            const intrinsicText = parts.join(' ').toLowerCase();

                            const isOrgOrName = ['organization', 'organisation', 'company', 'business', 'enterprise', 'firm', 'legal name', 'contact name', 'recipient'].some(w => intrinsicText.includes(w));
                            if (isOrgOrName) return false;

                            const lblLower = lbl.toLowerCase();
                            const hasKw = (...ws: string[]) => ws.some(w => intrinsicText.includes(w));
                            if (lblLower.includes('pin') || lblLower.includes('zip') || lblLower.includes('postal')) {
                                if (hasKw('apt', 'suite', 'room', 'apartment', 'floor', 'landmark', 'street', 'address', 'city', 'state', 'country', 'town', 'locality')) return false;
                            } else if (lblLower.includes('city') || lblLower.includes('town') || lblLower.includes('locality')) {
                                if (hasKw('state', 'country', 'zip', 'pin', 'postal', 'street', 'address', 'apt', 'suite', 'room', 'apartment', 'landmark')) return false;
                            } else if (lblLower.includes('apt') || lblLower.includes('suite') || lblLower.includes('landmark') || lblLower.includes('line 2')) {
                                if (hasKw('pin', 'zip', 'postal', 'city', 'state', 'country', 'street', 'address line 1', 'line 1', 'line1')) return false;
                            } else if (lblLower.includes('street') || lblLower.includes('line 1') || lblLower.includes('address')) {
                                if (hasKw('pin', 'zip', 'postal', 'city', 'state', 'country', 'apt', 'suite', 'room', 'apartment', 'line 2', 'line2')) return false;
                            }

                            const attrs = [placeholder, ariaLab, nameAttr, idAttr].map(a => (a || '').toLowerCase());
                            if (phList.some(ph => attrs.some(a => a.includes(ph.toLowerCase())))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
                            if (ariaLabBy) { for (const id of ariaLabBy.trim().split(/\s+/)) { const l = document.getElementById(id); if (l && phList.some(ph => getVisibleText(l).includes(ph.toLowerCase()))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; } } }
                            if (input.id) { for (const l of document.querySelectorAll(`label[for="${input.id}"]`)) { if (phList.some(ph => getVisibleText(l).includes(ph.toLowerCase()))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; } } }
                            const matchesAncestor = phList.some(ph => {
                                const lph = ph.toLowerCase();
                                let parent = input.parentElement; let depth = 0;
                                while (parent && depth < 3) {
                                    const inputsInParent = parent.querySelectorAll('input, textarea');
                                    if (inputsInParent.length === 1) { if (getVisibleText(parent).includes(lph)) return true; }
                                    parent = parent.parentElement; depth++;
                                }
                                return false;
                            });
                            if (matchesAncestor) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
                            return false;
                        }, [placeholders, label]);
                        if (matched === true) {
                            const box = await el.boundingBox();
                            if (box) {
                                await el.evaluate((e: any) => e.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => { });
                                await humanDelay(150, 300);
                                const fb = await el.boundingBox();
                                if (fb) {
                                    await el.evaluate((e: any) => { e.click(); e.focus(); }).catch(() => { });
                                    await humanDelay(50, 100);
                                    await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2, { clickCount: 3 }).catch(() => { });
                                    await humanDelay(100, 200);
                                    await el.evaluate((e: any) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
                                    await el.type(String(value), { delay: Math.random() * 30 + 30 });
                                    await el.evaluate((e: any) => e.dispatchEvent(new Event('blur', { bubbles: true })));
                                    return true;
                                }
                            }
                        }
                    }
                } catch (e) { }
            }
            return false;
        };
        const fillInputInFramesWithRetry = async (label: string, placeholders: string[], value: string): Promise<boolean> => {
            for (let attempt = 1; attempt <= 5; attempt++) {
                const filled = await fillInputInFrames(label, placeholders, value);
                if (filled) return true;
                log(`⏳ Retry ${attempt}/5: waiting for input field "${label}"...`);
                await humanDelay(1000, 1500);
            }
            return false;
        };

        // State dropdown (reference step order)
        const selectFromComboboxOrSelectInFrame = async (frame: any, value: string, opts: { labels: string[] }) => {
            try {
                const dropdowns = await frame.$$('select, [role="combobox"], [role="listbox"], [role="button"], input[aria-haspopup="listbox"], input[aria-haspopup="true"], [aria-expanded]');
                for (const el of dropdowns) {
                    const matched = await safeEval(el, (input: any, keywords: string[]) => {
                        const getVisibleText = (node: any) => (node.textContent || node.innerText || '').trim().toLowerCase();
                        const attrs = [input.getAttribute('placeholder'), input.getAttribute('aria-label'), input.getAttribute('name'), input.id, input.className, input.tagName].map((a: any) => (a || '').toLowerCase());
                        if (keywords.some(ph => attrs.some((a: any) => a.includes(ph.toLowerCase())))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
                        const labelledby = input.getAttribute('aria-labelledby');
                        if (labelledby) { for (const id of labelledby.trim().split(/\s+/)) { const l = document.getElementById(id); if (l && keywords.some(ph => getVisibleText(l).includes(ph.toLowerCase()))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; } } }
                        if (input.id) { for (const l of document.querySelectorAll(`label[for="${input.id}"]`)) { if (keywords.some(ph => getVisibleText(l).includes(ph.toLowerCase()))) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; } } }
                        const matchesAncestor = keywords.some(ph => { const lph = ph.toLowerCase(); let p = input.parentElement; let d = 0; while (p && d < 5) { if (getVisibleText(p).includes(lph)) return true; p = p.parentElement; d++; } return false; });
                        if (matchesAncestor) { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
                        return false;
                    }, opts.labels, 3500);
                    if (matched === true) {
                        const tagName = await safeEval(el, (e: any) => e.tagName.toLowerCase(), undefined, 3500);
                        if (tagName === 'select') {
                            const ok = await safeEval(el, (e: any, v: string) => {
                                const optsList = [...e.querySelectorAll('option')];
                                const m = optsList.find((o: any) => (o.textContent || '').trim().toLowerCase().includes(v.toLowerCase()));
                                if (m) { e.value = m.value; e.dispatchEvent(new Event('change', { bubbles: true })); e.dispatchEvent(new Event('input', { bubbles: true })); return m.textContent.trim(); }
                                return null;
                            }, value, 3500);
                            if (ok) return true;
                        } else {
                            try {
                                const box = await el.boundingBox();
                                if (box) {
                                    await el.evaluate((e: any) => e.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => { });
                                    await humanDelay(200, 400);
                                    const fb = await el.boundingBox();
                                    if (fb) {
                                        log(`🖱️ Clicking dropdown element to open options`);
                                        await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
                                        await humanDelay(800, 1500);
                                        // Search all frames for matching option elements
                                        const aframes = await getUsableFrames();
                                        for (const { frame: f } of aframes) {
                                            try {
                                                const options = await f.$$('[role="option"], li, div, span, [role="listbox"] *');
                                                for (const opt of options) {
                                                    const txt = await safeEval(opt, (e: any) => { const rect = e.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) return null; return (e.textContent || e.innerText || '').trim(); }, undefined, 3500);
                                                    if (txt && String(txt).toLowerCase() === String(value).toLowerCase()) {
                                                        const optBox = await opt.boundingBox();
                                                        if (optBox) {
                                                            log(`🎯 Found matching option element with text "${txt}" — clicking it`);
                                                            await opt.evaluate((e: any) => e.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => { });
                                                            await humanDelay(150, 300);
                                                            const optFb = await opt.boundingBox();
                                                            if (optFb) {
                                                                await page.mouse.click(optFb.x + optFb.width / 2, optFb.y + optFb.height / 2);
                                                                await humanDelay(500, 1000);
                                                                await opt.dispose().catch(() => { });
                                                                return true;
                                                            }
                                                        }
                                                    }
                                                    await opt.dispose().catch(() => { });
                                                }
                                            } catch (e) { }
                                        }
                                        // keyboard fallback
                                        log(`⚠️ Option element not found by click — trying keyboard fallback`);
                                        await page.keyboard.type(value, { delay: Math.random() * 30 + 30 });
                                        await humanDelay(500, 800);
                                        await page.keyboard.press('Enter');
                                        await humanDelay(500, 1000);
                                        return true;
                                    }
                                }
                            } catch (e) { }
                        }
                    }
                }
            } catch (e) { }
            return false;
        };

        let addressSaved = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
            const addr = this.generateIndianAddress();
            log(`🏠 Filling Indian address (attempt ${attempt}/5): ${addr.city}, ${addr.state} ${addr.pin} — street: ${addr.addressLine1}`);

            const streetFilled = await fillInputInFramesWithRetry('Street Address', ['Street address', 'Address line 1', 'Street', 'Address'], addr.addressLine1);
            log(`📝 Street [${addr.addressLine1}]: ${streetFilled ? '✅' : '⚠️'}`);
            await humanDelay(300, 600);

            try { await fillInputInFramesWithRetry('Address Line 2', ['Apt, suite', 'Apt,', 'Suite', 'Landmark', 'Address line 2', 'Address 2'], addr.addressLine2); } catch (e) { }
            await humanDelay(200, 400);

            const cityFilled = await fillInputInFramesWithRetry('City', ['City', 'Town', 'Locality'], addr.city);
            log(`📝 City [${addr.city}]: ${cityFilled ? '✅' : '⚠️'}`);
            await humanDelay(300, 600);

            const pinFilled = await fillInputInFramesWithRetry('PIN code', ['Pin code', 'PIN code', 'Zip code', 'Postal code', 'Pincode', 'ZIP', 'Postal'], addr.pin);
            log(`📝 PIN [${addr.pin}]: ${pinFilled ? '✅' : '⚠️'}`);
            await humanDelay(300, 600);

            let stateFilled = false;
            for (let stAttempt = 1; stAttempt <= 3; stAttempt++) {
                const aframes = await getUsableFrames();
                for (const { frame } of aframes) {
                    stateFilled = await selectFromComboboxOrSelectInFrame(frame, addr.state, { labels: ['state', 'province', 'region', 'state/region', 'state or region'] });
                    if (stateFilled) break;
                }
                if (stateFilled) break;
                log(`⏳ Waiting for state dropdown selection (attempt ${stAttempt}/3)...`);
                await humanDelay(1000, 1500);
            }
            log(`📝 State [${addr.state}]: ${stateFilled ? '✅' : '⚠️'}`);
            await humanDelay(500, 1000);

            // Save address
            let saveClicked = false;
            const saveTargets = ['Save', 'Save address', 'Apply', 'OK', 'Done', 'Confirm', 'Continue', 'Next'];
            const aframes = await getUsableFrames();
            for (const { frame } of aframes) {
                try {
                    const allBtns = await frame.$$('button, a, [role="button"]');
                    for (const btn of allBtns) {
                        const txt = await btn.evaluate((el: any) => (el.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '');
                        if (saveTargets.some(t => new RegExp(`^${t}$`, 'i').test(txt))) {
                            const box = await btn.boundingBox();
                            if (box && box.width > 0 && box.height > 0) {
                                await btn.evaluate((el: any) => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => { });
                                await humanDelay(150, 300);
                                const fb = await btn.boundingBox();
                                if (fb) {
                                    await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
                                    saveClicked = true;
                                    log(`💾 Save clicked in frame: "${txt}"`);
                                    break;
                                }
                            }
                        }
                    }
                } catch (e) { }
                if (saveClicked) break;
            }
            await humanDelay(2500, 3500);

            // Did the form close?
            const checkInputsVisible = async () => {
                const cframes = await getUsableFrames();
                for (const { frame } of cframes) {
                    try {
                        const present = await safeEval(frame, () => {
                            const inputs = [...document.querySelectorAll('input, textarea')];
                            return inputs.some((input: any) => { const r = input.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
                        }, undefined, 3500);
                        if (present === true) return true;
                    } catch (e) { }
                }
                return false;
            };
            const stillHasInputs = await checkInputsVisible();
            const anyFieldFilled = streetFilled || cityFilled || pinFilled || stateFilled;
            if (!stillHasInputs && anyFieldFilled) {
                log(`🎉 Address form saved and closed successfully!`);
                addressSaved = true;
                break;
            } else if (!anyFieldFilled) {
                warn(`⚠️ No address input was found/filled — the "Add name and address" trigger likely never opened. Re-triggering...`);
                await humanDelay(1000, 1500);
                // Re-attempt the trigger (interactive elements ONLY — div/span clicks don't open the popup)
                const trg = await getUsableFrames();
                for (const { frame } of trg) {
                    try {
                        const t2 = await safeEval(frame, () => {
                            const norm = (t: any) => String(t || '').replace(/\s+/g, ' ').trim();
                            const labels = ['add name and address', 'add name', 'add address'];
                            const clickables = [...document.querySelectorAll('button, a, [role="button"], [tabindex="0"]')];
                            for (const el of clickables) {
                                const t = norm(el.textContent);
                                const hit = labels.some(l => t.toLowerCase() === l.toLowerCase()) ||
                                    t.toLowerCase().includes('add name') || t.toLowerCase().includes('add address');
                                if (hit) {
                                    const rect = el.getBoundingClientRect();
                                    if (rect.width > 0 && rect.height > 0) { (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' }); (el as HTMLElement).click(); return t; }
                                }
                            }
                            return null;
                        }, undefined, 3500);
                        if (t2) { log(`✅ Re-clicked "Add name and address" trigger (interactive): "${t2}"`); break; }
                    } catch (e) { }
                }
                await humanDelay(1500, 2500);
            } else {
                warn(`⚠️ Address form is still open. Checking for errors or trying to save again...`);
                await humanDelay(1500, 2500);
            }
        }

        log(`🔗 After save: ${page.url().substring(0, 140)}`);
        return addressSaved;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Select NetBanking payment method + banks + checkout.
    // Ported from #selectNetBankingAndCheckout in createBusinessTrialWorkspaceScript.js
    // ─────────────────────────────────────────────────────────────────────────────
    private async selectNetBankingAndCheckout(
        page: any, browser: any,
        log: (m: string) => void, warn: (m: string) => void,
        humanDelay: (a: number, b: number) => Promise<void>,
        safeEval: (t: any, f: any, a?: any, to?: number) => Promise<any>,
        safeEvalHandle: (t: any, f: any, a?: any, to?: number) => Promise<any>,
        getUsableFrames: () => Promise<{ frame: any; page: any }[]>,
        findClickableByText: (s: string) => Promise<any>,
        dumpVisible: (w: string) => Promise<void>
    ): Promise<{ status: string; url?: string; detail?: string }> {
        log(`💳 Selecting NetBanking + Checkout`);
        await humanDelay(1500, 2500);

        let listOpened = false;
        let addPaymentClicked = false;

        // ── Step 1: Click "Add payment method" (VERBATIM reference walker + #getUsableFrames loop) ──
        for (let retry = 0; retry < 2 && !listOpened; retry++) {
            const framesInfo = await getUsableFrames();
            let clickTargetHandle: any = null;
            let currentFrame: any = null;
            let currentPage: any = null;

            for (const { frame, page } of framesInfo) {
                try {
                    clickTargetHandle = await safeEvalHandle(frame, () => {
                        const isVisibleAndEnabled = (el: any) => {
                            if (!el.isConnected) return false;
                            const style = window.getComputedStyle(el);
                            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
                            if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
                            if (el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
                            if (el.closest('[inert]')) return false;
                            const rect = el.getBoundingClientRect();
                            if (rect.width <= 0 || rect.height <= 0) return false;
                            if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
                            return true;
                        };
                        const normalizeText = (t: any) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null) as any;
                        let n: any;
                        let bestClickable: any = null;
                        while ((n = walker.nextNode())) {
                            if (normalizeText(n.nodeValue) === 'add payment method') {
                                let curr = n.parentElement;
                                let clickable: any = null;
                                while (curr && curr !== document.body) {
                                    if (isVisibleAndEnabled(curr)) {
                                        const tag = curr.tagName.toLowerCase();
                                        const role = curr.getAttribute('role');
                                        const tabIndex = curr.getAttribute('tabindex');
                                        const isBtnLike = tag === 'button' || role === 'button' || (tag === 'a' && curr.hasAttribute('href')) ||
                                                          (tag === 'input' && (curr.type === 'button' || curr.type === 'submit')) ||
                                                          (tabIndex !== null && tabIndex !== '-1');
                                        if (isBtnLike) {
                                            if (!clickable || curr.getAttribute('aria-haspopup') === 'listbox') {
                                                clickable = curr;
                                            }
                                            if (curr.getAttribute('aria-haspopup') === 'listbox') break;
                                        }
                                    }
                                    curr = curr.parentElement;
                                }
                                if (clickable) {
                                    bestClickable = clickable;
                                    break;
                                }
                            }
                        }
                        return bestClickable;
                    }, undefined, 6000);

                    const el = clickTargetHandle ? clickTargetHandle.asElement() : null;
                    if (el) {
                        const info = await safeEval(frame, (node: any) => ({
                            tag: node.tagName.toLowerCase(),
                            role: node.getAttribute('role'),
                            hasPopup: node.getAttribute('aria-haspopup'),
                            expanded: node.getAttribute('aria-expanded')
                        }), clickTargetHandle, 5000);
                        log(`🎯 Found "Add payment method" | Page: ${page.url()} | Frame: ${frame.url()} | Tag: ${info?.tag} | Role: ${info?.role} | HasPopup: ${info?.hasPopup}`);
                        await safeEval(frame, (node: any) => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }), clickTargetHandle, 5000);
                        currentFrame = frame;
                        currentPage = page;
                        break;
                    } else {
                        if (clickTargetHandle) await clickTargetHandle.dispose().catch(() => { });
                    }
                } catch (e) { }
            }

            if (currentFrame && clickTargetHandle) {
                const el = clickTargetHandle.asElement();
                try {
                    await el.click();
                    log(`🖱️ Clicked "Add payment method"`);
                    addPaymentClicked = true;
                } catch (e: any) {
                    warn(`⚠️ Error clicking "Add payment method": ${e.message}`);
                }
                await clickTargetHandle.dispose().catch(() => { });

                if (addPaymentClicked) {
                    // VERBATIM from reference: raw frame.evaluate() — no Promise.race
                    // wrapper. The Promise.race timeout caused dangling evaluate promises
                    // that piled up and made the first poll always miss the list opening.
                    const pollStart = Date.now();
                    while (Date.now() - pollStart < 20000 && !listOpened) {
                        const checkFrames = await getUsableFrames();
                        for (const { frame } of checkFrames) {
                            try {
                                listOpened = await frame.evaluate(() => {
                                    const isVis = (e: any) => {
                                        if (!e.isConnected) return false;
                                        const s = window.getComputedStyle(e);
                                        return s.display !== 'none' && s.visibility !== 'hidden' && s.visibility !== 'collapse' && s.opacity !== '0' && !e.hasAttribute('hidden') && e.getAttribute('aria-hidden') !== 'true' && e.getBoundingClientRect().width > 0;
                                    };
                                    const norm = (t: any) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
                                    const els = [...document.querySelectorAll('[role="listbox"], [role="menu"], [role="dialog"], [role="option"]')];
                                    for (const e of els) {
                                        if (!isVis(e)) continue;
                                        const text = norm(e.textContent);
                                        if (text.includes('add credit or debit card') || text.includes('pay by upi qr code') || text.includes('pay with netbanking')) return true;
                                    }
                                    const addBtn = [...document.querySelectorAll('button, [role="button"]')].find((b: any) => norm(b.textContent) === 'add payment method' && b.getAttribute('aria-expanded') === 'true');
                                    if (addBtn && [...document.querySelectorAll('[role="option"]')].some(isVis)) return true;
                                    return false;
                                });
                                if (listOpened) break;
                            } catch (e) { }
                        }
                        if (listOpened) break;
                        await new Promise(r => setTimeout(r, 250));
                    }
                    if (listOpened) log(`✅ Payment method list confirmed open`);
                }
            }

            if (!listOpened && retry === 0) {
                warn(`⚠️ Payment list did not open. Retrying...`);
                await humanDelay(1000, 2000);
            }
        }

        if (!listOpened) {
            warn(`❌ Payment method dialog did not open — dumping visible elements`);
            await dumpVisible('payment_list_not_opened');
            return { status: 'failed', detail: 'payment method dialog did not open' };
        }

// ── Step 2: Click "Pay with NetBanking" + verify (VERBATIM reference) ──
        let netBankingVerified = false;

        for (let retry = 0; retry < 2 && !netBankingVerified; retry++) {
            let nbClicked = false;
            let currentFrame: any = null;
            let clickTargetHandle: any = null;
            let currentPage: any = null;

            const framesInfo = await getUsableFrames();
            for (const { frame, page } of framesInfo) {
                try {
                    clickTargetHandle = await safeEvalHandle(frame, () => {
                        const isVis = (el: any) => {
                            if (!el.isConnected) return false;
                            const style = window.getComputedStyle(el);
                            return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0' &&
                                   !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true' &&
                                   (!el.disabled && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') &&
                                   !el.closest('[inert]') && el.getBoundingClientRect().width > 0;
                        };
                        const norm = (t: any) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

                        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null) as any;
                        let n: any;
                        while ((n = walker.nextNode())) {
                            if (norm(n.nodeValue) === 'pay with netbanking') {
                                let curr = n.parentElement;
                                let clickable: any = null;
                                while (curr && curr !== document.body) {
                                    if (isVis(curr)) {
                                        const role = curr.getAttribute('role');
                                        const tag = curr.tagName.toLowerCase();
                                        if (role === 'option' || role === 'button' || tag === 'button' || curr.getAttribute('tabindex') !== null) {
                                            if (!clickable || role === 'option') clickable = curr;
                                            if (role === 'option') break;
                                        }
                                    }
                                    curr = curr.parentElement;
                                }
                                if (clickable) return clickable;
                            }
                        }
                        return null;
                    }, undefined, 6000);

                    const el = clickTargetHandle ? clickTargetHandle.asElement() : null;
                    if (el) {
                        const info = await safeEval(frame, (node: any) => ({
                            tag: node.tagName.toLowerCase(), role: node.getAttribute('role'), selected: node.getAttribute('aria-selected')
                        }), clickTargetHandle, 5000);
                        log(`🎯 Found "Pay with NetBanking" | Page: ${page.url()} | Frame: ${frame.url()} | Tag: ${info?.tag} | Role: ${info?.role} | Selected: ${info?.selected}`);
                        await safeEval(frame, (node: any) => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }), clickTargetHandle, 5000);
                        currentFrame = frame;
                        currentPage = page;
                        break;
                    } else {
                        if (clickTargetHandle) await clickTargetHandle.dispose().catch(() => { });
                    }
                } catch (e) { }
            }

            if (currentFrame && clickTargetHandle) {
                const el = clickTargetHandle.asElement();

                // Re-query to get a fresh handle before clicking (reference)
                const requeryHandle = await safeEvalHandle(currentFrame, () => {
                    const isVis = (e: any) => e.isConnected && window.getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
                    const norm = (t: any) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null) as any;
                    let n: any;
                    while ((n = walker.nextNode())) {
                        if (norm(n.nodeValue) === 'pay with netbanking') {
                            let curr = n.parentElement;
                            while (curr && curr !== document.body) {
                                if (isVis(curr)) {
                                    const role = curr.getAttribute('role');
                                    if (role === 'option' || role === 'button' || curr.tagName.toLowerCase() === 'button' || curr.getAttribute('tabindex') !== null) return curr;
                                }
                                curr = curr.parentElement;
                            }
                        }
                    }
                    return null;
                }, undefined, 6000);

                const rqEl = requeryHandle ? requeryHandle.asElement() : null;
                if (rqEl) {
                    try {
                        await rqEl.click();
                        log(`🖱️ Clicked NetBanking option`);
                        nbClicked = true;
                    } catch (e) { }
                }
                if (requeryHandle) await requeryHandle.dispose().catch(() => { });
                await clickTargetHandle.dispose().catch(() => { });

                if (nbClicked) {
                    const pollStart = Date.now();
                    while (Date.now() - pollStart < 15000 && !netBankingVerified) {
                        try {
                            const isVerified = await safeEval(currentFrame, () => {
                                const norm = (t: any) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
                                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null) as any;
                                let n: any;
                                while ((n = walker.nextNode())) {
                                    if (norm(n.nodeValue) === 'pay with netbanking') {
                                        let p: any = n.parentElement;
                                        for (let i = 0; i < 6 && p && p !== document.body; i++) {
                                            if (p.getAttribute('aria-selected') === 'true' || p.getAttribute('data-is-selected') === 'true') return true;
                                            const input = p.querySelector('input[type="radio"], input[type="checkbox"]');
                                            if (input && input.checked) return true;
                                            p = p.parentElement;
                                        }
                                    }
                                }
                                const summaryVisible = [...document.querySelectorAll('*')].some((el: any) => {
                                    if (el.childNodes.length === 1 && el.childNodes[0].nodeType === Node.TEXT_NODE) {
                                        const t = norm(el.textContent);
                                        if (t === 'pay with netbanking' || t === 'netbanking') return el.getBoundingClientRect().width > 0;
                                    }
                                    return false;
                                });
                                if (summaryVisible) return true;
                                const cb = document.querySelector('[role="combobox"]');
                                if (cb && cb.getBoundingClientRect().width > 0) return true;
                                return false;
                            }, undefined, 2500);
                            if (isVerified === true) { netBankingVerified = true; break; }
                            const url = (currentPage.url() || '').toLowerCase();
                            if (url.includes('netbanking') || url.includes('banktransfer')) { netBankingVerified = true; break; }
                        } catch (e) { }
                        await new Promise(r => setTimeout(r, 300));
                    }
                    if (netBankingVerified) log(`✅ NetBanking selection verified`);
                }
            }
            if (!netBankingVerified && retry === 0) await humanDelay(1000, 2000);
        }

        if (!netBankingVerified) {
            warn(`❌ NetBanking option not found or verified — dumping visible options`);
            await dumpVisible('netbanking_not_verified');
            return { status: 'failed', detail: 'netbanking option not found or verified' };
        }

        log(`✅ NetBanking section clicked`);
        await humanDelay(1500, 2500);

        // ── Step 3: Pick a bank inside frames ──
        // VERBATIM port of the reference's bank loop:
        //   for each bank → for each frame → #selectFromComboboxOrSelectInFrame first,
        //   then a direct exact-text scan of button/a/option/radio/li/div/span.
        const banks = ['HDFC Bank', 'ICICI Bank', 'State Bank of India', 'Axis Bank', 'Kotak Mahindra Bank', 'YES Bank', 'IDFC FIRST Bank', 'Punjab National Bank', 'Bank of Baroda', 'Canara Bank', 'Union Bank of India', 'IndusInd Bank', 'Federal Bank', 'RBL Bank', 'South Indian Bank'];

        const q$$ = async (frame: any, sel: string, ms = 6000) => {
            try {
                return await Promise.race([
                    frame.$$(sel),
                    new Promise(resolve => setTimeout(() => resolve([]), ms))
                ]);
            } catch (e) { return []; }
        };

        // ── #selectDropdownOptionRobust (reference verbatim) ──
        const selectDropdownOptionRobust = async (frame: any, pageForMouse: any, el: any, value: string): Promise<boolean> => {
            try {
                const box = await el.boundingBox();
                if (!box) return false;
                await el.evaluate((e: any) => e.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => { });
                await humanDelay(200, 400);
                const fb = await el.boundingBox();
                if (!fb) return false;
                log(`🖱️ Clicking dropdown element to open options`);
                await pageForMouse.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
                await humanDelay(800, 1500); // Wait for options to transition in
                // Search all frames for matching option elements
                const allFrames = await getUsableFrames();
                for (const { frame: f } of allFrames) {
                    try {
                        const options = await q$$(f, '[role="option"], li, div, span, [role="listbox"] *');
                        for (const opt of options) {
                            const txt = await opt.evaluate((e: any) => {
                                const rect = e.getBoundingClientRect();
                                if (rect.width === 0 || rect.height === 0) return null;
                                return (e.textContent || e.innerText || '').trim();
                            }).catch(() => null);
                            if (txt && String(txt).toLowerCase() === value.toLowerCase()) {
                                const optBox = await opt.boundingBox();
                                if (optBox) {
                                    log(`🎯 Found matching option element with text "${txt}" — clicking it`);
                                    await opt.evaluate((e: any) => e.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => { });
                                    await humanDelay(150, 300);
                                    const optFb = await opt.boundingBox();
                                    if (optFb) {
                                        await pageForMouse.mouse.click(optFb.x + optFb.width / 2, optFb.y + optFb.height / 2);
                                        await humanDelay(500, 1000);
                                        return true;
                                    }
                                }
                            }
                            await opt.dispose().catch(() => { });
                        }
                    } catch (e) { }
                }
                // Fallback: type the value and press Enter
                log(`⚠️ Option element not found by click — trying keyboard fallback`);
                await pageForMouse.keyboard.type(value, { delay: Math.random() * 30 + 30 });
                await humanDelay(500, 800);
                await pageForMouse.keyboard.press('Enter');
                await humanDelay(500, 1000);
                return true;
            } catch (e) { }
            return false;
        };

        // ── #selectFromComboboxOrSelectInFrame (reference verbatim) ──
        const selectFromComboboxOrSelectInFrame = async (frame: any, pageForMouse: any, value: string): Promise<boolean> => {
            try {
                const matchLabels = ['bank', 'choose bank', 'select bank', 'select your bank', 'net banking bank', 'select a bank'];
                const dropdowns = await q$$(frame, 'select, [role="combobox"], [role="listbox"], [role="button"], input[aria-haspopup="listbox"], input[aria-haspopup="true"], [aria-expanded]');
                for (const el of dropdowns) {
                    let matched = false;
                    try {
                        matched = await el.evaluate((input: any, keywords: string[]) => {
                            const getVisibleText = (node: any) => (node.textContent || node.innerText || '').trim().toLowerCase();
                            const attrs = [input.getAttribute('placeholder'), input.getAttribute('aria-label'), input.getAttribute('name'), input.id, input.className, input.tagName].map((a: any) => (a || '').toLowerCase());
                            const matchesDirect = keywords.some(ph => {
                                const lph = ph.toLowerCase();
                                return attrs.some(a => a.includes(lph));
                            });
                            if (matchesDirect) {
                                const rect = input.getBoundingClientRect();
                                return rect.width > 0 && rect.height > 0;
                            }
                            const labelledby = input.getAttribute('aria-labelledby');
                            if (labelledby) {
                                const ids = labelledby.trim().split(/\s+/);
                                for (const id of ids) {
                                    const lbl = document.getElementById(id);
                                    if (lbl) {
                                        const text = getVisibleText(lbl);
                                        if (keywords.some(ph => text.includes(ph.toLowerCase()))) {
                                            const rect = input.getBoundingClientRect();
                                            return rect.width > 0 && rect.height > 0;
                                        }
                                    }
                                }
                            }
                            if (input.id) {
                                const labels = document.querySelectorAll(`label[for="${input.id}"]`);
                                for (const lbl of labels) {
                                    const text = getVisibleText(lbl);
                                    if (keywords.some(ph => text.includes(ph.toLowerCase()))) {
                                        const rect = input.getBoundingClientRect();
                                        return rect.width > 0 && rect.height > 0;
                                    }
                                }
                            }
                            const matchesAncestor = keywords.some(ph => {
                                const lph = ph.toLowerCase();
                                let parent = input.parentElement;
                                let depth = 0;
                                while (parent && depth < 5) {
                                    const combosInParent = parent.querySelectorAll('select, [role="combobox"], [role="button"], [role="listbox"], input[aria-haspopup]');
                                    if (combosInParent.length === 1) {
                                        if (getVisibleText(parent).includes(lph)) return true;
                                    } else {
                                        for (const child of parent.children) {
                                            if (child !== input && !child.contains(input)) {
                                                if (child.querySelector('select, [role="combobox"], [role="button"], [role="listbox"], input[aria-haspopup], input, textarea')) continue;
                                                if (getVisibleText(child).includes(lph)) return true;
                                            }
                                        }
                                    }
                                    parent = parent.parentElement;
                                    depth++;
                                }
                                return false;
                            });
                            if (matchesAncestor) {
                                const rect = input.getBoundingClientRect();
                                return rect.width > 0 && rect.height > 0;
                            }
                            return false;
                        }, matchLabels);
                    } catch (e) { }
                    if (matched) {
                        const tagName = await el.evaluate((e: any) => e.tagName.toLowerCase()).catch(() => '');
                        if (tagName === 'select') {
                            const selectText = await el.evaluate((e: any, v: string) => {
                                const opts = [...e.querySelectorAll('option')];
                                const match = opts.find((o: any) => {
                                    const t = (o.textContent || '').trim();
                                    return t.toLowerCase() === v.toLowerCase() || t.toLowerCase().includes(v.toLowerCase());
                                });
                                if (match) {
                                    e.value = match.value;
                                    e.dispatchEvent(new Event('change', { bubbles: true }));
                                    e.dispatchEvent(new Event('input', { bubbles: true }));
                                    return match.textContent.trim();
                                }
                                return null;
                            }, value).catch(() => null);
                            if (selectText) {
                                log(`🎯 Selected native option: ${selectText}`);
                                return true;
                            }
                        } else {
                            const selected = await selectDropdownOptionRobust(frame, pageForMouse, el, value);
                            if (selected) {
                                log(`🎯 Selected custom option: ${value}`);
                                return true;
                            }
                        }
                    }
                    await el.dispose().catch(() => { });
                }
            } catch (e: any) {
                warn(`⚠️ Warning in selectFromComboboxOrSelectInFrame: ${e.message}`);
            }
            return false;
        };

        let bankSelected = false;
        let bankChosen: string | null = null;

        // Pre-check: scan all frames for any bank dropdown before trying any banks.
        // This avoids wasting 15 × N iterations when no dropdown exists.
        let hasBankDropdown = false;
        {
            const preFrames = await getUsableFrames();
            for (const { frame } of preFrames) {
                try {
                    hasBankDropdown = await safeEval(frame, () => {
                        return !!document.querySelector('select, [role="combobox"], [role="listbox"]');
                    }, undefined, 3000);
                    if (hasBankDropdown) break;
                } catch (e) { }
            }
        }

        if (hasBankDropdown) {
        for (const bank of banks) {
            const frames = await getUsableFrames();
            for (const { frame, page: pageForMouse } of frames) {
                bankSelected = await selectFromComboboxOrSelectInFrame(frame, pageForMouse, bank);
                if (bankSelected) { bankChosen = bank; break; }
                // Direct exact-text scan (reference) — radio rows / option rows.
                try {
                    const allBtns = await q$$(frame, 'button, a, [role="option"], [role="radio"], li, div, span');
                    for (const btn of allBtns) {
                        const txt = await btn.evaluate((el: any) => (el.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '');
                        if (txt.toLowerCase() === bank.toLowerCase()) {
                            const box = await btn.boundingBox();
                            if (box && box.width > 0 && box.height > 0) {
                                await btn.evaluate((el: any) => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => { });
                                await humanDelay(150, 250);
                                try { await btn.click(); } catch (clickErr) { await btn.evaluate((el: any) => el.click()); }
                                bankSelected = true; bankChosen = bank; break;
                            }
                        }
                        await btn.dispose().catch(() => { });
                    }
                } catch (e) { }
                if (bankSelected) break;
            }
            if (bankSelected) break;
        }
        } // end if (hasBankDropdown)
        if (!hasBankDropdown) log(`ℹ️ No bank dropdown found in any frame — skipping bank selection`);

        log(bankSelected ? `🏦 Bank selected: ${bankChosen}` : `⚠️ No bank could be auto-selected`);
        await humanDelay(1500, 2500);

        // ── Step 3.5: Click Save / Add payment method ──
        let paymentSaved = false;
        const paySaveTargets = ['Save', 'Add', 'Done', 'Confirm', 'Save payment method'];
        const aframes = await getUsableFrames();
        for (const { frame } of aframes) {
            try {
                const allBtns = await frame.$$('button, a, [role="button"]');
                for (const btn of allBtns) {
                    const txt = await btn.evaluate((el: any) => (el.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '');
                    if (paySaveTargets.some(t => new RegExp(`^${t}$`, 'i').test(txt))) {
                        const isHeading = await safeEval(btn, (el: any) => {
                            let p = el;
                            for (let i = 0; i < 3 && p; i++) {
                                if (p.tagName.toLowerCase() === 'h1' || p.getAttribute('role') === 'heading') return true;
                                if (p.querySelector('h1')) return true;
                                p = p.parentElement;
                            }
                            return false;
                        }, undefined, 3500);
                        if (isHeading === true) continue;
                        const box = await btn.boundingBox();
                        if (box && box.width > 0 && box.height > 0) {
                            try {
                                await btn.evaluate((el: any) => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => { });
                                await humanDelay(200, 300);
                                await btn.click();
                                paymentSaved = true;
                                log(`💾 Save payment button clicked via Puppeteer click: "${txt}"`);
                            } catch (clickErr) {
                                await btn.evaluate((el: any) => el.click());
                                paymentSaved = true;
                                log(`💾 Save payment button clicked via DOM click: "${txt}"`);
                            }
                            break;
                        }
                    }
                }
            } catch (e) { }
            if (paymentSaved) break;
        }
        if (paymentSaved) await humanDelay(2000, 3000);

        // ── Step 4: Click final Checkout / Agree and continue ──
        const checkoutTargets = ['checkout', 'agree and continue', 'agree & continue'];
        let checkoutClicked = false;
        let checkoutPage: any = page;
        for (const target of checkoutTargets) {
            const found = await findClickableByText(target);
            if (!found) continue;
            const { handle, frame, page: fp } = found;
            checkoutPage = fp;
            try {
                const info = await safeEval(frame, (node: any) => ({ tag: node.tagName.toLowerCase(), role: node.getAttribute('role') }), handle, 5000);
                log(`🎯 Found checkout/agree button "${target}" | Page: ${fp.url()} | Frame: ${frame.url()} | Tag: ${info?.tag} | Role: ${info?.role}`);
                const el = handle.asElement();
                if (el) await el.click().catch(async () => { await safeEval(frame, (node: any) => node.click(), handle, 5000); });
                log(`💳 Clicked checkout/agree: "${target}"`);
                checkoutClicked = true;
            } catch (e: any) {
                warn(`⚠️ Checkout click error: ${e.message}`);
            }
            await handle.dispose().catch(() => { });
            if (checkoutClicked) break;
        }

        if (!checkoutClicked) {
            log(`⚠️ Checkout/agree walker miss — trying direct DOM text scan across all frames...`);
            const coFrames = await getUsableFrames();
            outer: for (const { frame } of coFrames) {
                try {
                    const clicked = await safeEval(frame, (tgts: string[]) => {
                        const isVis = (el: any) => el.isConnected && el.getBoundingClientRect().width > 0;
                        const norm = (t: any) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        // Prefer leaf-level elements whose text IS the target (avoid big containers).
                        const els = [...document.querySelectorAll('button, a, [role="button"], [role="option"], li div, [role="listbox"] *, div, span')];
                        let best: any = null;
                        for (const el of els) {
                            const t = norm(el.textContent);
                            if (!tgts.some((target) => t === target || t.startsWith(target + ' '))) continue;
                            if (!isVis(el)) continue;
                            if ([...el.children].some((c: any) => isVis(c) && tgts.some((target) => norm(c.textContent) === target))) continue;
                            if (!best || el.textContent.length < best.textContent.length) best = el;
                        }
                        if (best) {
                            (best as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' });
                            (best as HTMLElement).click();
                            return true;
                        }
                        // Fallback: any visible element whose DIRECT text matches.
                        for (const el of els) {
                            if (!isVis(el) || el.children.length) continue;
                            const t = norm(el.textContent);
                            if (tgts.some((target) => t === target || t.startsWith(target + ' '))) {
                                (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' });
                                (el as HTMLElement).click();
                                return true;
                            }
                        }
                        return false;
                    }, checkoutTargets, 4000);
                    if (clicked === true) {
                        log(`✅ Checkout/agree clicked via direct DOM text scan`);
                        checkoutClicked = true;
                        break outer;
                    }
                } catch (e) { }
            }
        }

        if (!checkoutClicked) {
            warn(`⚠️ Checkout/agree button NOT found — dumping visible elements`);
            await dumpVisible('checkout_button_not_found');
            return { status: 'failed', detail: 'checkout button not found' };
        }

        // ── Step 4b: 10 second delay after clicking checkout button for potential popup ──
        log(`⏳ Waiting 10 seconds for potential popup or checkout initialization...`);
        await new Promise(r => setTimeout(r, 10000));

        // ── Step 4c: Close any popup page that might have appeared (e.g. BillDesk netbankingredirect or Google liftoff) ──
        const pages = await browser.pages();
        let popupFound = false;
        for (const p of pages) {
            if (p !== page && p !== checkoutPage && !p.isClosed()) {
                const url = p.url();
                log(`📄 Closing popup page: ${url}`);
                await p.close().catch(() => { });
                popupFound = true;
            }
        }

        // ── Step 4d: If a popup appeared and was closed, return to checkout page and re-confirm checkout ──
        if (popupFound) {
            log(`🔄 Popup was closed. Confirming checkout...`);
            let reCheckoutHandle: any = null;
            const reCFramesInfo = await getUsableFrames();
            for (const { frame } of reCFramesInfo) {
                try {
                    reCheckoutHandle = await safeEvalHandle(frame, () => {
                        const isVis = (el: any) => {
                            if (!el.isConnected) return false;
                            const s = window.getComputedStyle(el);
                            return s.display !== 'none' && s.visibility !== 'hidden' && s.visibility !== 'collapse' && s.opacity !== '0' &&
                                   !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true' &&
                                   (!el.disabled && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') &&
                                   !el.closest('[inert]') && el.getBoundingClientRect().width > 0;
                        };
                        const norm = (t: any) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null) as any;
                        let n: any;
                        while ((n = walker.nextNode())) {
                            const nodeText = norm(n.nodeValue);
                            if (nodeText === 'checkout' || nodeText === 'agree and continue' || nodeText === 'agree & continue') {
                                let curr = n.parentElement;
                                let clickable: any = null;
                                while (curr && curr !== document.body) {
                                    if (isVis(curr)) {
                                        const tag = curr.tagName.toLowerCase();
                                        const role = curr.getAttribute('role');
                                        const tabIndex = curr.getAttribute('tabindex');
                                        if (tag === 'button' || role === 'button' || (tag === 'a' && curr.hasAttribute('href')) ||
                                            (tag === 'input' && (curr.type === 'button' || curr.type === 'submit')) ||
                                            (tabIndex !== null && tabIndex !== '-1')) {
                                            clickable = curr;
                                            break;
                                        }
                                    }
                                    curr = curr.parentElement;
                                }
                                if (clickable) return clickable;
                            }
                        }
                        return null;
                    }, undefined, 6000);

                    if (reCheckoutHandle && reCheckoutHandle.asElement()) {
                        break;
                    } else if (reCheckoutHandle) {
                        await reCheckoutHandle.dispose().catch(() => { });
                        reCheckoutHandle = null;
                    }
                } catch (e) { }
            }

            if (reCheckoutHandle) {
                const reEl = reCheckoutHandle.asElement();
                try {
                    await reEl.click();
                    log(`🖱️ Re-clicked checkout/agree button after popup was closed.`);
                } catch (e: any) {
                    warn(`⚠️ Failed to re-click checkout/agree button: ${e.message}`);
                }
                await reCheckoutHandle.dispose().catch(() => { });
                await new Promise(r => setTimeout(r, 5000));
            } else {
                warn(`⚠️ Checkout/agree button not found for re-clicking.`);
            }
        }

        // ── Step 5: Monitor redirection to getupgrade or admin ──
        log(`⏳ Monitoring redirection to getupgrade/admin...`);
        let reachedGetUpgrade = false;
        const startMonitorTime = Date.now();
        while (Date.now() - startMonitorTime < 25000) {
            const currentUrl = page.url();
            log(`🔗 Current URL: ${currentUrl}`);
            if (currentUrl.includes('getupgrade') || currentUrl.includes('admin.google.com')) {
                reachedGetUpgrade = true;
                break;
            }
            const allPages = await browser.pages();
            for (const p of allPages) {
                if (!p.isClosed()) {
                    const u = (p.url() || '').toLowerCase();
                    if (u.includes('getupgrade') || u.includes('admin.google.com')) {
                        log(`✅ Found target URL on another page: ${u.substring(0, 120)}`);
                        reachedGetUpgrade = true;
                        break;
                    }
                }
            }
            if (reachedGetUpgrade) break;
            await new Promise(r => setTimeout(r, 1000));
        }

        if (!reachedGetUpgrade) {
            warn(`⚠️ Did not redirect automatically to getupgrade. Navigating manually...`);
            try {
                await page.goto('https://workspace.google.com/u/0/getupgrade', { waitUntil: 'domcontentloaded', timeout: 30000 });
                log(`🧭 Navigated manually to getupgrade. Current URL: ${page.url()}`);
            } catch (e: any) {
                warn(`❌ Failed manual navigation to getupgrade: ${e.message}`);
            }
        }

        return { status: 'success', url: page.url(), detail: 'getupgrade reached' };
    }

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
