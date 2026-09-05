const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// All DWD scopes (single source of truth — no duplicates)
const ALL_SCOPES = [
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/gmail.settings.basic',
    'https://www.googleapis.com/auth/gmail.settings.sharing',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.insert',
    'https://www.googleapis.com/auth/admin.directory.user',
    'https://www.googleapis.com/auth/admin.directory.user.alias',
    'https://www.googleapis.com/auth/admin.directory.user.security',
    'https://www.googleapis.com/auth/admin.directory.group',
    'https://www.googleapis.com/auth/admin.directory.domain',
    'https://www.googleapis.com/auth/admin.directory.domain.readonly',
    'https://www.googleapis.com/auth/admin.directory.orgunit',
    'https://www.googleapis.com/auth/admin.directory.customer',
    'https://www.googleapis.com/auth/siteverification'
];

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

        // 1. Open DWD and complete whatever Google sign-in state is shown.
        // Do not assume a missing email field means that authentication succeeded:
        // Google may still be loading, showing an account chooser, password, OTP,
        // CAPTCHA, or another intermediate challenge.
        const initialDwdUrl = 'https://admin.google.com/ac/owl/domainwidedelegation?hl=en';
        console.log('[DWD] Navigating to DWD Page...');
        await page.goto(initialDwdUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const { solveGoogleLoginCaptchaIfPresent } = require('./captchaSolver.cjs');
        const { handleOTPIfRequested } = require('./autoOTPHandler.cjs');

        for (let loginStep = 1; loginStep <= 10; loginStep++) {
            await new Promise(r => setTimeout(r, loginStep === 1 ? 4000 : 2500));
            const loginUrl = page.url();

            if (!loginUrl.includes('accounts.google.com')) {
                console.log('[DWD] Google sign-in complete.');
                break;
            }

            console.log(`[DWD] Login state ${loginStep}/10: ${loginUrl}`);

            // Google may show an account chooser instead of the identifier form.
            const chooserClicked = await page.evaluate(targetEmail => {
                const nodes = Array.from(document.querySelectorAll('[data-identifier], [data-email], [role="link"], [role="button"]'));
                const target = String(targetEmail).toLowerCase();
                const item = nodes.find(node => {
                    if (node.offsetParent === null) return false;
                    const identifier = String(node.getAttribute('data-identifier') || node.getAttribute('data-email') || '').toLowerCase();
                    const text = String(node.innerText || node.textContent || '').toLowerCase();
                    return identifier === target || text.includes(target);
                });
                if (!item) return false;
                item.click();
                return true;
            }, email);

            if (chooserClicked) {
                console.log('[DWD] Selected account from Google account chooser.');
                continue;
            }

            const emailInput = await page.$('input[type="email"], input[name="identifier"], #identifierId');
            if (emailInput && await emailInput.isIntersectingViewport().catch(() => true)) {
                await emailInput.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await emailInput.type(email, { delay: 45 });
                console.log('[DWD] Email entered.');
                const nextClicked = await page.evaluate(() => {
                    const button = document.querySelector('#identifierNext, button[jsname="LgbsSe"]');
                    if (!button) return false;
                    button.click();
                    return true;
                });
                if (!nextClicked) await page.keyboard.press('Enter');
                continue;
            }

            const passwordInput = await page.$('input[type="password"]');
            if (passwordInput && await passwordInput.isIntersectingViewport().catch(() => true)) {
                await passwordInput.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await passwordInput.type(password, { delay: 45 });
                console.log('[DWD] Password entered.');
                const nextClicked = await page.evaluate(() => {
                    const button = document.querySelector('#passwordNext, button[jsname="LgbsSe"]');
                    if (!button) return false;
                    button.click();
                    return true;
                });
                if (!nextClicked) await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 3000));
                await solveGoogleLoginCaptchaIfPresent(page, password).catch(error =>
                    console.log('[DWD] CAPTCHA handler:', error.message)
                );
                await handleOTPIfRequested(page, email, 12000).catch(error =>
                    console.log('[DWD] OTP handler:', error.message)
                );
                continue;
            }

            // No standard field is visible: let the existing challenge handlers
            // inspect CAPTCHA/OTP pages before the next state check.
            const captchaHandled = await solveGoogleLoginCaptchaIfPresent(page, password).catch(() => false);
            const otpHandled = await handleOTPIfRequested(page, email, 10000).catch(() => false);
            if (!captchaHandled && !otpHandled) {
                console.log('[DWD] Waiting for Google sign-in page to finish rendering...');
            }
        }

        if (page.url().includes('accounts.google.com')) {
            const state = await page.evaluate(() => ({
                url: window.location.href,
                title: document.title,
                body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600)
            }));
            console.log('[DWD] Login blocked state:', JSON.stringify(state));
            throw new Error(`Google login/verification did not finish after 10 checks: ${state.url}`);
        }

        // 2. Navigate to Domain-Wide Delegation (if not already there)
        const currentUrl = page.url();
        if (!currentUrl.includes('domainwidedelegation')) {
            await page.goto('https://admin.google.com/ac/owl/domainwidedelegation?hl=en', { waitUntil: 'networkidle2' });
        }

        await new Promise(resolve => setTimeout(resolve, 3000));

        // 3. Click "Add new" button. Google Admin is a heavy SPA, so the
        // control can appear late or after an internal redirect.
        console.log('[DWD] Adding new client...');

        const dwdUrl = 'https://admin.google.com/ac/owl/domainwidedelegation?hl=en';
        let addButton = false;
        let lastPageState = {};

        for (let attempt = 1; attempt <= 3 && !addButton; attempt++) {
            if (!page.url().includes('domainwidedelegation')) {
                console.log(`[DWD] Add New attempt ${attempt}: returning to DWD page...`);
                await page.goto(dwdUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            }

            await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 5000 : 8000));

            lastPageState = await page.evaluate(() => ({
                url: window.location.href,
                title: document.title,
                body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500)
            }));

            const currentPageUrl = String(lastPageState.url || page.url());
            if (currentPageUrl.includes('accounts.google.com')) {
                throw new Error(`Google login/verification is still blocking the DWD page: ${currentPageUrl}`);
            }

            addButton = await page.evaluate(() => {
                const candidates = Array.from(document.querySelectorAll(
                    'button, [role="button"], a, [data-action], [aria-label]'
                ));

                const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
                const labels = ['add new', 'add client', 'new client', 'add app'];

                const button = candidates.find(element => {
                    if (element.offsetParent === null) return false;
                    if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;

                    const text = normalize(element.innerText || element.textContent);
                    const aria = normalize(element.getAttribute('aria-label'));
                    const tooltip = normalize(element.getAttribute('data-tooltip'));
                    return labels.some(label =>
                        text === label || aria.includes(label) || tooltip.includes(label)
                    );
                });

                if (!button) return false;
                button.scrollIntoView({ block: 'center' });
                button.click();
                return true;
            });

            if (!addButton && attempt < 3) {
                console.log(`[DWD] Add New not visible (attempt ${attempt}/3). Reloading DWD page...`);
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            }
        }

        if (!addButton) {
            console.log('[DWD] Page state:', JSON.stringify(lastPageState));
            const pageText = String(lastPageState.body || '').toLowerCase();
            if (pageText.includes('you do not have permission') ||
                pageText.includes('access denied') ||
                pageText.includes('not authorized')) {
                throw new Error('DWD page opened, but this account does not have Super Admin permission');
            }
            throw new Error(`Could not find "Add new" button after 3 attempts. URL: ${lastPageState.url || page.url()}; title: ${lastPageState.title || 'unknown'}`);
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
        } catch (e) {
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

        // DEBUG: Screenshot + dump all inputs in page to find correct scopes selector
        console.log('[DWD] [DEBUG] Dumping all inputs in dialog...');
        const debugInfo = await page.evaluate(() => {
            const allInputs = Array.from(document.querySelectorAll('input, textarea'));
            return allInputs.map((el, i) => ({
                i,
                tag: el.tagName,
                type: el.type || '',
                name: el.name || '',
                id: el.id || '',
                ariaLabel: el.getAttribute('aria-label') || '',
                placeholder: el.getAttribute('placeholder') || '',
                visible: el.offsetParent !== null,
                value: el.value?.substring(0, 30) || ''
            }));
        });
        console.log('[DWD] [DEBUG] Inputs found:', JSON.stringify(debugInfo));

        try {
            const dbgShot = require('path').join(__dirname, `dwd-debug-${Date.now()}.png`);
            // disabled screenshot
            console.log(`[DWD] [DEBUG] Screenshot: ${dbgShot}`);
        } catch (_) { }

        // 6. Fill in Scopes 
        console.log(`[DWD] Filling Scopes (comma-delimited)...`);
        await new Promise(resolve => setTimeout(resolve, 1000));


        // Explicitly get the OAuth scopes input from exactly the aria-label Google uses:
        const scopesSelector = 'input[aria-label*="OAuth scopes"], input[aria-label*="scopes" i]';
        const scopesField = await page.$(scopesSelector);

        if (scopesField) {
            await scopesField.click();
            await new Promise(r => setTimeout(r, 300));

            // Google explicitly says "comma-delimited", and typing commas natively spins up chips 
            // without moving the focus out of the input field like Tab/Enter does!
            const scopesString = ALL_SCOPES.join(',');

            console.log(`[DWD] Typing all scopes as comma-separated string...`);
            // We use a slightly faster delay since it's one continuous string
            await page.keyboard.type(scopesString, { delay: 5 });
            await new Promise(r => setTimeout(r, 1000)); // allow chips to render

            // Press Tab ONCE at the very end just to commit the final chip 
            // and move focus towards the Authorize button
            await page.keyboard.press('Tab');
            await new Promise(r => setTimeout(r, 500));

            console.log(`[DWD] ✅ Added all ${ALL_SCOPES.length} scopes successfully.`);
        } else {
            console.log('[DWD] ❌ CRITICAL ERROR: Could not find explicitly the OAuth scopes input field.');
        }

        console.log('[DWD] Scopes step complete.');

        // 7. Click the FIRST "Authorize" button (inside the DWD add-client dialog)
        console.log('[DWD] Clicking Authorize (Step 1)...');

        await new Promise(resolve => setTimeout(resolve, 1500));

        const step1Result = await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll(
                'button, div[role="button"], span[role="button"], a[role="button"], input[type="submit"]'
            ));
            // Step 1: Click ONLY "Authorize" — not Confirm, not Cancel
            const btn = all.find(el => {
                const text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
                if (el.offsetParent === null) return false;
                if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
                if (text.includes('cancel') || text.includes('annuler')) return false;
                if (text.includes('confirm') || text.includes('confirmer')) return false; // skip confirm at step 1
                return text === 'authorize' || text === 'autoriser' ||
                    (text.includes('authorize') && text.length < 20);
            });
            if (btn) {
                btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                btn.click();
                return btn.innerText?.trim() || 'Authorize';
            }
            return null;
        });

        if (step1Result) {
            console.log(`[DWD] ✅ Step 1 clicked: "${step1Result}"`);
        } else {
            console.log('[DWD] ⚠️ Step 1: Could not find Authorize button!');
        }

        // 8. Wait for the SECOND confirmation dialog (shows "Confirm" button) then click it
        console.log('[DWD] Waiting for Confirm dialog to appear...');

        // Poll up to 8 seconds for the Confirm button to appear
        let confirmClicked = false;
        for (let attempt = 0; attempt < 16; attempt++) {
            await new Promise(r => setTimeout(r, 500));

            confirmClicked = await page.evaluate(() => {
                // Google's Confirm button: data-default="true" with text "Confirm"
                // Or jsname="LgbsSe", or data-id="EBS5u"
                const allBtns = Array.from(document.querySelectorAll(
                    '[role="button"], button'
                ));

                // Priority 1: data-default="true" with "Confirm" text
                let confirmBtn = allBtns.find(el => {
                    if (el.offsetParent === null) return false;
                    if (el.getAttribute('aria-disabled') === 'true') return false;
                    const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                    const isDefault = el.getAttribute('data-default') === 'true';
                    return isDefault && (text === 'confirm' || text === 'confirmer');
                });

                // Priority 2: any visible button with exactly "Confirm" text
                if (!confirmBtn) {
                    confirmBtn = allBtns.find(el => {
                        if (el.offsetParent === null) return false;
                        if (el.getAttribute('aria-disabled') === 'true') return false;
                        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                        return text === 'confirm' || text === 'confirmer';
                    });
                }

                // Priority 3: jsname="LgbsSe" (Google's internal name for confirm btn)
                if (!confirmBtn) {
                    confirmBtn = document.querySelector('[jsname="LgbsSe"][role="button"]:not([aria-disabled="true"])');
                    if (confirmBtn && confirmBtn.offsetParent === null) confirmBtn = null;
                }

                if (confirmBtn) {
                    const label = confirmBtn.innerText?.trim() || 'Confirm';
                    console.log(`[DWD] Found Confirm button: "${label}"`);
                    confirmBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    confirmBtn.click();
                    return label;
                }
                return null;
            });

            if (confirmClicked) {
                console.log(`[DWD] ✅ Step 2 clicked: "${confirmClicked}"`);
                break;
            }
        }

        if (!confirmClicked) {
            console.log('[DWD] ⚠️ Step 2: Confirm dialog did not appear — DWD may have auto-saved or failed silently.');
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('[DWD] Domain-Wide Delegation added successfully!');

        // Take screenshot for verification
        const screenshotPath = path.join(__dirname, `dwd-success-${Date.now()}.png`);
        // disabled screenshot
        console.log(`[DWD] Screenshot saved: ${screenshotPath}`);




    } catch (error) {
        console.error('[DWD] Error:', error.message);
        try {
            if (typeof page !== 'undefined' && page) {
                const screenshotPath = path.join(__dirname, `dwd-error-${Date.now()}.png`);
                // disabled screenshot
                console.log(`[DWD] Error screenshot saved: ${screenshotPath}`);
            }
        } catch (e) {
            console.error('[DWD] Failed to save error screenshot:', e.message);
        }
        throw error;
    } finally {
        if (shouldCloseBrowser && browser) {
            await browser.close();
        } else if (browser) {
            // Check if we have multiple pages, close the current one to clean up but keep browser open
            try {
                const pages = await browser.pages();
                if (pages.length > 1) {
                    const currentPage = pages[pages.length - 1]; // Get last page (current)
                    if (currentPage) await currentPage.close();
                }
            } catch (cleanupErr) {
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
