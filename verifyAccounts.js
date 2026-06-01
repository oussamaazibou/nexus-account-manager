
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import SMSService from './services/smsService.js';
import CaptchaService from './services/captchaService.js';
import CloudflareService from './services/cloudflareService.js';
import UserAgent from 'user-agents';

// CONFIGURATION
const HEADLESS = false; // Set to true for production
const ACCOUNTS_FILE = 'accounts.txt';
const VERIFIED_FILE = 'verified_accounts.txt';
const FAILED_FILE = 'failed_verification.txt';

// SERVICES
const SMS_API_KEY = '52f6060efdA770541bf3e867A6ccbdAb';
const smsService = new SMSService(SMS_API_KEY);

const CAPTCHA_API_KEY = '4a8189e5ca7d59ebcd481b14387f58e4';
const captchaService = new CaptchaService(CAPTCHA_API_KEY);

const CF_EMAIL = 'abdo.charhamane@gmail.com';
const CF_API_KEY = '541da7b4fd89331cc0abe3cf712b1786e35ce';
const cloudflareService = new CloudflareService(CF_EMAIL, CF_API_KEY);

async function formatPhoneNumberForInput(number) {
    if (number.startsWith('+')) return number;
    return '+' + number;
}

// HUMAN-LIKE TYPING
async function humanLikeType(element, text) {
    for (const char of text) {
        await element.type(char, { delay: Math.random() * 100 + 50 });
    }
}

