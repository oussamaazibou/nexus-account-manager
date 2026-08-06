const fs = require('fs');
const path = require('path');
const { Solver } = require('@2captcha/captcha-solver');

function getCaptchaKey() {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.captchaKey) return config.captchaKey;
        }
    } catch (e) { /* ignore */ }
    // Fall back to the 2Captcha key already used by AccountVerifier.ts
    return '4a8189e5ca7d59ebcd481b14387f58e4';
}

/**
 * Checks if a Google image captcha is visible, solves it with 2Captcha, and types the result.
 * It will also type the password if the password field is visible/enabled (Google often clears it).
 *
 * @param {object} page - Puppeteer page
 * @param {string} password - User password (required in case it needs refilling)
 * @returns {boolean} - True if captcha was solved, False if no captcha was found.
 */
async function solveGoogleLoginCaptchaIfPresent(page, password) {
    try {
        // Look for the typical Google login captcha image
        const captchaImgParams = await page.evaluate(() => {
            const img = document.querySelector('img#captchaimg') || document.querySelector('img[src*="Captcha"]');
            if (img && img.src && img.offsetHeight > 0) {
                return { found: true, id: img.id, class: img.className, src: img.src };
            }
            return { found: false };
        });

        if (!captchaImgParams || !captchaImgParams.found) {
            return false; // No captcha
        }

        console.log('[CAPTCHA] Detect image captcha challenge!');

        const apiKey = getCaptchaKey();
        if (!apiKey) {
            console.log('[CAPTCHA] ERROR: No captchaKey in config.json. Cannot solve.');
            throw new Error('No 2Captcha API key found');
        }

        const solver = new Solver(apiKey);

        // Get the base64 of the image
        console.log('[CAPTCHA] Extracting and solving image...');
        const base64Data = await page.evaluate(async (src) => {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'Anonymous';
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    resolve(canvas.toDataURL('image/png').split(',')[1]);
                };
                img.onerror = () => reject('Failed to load image');
                img.src = src;
            });
        }, captchaImgParams.src);

        const res = await solver.imageCaptcha({ body: base64Data, numeric: 0, minLen: 0, maxLen: 0 });
        const captchaText = res.data;
        console.log(`[CAPTCHA] Solver Result: ${captchaText}`);

        // Find the captcha input field
        const captchaInputStr = 'input[name="logincaptcha"], input[id="ca"], input[aria-label*="characters"], input[aria-label*="captcha"]';
        const captchaInput = await page.waitForSelector(captchaInputStr, { timeout: 3000 }).catch(() => null);

        if (captchaInput) {
            await captchaInput.click({ clickCount: 3 });
            await captchaInput.type(captchaText, { delay: 60 });
        } else {
            console.log('[CAPTCHA] Could not find the captcha text input field.');
        }

        // Usually password gets cleared when a captcha fails/appears
        const passInputStr = 'input[type="password"]';
        const passInput = await page.$(passInputStr);
        if (passInput) {
            const isVisible = await passInput.evaluate(el => el.offsetParent !== null);
            if (isVisible) {
                console.log('[CAPTCHA] Re-entering password...');
                await passInput.click({ clickCount: 3 });
                await passInput.type(password, { delay: 60 });
            }
        }

        // Click next/submit
        const clicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const next = btns.find(b => {
                const t = (b.innerText || b.textContent || '').trim().toLowerCase();
                return t === 'next' || t === 'suivant' || t === 'sign in' || t === 'se connecter';
            });
            if (next) { next.click(); return true; }
            return false;
        });

        if (!clicked) {
            await page.keyboard.press('Enter');
        }

        console.log('[CAPTCHA] Captcha submitted.');
        return true;

    } catch (err) {
        const msg = (err && err.message) ? err.message : String(err || 'Unknown captcha error');
        if (!msg.includes('Execution context was destroyed') && !msg.includes('navigat')) {
            console.log(`[CAPTCHA] Error solving captcha: ${msg}`);
        }
        // Return false to let the workflow continue (maybe it wasn't a strict blocker or will fail naturally)
        return false;
    }
}

module.exports = { solveGoogleLoginCaptchaIfPresent, getCaptchaKey };
