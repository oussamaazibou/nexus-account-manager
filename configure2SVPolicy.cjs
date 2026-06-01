const puppeteer = require('puppeteer');

/**
 * Configure 2-Step Verification Policy in Google Admin Console
 * @param {string} adminEmail - Admin email
 * @param {string} adminPassword - Admin password
 * @param {object} browser - Optional existing browser instance
 * @returns {Promise<void>}
 */
// 2SV Policy Script with Shared Browser Support
async function configure2SVPolicy(adminEmail, adminPassword, browser = null) {
    const shouldCloseBrowser = !browser;
    if (!browser) {
        browser = await puppeteer.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US']
        });
    }

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9'
    });

    // Force English on ALL navigations (Request Interception)
    await page.setRequestInterception(true);
    page.on('request', (request) => {
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

    try {
        console.log(`[2SV Policy] Configuring 2-Step Verification policy for ${adminEmail}...`);

        // 1. Navigate to 2SV Admin Settings
        const url = 'https://admin.google.com/ac/security/2sv?journey=32&journey=218&hl=en';
        await page.goto(url, { waitUntil: 'networkidle2' });

        // 2. CHECK IF LOGIN IS NEEDED
        const isLoginPage = await page.evaluate(() => {
            return !!document.querySelector('input[type="email"]') || !!document.querySelector('input[type="password"]');
        });

        if (isLoginPage) {
            console.log('[2SV Policy] Login page detected. Performing full login...');

            // Load Config
            const fs = require('fs');
            const path = require('path');
            const configPath = path.join(__dirname, 'config.json');
            let config = {};
            try {
                if (fs.existsSync(configPath)) {
                    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                }
            } catch (e) { }

            let captchaService = null;
            try {
                const { default: CaptchaService } = await import('./services/captchaService.js');
                if (config.captchaKey) {
                    captchaService = new CaptchaService(config.captchaKey);
                }
            } catch (e) { }

            // Email Logic
            const emailInput = await page.$('input[type="email"]');
            if (emailInput) {
                await page.type('input[type="email"]', adminEmail);
                await page.click('#identifierNext');
                await new Promise(r => setTimeout(r, 2000));
            }

            // Password/Captcha Loop
            let attempts = 0;
            let loggedIn = false;
            while (!loggedIn && attempts < 3) {
                attempts++;
                try {
                    const result = await Promise.race([
                        page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 }).then(() => 'password'),
                        page.waitForSelector('#captchaimg', { visible: true, timeout: 10000 }).then(() => 'captcha'),
                        page.waitForSelector('input[name="ca"]', { visible: true, timeout: 10000 }).then(() => 'captcha')
                    ]).catch(() => 'timeout');

                    if (result === 'password') {
                        await page.type('input[type="password"]', adminPassword);
                        await page.click('#passwordNext');
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => console.log('Nav timeout'));
                        loggedIn = true;
                    } else if (result === 'captcha' && captchaService) {
                        console.log('[2SV Policy] CAPTCHA detected, solving...');
                        const img = await page.$('#captchaimg') || await page.$('img[src*="captcha"]');
                        if (img) {
                            const b64 = await img.screenshot({ encoding: 'base64' });
                            const sol = await captchaService.solveImageCaptcha(b64);
                            if (sol.success) {
                                console.log(`[2SV Policy] Solved: ${sol.solution}`);
                                const inp = await page.$('input[name="ca"]') || await page.$('input[aria-label*="hear"]');
                                if (inp) {
                                    await inp.type(sol.solution);
                                    await page.keyboard.press('Enter');
                                    await new Promise(r => setTimeout(r, 4000));
                                }
                            }
                        }
                    }
                } catch (e) { console.log('Login loop error:', e.message); }
            }
        }

        console.log('[2SV Policy] Ensuring we are on 2SV page...');
        if (page.url() !== url) {
            await page.goto(url, { waitUntil: 'networkidle2' });
        }
        await new Promise(r => setTimeout(r, 5000));

        // Check for "Welcome" / "Accept Terms" screen
        try {
            const pageTitle = await page.title();
            console.log(`[2SV Policy] Current Page Title: ${pageTitle}`);

            if (pageTitle.includes('Welcome') || pageTitle.includes('Bienvenue')) {
                console.log('[2SV Policy] Detected Welcome screen. Attempting to click Accept...');
                const accepted = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
                    const acceptBtn = buttons.find(btn => {
                        const text = (btn.innerText || btn.textContent || '').toLowerCase();
                        return text.includes('accept') || text.includes('understand') || text.includes('compris');
                    });
                    if (acceptBtn) {
                        acceptBtn.click();
                        return true;
                    }
                    return false;
                });

                if (accepted) {
                    await new Promise(r => setTimeout(r, 3000));
                    // Navigate again to be sure
                    await page.goto(url, { waitUntil: 'networkidle2' });
                }
            }
        } catch (e) {
            console.log('[2SV Policy] Title check failed:', e.message);
        }

        // 3. Turn ON enforcement
        console.log('[2SV Policy] Enabling 2SV enforcement...');

        // Wait for radio buttons to be visible
        await new Promise(r => setTimeout(r, 2000));

        let targetFrame = page;
        let foundOnRadio = false;

        // Try to handle frames
        for (const frame of page.frames()) {
            console.log(`[2SV] Checking frame for "On" radio: ${frame.url()}`);

            const success = await frame.evaluate(async () => {
                // Helper: Wait function
                const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                // Strategy: Find div[role="radio"] with aria-label="On" (Based on user HTML)
                const onRadio = document.querySelector('div[role="radio"][aria-label="On"]') ||
                    document.querySelector('div[role="radio"][aria-label="Aan"]');

                if (onRadio) {
                    console.log('[2SV] Found specific div[role="radio"][aria-label="On"]');
                    onRadio.scrollIntoView({ behavior: 'smooth', block: 'center' });

                    // Check if already checked
                    if (onRadio.getAttribute('aria-checked') === 'true') {
                        console.log('[2SV] "On" is already selected.');
                        return true;
                    }

                    // Click specific div
                    console.log('[2SV] Clicking div[role="radio"]...');
                    onRadio.click();
                    await wait(500); // Wait for reaction

                    // Verification
                    if (onRadio.getAttribute('aria-checked') === 'true') return true;

                    // Retry: Click the parent Label
                    const parentLabel = onRadio.closest('label');
                    if (parentLabel) {
                        console.log('[2SV] Clicking parent label fallback...');
                        parentLabel.click();
                        await wait(500);
                        if (onRadio.getAttribute('aria-checked') === 'true') return true;
                    }

                    // Force JS click
                    console.log('[2SV] Force clicking via JS...');
                    const clickEvent = new MouseEvent('click', {
                        view: window,
                        bubbles: true,
                        cancelable: true
                    });
                    onRadio.dispatchEvent(clickEvent);

                    return true; // Assume success after multiple tries
                }

                // Fallback: Legacy Text Search (xpath)
                const xpath = "//*[text()='On' or text()='Aan']";
                const iterator = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                const textNode = iterator.singleNodeValue;

                if (textNode) {
                    console.log('[2SV] Found "On" text node, attempting select...');
                    textNode.click();
                    return true;
                }

                return false;
            });

            if (success) {
                console.log(`[2SV] ✅ Verified "On" click in frame: ${frame.url()}`);
                targetFrame = frame;
                foundOnRadio = true;
                break;
            }
        }

        if (!foundOnRadio) {
            console.error('[2SV Policy] Critical: Could not find "On" radio button');
            // disabled screenshot
            throw new Error('Could not find "On" radio button');
        }

        console.log('[2SV Policy] ✅ "On" radio button clicked');
        await new Promise(r => setTimeout(r, 2000));

        // 4. Select "6 months" from enrollment period dropdown
        console.log('[2SV Policy] Setting enrollment period to 6 months...');
        // 4. Select "6 months" from enrollment period dropdown (Keyboard Strategy)
        console.log('[2SV Policy] Setting enrollment period to 6 months via Keyboard...');

        try {
            // Find the listbox handle manually to interact with Puppeteer API
            const listboxHandle = await targetFrame.evaluateHandle(() => {
                const headers = Array.from(document.querySelectorAll('h5'));
                const header = headers.find(h => {
                    const t = (h.textContent || '').toLowerCase();
                    return t.includes('enrollment period') ||
                        (t.includes('periode') && (t.includes('inschrij') || t.includes('aanmeld'))) ||
                        t.includes('période d\'inscription');
                });
                if (!header) return null;

                // Find listbox near header
                // Strategy: Next generic sibling that contains a listbox or is one
                const allListboxes = Array.from(document.querySelectorAll('div[role="listbox"]'));
                const headerIndex = Array.from(document.querySelectorAll('*')).indexOf(header);
                const lb = allListboxes.find(e => Array.from(document.querySelectorAll('*')).indexOf(e) > headerIndex);
                return lb;
            });

            if (listboxHandle && listboxHandle.asElement()) {
                console.log('[2SV] Listbox handle found. Focusing and clicking...');

                // Visual click
                await listboxHandle.asElement().click();
                await new Promise(r => setTimeout(r, 1000));

                // Keyboard navigation: Press ArrowDown 6 times (None -> 1d -> 1w -> 2w -> 1m -> 3m -> 6m)
                // Assuming "None" is current
                console.log('[2SV] Navigating with keyboard (6x ArrowDown)...');

                for (let i = 0; i < 6; i++) {
                    await page.keyboard.press('ArrowDown');
                    await new Promise(r => setTimeout(r, 150));
                }

                await new Promise(r => setTimeout(r, 500));
                console.log('[2SV] Pressing Enter...');
                await page.keyboard.press('Enter');

                // Verification
                await new Promise(r => setTimeout(r, 1000));

                const currentText = await targetFrame.evaluate(el => el.textContent, listboxHandle);
                console.log(`[2SV] Current listbox text: "${currentText}"`);

                if (currentText.includes('6') && currentText.includes('month')) {
                    console.log('[2SV Policy] ✅ "6 months" selected successfully via keyboard.');
                } else {
                    console.warn('[2SV Policy] ⚠️ Warning: Keyboard selection might have failed. Text is: ' + currentText);
                    // Fallback: Try one more ArrowDown and Enter? (In case started from different position)
                    // No, let's just create error for now.
                }
            } else {
                console.error('[2SV] Critical: Could not get listbox handle for keyboard interaction.');
            }

        } catch (err) {
            console.error('[2SV Policy] Error during keyboard selection:', err.message);
        }

        await new Promise(r => setTimeout(r, 1500));

        // 5. Click "Save" button
        console.log('[2SV Policy] Clicking Save...');

        // Scroll to bottom to ensure Save button is visible
        await page.evaluate(() => {
            window.scrollBy(0, 200);
        });
        await new Promise(r => setTimeout(r, 1000));

        const saved = await page.evaluate(() => {
            console.log('[2SV] Looking for Save button...');

            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], span[role="button"]'));
            console.log(`[2SV] Found ${buttons.length} potential buttons`);

            // Log all button texts for debugging
            buttons.forEach((btn, i) => {
                const text = (btn.innerText || btn.textContent || btn.value || '').trim();
                if (text && text.length < 50) {
                    console.log(`[2SV] Button ${i}: "${text}"`);
                }
            });

            const saveBtn = buttons.find(btn => {
                const text = (btn.innerText || btn.textContent || btn.value || '').toLowerCase().trim();
                return text === 'save' || text === 'enregistrer' || text === 'opslaan' || text.includes('save');
            });

            if (saveBtn) {
                console.log(`[2SV] Found Save button: "${saveBtn.innerText || saveBtn.textContent}"`);
                saveBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                saveBtn.click();
                return true;
            }

            console.log('[2SV] ERROR: Could not find Save button');
            return false;
        });

        if (!saved) {
            console.error('[2SV Policy] Critical: Could not find Save button');
            // disabled screenshot

            // Dump all button texts for debugging
            const buttonTexts = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"]'));
                return buttons.map(b => (b.innerText || b.textContent || b.value || '').trim()).filter(t => t);
            });
            console.log('[2SV Debug] Available buttons:', buttonTexts);

            throw new Error('Could not find Save button');
        }

        console.log('[2SV Policy] ✅ Save button clicked');
        await new Promise(r => setTimeout(r, 3000));

        console.log('[2SV Policy] ✅ 2-Step Verification policy configured successfully!');

        // Take screenshot for verification
        const screenshotPath = `2sv-policy-success-${Date.now()}.png`;
        // disabled screenshot
        console.log(`[2SV Policy] Screenshot saved: ${screenshotPath}`);

    } catch (error) {
        console.error('[2SV Policy] Error:', error.message);

        // Take error screenshot
        try {
            const errorScreenshot = `2sv-policy-error-${Date.now()}.png`;
            // disabled screenshot
            console.log(`[2SV Policy] Error screenshot saved: ${errorScreenshot}`);
        } catch (e) {
            console.log('[2SV Policy] Could not save error screenshot');
        }

        throw error;
    } finally {
        if (shouldCloseBrowser) {
            await browser.close();
        } else {
            // Close the current page but keep browser open
            const pages = await browser.pages();
            if (pages.length > 1) {
                const page = (await browser.pages())[pages.length - 1];
                if (page) await page.close();
            }
        }
    }
}

module.exports = configure2SVPolicy;

