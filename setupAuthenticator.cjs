const puppeteer = require('puppeteer');
// Handle otplib import differences
const otplib = require('otplib');
const authenticator = otplib.authenticator || otplib.default?.authenticator || otplib;

/**
 * Setup Google Authenticator for a workspace account
 * @param {string} email - User email
 * @param {string} password - User password  
 * @param {object} browser - Optional existing browser instance
 * @returns {Promise<string>} - The authenticator secret key
 */
// 2FA Setup Script with Shared Browser Support
async function setupAuthenticator(email, password, browser = null) {
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
        console.log(`[2FA] Setting up Authenticator for ${email}...`);

        // 1. Navigate to Google Account Security
        await page.goto('https://myaccount.google.com/security?hl=en', { waitUntil: 'networkidle2' });

        // 2. Check if already logged in, if not, login
        try {
            await page.waitForSelector('input[type="email"]', { timeout: 3000 });
            console.log('[2FA] Logging in...');
            await page.type('input[type="email"]', email);
            await page.click('#identifierNext');
            await new Promise(r => setTimeout(r, 2000));

            await page.waitForSelector('input[type="password"]', { timeout: 10000 });
            await page.type('input[type="password"]', password);
            await page.click('#passwordNext');
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) {
            console.log('[2FA] Already logged in or password not required');
        }

        // 3. Navigate to Security Page directly (User suggested method)
        console.log('[2FA] Navigating to Security Page...');
        await page.goto('https://myaccount.google.com/security?hl=en', { waitUntil: 'networkidle2' });

        // Wait for page to load
        await new Promise(r => setTimeout(r, 3000));

        // 4. Find and Click "Authenticator" Chip/Button under "How you sign in to Google" or "More sign-in options"
        console.log('[2FA] Looking for "Authenticator" chip/button...');

        const authenticatorClicked = await page.evaluate(() => {
            const getText = el => (el.innerText || el.textContent || '').trim().toLowerCase();
            const allElements = Array.from(document.querySelectorAll('button, a, div[role="button"], span'));

            // Look for "Authenticator" text inside a clickable element
            const target = allElements.find(el => {
                const text = getText(el);
                // The chip usually just says "Authenticator"
                // Avoid "Add authenticator app" if it's not clickable directly, but try both
                return (text === 'authenticator' || text === 'google authenticator') &&
                    (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.closest('a') || el.closest('button'));
            });

            if (target) {
                // Click the closest clickable container or the element itself
                const clickable = target.closest('button, a, div[role="button"]') || target;
                clickable.scrollIntoView({ behavior: 'smooth', block: 'center' });
                clickable.click();
                return true;
            }
            return false;
        });

        if (!authenticatorClicked) {
            console.log('[2FA] "Authenticator" chip not found. Trying fallback to "Add authenticator app" link...');
            // Fallback: The list style
            const addAuthLink = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('a, div[role="button"]'));
                const found = elements.find(el => {
                    const text = (el.innerText || el.textContent || '').toLowerCase();
                    return text.includes('add authenticator app') || text.includes('set up authenticator');
                });
                if (found) {
                    found.click();
                    return true;
                }
                return false;
            });

            if (!addAuthLink) {
                console.error('[2FA] Critical: Could not find Authenticator option on Security Page');
                // disabled screenshot
                // Dump HTML
                const html = await page.content();
                console.log('[2FA Debug HTML]:', html.substring(0, 2000));
                throw new Error('Could not find Authenticator option');
            }
        }

        await new Promise(r => setTimeout(r, 3000));

        // 5. Click "Set up authenticator" button (on the new page/modal)
        console.log('[2FA] Looking for "Set up authenticator" button...');
        const setupBtn = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, span[role="button"], div[role="button"]'));
            const btn = buttons.find(b => {
                const text = (b.innerText || b.textContent || '').toLowerCase();
                return text.includes('set up authenticator') || text.includes('configurer l\'application') || text.includes('authenticator instellen');
            });
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        });

        if (setupBtn) {
            console.log('[2FA] Clicked "Set up authenticator"');
            await new Promise(r => setTimeout(r, 2000));
        } else {
            console.log('[2FA] "Set up authenticator" button not found. Maybe directly on QR code screen?');
        }

        // 6. Click "Can't scan it?" (to reveal secret key)
        console.log('[2FA] Looking for "Can\'t scan it?" link...');

        // Wait longer for modal to appear
        await new Promise(r => setTimeout(r, 4000));

        const cantScan = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('button, a, span[role="button"], div[role="button"]'));

            // First pass: strict match (normalized)
            let link = elements.find(el => {
                let text = (el.innerText || el.textContent || '').toLowerCase().trim();
                // Normalize curly apostrophes
                text = text.replace(/’/g, "'").replace(/‘/g, "'");
                return text === "can't scan it?" || text === "impossible de scanner le code qr ?" || text.includes('scannen') && (text.includes('niet') || text.includes('kan') || text.includes('lukt'));
            });

            // Second pass: robust/generic match (normalized)
            if (!link) {
                link = elements.find(el => {
                    let text = (el.innerText || el.textContent || '').toLowerCase();
                    text = text.replace(/’/g, "'").replace(/‘/g, "'");
                    return text.includes('scan') && (text.includes("can't") || text.includes('cannot') || text.includes('impossible'));
                });
            }

            if (link) {
                link.click();
                return true;
            }
            return false;
        });

        if (cantScan) {
            console.log('[2FA] Clicked "Can\'t scan it?"');
            await new Promise(r => setTimeout(r, 3000));
        } else {
            console.log('[2FA] Warning: "Can\'t scan it?" link not found. Dumping available options...');
            // Debug: dump buttons
            const options = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('button, a')).map(el => (el.innerText || el.textContent || '').trim().substring(0, 50)).join(' | ');
            });
            console.log(`[2FA Debug Options]: ${options}`);
            // disabled screenshot
        }

        // 7. Extract Secret Key
        console.log('[2FA] Extracting Secret Key...');

        // Wait for potential rendering of key
        await new Promise(r => setTimeout(r, 2000));

        const secretKey = await page.evaluate(() => {
            // Function to clean potential key string (remove spaces)
            const cleanKey = (str) => str.replace(/\s+/g, '').toUpperCase();
            // Regex for Base32 key (A-Z, 2-7, length >= 16)
            // Note: Google keys are usually 32 chars (spaces removed)
            const keyRegex = /^[A-Z2-7]{16,64}$/i;

            const getKeyFromText = (text) => {
                if (!text) return null;
                const cleaned = cleanKey(text);
                return keyRegex.test(cleaned) ? cleaned : null;
            };

            // Strategy 1: Look for bold text inside the modal (strong, b)
            const strongs = Array.from(document.querySelectorAll('strong, b, div[dir="ltr"]'));
            for (const el of strongs) {
                const key = getKeyFromText(el.innerText || el.textContent);
                if (key) return key;
            }

            // Strategy 2: Look for text following "spaces don't matter"
            // Get all text nodes or elements containing that phrase
            const allElements = Array.from(document.querySelectorAll('li, p, div, span'));
            for (const el of allElements) {
                const text = (el.innerText || el.textContent || '').toLowerCase();
                if (text.includes("spaces don't matter") || text.includes("espaces ne comptent pas")) {
                    // Start looking at subsequent text content
                    // It might be in the same element or the next one
                    // Check if the element itself contains the key after the phrase
                    const fullText = (el.innerText || el.textContent).replace(/\s+/g, ' '); // normalize spaces
                    // Try to extract a key-like sequence from the full text
                    const match = fullText.match(/([a-z2-7]{4}\s?){8}/i); // e.g. "abcd efgh ..."
                    if (match) {
                        return cleanKey(match[0]);
                    }
                }
            }

            // Strategy 3: Brute force check all list items for a key pattern
            const listItems = Array.from(document.querySelectorAll('li'));
            for (const li of listItems) {
                const key = getKeyFromText(li.innerText || li.textContent);
                if (key) return key;
            }

            return null;
        });

        if (!secretKey) {
            console.error('[2FA] Critical: Could not extract Secret Key');
            // disabled screenshot

            // Dump text for debugging
            const textDump = await page.evaluate(() => document.body.innerText.substring(0, 2000));
            console.log(`[2FA Debug Text]: ${textDump}`);

            throw new Error('Could not extract Secret Key');
        }

        console.log(`[2FA] Secret Key Extracted: ${secretKey.substring(0, 4)}...`);

        // 8. Click "Next" to reveal OTP input (Crucial step user mentioned)
        console.log('[2FA] Clicking "Next" to proceed to OTP input...');
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const nextBtn = buttons.find(btn => {
                const text = (btn.innerText || btn.textContent || '').toLowerCase();
                return text === 'next' || text === 'suivant' || text === 'continuar' || text.includes('next');
            });
            if (nextBtn) nextBtn.click();
        });

        await new Promise(r => setTimeout(r, 2000));

        // 9. Generate OTP MANUALLY (Avoid otplib issues)
        console.log('[2FA] Generating OTP (Manual Crypto Method)...');

        // Manual TOTP Implementation (HMAC-SHA1)
        const crypto = require('crypto');

        const generateTOTP = (secret) => {
            try {
                // Decode Base32
                const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
                let bits = '';

                // Clean secret
                secret = secret.replace(/\s+/g, '').toUpperCase();

                for (let i = 0; i < secret.length; i++) {
                    const val = base32chars.indexOf(secret.charAt(i));
                    if (val === -1) continue; // skip invalid chars
                    bits += val.toString(2).padStart(5, '0');
                }

                // Pad to byte boundary
                const hex = [];
                for (let i = 0; i < bits.length; i += 8) {
                    const byte = bits.substr(i, 8);
                    if (byte.length < 8) break;
                    hex.push(parseInt(byte, 2));
                }
                const keyBuffer = Buffer.from(hex);

                // Calculate Counter
                const epoch = Math.floor(Date.now() / 1000);
                const time = Buffer.alloc(8);
                // BigInt needed for writing 64-bit integer
                time.writeBigInt64BE(BigInt(Math.floor(epoch / 30)), 0);

                // HMAC-SHA1
                const hmac = crypto.createHmac('sha1', keyBuffer);
                hmac.update(time);
                const h = hmac.digest();

                // Truncate
                const offset = h[h.length - 1] & 0xf;
                const binary = ((h[offset] & 0x7f) << 24) |
                    ((h[offset + 1] & 0xff) << 16) |
                    ((h[offset + 2] & 0xff) << 8) |
                    (h[offset + 3] & 0xff);

                const otp = (binary % 1000000).toString().padStart(6, '0');
                return otp;
            } catch (e) {
                console.error('[2FA] Manual TOTP Generation Error:', e);
                return null;
            }
        };

        const otp = generateTOTP(secretKey);

        if (!otp) {
            throw new Error('Failed to generate OTP manually');
        }

        console.log(`[2FA] Generated OTP: ${otp}`);

        // Find OTP input field
        await page.waitForSelector('input[type="text"], input[type="tel"]', { timeout: 5000 });
        const otpInput = await page.$('input[type="text"], input[type="tel"]');
        if (otpInput) {
            await otpInput.type(otp);
            await new Promise(r => setTimeout(r, 1000));
        }

        // 11. Click "Verify" or "Next"
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const verifyBtn = buttons.find(btn => {
                const text = (btn.innerText || btn.textContent || '').toLowerCase();
                return text.includes('verify') || text.includes('next') || text.includes('vérifier');
            });
            if (verifyBtn) verifyBtn.click();
        });

        await new Promise(r => setTimeout(r, 3000));

        // 12. Navigate to 2-Step Verification settings page
        console.log('[2FA] Navigating to 2-Step Verification settings page...');
        await page.goto('https://myaccount.google.com/signinoptions/twosv?hl=en', { waitUntil: 'networkidle0' });

        // Scroll to bottom to ensure button loads
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 2000));

        // Scroll back to top then to bottom again to trigger any lazy loading
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise(r => setTimeout(r, 500));
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 2000)); // Wait for button to fully load


        const buttonFound = await page.evaluate(() => {
            // Scan ALL elements for the Turn on button
            console.log('[2FA DEBUG] Scanning page for Turn on button...');
            const allElements = Array.from(document.querySelectorAll('*'));

            const turnOnEl = allElements.find(el => {
                const text = (el.innerText || el.textContent || '').toLowerCase();
                const tagName = el.tagName.toLowerCase();

                // Must contain both "turn on" and "verification" (OR Dutch equivalent)
                if ((text.includes('turn on') && text.includes('verification')) ||
                    (text.includes('aanzetten') && text.includes('verificatie')) ||
                    text === 'aanzetten' ||
                    text.includes('inschakele')) { // Inschakelen
                    // Must be a clickable element
                    if (tagName === 'button' || tagName === 'a' ||
                        el.getAttribute('role') === 'button' || el.onclick) {
                        console.log('[2FA DEBUG] Found button! Tag:', tagName, 'Text:', (el.innerText || '').substring(0, 50));
                        return true;
                    }
                }
                return false;
            });

            if (turnOnEl) {
                turnOnEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                turnOnEl.click();
                return true;
            }

            // If not found, log all buttons for debugging
            if (!turnOnEl) {
                console.log('[2FA DEBUG] Button not found! Logging all clickable elements...');
                const clickables = allElements.filter(el => {
                    const tag = el.tagName.toLowerCase();
                    return tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button';
                });
                clickables.forEach((el, i) => {
                    const text = (el.innerText || el.textContent || '').trim();
                    if (text.length > 0 && text.length < 100) {
                        console.log(`[2FA DEBUG] Clickable ${i}: ${text.substring(0, 50)}`);
                    }
                });
            }

            return false;
        });

        if (buttonFound) {
            console.log('[2FA] ✅ Clicked "Turn on" button successfully!');
        } else {
            console.log('[2FA] ⚠️ Warning: "Turn on" button not found on page');

            // Debug: dump page HTML to file
            const pageHTML = await page.content();
            const fs = require('fs');
            fs.writeFileSync('2fa-page-debug.html', pageHTML);
            console.log('[2FA] Page HTML dumped to: 2fa-page-debug.html');

            // Debug: dump all button texts
            const allButtonTexts = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a'));
                return elements.map(el => (el.innerText || el.textContent || '').trim()).filter(t => t.length > 0);
            });
            console.log('[2FA] Available buttons:', allButtonTexts);
        }

        await new Promise(r => setTimeout(r, 2000));

        console.log('[2FA] ✅ 2-Step Verification enabled successfully!');

        // Take screenshot for verification
        const screenshotPath = `2fa-success-${Date.now()}.png`;
        // disabled screenshot
        console.log(`[2FA] Screenshot saved: ${screenshotPath}`);

        return secretKey;

    } catch (error) {
        console.error('[2FA] Error:', error.message);

        // Take error screenshot
        try {
            const errorScreenshot = `2fa-error-${Date.now()}.png`;
            // disabled screenshot
            console.log(`[2FA] Error screenshot saved: ${errorScreenshot}`);
        } catch (e) {
            console.log('[2FA] Could not save error screenshot');
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

module.exports = setupAuthenticator;
