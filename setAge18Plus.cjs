'use strict';
const puppeteer = require('puppeteer');
const UserAgent = require('user-agents');
const { handleOTPIfRequested } = require('./autoOTPHandler.cjs');

function isOnAdminConsole(url) {
    try { return new URL(url).hostname === 'admin.google.com'; } catch { return false; }
}

function isOnGoogleAuth(url) {
    try { return new URL(url).hostname === 'accounts.google.com'; } catch { return false; }
}

async function setAge18Plus(email, password, headless = true) {
    console.log(`[Age18+] Starting for ${email}`);

    const userAgent = new UserAgent({ deviceCategory: 'desktop' });

    const browser = await puppeteer.launch({
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', `--user-agent=${userAgent.toString()}`, '--lang=en-US']
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent(userAgent.toString());
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await page.setViewport({ width: 1280, height: 800 });

        // Step 1: Navigate to admin — Google redirects to login
        console.log('[Age18+] Navigating to admin console...');
        await page.goto('https://admin.google.com/ac/accountsettings/profile?hl=en&pli=1', {
            waitUntil: 'networkidle2', timeout: 60000
        });
        await new Promise(r => setTimeout(r, 2000));

        // Step 2: Login if needed
        const emailInput = await page.$('input[type="email"]');
        if (emailInput) {
            console.log('[Age18+] Logging in...');
            await page.type('input[type="email"]', email, { delay: 60 });
            await page.click('#identifierNext');
            await new Promise(r => setTimeout(r, 2500));

            await page.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 });
            await page.type('input[type="password"]', password, { delay: 60 });
            await page.click('#passwordNext');
            await new Promise(r => setTimeout(r, 3000));

            await handleOTPIfRequested(page, email, 12000);
            await new Promise(r => setTimeout(r, 2000));
        }

        // Step 3: Wait for admin.google.com — handle speedbump pages properly
        console.log('[Age18+] Waiting for admin console...');
        let waited = 0;
        while (waited < 60000) {
            const url = page.url();

            if (isOnAdminConsole(url)) {
                console.log(`[Age18+] ✅ On admin console`);
                break;
            }

            if (isOnGoogleAuth(url)) {
                // If back on EMAIL INPUT page — re-do login
                const onEmailInput = await page.$('input[type="email"]').catch(() => null);
                if (onEmailInput) {
                    console.log('[Age18+] On email login page — re-logging in...');
                    await page.evaluate(el => el.value = '', onEmailInput);
                    await page.type('input[type="email"]', email, { delay: 60 });
                    await page.click('#identifierNext');
                    await new Promise(r => setTimeout(r, 2500));
                    const pwInput = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 }).catch(() => null);
                    if (pwInput) {
                        await page.type('input[type="password"]', password, { delay: 60 });
                        await page.click('#passwordNext');
                        await new Promise(r => setTimeout(r, 3000));
                        await handleOTPIfRequested(page, email, 12000);
                        await new Promise(r => setTimeout(r, 2000));
                    }
                    continue;
                }

                // On speedbump/explanation page — submit the form directly
                if (url.includes('speedbump') || url.includes('explanation') || url.includes('disabled')) {
                    console.log(`[Age18+] Speedbump page detected — submitting form...`);
                    const handled = await page.evaluate(() => {
                        // Method 1: submit button
                        const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
                        if (submitBtn) { submitBtn.click(); return 'submit-btn'; }
                        // Method 2: submit the form
                        const form = document.querySelector('form');
                        if (form) { form.submit(); return 'form.submit'; }
                        // Method 3: find a visible button that is NOT "Forgot email?" or "Cancel"
                        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
                        const btn = buttons.find(b => {
                            const t = (b.innerText || b.textContent || '').toLowerCase().trim();
                            return b.offsetParent !== null && t.length > 0 &&
                                !t.includes('forgot') && !t.includes('cancel') &&
                                !t.includes('back') && !t.includes('email');
                        });
                        if (btn) { btn.click(); return btn.innerText || 'btn'; }
                        return null;
                    });
                    console.log(`[Age18+] Speedbump handled: ${handled}`);
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }

                // Other Google auth page — wait for navigation
                console.log(`[Age18+] On Google auth page, waiting...`);
            }

            await new Promise(r => setTimeout(r, 1500));
            waited += 1500;
        }

        if (!isOnAdminConsole(page.url())) {
            throw new Error(`Login failed — stuck at: ${page.url().substring(0, 100)}`);
        }

        // Step 4: Now that we're authenticated, navigate directly to Age settings
        console.log('[Age18+] Navigating to Age-Based Access settings...');
        await page.goto('https://admin.google.com/ac/managedsettings/age_based_access?hl=en', {
            waitUntil: 'networkidle2', timeout: 30000
        });
        await new Promise(r => setTimeout(r, 3000));

        console.log(`[Age18+] Settings URL: ${page.url()}`);

        // Step 5: Select "All users 18 or older"
        const selected = await page.evaluate(() => {
            const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
            for (const radio of radios) {
                let el = radio.parentElement;
                for (let i = 0; i < 6; i++) {
                    if (el && el.textContent && el.textContent.includes('18 or older')) {
                        if (!radio.checked) radio.click();
                        return true;
                    }
                    if (el) el = el.parentElement;
                }
            }
            const allEls = Array.from(document.querySelectorAll('label, div, span'));
            const el18 = allEls.find(e => e.children.length < 5 && e.textContent && e.textContent.trim().includes('18 or older'));
            if (el18) { el18.click(); return true; }
            return false;
        });

        if (!selected) throw new Error('Could not find "18 or older" radio button');
        console.log('[Age18+] ✅ Selected "All users 18 or older"');
        await new Promise(r => setTimeout(r, 1500));

        // Step 6: Click SAVE
        const saved = await page.evaluate(() => {
            const allClickable = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
            const saveBtn = allClickable.find(el => (el.innerText || el.textContent || '').trim().toUpperCase() === 'SAVE');
            if (saveBtn) { saveBtn.click(); return true; }
            return false;
        });

        if (!saved) throw new Error('Could not find SAVE button');
        console.log('[Age18+] ✅ Clicked Save');
        await new Promise(r => setTimeout(r, 4000));

        const confirmed = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('input[type="radio"]')).some(r => {
                if (!r.checked) return false;
                let el = r.parentElement;
                for (let i = 0; i < 6; i++) {
                    if (el && el.textContent && el.textContent.includes('18 or older')) return true;
                    if (el) el = el.parentElement;
                }
                return false;
            });
        });

        console.log(`[Age18+] ✅ Done for ${email}. Confirmed: ${confirmed}`);
        return { success: true, confirmed };

    } finally {
        await browser.close();
    }
}

module.exports = { setAge18Plus };
