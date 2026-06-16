/**
 * phoneVerifyBot.js
 * Puppeteer automation: Gmail login → phone entry → SMS code entry
 */
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TIMEOUT = 30000;
const TYPE_DELAY = 10;

// Save screenshot for debugging
async function screenshot(page, name) {
    // Disabled to save server space
}

// ── Launch browser ─────────────────────────────────────────────────────────────
export async function launchBrowser(proxy = null) {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--blink-settings=imagesEnabled=false',
        '--window-size=1024,768',
    ];
    if (proxy) args.push(`--proxy-server=${proxy}`);
    return puppeteer.launch({
        headless: 'new',
        args,
        defaultViewport: { width: 1024, height: 768 },
    });
}

// ── Gmail Login → returns the active page ─────────────────────────────────────
export async function doGoogleLogin(browser, email, password) {
    const page = await browser.newPage();
    
    // Speed up by blocking unnecessary resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const type = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
            req.abort();
        } else {
            req.continue();
        }
    });

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.goto(
        'https://accounts.google.com/v3/signin/identifier?hl=en&flowName=GlifWebSignIn',
        { waitUntil: 'domcontentloaded', timeout: TIMEOUT }
    );
    await sleep(1000);

    // Enter email
    const emailEl = await page.waitForSelector('input[type="email"], input[name="identifier"], #identifierId', { timeout: TIMEOUT });
    await emailEl.click({ clickCount: 3 }); await page.keyboard.press('Backspace');
    await emailEl.type(email, { delay: TYPE_DELAY });
    await sleep(200);
    await page.keyboard.press('Enter');
    await sleep(1500); 

    // Enter password (might be skipped if account is suspended or already remembered)
    try {
        const pwEl = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 8000 });
        await pwEl.type(password, { delay: TYPE_DELAY });
        await sleep(200);
        await page.keyboard.press('Enter');
    } catch (e) {
        console.log(`[PhoneBot] No password field appeared for ${email}. Proceeding to check page status...`);
    }

    try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 });
    } catch { /* might not fire */ }
    await sleep(1000); // Reduced from 2000

    const url = page.url();
    await screenshot(page, 'after_login');
    console.log(`[PhoneBot] After login URL: ${url}`);

    // Check for login error
    const errEl = await page.$('[data-error-code], .Ekjuhf, .dEOOab, .o6cuMc');
    if (errEl) {
        const txt = await errEl.evaluate(e => e.textContent.trim()).catch(() => '');
        const lower = txt.toLowerCase();
        const isNotFound = lower.includes("couldn't find") || lower.includes("could not find") ||
                           lower.includes("no google account") || lower.includes("enter a valid email") ||
                           lower.includes("this account was recently deleted");
        if (isNotFound) throw new Error('ACCOUNT_NOT_FOUND');
        throw new Error(`Login failed: ${txt || 'Wrong credentials'}`);
    }

    // Also check page text for account-not-found indicators (some Google flows show it without error element)
    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
    if (pageText.includes("enter the text you hear or see") || pageText.includes("prove you're not a robot")) {
        throw new Error('CAPTCHA_BLOCKED');
    }

    if (pageText.includes("couldn't find your google account") ||
        pageText.includes("could not find your google account") ||
        pageText.includes("no google account found") ||
        pageText.includes("enter a valid email") ||
        pageText.includes("this account was recently deleted")) {
        throw new Error('ACCOUNT_NOT_FOUND');
    }

    // Check if phone verification is required
    let requiresVerification = true;
    let finalUrl = url;

    // Check for TOTP/Authenticator
    const otpInputCheck = await page.$('input[name="totpPin"], input[id*="totp"], input[id*="otp"], input[type="tel"]').catch(() => null);
    if (otpInputCheck || finalUrl.includes('challenge/totp') || finalUrl.includes('challenge/pwd')) {
        const pageTxt = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
        if (pageTxt.includes('google authenticator') || pageTxt.includes('get a verification code') || otpInputCheck) {
            console.log(`[PhoneBot] TOTP requested for ${email}, generating...`);
            const genOtpModule = await import('./generateOTP.cjs');
            const otpCode = await genOtpModule.getOTPForAccount(email);
            
            if (otpCode) {
                console.log(`[PhoneBot] Submitting OTP ${otpCode} for ${email}`);
                const totpInput = await page.waitForSelector('input[name="totpPin"], input[id*="totp"], input[id*="otp"], input[type="tel"]', { visible: true, timeout: 5000 }).catch(() => null);
                if (totpInput) {
                    await totpInput.click({ clickCount: 3 });
                    await page.keyboard.press('Backspace');
                    await totpInput.type(otpCode, { delay: TYPE_DELAY });
                    await sleep(500);
                    await page.keyboard.press('Enter');
                    
                    try {
                        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 });
                    } catch { /* might not fire */ }
                    await sleep(1500);
                    finalUrl = page.url();
                    console.log(`[PhoneBot] After TOTP URL: ${finalUrl}`);
                }
            } else {
                console.log(`[PhoneBot] No OTP secret found for ${email}`);
            }
        }
    }

    if (finalUrl.includes('myaccount.google.com') || finalUrl.includes('mail.google.com')) {
        requiresVerification = false;
    } else {
        // If we are still on accounts.google.com, we might be on an intermediate "Verify it's you" or "Disabled" page.
        let hasInput = await page.$('#phoneNumberId, input[name="phoneNumber"], input[type="tel"]').catch(() => null);
        
        if (!hasInput) {
            console.log(`[PhoneBot] No phone input found on ${finalUrl}, attempting to click Next/Start...`);
            const clicked = await clickNext(page);
            if (clicked) {
                try {
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 });
                } catch { /* ignore */ }
                await sleep(1000);
            }
        }
    }

    return { page, requiresVerification };
}

