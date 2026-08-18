"use strict";
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.insert',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/admin.directory.user',
    'https://www.googleapis.com/auth/admin.directory.user.security',
    'https://www.googleapis.com/auth/admin.directory.orgunit',
    'https://www.googleapis.com/auth/admin.directory.domain.readonly',
    'https://www.googleapis.com/auth/admin.directory.domain',
    'https://www.googleapis.com/auth/siteverification'
].join(',');
// DWD Script with Shared Browser Support
async function addDomainWideDelegation(email, password, serviceAccountEmail, browser = null, configDir = null) {
    console.log(`[DWD] Starting automation for ${serviceAccountEmail}`);
    const shouldCloseBrowser = !browser;
    if (!browser) {
        browser = await puppeteer.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US']
        });
    }
    try {
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9'
        });
        await page.setViewport({ width: 1280, height: 800 });
        // 1. Check if we are already logged in (Shared Browser Scenario)
        // If the browser was passed, we assume the previous step might have left us logged in
        // But we need to navigate to the Admin Console DWD page anyway.
        console.log('[DWD] Navigating to DWD Page...');
        await page.goto('https://admin.google.com/ac/owl/domainwidedelegation?hl=en', { waitUntil: 'networkidle2' });
        // Check if login is required
        try {
            const emailInput = await page.waitForSelector('input[type="email"]', { visible: true, timeout: 5000 }).catch(() => null);
            if (emailInput) {
                console.log('[DWD] Login required. Entering credentials...');
                // Enter email
                await emailInput.click({ clickCount: 3 });
                await emailInput.type(email, { delay: 60 });
                console.log('[DWD] Email typed.');
                await page.click('#identifierNext').catch(() => page.keyboard.press('Enter'));
                await new Promise(r => setTimeout(r, 2000));
                // Optional Captcha after email
                const { solveGoogleLoginCaptchaIfPresent } = require('./captchaSolver.cjs');
                await solveGoogleLoginCaptchaIfPresent(page, password);
                // Enter password
                const passwordInput = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 });
                await new Promise(r => setTimeout(r, 1000));
                await passwordInput.click({ clickCount: 3 });
                await passwordInput.type(password, { delay: 60 });
                console.log('[DWD] Password typed.');
                await page.click('#passwordNext').catch(() => page.keyboard.press('Enter'));
                await new Promise(r => setTimeout(r, 3000));
                // Watch for captcha after password or "Wrong password"
                let solvedCaptcha = await solveGoogleLoginCaptchaIfPresent(page, password);
                if (solvedCaptcha) {
                    await new Promise(r => setTimeout(r, 4000)); // wait for submit
                }
                // AUTO-OTP: Check if OTP is requested and handle automatically
                console.log('[DWD] Checking for OTP request...');
                const { handleOTPIfRequested } = require('./autoOTPHandler.cjs');
                await new Promise(r => setTimeout(r, 3000)); // Wait for page to load
                await handleOTPIfRequested(page, email, 10000);
                // Wait for Admin Console to load
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
                console.log('[DWD] Logged in successfully');
            }
            else {
                console.log('[DWD] Already logged in (or email input not found). Continuing...');
            }
        }
        catch (e) {
            console.log('[DWD] Login check failed or skipped:', e.message);
        }
        // 2. Navigate to Domain-Wide Delegation (if not already there)
        const currentUrl = page.url();
        if (!currentUrl.includes('domainwidedelegation')) {
            await page.goto('https://admin.google.com/ac/owl/domainwidedelegation?hl=en', { waitUntil: 'networkidle2' });
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
        // 3. Click "Add new" button
        console.log('[DWD] Adding new client...');
        // More robust button finding
        const addButton = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, span[role="button"], div[role="button"]'));
            const addBtn = buttons.find(btn => {
                const text = btn.innerText || btn.textContent || '';
                const ariaLabel = btn.getAttribute('aria-label') || '';
                return text.toLowerCase().includes('add new') ||
                    ariaLabel.toLowerCase().includes('add new') ||
                    text.toLowerCase().includes('add') && text.length < 15;
            });
            if (addBtn) {
                addBtn.click();
                return true;
            }
            return false;
        });
        if (!addButton) {
            throw new Error('Could not find "Add new" button');
        }
        console.log('[DWD] Clicked Add New button');
        // Wait for the side panel or modal to appear
        try {
            await page.waitForFunction(() => {
                const inputs = Array.from(document.querySelectorAll('input, textarea'));
                return inputs.some(inp => {
                    const label = inp.getAttribute('aria-label') || inp.getAttribute('placeholder') || inp.getAttribute('name') || '';
                    return label.toLowerCase().includes('client') || label.toLowerCase().includes('id');
                });
            }, { timeout: 10000 });
        }
        catch (e) {
            console.log('[DWD] Waiting for input fields timed out, continuing anyway...');
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        // 4. Get Service Account Unique ID (Client ID)
        console.log('[DWD] Fetching Service Account Unique ID...');
        const { execSync } = require('child_process');
        const env = { ...process.env };
        if (configDir) {
            env.CLOUDSDK_CONFIG = configDir;
            console.log(`[DWD] Using Isolated Config for gcloud commands: ${configDir}`);
        }
        const clientId = execSync(`gcloud iam service-accounts describe ${serviceAccountEmail} --format="value(uniqueId)"`, {
            encoding: 'utf8',
            env: env
        }).trim();
        console.log(`[DWD] Client ID: ${clientId}`);
        // 5. Fill in Client ID
        console.log(`[DWD] Filling Client ID: ${clientId}`);
        // Try to find the specific "Client ID" input
        // Analysis of Google Admin Console DWD Dialog:
        // Usually the first input is Client ID, second is Scopes.
        // We look for aria-label or placeholder containing "Client ID"
        const clientInputSelector = 'input[aria-label*="Client ID"], input[placeholder*="Client ID"], input[aria-label*="ID client"]';
        const clientInputFound = await page.evaluate((selector, id) => {
            // Priority 1: Specific Selector
            const specificInput = document.querySelector(selector);
            if (specificInput && specificInput.offsetParent !== null) {
                specificInput.focus();
                specificInput.click();
                // Clear existing (ctrl+a del) - just in case
                // document.execCommand('selectAll', false, null); // Deprecated but might work
                specificInput.value = '';
                return true;
            }
            // Priority 2: First visible text input in the dialog
            // The dialog usually has 2 inputs. First is ID, second is Scopes.
            const inputs = Array.from(document.querySelectorAll('div[role="dialog"] input[type="text"]'));
            if (inputs.length >= 2) {
                const firstInput = inputs[0];
                if (firstInput.offsetParent !== null) {
                    firstInput.focus();
                    firstInput.click();
                    firstInput.value = '';
                    return true;
                }
            }
            return false;
        }, clientInputSelector, clientId);
        if (!clientInputFound) {
            console.log('[DWD] Warning: Could not find specific Client ID input. Trying generic first input...');
        }
        // Type the ID in focused element
        await new Promise(resolve => setTimeout(resolve, 500));
        await page.keyboard.type(clientId, { delay: 50 });
        // Check removed as variable clientIdFilled is no longer defined
        console.log('[DWD] Filled Client ID');
        // 6. Fill in Scopes - Newline separated
        console.log(`[DWD] Filling Scopes (one per line)...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        // SMART TABBING STRATEGY
        // We are currently focused on Client ID.
        // We will press Tab until we find an element that looks like "Scopes".
        // Max tabs: 5 (Client ID -> Overwrite -> Scopes -> Authorize -> Cancel -> Etc.)
        let scopesInputIdentified = false;
        for (let t = 0; t < 5; t++) {
            await page.keyboard.press('Tab');
            await new Promise(r => setTimeout(r, 200)); // Wait for focus shift
            const info = await page.evaluate(() => {
                const el = document.activeElement;
                if (!el)
                    return null;
                const tag = el.tagName.toLowerCase();
                const type = (el.getAttribute('type') || '').toLowerCase();
                const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').toLowerCase();
                // Check if it looks like Scopes
                if (tag === 'textarea' || (tag === 'input' && type === 'text')) {
                    // Verify label if possible
                    if (label.includes('scope') || label.includes('oauth'))
                        return { match: true, reason: 'label' };
                    // If it's the second text input we encounter (and current is not Client ID)
                    // But here we rely on "Not Checkbox, Not Button".
                    // If it's a text input/textarea and NOT Client ID (which we just left), it's probably Scopes.
                    return { match: true, reason: 'input' };
                }
                // If it's a checkbox (Overwrite), return false (keep tabbing)
                if (type === 'checkbox')
                    return { match: false, reason: 'checkbox' };
                // If it's a button (Authorize), we went too far! (But loop handles 5 tabs max)
                if (tag === 'button')
                    return { match: false, reason: 'button' };
                return { match: false, reason: 'unknown' };
            });
            if (info && info.match) {
                console.log(`[DWD] Found Scopes input via Tab (Reason: ${info.reason})`);
                scopesInputIdentified = true;
                break;
            }
            if (info && info.reason === 'button') {
                console.log('[DWD] Hit a button (Authorize?), stopping tab search.');
                break;
            }
        }
        if (!scopesInputIdentified) {
            console.log('[DWD] Warning: Smart Tabbing failed to confirm Scopes input. Typing blindly into focused element...');
        }
        const SCOPES = [
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/gmail.compose',
            'https://www.googleapis.com/auth/gmail.insert',
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/admin.directory.user',
            'https://www.googleapis.com/auth/admin.directory.user.security',
            'https://www.googleapis.com/auth/admin.directory.orgunit',
            'https://www.googleapis.com/auth/admin.directory.domain.readonly',
            'https://www.googleapis.com/auth/admin.directory.domain',
            'https://www.googleapis.com/auth/siteverification'
        ];
        for (const scope of SCOPES) {
            await page.keyboard.type(scope, { delay: 10 });
            await new Promise(r => setTimeout(r, 100));
            // Smart Navigation: Tab until next input (max 3 times)
            let foundNextInput = false;
            for (let t = 0; t < 3; t++) {
                await page.keyboard.press('Tab');
                await new Promise(r => setTimeout(r, 100));
                const isInput = await page.evaluate(() => {
                    const el = document.activeElement;
                    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
                });
                if (isInput) {
                    foundNextInput = true;
                    break;
                }
            }
            if (!foundNextInput) {
                console.log('[DWD] Warning: Could not smart-tab to next scope field. Pressing Enter as fallback.');
                await page.keyboard.press('Enter');
            }
        }
        console.log('[DWD] Typed Scopes via Smart Tabbing (Iterative with Smart Tab).');
        // 7. Click "Authorize"
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('[DWD] Clicking Authorize...');
        const authorized = await page.evaluate(() => {
            // Find ALL clickable elements that might be the button
            const clickables = Array.from(document.querySelectorAll('button, span[role="button"], div[role="button"], a[role="button"], input[type="submit"]'));
            // Search based on TEXT CONTENT (Authorize / Autoriser / Add)
            const authBtn = clickables.find(btn => {
                // Priority: "Authorize", "Autoriser"
                const text = (btn.innerText || btn.textContent || btn.value || '').trim().toLowerCase();
                // Exclude obvious non-matches
                if (text.includes('cancel') || text.includes('annuler'))
                    return false;
                return text === 'authorize' ||
                    text === 'autoriser' ||
                    (text.includes('authorize') && text.length < 20);
            });
            if (authBtn) {
                // Check visibility: ensure it's not hidden
                if (authBtn.offsetParent === null || authBtn.disabled || authBtn.getAttribute('aria-disabled') === 'true') {
                    console.log(`[DWD] Found button "${authBtn.innerText}" but it is disabled or hidden.`);
                    return false;
                }
                console.log(`[DWD] Found Authorize button: "${authBtn.innerText}"`);
                authBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                authBtn.click();
                return true;
            }
            return false;
        });
        if (authorized) {
            console.log('[DWD] Clicked Authorize button');
        }
        else {
            console.log('[DWD] Warning: Could not find Authorize button (or maybe already authorized?)');
        }
        // 8. Wait for "OK" / "Confirm" / "Done"
        // The user says "db khso y cliki 3la confrmed"
        console.log('[DWD] Waiting for Confirmation button...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        const confirmed = await page.evaluate(() => {
            const clickables = Array.from(document.querySelectorAll('button, span[role="button"], div[role="button"], a[role="button"]'));
            const confirmBtn = clickables.find(btn => {
                const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                if (btn.offsetParent === null || btn.disabled)
                    return false;
                return text === 'confirm' ||
                    text === 'confirmer' ||
                    text === 'ok' ||
                    text === 'done' ||
                    text === 'terminé' ||
                    text.includes('confirm');
            });
            if (confirmBtn) {
                console.log(`[DWD] Found Confirmation button: "${confirmBtn.innerText}"`);
                confirmBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                confirmBtn.click();
                return true;
            }
            return false;
        });
        if (confirmed) {
            console.log('[DWD] Clicked Confirmation button');
        }
        else {
            console.log('[DWD] Warning: Could not find Confirmation button. Maybe Authorize was enough?');
        }
        console.log('[DWD] Domain-Wide Delegation added successfully!');
        // Take screenshot for verification
        const screenshotPath = path.join(__dirname, `dwd-success-${Date.now()}.png`);
        // disabled screenshot);
        console.log(`[DWD] Screenshot saved: ${screenshotPath}`);
    }
    catch (error) {
        console.error('[DWD] Error:', error.message);
        try {
            if (typeof page !== 'undefined' && page) {
                const screenshotPath = path.join(__dirname, `dwd-error-${Date.now()}.png`);
                // disabled screenshot);
                console.log(`[DWD] Error screenshot saved: ${screenshotPath}`);
            }
        }
        catch (e) {
            console.error('[DWD] Failed to save error screenshot:', e.message);
        }
        throw error;
    }
    finally {
        if (shouldCloseBrowser && browser) {
            await browser.close();
        }
        else if (browser) {
            // Check if we have multiple pages, close the current one to clean up but keep browser open
            try {
                const pages = await browser.pages();
                if (pages.length > 1) {
                    const currentPage = pages[pages.length - 1]; // Get last page (current)
                    if (currentPage)
                        await currentPage.close();
                }
            }
            catch (cleanupErr) {
                console.log('[DWD] Cleanup error:', cleanupErr.message);
            }
        }
    }
    // CLI Usage
    if (require.main === module) {
        const args = process.argv.slice(2);
        if (args.length < 3) {
            console.error('Usage: node addDomainWideDelegation.js <admin-email> <admin-password> <service-account-email>');
            process.exit(1);
        }
        const [email, password, saEmail] = args;
        addDomainWideDelegation(email, password, saEmail)
            .then(() => {
            console.log('[DWD] Complete!');
            process.exit(0);
        })
            .catch(err => {
            console.error('[DWD] Failed:', err);
            process.exit(1);
        });
    }
}
module.exports = { addDomainWideDelegation };
