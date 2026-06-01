const puppeteer = require('puppeteer');
const setupAuthenticator = require('./setupAuthenticator.cjs');
const { getOTPForAccount } = require('./generateOTP.cjs');

/**
 * Login to Google account via Puppeteer, handle OTP automatically if needed.
 * Returns the page after successful login.
 */
async function loginToGoogle(page, email, password) {
    console.log('[App Password] Logging in as ' + email);

    await page.goto('https://accounts.google.com/signin/v2/identifier?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // --- STEP 1: EMAIL ---
    const emailInput = await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await emailInput.click({ clickCount: 3 }); // Select all first
    await emailInput.type(email, { delay: 80 });
    console.log('[App Password] Email typed: ' + email);
    await new Promise(r => setTimeout(r, 1000));

    // Click Next button (not just press Enter)
    const emailNextClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
        const next = btns.find(b => {
            const t = (b.innerText || b.textContent || '').trim().toLowerCase();
            return t === 'next' || t === 'suivant';
        });
        if (next) { next.click(); return true; }
        return false;
    });
    if (!emailNextClicked) {
        await page.keyboard.press('Enter');
    }
    console.log('[App Password] Email Next clicked');

    // Wait for password field to appear
    await new Promise(r => setTimeout(r, 3000));
    const passwordInput = await page.waitForSelector('input[type="password"]', { timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));

    // --- STEP 2: PASSWORD ---
    await passwordInput.scrollIntoView();
    await passwordInput.click({ clickCount: 3 }); // Select all
    await passwordInput.type(password, { delay: 80 });
    console.log('[App Password] Password typed');
    await new Promise(r => setTimeout(r, 1000));

    // Click Next / Sign In button
    const passNextClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
        const next = btns.find(b => {
            const t = (b.innerText || b.textContent || '').trim().toLowerCase();
            return t === 'next' || t === 'suivant' || t === 'sign in' || t === 'se connecter';
        });
        if (next) { next.click(); return true; }
        return false;
    });
    if (!passNextClicked) {
        await page.keyboard.press('Enter');
    }
    console.log('[App Password] Password Next clicked');

    // Wait for navigation after login
    await new Promise(r => setTimeout(r, 5000));

    // Check if 2FA/OTP requested
    const currentUrl = page.url();
    console.log('[App Password] After login URL: ' + currentUrl);

    if (currentUrl.includes('challenge') || currentUrl.includes('totp') || currentUrl.includes('2sv')) {
        console.log('[App Password] OTP challenge detected for ' + email);
        try {
            const otp = await getOTPForAccount(email);
            console.log('[App Password] Got OTP: ' + otp);

            const totpInput = await page.waitForSelector(
                'input[name="totpPin"], input[type="tel"], input[id*="totp"], input[id*="otp"], input[aria-label*="code"], input[aria-label*="verification"]',
                { timeout: 10000 }
            ).catch(() => null);

            if (totpInput) {
                await totpInput.click({ clickCount: 3 });
                await totpInput.type(otp, { delay: 80 });
                await new Promise(r => setTimeout(r, 500));
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 4000));
            }
        } catch (otpErr) {
            console.warn('[App Password] Could not auto-fill OTP: ' + otpErr.message);
        }
    }

    // Final wait
    await new Promise(r => setTimeout(r, 2000));
    console.log('[App Password] Final URL: ' + page.url());
    return page;
}


/**
 * Generate an App Password for a Google Workspace User.
 * Steps:
 *   1. Login to user's Google account
 *   2. If 2FA not set up → run setupAuthenticator first
 *   3. Go to App Passwords page
 *   4. Create new App Password
 *   5. Return appPassword + secretKey
 *
 * @param {string} email
 * @param {string} password
 * @param {boolean} headless
 */