// ── Enter phone number on Google page ─────────────────────────────────────────
export async function enterPhoneNumber(page, phone) {
    // Always use +prefix so Google auto-detects country (e.g. +6283... → Indonesia 🇮🇩)
    const fullPhone = phone.startsWith('+') ? phone : '+' + phone;

    await screenshot(page, 'before_phone_entry');
    const currentUrl = page.url();
    console.log(`[PhoneBot] Before phone entry. URL: ${currentUrl}`);

    let input = await findInput(page, [
        '#phoneNumberId',
        'input[name="phoneNumber"]',
        'input[type="tel"]',
        'input[aria-label*="phone" i]',
        'input[placeholder*="phone" i]',
    ]);

    if (!input) {
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
        console.log(`[PhoneBot] No phone input found. Page text: ${bodyText.substring(0, 200)}`);

        console.log('[PhoneBot] Navigating to recovery phone add page...');
        await page.goto('https://myaccount.google.com/signinoptions/rescuephone/add', {
            waitUntil: 'domcontentloaded', timeout: TIMEOUT
        });
        await sleep(3000);
        await screenshot(page, 'recovery_phone_page');
        console.log(`[PhoneBot] Recovery phone page URL: ${page.url()}`);

        input = await findInput(page, [
            '#phoneNumberId', 'input[type="tel"]', 'input[name="phoneNumber"]',
            'input[aria-label*="phone" i]',
        ]);
    }

    if (!input) {
        await screenshot(page, 'no_phone_input');
        throw new Error(`Phone input field not found on any page. Current: ${page.url()}`);
    }

    // Clear the field completely first
    await input.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await sleep(200);

    // Type with + prefix → Google auto-selects country flag
    await input.type(fullPhone, { delay: TYPE_DELAY });
    await sleep(300); // Reduced from 600
    await screenshot(page, 'phone_typed');
    await page.keyboard.press('Enter');
    
    // Wait for either the code input to appear OR an error text to show up
    try {
        await page.waitForFunction(() => {
            const codeInput = document.querySelector('#code, input[name="code"], #idvPin, input[maxlength="6"], input[aria-label*="code" i]');
            if (codeInput && codeInput.offsetParent !== null) return 'SUCCESS';
            
            const bodyText = document.body.innerText.toLowerCase();
            const hasError = bodyText.includes('phone number has already been used') ||
                             bodyText.includes('cannot be used for verification') ||
                             bodyText.includes('invalid phone number') ||
                             bodyText.includes('something went wrong');
            if (hasError) return 'REJECTED';
            
            return false;
        }, { timeout: 8000 });
        
        const isRejected = await page.evaluate(() => {
            const bodyText = document.body.innerText.toLowerCase();
            return bodyText.includes('phone number has already been used') ||
                   bodyText.includes('cannot be used for verification') ||
                   bodyText.includes('invalid phone number') ||
                   bodyText.includes('something went wrong');
        });
        
        if (isRejected) {
            throw new Error('PHONE_REJECTED');
        }
        
        await screenshot(page, 'after_phone_entry');
        console.log(`[PhoneBot] Phone entered (${fullPhone}) and accepted. URL: ${page.url()}`);
    } catch (e) {
        // If it timed out, it means we never saw the code input field and no explicit error text appeared.
        // It's highly likely the number was rejected silently or stuck.
        console.log(`[PhoneBot] Rejection or timeout detected. Error: ${e.message}`);
        throw new Error('PHONE_REJECTED');
    }
    
    return { success: true };
}

