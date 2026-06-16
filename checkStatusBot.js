import puppeteer from 'puppeteer';

const TIMEOUT = 15000;
const TYPE_DELAY = 10;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const clickNext = async (page) => {
    const nextBtn = await page.$('button, [role="button"]');
    if (nextBtn) {
        await nextBtn.click();
    } else {
        await page.keyboard.press('Enter');
    }
};

export async function checkStatus(account) {
    const { email, password } = account;
    
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,800',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        const page = await browser.newPage();
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
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
        await emailEl.press('Enter').catch(() => page.keyboard.press('Enter'));
        await sleep(1500);

        // Check if page text shows account not found or captcha
        let pageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
        if (pageText.includes("enter the text you hear or see") || pageText.includes("prove you're not a robot")) {
            return { status: 'CAPTCHA_BLOCKED' };
        }
        if (pageText.includes("couldn't find your google account") ||
            pageText.includes("could not find your google account") ||
            pageText.includes("no google account found") ||
            pageText.includes("enter a valid email") ||
            pageText.includes("this account was recently deleted")) {
            return { status: 'ACCOUNT_NOT_FOUND' };
        }

        // Enter password
        try {
            const pwEl = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 5000 });
            await pwEl.type(password, { delay: TYPE_DELAY });
            await sleep(200);
            await pwEl.press('Enter').catch(() => page.keyboard.press('Enter'));
        } catch (e) {
            // Password box didn't appear, check text again
            pageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
            if (pageText.includes("enter the text you hear or see") || pageText.includes("prove you're not a robot")) return { status: 'CAPTCHA_BLOCKED' };
            if (pageText.includes("couldn't find")) return { status: 'ACCOUNT_NOT_FOUND' };
        }

        try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 });
        } catch { /* might not fire */ }
        await sleep(1500);

        let url = page.url();
        pageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');

        // Check for TOTP/Authenticator
        const otpInputCheck = await page.$('input[name="totpPin"], input[id*="totp"], input[id*="otp"], input[type="tel"]').catch(() => null);
        if (otpInputCheck || url.includes('challenge/totp') || url.includes('challenge/pwd')) {
            if (pageText.includes('google authenticator') || pageText.includes('get a verification code') || otpInputCheck) {
                console.log(`[CheckStatus] TOTP requested for ${email}, generating...`);
                const genOtpModule = await import('./generateOTP.cjs');
                const otpCode = await genOtpModule.getOTPForAccount(email);
                
                if (otpCode) {
                    console.log(`[CheckStatus] Submitting OTP ${otpCode} for ${email}`);
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
                        url = page.url();
                        pageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
                    }
                }
            }
        }

        // Check for login errors
        const errEl = await page.$('[data-error-code], .Ekjuhf, .dEOOab, .o6cuMc');
        if (errEl) {
            const txt = await errEl.evaluate(e => e.textContent.trim()).catch(() => '');
            if (txt.toLowerCase().includes('wrong password')) return { status: 'WRONG_PASSWORD' };
        }

        if (url.includes('myaccount.google.com') || url.includes('mail.google.com') || url.includes('myaccount')) {
            return { status: 'ACTIVE' };
        } else if (url.includes('challenge/pwd')) {
            return { status: 'WRONG_PASSWORD' };
        } else if (pageText.includes("we've detected unusual activity") || url.includes('challenge/iap') || url.includes('challenge/phone') || pageText.includes('get a verification code')) {
            return { status: 'REQUIRES_PHONE_VERIFY' };
        } else if (pageText.includes("suspended") || url.includes('suspended')) {
            return { status: 'SUSPENDED' };
        } else {
            return { status: 'UNKNOWN', details: url };
        }
    } catch (error) {
        return { status: 'ERROR', details: error.message };
    } finally {
        if (browser) await browser.close();
    }
}