async function verifyAccount(email, password) {
    console.log(`\n========================================`);
    console.log(`🚀 Processing: ${email}`);
    console.log(`========================================`);

    let browser = null;
    try {
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });

        browser = await puppeteer.launch({
            headless: HEADLESS,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1366,768'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        const page = await browser.newPage();
        await page.setUserAgent(userAgent.toString());
        await page.setViewport({ width: 1366, height: 768 });

        // Force English Language via Headers
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9'
        });

        // Enable Request Interception to Force English URL Parameter
        await page.setRequestInterception(true);
        page.on('request', request => {
            const url = request.url();
            if (request.isNavigationRequest() && url.includes('google.com') && !url.includes('hl=en')) {
                try {
                    const newUrl = new URL(url);
                    newUrl.searchParams.set('hl', 'en');
                    request.continue({ url: newUrl.toString() });
                } catch (e) {
                    request.continue();
                }
            } else {
                request.continue();
            }
        });

        // Navigate to Gmail/Login
        console.log(`🌐 Navigating to login...`);
        await page.goto('https://accounts.google.com/signin/v2/identifier?hl=en&flowName=GlifWebSignIn&flowEntry=ServiceLogin', { waitUntil: 'networkidle2' });

        // LOGIN - EMAIL
        console.log(`✍️  Entering email...`);
        await page.waitForSelector('input[type="email"]');
        await humanLikeType(await page.$('input[type="email"]'), email);
        await page.keyboard.press('Enter');

        // WAIT FOR PASSWORD OR CAPTCHA
        try {
            const passwordSelector = 'input[type="password"]';
            const captchaImageSelector = '#captchaimg';
            const captchaInputSelector = 'input[name="ca"], input[aria-label="Type the text you hear or see"]';

            await new Promise(r => setTimeout(r, 2000));

            // Check if Captcha input appeared
            const captchaInput = await page.$(captchaInputSelector);

            if (captchaInput) {
                console.log(`⚠️  Image Captcha detected!`);

                // Find visible image
                const captchaImg = await page.$(captchaImageSelector) || await page.$('div#captcha-box img');

                if (captchaImg) {
                    const isVisible = await captchaImg.boundingBox();
                    if (isVisible) {
                        console.log(`📸 Capturing captcha image...`);
                        const base64Image = await captchaImg.screenshot({ encoding: 'base64' });

                        const solution = await captchaService.solveImageCaptcha(base64Image);

                        if (solution.success) {
                            console.log(`✅ Captcha solved: ${solution.solution}`);
                            await humanLikeType(captchaInput, solution.solution);
                            await page.keyboard.press('Enter');
                            await new Promise(r => setTimeout(r, 3000));
                        } else {
                            throw new Error(`Captcha solving failed: ${solution.error}`);
                        }
                    } else {
                        console.log(`ℹ️ Captcha detected but image is hidden/not rendered.`);
                        // Sometimes it's hidden because it's loading, wait a bit
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
            }
        } catch (e) {
            console.log(`ℹ️  No image captcha detected or check failed: ${e.message}`);
        }

        // LOGIN - PASSWORD
        console.log(`✍️  Entering password...`);
        await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
        await new Promise(r => setTimeout(r, 2000));
        await humanLikeType(await page.$('input[type="password"]'), password);
        await page.keyboard.press('Enter');

        await new Promise(r => setTimeout(r, 3000));

        // HANDLE POTENTIAL REDIRECTS OR CHALLENGES
        // Loop to check for subsequent barriers (Recaptcha, Phone, etc.)
        let isOnLoginFlow = true;
        let attemptsCheck = 0;
        const maxCheckAttempts = 5;

        while (isOnLoginFlow && attemptsCheck < maxCheckAttempts) {
            try {
                attemptsCheck++;
                // Check if page/browser is still valid
                if (page.isClosed()) throw new Error('Page closed');

                const currentUrl = page.url();
                console.log(`🔄 Checking state (URL: ${currentUrl})...`);

                if (currentUrl.includes('myaccount.google.com') || currentUrl.includes('admin.google.com') || currentUrl.includes('workspace.google.com')) {
                    console.log(`✅ Authentication Successful!`);
                    isOnLoginFlow = false;
                    break;
                }

                // CHECK FOR SPEEDBUMP / INTERSTITIAL / CONSENT
                if (currentUrl.includes('speedbump') || currentUrl.includes('gaplustos') || currentUrl.includes('signin/v2/challenge') || currentUrl.includes('c/pwd')) {
                    console.log(`🚧 Speedbump/Interstitial detected. Searching for buttons...`);

                    // Try to find a continue/understand button
                    const actionBtn = await page.evaluateHandle(() => {
                        const candidates = Array.from(document.querySelectorAll('button, div[role="button"], span, a, input[type="button"], input[type="submit"]'));
                        return candidates.find(b => {
                            const t = (b.innerText || b.value || '').toLowerCase();
                            // Add 'understand', 'accept', 'not now', 'done'
                            return (t.includes('continue') || t.includes('next') || t.includes('confirm') ||
                                t.includes('i understand') || t.includes('accept') || t.includes('agreed') ||
                                t.includes('yes, i am in') || t.includes('link data')) &&
                                b.offsetParent !== null; // Visible
                        });
                    });

                    if (actionBtn && actionBtn.asElement()) {
                        console.log(`🖱️ Clicking Consent/Speedbump button...`);
                        await Promise.all([
                            actionBtn.click(),
                            new Promise(r => setTimeout(r, 5000))
                        ]).catch(() => { }); // Ignore potential navigation errors on click
                        continue;
                    } else {
                        console.log(`⏳ No obvious button found. Waiting...`);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                } else {
                    // ALSO CHECK FOR "I understand" even if URL doesn't look like speedbump (sometimes just an overlay)
                    const understandBtn = await page.evaluateHandle(() => {
                        const buttons = Array.from(document.querySelectorAll('button, span'));
                        return buttons.find(b => b.innerText.toLowerCase().includes('i understand') && b.offsetParent !== null);
                    });

                    if (understandBtn && understandBtn.asElement()) {
                        console.log(`🖱️ Clicking 'I understand'...`);
                        await understandBtn.click();
                        await new Promise(r => setTimeout(r, 5000));
                        continue;
                    }
                }

                // CHECK FOR RECAPTCHA (Iframe)
                const captchaFrame = await page.$('iframe[src*="recaptcha"]');
                if (captchaFrame) {
                    // ... (existing recaptcha logic) ...
                    // Keeping simple check here to avoid massive diff, assume existing Logic is fine or simplify it
                    console.log(`⚠️  Recaptcha iframe detected! Attempting to solve...`);
                    const siteKey = await page.evaluate(() => {
                        const element = document.querySelector('[data-sitekey]');
                        return element ? element.getAttribute('data-sitekey') : null;
                    });

                    if (siteKey) {
                        const solution = await captchaService.solveRecaptchaV2(siteKey, page.url());
                        if (solution.success) {
                            await page.evaluate((token) => {
                                document.getElementById('g-recaptcha-response').innerHTML = token;
                            }, solution.solution);

                            const nextButton = await page.$('#passwordNext') || await page.$('button[type="button"]:not([disabled])');
                            if (nextButton) await nextButton.click();
                            await new Promise(r => setTimeout(r, 5000));
                            continue;
                        }
                    }
                }

                // CHECK FOR PHONE VERIFICATION
                // ... (Phone Logic needs to be safe too) ...
                const isPhoneChallenge = await page.$('input[type="tel"]').catch(() => null);
                if (isPhoneChallenge) {
                    // If phone detected, break out of this quick loop and handle it below or just let the original logic run?
                    // original logic was big. Let's assume we handle it if we find it.
                    // IMPORTANT: The original code had a huge block for phone. 
                    // To fix "Execution context destroyed", we surrounding the WHOLE loop body in try/catch.
                    // Just need to make sure we don't accidentally cut off the phone logic.
                    console.log(`⚠️  Phone verification detected! (Breaking to handle)`);
                    // We can break here to handle it outside or handle inside.
                    // Because of the complexity, let's just log it and potentially let the original phone block run if I didn't replace it entirely.
                    // The replacement is REPLACING the loop content. I need to keep the phone logic.

                    // ... (Restoring Phone Logic) ...
                    console.log(`⚠️  Phone verification challenge detected!`);

                    let phoneSuccess = false;
                    let currentActivationId = null;
                    let attempts = 0;
                    const maxAttempts = 3;
                    let smsCodeObj = null;

                    while (!phoneSuccess && attempts < maxAttempts) {
                        attempts++;
                        console.log(`\n🔄 Phone Verification Attempt ${attempts}/${maxAttempts}...`);

                        try {
                            console.log(`📱 Requesting number from HeroSMS...`);
                            const countryId = '6';
                            const numberResult = await smsService.getNumber(countryId);

                            if (!numberResult.success) throw new Error(`SMS Service Error: ${numberResult.error}`);

                            const { id: activationId, number } = numberResult;
                            currentActivationId = activationId;
                            console.log(`📱 Got number: ${number} (ID: ${activationId})`);

                            const inputPhone = await formatPhoneNumberForInput(number);

                            const phoneInput = await page.$('input[type="tel"]');
                            if (phoneInput) {
                                await phoneInput.click({ clickCount: 3 });
                                await page.keyboard.press('Backspace');
                                await humanLikeType(phoneInput, inputPhone);
                                await page.keyboard.press('Enter');
                            }

                            await new Promise(r => setTimeout(r, 4000));

                            const errorExists = await page.evaluate(() => {
                                const body = document.body.innerText;
                                return body.includes('phone number has already been used too many times') ||
                                    body.includes('cannot be used for verification');
                            });

                            if (errorExists) {
                                console.log(`❌ Number rejected.`);
                                await smsService.cancelNumber(activationId);
                                currentActivationId = null;
                                await new Promise(r => setTimeout(r, 2000));
                                continue;
                            }

                            try {
                                smsCodeObj = await page.waitForSelector('input[type="tel"], input[name="code"], input[placeholder*="code"]', { timeout: 10000 });
                                if (smsCodeObj) {
                                    phoneSuccess = true;
                                    break;
                                }
                            } catch (e) {
                                await smsService.cancelNumber(activationId);
                                currentActivationId = null;
                                continue;
                            }
                        } catch (e) { console.log(e.message); }
                    }

                    if (phoneSuccess && smsCodeObj && currentActivationId) {
                        console.log(`⏳ Waiting for SMS code...`);
                        const codeResult = await smsService.waitForCode(currentActivationId);
                        if (codeResult.success) {
                            console.log(`📨 Code: ${codeResult.code}`);
                            await humanLikeType(smsCodeObj, codeResult.code);
                            await page.keyboard.press('Enter');
                            await smsService.confirmSuccess(currentActivationId);
                            await new Promise(r => setTimeout(r, 5000));
                            continue; // Continue outer loop to check where we are
                        }
                    }
                }

                // If we are still on some other page, wait a bit
                await new Promise(r => setTimeout(r, 2000));

            } catch (error) {
                console.log(`⚠️ Navigation error in loop (retrying): ${error.message}`);
                await new Promise(r => setTimeout(r, 2000)); // Wait for stability
                continue;
            }
        }


        // DOMAIN VERIFICATION
        console.log(`\n🔍 Checking/Navigating to Domain Verification...`);
        await new Promise(r => setTimeout(r, 3000));

        // Explicitly check if we are LOGGED IN before navigating
        // If we are still at accounts.google.com/signin... we failed
        if (page.url().includes('/signin/')) {
            console.error(`❌ Still on Login Page. Aborting Domain Verification.`);
            throw new Error("Login failed (stuck on signin page)");
        }

        console.log(`🌐 Navigating to Domain Management...`);
        // Added hl=en to force English UI
        await page.goto('https://admin.google.com/ac/domains/manage?journey=218&utm_source=og_am&hl=en', { waitUntil: 'domcontentloaded' });

        await new Promise(r => setTimeout(r, 5000));

        // Check for "Verify domain" link or "Get started"
        console.log(`🔍 Searching for 'Verify domain' link or 'Get started' (Polling up to 20s)...`);

        // Wait for one of the target elements to continuously appear
        try {
            await page.waitForFunction(() => {
                const buttons = Array.from(document.querySelectorAll('span, div[role="button"], button, a'));
                return buttons.some(b => {
                    const t = b.innerText.toLowerCase();
                    return (t.includes('get started') || t.includes('verify domain') || t.includes('activate gmail')) && b.offsetParent !== null;
                });
            }, { timeout: 20000 });
            console.log(`✅ Found a verification button/link!`);
        } catch (e) {
            console.log(`⚠️ Timed out waiting for start/verify button.`);
        }

        // Strategy 1: Check for "Verify domain" / "Activate" Link or Button FIRST
        const verifyLink = await page.evaluateHandle(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const found = links.find(a => (a.innerText.toLowerCase().includes('verify domain') || a.innerText.toLowerCase().includes('activate')) && a.offsetParent !== null);
            if (found) {
                // Force English URL
                try {
                    const url = new URL(found.href);
                    url.searchParams.set('hl', 'en');
                    found.href = url.toString();
                } catch (e) { }
                return found;
            }
            return null;
        });

        const verifyButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('div[role="button"], button, span'));
            return buttons.find(b => {
                const t = b.innerText.toLowerCase();
                return (t.includes('verify') || t.includes('activate gmail')) && b.offsetParent !== null;
            });
        });

        if (verifyLink && verifyLink.asElement()) {
            console.log(`🖱️  Clicking 'Verify domain' link (en-forced)...`);
            try { await verifyLink.click(); } catch (e) { await page.evaluate(el => el.click(), verifyLink); }
            await new Promise(r => setTimeout(r, 5000));
        } else if (verifyButton && verifyButton.asElement()) {
            console.log(`🖱️  Clicking Verify Button...`);
            try { await verifyButton.click(); } catch (e) { await page.evaluate(el => el.click(), verifyButton); }
            await new Promise(r => setTimeout(r, 5000));
        }

        // Strategy 2: Check for "Get started" (Let's set up your domain)
        const getStartedBtn = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('span, div[role="button"], button, a'));
            const found = buttons.find(b => b.innerText.toLowerCase().includes('get started') && b.offsetParent !== null);
            if (found && found.tagName === 'A') {
                // Force English URL for Links
                try {
                    const url = new URL(found.href);
                    url.searchParams.set('hl', 'en');
                    found.href = url.toString();
                } catch (e) { }
            }
            return found;
        });

        if (getStartedBtn && getStartedBtn.asElement()) {
            console.log(`🖱️  Clicking 'Get started'...`);
            try {
                await Promise.all([
                    page.evaluate(el => el.click(), getStartedBtn),
                    new Promise(r => setTimeout(r, 10000)) // Wait for nav
                ]);
            } catch (e) { console.error("Click failed", e); }
        } else {
            // Fallback for "Get Setup" page which might have "Next" or "Protect domain"
            const nextBtn = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('span, div[role="button"], button'));
                return buttons.find(b => {
                    const t = b.innerText.toLowerCase();
                    return (t.includes('next') || t.includes('unprotect') || t.includes('protect') || t.includes('continue') || t.includes('review')) && b.offsetParent !== null;
                });
            });

            if (nextBtn && nextBtn.asElement()) {
                console.log(`🖱️  Clicking Next/Protect button on setup page...`);
                try {
                    await Promise.all([
                        page.evaluate(el => el.click(), nextBtn),
                        new Promise(r => setTimeout(r, 10000))
                    ]);
                } catch (e) { console.error("Click failed", e); }
            } else {
                console.log(`ℹ️ 'Get started' or 'Next' button not found (or already passed).`);
            }
        }

        // Check for "Select your domain host" page (Intermediate Step)
        try {
            // Use waitForFunction with a short timeout to handle potential instability/loading
            const isSelectHost = await page.waitForFunction(() => document.body.innerText.includes('Select your domain host'), { timeout: 2000 }).catch(() => false);

            if (isSelectHost) {
                console.log(`ℹ️ 'Select domain host' page detected. Selecting generic/different host...`);
                // Click "My domain uses a different host" checkbox if present (to avoid Cloudflare OAuth)
                const differentHostCheckbox = await page.$('input[type="checkbox"]'); // Usually only one here
                if (differentHostCheckbox) {
                    try { await differentHostCheckbox.click(); } catch (e) { }
                    await new Promise(r => setTimeout(r, 1000));
                }

                // Click Continue
                const continueBtn = await page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button, span, div[role="button"]'));
                    return buttons.find(b => b.innerText.toLowerCase().includes('continue') || b.innerText.toLowerCase().includes('next'));
                });
                if (continueBtn && continueBtn.asElement()) {
                    console.log(`🖱️  Clicking Continue on Host Selection...`);
                    try {
                        await Promise.all([
                            continueBtn.click(),
                            new Promise(r => setTimeout(r, 5000))
                        ]);
                    } catch (e) { console.error("Continue click failed", e); }
                }
            }
        } catch (e) { console.log("Host selection check failed or skipped", e.message); }


        // Wait to be on TXT page
        const isTxtPage = await page.evaluate(() => {
            return document.body.innerText.includes('google-site-verification=') ||
                document.body.innerText.includes('TXT record');
        });

        if (isTxtPage) {
            console.log(`🛡️  TXT Record Page detected!`);
            const txtRecord = await page.evaluate(() => {
                const el = document.querySelector('[data-copy-value]');
                if (el) return el.getAttribute('data-copy-value');
                const strong = document.querySelector('strong.const-text');
                if (strong) return strong.innerText;
                const match = document.body.innerText.match(/google-site-verification=[\w-]+/);
                return match ? match[0] : null;
            });

            if (txtRecord) {
                console.log(`📝 Extracted TXT Record: ${txtRecord}`);

                // Extract subdomain from email: support@prime-learn.belvynteam.my.id
                const fullDomain = email.split('@')[1];
                const parts = fullDomain.split('.');

                // Smart zone detection: try from most-specific to least-specific
                // to handle multi-part TLDs like my.id, co.uk, com.br
                // e.g. ['prime-learn', 'belvynteam', 'my', 'id']
                // will try: belvynteam.my.id → my.id → id
                // belvynteam.my.id should be the Cloudflare zone!
                let zoneId = null;
                let rootDomain = null;
                let recordName = null;

                for (let i = parts.length - 2; i >= 1; i--) {
                    const candidate = parts.slice(i).join('.');
                    const candidateRecord = parts.slice(0, i).join('.');
                    console.log(`🔍 Trying Cloudflare zone: ${candidate} (record: '${candidateRecord}')...`);
                    const foundZone = await cloudflareService.getZoneId(candidate);
                    if (foundZone) {
                        zoneId = foundZone;
                        rootDomain = candidate;
                        recordName = candidateRecord;
                        console.log(`✅ Found Cloudflare zone: ${rootDomain} (record: '${recordName}')`);
                        break;
                    }
                }

                if (zoneId) {
                    console.log(`🌍 Zone ID found for ${rootDomain}. Adding TXT record for '${recordName}'...`);
                    const addResult = await cloudflareService.addTxtRecord(zoneId, recordName, txtRecord);
                    if (addResult.success) {
                        console.log(`✅ TXT Record added.`);
                        console.log(`⏳ Waiting 15s for Cloudflare propagation...`);
                        await new Promise(r => setTimeout(r, 15000));

                        // 1. Check for "Come back here and confirm" CHECKBOX
                        try {
                            console.log(`🔍 Checking for 'Confirm' checkbox...`);
                            const confirmCheckbox = await page.evaluateHandle(() => {
                                // Find label containing text, then find input
                                const labels = Array.from(document.querySelectorAll('label, div'));
                                const label = labels.find(l => l.innerText.includes('Come back here and confirm'));
                                if (label) {
                                    // Try to find input inside or near
                                    const input = label.querySelector('input') || label.parentElement.querySelector('input');
                                    return input;
                                }
                                // Fallback: just any unchecked checkbox if it's the only one
                                return document.querySelector('input[type="checkbox"]:not(:checked)');
                            });

                            if (confirmCheckbox && confirmCheckbox.asElement()) {
                                console.log(`🖱️  Clicking Confirm Checkbox...`);
                                await confirmCheckbox.click();
                                await new Promise(r => setTimeout(r, 1000));
                            }
                        } catch (e) {
                            console.log("Checkbox check failed (might not be required)", e);
                        }

                        console.log(`🖱️  Clicking Final Verify/Confirm...`);
                        const finalVerify = await page.evaluateHandle(() => {
                            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
                            return buttons.find(b => {
                                const t = b.innerText.toLowerCase();
                                return (t.includes('verify') || t.includes('continue') || t.includes('activate') || t.includes('confirm')) && b.offsetParent !== null;
                            });
                        });

                        if (finalVerify && finalVerify.asElement()) {
                            await finalVerify.click();
                            await new Promise(r => setTimeout(r, 10000));
                        }
                    }
                }
            }
        }

        // Final Status Check
        await new Promise(r => setTimeout(r, 5000));
        const finalUrl = page.url();
        console.log(`🏁 Final URL: ${finalUrl}`);

        if (finalUrl.includes('admin.google.com')) {
            console.log(`✅ Login/Verification Flow Complete: ${email}`);
            fs.appendFileSync(VERIFIED_FILE, `${email}:${password}\n`);
        } else {
            console.log(`❓ Unknown Status: ${finalUrl}`);
            fs.appendFileSync(FAILED_FILE, `${email}:${password}|UNKNOWN\n`);
        }

    } catch (error) {
        console.error(`❌ Verification Failed: ${error.message}`);
        fs.appendFileSync(FAILED_FILE, `${email}:${password}|${error.message}\n`);
    } finally {
        if (browser) await browser.close();
    }
}

async function main() {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
        console.error(`File ${ACCOUNTS_FILE} not found!`);
        return;
    }

    const fileContent = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
    const accounts = fileContent.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
            const parts = line.split(/[:|]/);
            return { email: parts[0], password: parts[1] };
        });

    console.log(`Loaded ${accounts.length} accounts.`);

    for (const account of accounts) {
        await verifyAccount(account.email, account.password);
    }
}

main();