// ── Replace phone with new number (retry) ─────────────────────────────────────
// ── Replace phone with new number (retry) ─────────────────────────────────────
export async function retryWithNewPhone(page, newPhone) {
    const fullPhone = newPhone.startsWith('+') ? newPhone : '+' + newPhone;

    // Check if phone input is ALREADY on the page (e.g., if previous number was rejected)
    let input = await findInput(page, [
        '#phoneNumberId', 'input[name="phoneNumber"]', 'input[type="tel"]',
        'input[aria-label*="phone" i]', 'input[placeholder*="phone" i]',
    ]);

    // If not on page, it means we are on the "Enter code" page, try going back
    if (!input) {
        try {
            // First try clicking Google's back button if it exists
            const backBtn = await page.$('button[aria-label="Back"], button[jsname="hRZeKc"]');
            if (backBtn) {
                await backBtn.click();
            } else {
                await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
            }
            await sleep(2000);
        } catch { /* ignore */ }

        input = await findInput(page, [
            '#phoneNumberId', 'input[name="phoneNumber"]', 'input[type="tel"]',
            'input[aria-label*="phone" i]', 'input[placeholder*="phone" i]',
        ]);
    }

    await screenshot(page, 'retry_page');
    console.log(`[PhoneBot] Retry page URL: ${page.url()}`);

    if (!input) {
        console.log('[PhoneBot] Retry: no phone input on back page, going to rescue phone add...');
        await page.goto('https://myaccount.google.com/signinoptions/rescuephone/add', {
            waitUntil: 'domcontentloaded', timeout: TIMEOUT
        });
        await sleep(3000);
        input = await findInput(page, [
            '#phoneNumberId', 'input[type="tel"]', 'input[name="phoneNumber"]',
        ]);
    }

    if (!input) {
        await screenshot(page, 'retry_no_input');
        throw new Error('Cannot find phone input for retry');
    }

    // Clear completely then type +prefix
    await input.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await sleep(200);
    await input.type(fullPhone, { delay: TYPE_DELAY });
    await sleep(400);
    await page.keyboard.press('Enter');
    
    // Wait for either the code input to appear OR an error text to show up
    try {
        await page.waitForFunction(() => {
            const codeInput = document.querySelector('#code, input[name="code"], #idvPin, input[maxlength="6"], input[aria-label*="code" i]');
            if (codeInput && codeInput.offsetParent !== null) return 'SUCCESS';
            
            const bodyText = document.body.innerText.toLowerCase();
            const hasError = bodyText.includes('phone number has already been used') ||
                             bodyText.includes('cannot be used for verification') ||
                             bodyText.includes('invalid phone number') ||
                             bodyText.includes('something went wrong');
            if (hasError) return 'REJECTED';
            
            return false;
        }, { timeout: 8000 });
        
        const isRejected = await page.evaluate(() => {
            const bodyText = document.body.innerText.toLowerCase();
            return bodyText.includes('phone number has already been used') ||
                   bodyText.includes('cannot be used for verification') ||
                   bodyText.includes('invalid phone number') ||
                   bodyText.includes('something went wrong');
        });
        
        if (isRejected) {
            throw new Error('PHONE_REJECTED');
        }
        
        await screenshot(page, 'after_retry_phone_entry');
        console.log(`[PhoneBot] Retry Phone entered (${fullPhone}) and accepted. URL: ${page.url()}`);
    } catch (e) {
        console.log(`[PhoneBot] Retry Rejection or timeout detected. Error: ${e.message}`);
        throw new Error('PHONE_REJECTED');
    }
    
    return { success: true };
}

// ── Enter SMS verification code ────────────────────────────────────────────────
export async function enterSmsCode(page, code) {
    await screenshot(page, 'before_code_entry');
    console.log(`[PhoneBot] Entering code ${code}. URL: ${page.url()}`);

    const input = await findInput(page, [
        '#code',
        'input[name="code"]',
        'input[maxlength="6"]',
        'input[type="tel"]',
        'input[aria-label*="code" i]',
        'input[aria-label*="Code" i]',
    ]);

    if (!input) {
        await screenshot(page, 'no_code_input');
        throw new Error('Code input field not found');
    }

    await input.click({ clickCount: 3 });
    await input.type(code, { delay: TYPE_DELAY });
    await sleep(400);
    await page.keyboard.press('Enter');
    await sleep(3000);

    await screenshot(page, 'after_code_entry');
    console.log(`[PhoneBot] Code entered. URL: ${page.url()}`);
    return { success: true };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
async function findInput(page, selectors) {
    for (const sel of selectors) {
        try {
            const el = await page.$(sel);
            if (!el) continue;
            const box = await el.boundingBox();
            if (box) return el;
        } catch { /* skip */ }
    }
    return null;
}

async function clickNext(page) {
    const selectors = [
        '#identifierNext button', '#passwordNext button', '#sendVerificationCode button',
        '#next', 'button[data-action="next"]', '[jsname="LgbsSe"]',
        'button[type="submit"]',
    ];
    for (const sel of selectors) {
        try {
            const el = await page.$(sel);
            if (el) { await el.click(); return true; }
        } catch { /* try next */ }
    }
    await page.keyboard.press('Enter');
    return false;
}