async function generateAppPassword(email, password, headless = false) {
    let browser;
    try {
        console.log(`[App Password] ▶ Starting for ${email}`);

        browser = await puppeteer.launch({
            headless: headless ? 'new' : false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--lang=en-US',
                '--disable-blink-features=AutomationControlled'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await page.setViewport({ width: 1280, height: 900 });

        let secretKey = null;

        // Try to get existing secret key from SSH server
        try {
            secretKey = await getOTPForAccount(email);
            console.log(`[App Password] ✅ Got existing secret key for ${email}`);
        } catch (e) {
            console.log(`[App Password] No existing secret key for ${email}: ${e.message}`);
        }

        // Login
        await loginToGoogle(page, email, password);

        // Try to go to App Passwords page
        await page.goto('https://myaccount.google.com/apppasswords?hl=en', { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));

        const pageUrl = page.url();
        console.log(`[App Password] App Passwords URL: ${pageUrl}`);

        // If redirected to 2FA setup page or access denied → run setupAuthenticator
        if (pageUrl.includes('signinchooser') || pageUrl.includes('accounts.google.com') || !pageUrl.includes('apppasswords')) {
            console.log(`[App Password] App Passwords not accessible — setting up 2SV first...`);

            // Close current page and run setupAuthenticator (it handles login + 2FA setup)
            await page.close();
            const secretFromSetup = await setupAuthenticator(email, password, browser);
            if (secretFromSetup) {
                secretKey = secretFromSetup;
                console.log(`[App Password] 2SV set up. Secret key obtained.`);
            }

            // Now retry App Passwords
            const page2 = await browser.newPage();
            await page2.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
            await page2.goto('https://myaccount.google.com/apppasswords?hl=en', { waitUntil: 'networkidle2', timeout: 20000 });
            await new Promise(r => setTimeout(r, 3000));

            const result = await createAppPasswordOnPage(page2, email, secretKey);
            return result;
        }

        // Already on App Passwords page
        const result = await createAppPasswordOnPage(page, email, secretKey);
        return result;

    } catch (e) {
        console.error(`[App Password] ❌ Error: ${e.message}`);
        return { success: false, error: e.message };
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * On the App Passwords page, create a new App Password and return it.
 */
async function createAppPasswordOnPage(page, email, secretKey) {
    // Check if we see the "App name" input
    const appNameInput = await page.waitForSelector('input[type="text"]', { timeout: 12000 }).catch(() => null);
    if (!appNameInput) {
        // Take screenshot for debug
        // disabled screenshot
        const title = await page.title();
        throw new Error(`Could not find App Password input. Page title: "${title}". 2-Step Verification may not be enabled.`);
    }

    // Enter app name
    const appName = 'Nexus-Auth-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    await appNameInput.type(appName, { delay: 60 });
    console.log(`[App Password] Creating app password: ${appName}`);

    // Click Create button
    const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const createBtn = buttons.find(b => {
            const t = (b.innerText || b.textContent || '').toLowerCase().trim();
            return t === 'create' || t.startsWith('create');
        });
        if (createBtn) { createBtn.click(); return true; }
        return false;
    });

    if (!clicked) {
        await page.keyboard.press('Enter');
    }

    await new Promise(r => setTimeout(r, 5000));

    // Extract the generated password — format: "xxxx xxxx xxxx xxxx"
    const appPassword = await page.evaluate(() => {
        const allEls = Array.from(document.querySelectorAll('span, div, p, strong, li, td'));
        for (const el of allEls) {
            const text = (el.innerText || el.textContent || '').trim();
            // Match pattern like "aaaa bbbb cccc dddd" or "aaaabbbbccccdddd"
            if (/^[a-z]{4}\s[a-z]{4}\s[a-z]{4}\s[a-z]{4}$/i.test(text)) {
                return text.replace(/\s/g, '');
            }
        }
        // Try wider search for 16 consecutive lowercase letters
        const bodyText = document.body.innerText || '';
        const match = bodyText.match(/\b([a-z]{4})\s([a-z]{4})\s([a-z]{4})\s([a-z]{4})\b/i);
        if (match) {
            return (match[1] + match[2] + match[3] + match[4]).toLowerCase();
        }
        return null;
    });

    if (!appPassword) {
        // disabled screenshot
        throw new Error('Created App Password but could not read it from screen.');
    }

    console.log(`[App Password] ✅ Generated successfully for ${email}: ${appPassword}`);
    return { success: true, appPassword, secretKey };
}

module.exports = { generateAppPassword };
