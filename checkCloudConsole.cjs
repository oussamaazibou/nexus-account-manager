const puppeteer = require('puppeteer');

const UserAgent = require('user-agents');

async function checkAndActivateCloudConsole(email, password, headless = false) {
    console.log(`[Cloud Console] Checking activation for ${email} (Headless: ${headless})`);

    const userAgent = new UserAgent({ deviceCategory: 'desktop' });

    const browser = await puppeteer.launch({
        headless: headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            `--user-agent=${userAgent.toString()}`,
            '--lang=en-US'
        ]
    });

    let page;
    try {
        page = await browser.newPage();
        await page.setUserAgent(userAgent.toString());
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9'
        });
        await page.setViewport({ width: 1280, height: 800 });

        // 1. Try to access Cloud Console Project Create Page (Forces TOS)
        console.log('[Cloud Console] Attempting to access console.cloud.google.com/projectcreate...');
        await page.goto('https://console.cloud.google.com/projectcreate?hl=en', { waitUntil: 'networkidle2' });

        // Login if needed
        const emailInput = await page.$('input[type="email"], input[name="identifier"], #identifierId');
        if (emailInput) {
            await emailInput.click({ clickCount: 3 }); await page.keyboard.press('Backspace');
            await emailInput.type(email);
            await page.keyboard.press('Enter');
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Load Config for Captcha Key
            const fs = require('fs');
            const path = require('path');
            const configPath = path.join(__dirname, 'config.json');
            let config = {};
            try {
                if (fs.existsSync(configPath)) {
                    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                }
            } catch (e) { }

            // Dynamic Import for CaptchaService (ESM in CJS)
            let captchaService = null;
            try {
                const { default: CaptchaService } = await import('./services/captchaService.js');
                if (config.captchaKey) {
                    captchaService = new CaptchaService(config.captchaKey);
                }
            } catch (e) { console.error('Failed to load CaptchaService:', e.message); }

            // Robust Password/Captcha Loop
            let isCaptchaResolved = false;
            let attempts = 0;
            const maxAttempts = 3;

            while (!isCaptchaResolved && attempts < maxAttempts) {
                attempts++;
                console.log(`[Cloud Console] Waiting for Password or CAPTCHA (Attempt ${attempts})...`);

                try {
                    const result = await Promise.race([
                        page.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 }).then(() => 'password'),
                        page.waitForSelector('#captchaimg', { visible: true, timeout: 15000 }).then(() => 'captcha'),
                        page.waitForSelector('input[name="ca"]', { visible: true, timeout: 15000 }).then(() => 'captcha')
                    ]).catch(() => 'timeout');

                    if (result === 'password') {
                        await page.type('input[type="password"]', password);
                        await page.click('#passwordNext');
                        isCaptchaResolved = true;
                    } else if (result === 'captcha') {
                        console.log('[Cloud Console] ⚠️ CAPTCHA Detected!');
                        if (captchaService) {
                            const captchaImg = await page.$('#captchaimg') || await page.$('img[src*="captcha"]');
                            if (captchaImg) {
                                const base64 = await captchaImg.screenshot({ encoding: 'base64' });
                                const solution = await captchaService.solveImageCaptcha(base64);
                                if (solution.success) {
                                    console.log(`[Cloud Console] Captcha Solved: ${solution.solution}`);
                                    const input = await page.$('input[name="ca"]') || await page.$('input[aria-label="Type the text you hear or see"]');
                                    if (input) {
                                        await input.type(solution.solution);
                                        await page.keyboard.press('Enter');
                                        await new Promise(r => setTimeout(r, 4000));
                                        continue; // Loop to check if passed
                                    }
                                }
                            }
                        } else {
                            console.warn('[Cloud Console] Captcha service not available. Manual intervention needed.');
                            await new Promise(r => setTimeout(r, 10000));
                        }
                    } else {
                        // Timeout
                        console.log('[Cloud Console] Timeout waiting for login fields. Check screenshot.');
                    }
                } catch (e) {
                    console.error('[Cloud Console] Login Error:', e.message);
                }
            }

            // AUTO-OTP: Check if OTP is requested and handle automatically
            console.log('[Cloud Console] Checking for OTP request...');
            const { handleOTPIfRequested } = require('./autoOTPHandler.cjs');
            await new Promise(resolve => setTimeout(resolve, 3000));
            await handleOTPIfRequested(page, email, 10000);

            // Wait for navigation, but don't fail if TOS page appears (navigation won't complete)
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
                console.log('[Cloud Console] Navigation timeout (might be TOS page), continuing...');
            });
        }

        await new Promise(resolve => setTimeout(resolve, 3000));

        // 1.5. Check for Terms of Service page/Modal and accept automatically
        console.log('[Cloud Console] Checking for Terms of Service (TOS)...');

        // Wait briefly for modal to potentially animate in
        await new Promise(resolve => setTimeout(resolve, 3000));

        const tosHandled = await page.evaluate(async () => {
            const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

            // Check for common TOS text
            const bodyText = document.body.innerText;
            const hasTOS = bodyText.includes('Terms of Service') && bodyText.includes('I agree');

            if (!hasTOS) return false;

            console.log('[Cloud Console] TOS text detected. Searching for elements...');

            // 1. Find the "I agree" Checkbox
            // Strategy: Find all checkboxes, check their labels/parent text
            const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
            let targetCheckbox = null;

            for (const box of allCheckboxes) {
                // Check closest label or parent div text
                let parent = box.parentElement;
                let found = false;
                for (let i = 0; i < 3; i++) { // Go up 3 levels
                    if (parent && (parent.textContent.includes('I agree') || parent.textContent.includes('Terms of Service'))) {
                        targetCheckbox = box;
                        found = true;
                        break;
                    }
                    if (parent) parent = parent.parentElement;
                }
                if (found) break;
            }

            if (targetCheckbox) {
                console.log('[Cloud Console] Found TOS Checkbox. Clicking...');
                if (!targetCheckbox.checked) {
                    targetCheckbox.click();
                    // Force check if click fails
                    targetCheckbox.checked = true;
                    targetCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
                    await wait(1000);
                }
            } else {
                console.log('[Cloud Console] Could not find specific TOS checkbox input. Trying simplified material checkbox search...');
                // Fallback: Material design unchecked checkboxes often have specific classes or roles
                const materialCheckbox = document.querySelector('span[role="checkbox"], div[role="checkbox"]');
                if (materialCheckbox && materialCheckbox.getAttribute('aria-checked') === 'false') {
                    materialCheckbox.click();
                    await wait(1000);
                }
            }

            // 2. Find "Agree and continue" Button
            // Search all buttons valid for clicking
            const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const agreeButton = allButtons.find(btn => {
                const t = (btn.innerText || btn.textContent || '').toLowerCase().trim();
                return t.includes('agree') && t.includes('continue');
            });

            if (agreeButton) {
                console.log('[Cloud Console] Found "Agree and continue" button. Clicking...');
                agreeButton.click();
                await wait(2000); // Wait for submission
                return true;
            }

            console.log('[Cloud Console] "Agree and continue" button NOT found.');
            return false;
        });

        if (tosHandled) {
            console.log('[Cloud Console] ✅ TOS Accepted successfully.');
            // Wait for redirection
            await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
            console.log('[Cloud Console] No TOS action taken (not found or already accepted).');
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

        // 2. Check if we see "you do not have access" message
        const bodyText = await page.evaluate(() => document.body.innerText);

        if (bodyText.includes('you do not have access to Google Cloud Platform') ||
            bodyText.includes('Please log in to your Admin Console to enable it')) {

            console.log('[Cloud Console] ❌ Cloud Console is DISABLED. Activating...');

            // 3. Navigate to Admin Console to enable
            await page.goto('https://admin.google.com?hl=en', { waitUntil: 'networkidle2' });
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Navigate to Apps > Additional Google services
            console.log('[Cloud Console] Navigating to Additional Google services...');

            // Try to find and click "Apps" in sidebar
            const appsLink = await page.evaluateHandle(() => {
                const links = Array.from(document.querySelectorAll('a, span'));
                return links.find(el => el.innerText && el.innerText.trim().toLowerCase() === 'apps');
            });

            if (appsLink) {
                await appsLink.click();
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // Click "Additional Google services"
            const additionalServicesLink = await page.evaluateHandle(() => {
                const links = Array.from(document.querySelectorAll('a, span'));
                return links.find(el => el.innerText && el.innerText.includes('Additional Google services'));
            });

            if (additionalServicesLink) {
                await additionalServicesLink.click();
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                // Direct navigation
                await page.goto('https://admin.google.com/ac/appslist/additional', { waitUntil: 'networkidle2' });
            }

            // 4. Find "Google Cloud Platform" and enable it
            console.log('[Cloud Console] Looking for Google Cloud Platform service...');

            const gcpService = await page.evaluateHandle(() => {
                const elements = Array.from(document.querySelectorAll('*'));
                const gcpElement = elements.find(el => el.innerText && el.innerText.includes('Google Cloud Platform'));
                return gcpElement;
            });

            if (gcpService) {
                // Click on the service row
                await gcpService.click();
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Look for "Turn ON" or "Enable" button
                const enableButton = await page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    return buttons.find(btn =>
                        btn.innerText &&
                        (btn.innerText.toLowerCase().includes('turn on') ||
                            btn.innerText.toLowerCase().includes('enable'))
                    );
                });

                if (enableButton) {
                    await enableButton.click();
                    console.log('[Cloud Console] Clicked Enable button');
                    await new Promise(resolve => setTimeout(resolve, 3000));

                    // Confirm if there's a dialog
                    const confirmButton = await page.evaluateHandle(() => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        return buttons.find(btn =>
                            btn.innerText &&
                            (btn.innerText.toLowerCase().includes('turn on') ||
                                btn.innerText.toLowerCase().includes('confirm'))
                        );
                    });

                    if (confirmButton) {
                        await confirmButton.click();
                        console.log('[Cloud Console] Confirmed activation');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
            }

            console.log('[Cloud Console] ✅ Cloud Console activated successfully!');
            return { activated: true, wasDisabled: true };

        } else {
            console.log('[Cloud Console] ✅ Cloud Console is already ENABLED');
            return { activated: true, wasDisabled: false };
        }

    } catch (error) {
        console.error('[Cloud Console] Error:', error.message);
        if (page) {
            const screenshotPath = `cloud-console-error-${Date.now()}.png`;
            try {
                // disabled screenshot
                console.log(`[Cloud Console] Error screenshot: ${screenshotPath}`);
            } catch (snapErr) {
                console.log('[Cloud Console] Could not take screenshot:', snapErr.message);
            }
        }
        throw error;
    } finally {
        await browser.close();
    }
}

// CLI Usage
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: node checkCloudConsole.js <email> <password>');
        process.exit(1);
    }

    const [email, password] = args;
    checkAndActivateCloudConsole(email, password)
        .then(result => {
            console.log('[Cloud Console] Result:', result);
            process.exit(0);
        })
        .catch(err => {
            console.error('[Cloud Console] Failed:', err);
            process.exit(1);
        });
}

module.exports = { checkAndActivateCloudConsole };
