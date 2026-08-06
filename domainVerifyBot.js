/**
 * domainVerifyBot.js
 * Puppeteer automation: log into Google Workspace as admin, then for every
 * unverified domain open the Workspace verification codes page using the same
 * browser session (preserving cookies), tick the "Come back here and confirm…"
 * checkbox and press the confirm/verify button.
 *
 * Workspace codes URL template:
 *   https://workspace.google.com/u/0/getsetup/domain/verification/codes?cid=00tkujf8&domain={domain}&continue_url=…&origin=ac_manage_domains
 */
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { fileURLToPath } from 'url';
import genOtp from './generateOTP.cjs';
import cSolver from './captchaSolver.cjs';

const { solveGoogleLoginCaptchaIfPresent } = cSolver;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Retry-safe click+type: re-queries the selector if the node detaches mid-click
// (common under concurrency — "Node is either not clickable or not an Element").
async function safeLoginType(page, selector, text, label, log = () => {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const el = await page.waitForSelector(selector, { visible: true, timeout: 15000 }).catch(() => null);
        if (!el) {
            log(`[Login] ${label} input not found`);
            return false;
        }
        try {
            await el.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await el.type(text, { delay: 25 });
            return true;
        } catch (e) {
            log(`[Login] ${label} interaction failed (${e.message}) — retrying…`);
            await sleep(1500);
        }
    }
    return false;
}

const CODES_URL = (domain, cid = '00tkujf8') =>
    `https://workspace.google.com/u/0/getsetup/domain/verification/codes?cid=${cid}&domain=${encodeURIComponent(domain)}&continue_url=https%3A%2F%2Fadmin.google.com%2Fac%2Fdomains%2Fmanage%3Futm_source%3Dog_am&origin=ac_manage_domains`;

const CHECKBOX_PHRASE = 'come back here and confirm';

// ── Classify login failures from the visible page text ────────────────────────
function detectLoginError(text) {
    const t = (text || '').toLowerCase();
    if (t.includes("couldn't find your google account") ||
        t.includes("could not find your google account") ||
        t.includes("no google account found") ||
        t.includes('enter a valid email') ||
        t.includes('this account was recently deleted')) return 'ACCOUNT_NOT_FOUND';
    if (t.includes("prove you're not a robot") ||
        t.includes('enter the text you hear or see') ||
        t.includes('unusual traffic')) return 'CAPTCHA_BLOCKED';
    if (t.includes('wrong password') ||
        t.includes("couldn't sign you in") ||
        t.includes('incorrect password') ||
        t.includes('password is incorrect')) return 'WRONG_PASSWORD';
    if (t.includes('enter the code shown on your phone') ||
        t.includes('phone number to verify') ||
        t.includes('verify your identity with your phone')) return 'PHONE_VERIFICATION_REQUIRED';
    if (t.includes('this browser or app may not be secure') ||
        t.includes('browser or app may not be secure')) return 'UNSAFE_BROWSER';
    return null;
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
        '--window-size=1100,800',
    ];
    if (proxy) args.push(`--proxy-server=${proxy}`);
    return puppeteer.launch({
        headless: 'new',
        args,
        defaultViewport: { width: 1100, height: 800 },
    });
}

// ── Google login → returns an authenticated page (session preserved) ──────────
export async function googleLogin(browser, email, password, log = () => {}) {
    const page = await browser.newPage();

    // NOTE: no request interception here — aborting images breaks the captcha
    // image load, which 2Captcha needs to solve.

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    log(`[Login] Opening Google sign-in for ${email}`);
    await page.goto(
        'https://accounts.google.com/signin/v2/identifier?hl=en&flowName=GlifWebSignIn&flowEntry=ServiceLogin',
        { waitUntil: 'networkidle2', timeout: 60000 }
    );

    // Email
    const emailEl = await page.waitForSelector('input[type="email"], input[name="identifier"], #identifierId', { visible: true, timeout: 30000 });
    if (!emailEl) throw new Error('Email input not found');
    await safeLoginType(page, 'input[type="email"], input[name="identifier"], #identifierId', email, 'email', log);
    await sleep(400);
    await page.keyboard.press('Enter');
    await sleep(2500);

    // Race: password page / captcha / account-not-found
    const resp = await Promise.race([
        page.waitForSelector('input[type="password"]', { visible: true, timeout: 12000 }).then(() => 'password'),
        page.waitForSelector('input[name="ca"], input[aria-label*="captcha" i]', { visible: true, timeout: 12000 }).then(() => 'captcha'),
        page.waitForFunction(() => {
            const t = document.body.innerText.toLowerCase();
            return t.includes("couldn't find your google account") ||
                   t.includes('no google account found') ||
                   t.includes('this account was recently deleted');
        }, { timeout: 12000 }).then(() => 'not_found'),
    ]).catch(() => 'timeout');

    if (resp === 'not_found') throw new Error('ACCOUNT_NOT_FOUND');

    // Password (may be skipped if remembered / already logged in)
    let pwEl = resp === 'password' ? await page.$('input[type="password"]') : null;

    // Solve Google's image captcha with 2Captcha if it blocks the login
    if (resp === 'captcha' || !pwEl) {
        const hasCaptcha = await page.evaluate(() => {
            const img = document.querySelector('img#captchaimg') || document.querySelector('img[src*="Captcha"]');
            return !!(img && img.offsetHeight > 0);
        }).catch(() => false);
        if (hasCaptcha) {
            log(`[Login] CAPTCHA detected for ${email} — solving with 2Captcha…`);
            const solved = await solveGoogleLoginCaptchaIfPresent(page, password);
            log(solved ? `[Login] CAPTCHA solved and submitted` : `[Login] CAPTCHA solver did not complete`);
            await sleep(2500);
            pwEl = await page.$('input[type="password"]');
        }
    }

    if (!pwEl) pwEl = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 8000 }).catch(() => null);

    if (pwEl) {
        await safeLoginType(page, 'input[type="password"]', password, 'password', log);
        await sleep(400);
        await page.keyboard.press('Enter');
        await sleep(3500);
    } else {
        log(`[Login] No password field appeared for ${email} (${resp})`);
    }

    // Surface any error shown right after submit (solve captcha before failing)
    let bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    let err = detectLoginError(bodyText);
    if (err === 'CAPTCHA_BLOCKED') {
        log(`[Login] CAPTCHA blocked after password submit — solving with 2Captcha…`);
        await solveGoogleLoginCaptchaIfPresent(page, password);
        await sleep(3000);
        bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
        err = detectLoginError(bodyText);
    }
    if (err) throw new Error(err);

    // TOTP / Authenticator challenge
    const OTP_SELECTOR = 'input[name="totpPin"], input[id*="totp"], input[id*="otp"], input[type="tel"]';
    for (let i = 0; i < 3; i++) {
        // Wait for the input to actually render — the 2-Step page loads it
        // asynchronously, so a one-shot page.$ can miss it (LOGIN_FAILED).
        const otpInput = await page.waitForSelector(OTP_SELECTOR, { visible: true, timeout: 15000 }).catch(() => null);
        if (!otpInput) break;
        const url = page.url();
        const isTOTP = url.includes('/challenge/totp') || url.includes('/challenge/iap') || url.includes('/challenge/ipp') ||
            await page.evaluate(() => {
                const t = document.body.innerText.toLowerCase();
                return t.includes('google authenticator') || t.includes('get a verification code') || t.includes('enter your verification code');
            }).catch(() => false);
        if (!isTOTP) break;

        log(`[Login] TOTP requested for ${email}`);
        let otpCode = null;
        try {
            otpCode = await genOtp.getOTPForAccount(email);
        } catch (otpErr) {
            log(`[Login] OTP generation failed: ${otpErr.message}`);
        }
        if (otpCode) {
            await safeLoginType(page, OTP_SELECTOR, String(otpCode), 'OTP', log);
            await sleep(500);
            await page.keyboard.press('Enter');
            await sleep(3000);
        } else {
            throw new Error('TOTP_REQUIRED_NO_SECRET: account uses Google Authenticator but no OTP secret is available');
        }
    }

    // Wait for login to complete: URL must leave accounts.google.com
    let finalUrl = page.url();
    try {
        await page.waitForFunction(() => !window.location.href.includes('accounts.google.com'), { timeout: 15000 });
        finalUrl = page.url();
    } catch (e) { /* still on google */ }

    bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    err = detectLoginError(bodyText);
    if (err) throw new Error(err);

    if (finalUrl.includes('accounts.google.com')) {
        const snippet = bodyText.replace(/\n+/g, ' ').substring(0, 220);
        log(`[Login] Did not finish login. URL: ${finalUrl}. Text: ${snippet}`);
        throw new Error('LOGIN_FAILED');
    }

    log(`[Login] Logged in as ${email} (${finalUrl})`);
    return page;
}

// ── Extract the google-site-verification TXT token from the codes page ────────
async function extractTxtToken(page) {
    return await page.evaluate(() => {
        const copyEl = document.querySelector('[data-copy-value]');
        if (copyEl) {
            const v = copyEl.getAttribute('data-copy-value');
            if (v && v.includes('google-site-verification=')) return v.trim();
        }
        const strongEl = document.querySelector('strong.const-text');
        if (strongEl?.innerText && strongEl.innerText.includes('google-site-verification=')) return strongEl.innerText.trim();
        const inputs = Array.from(document.querySelectorAll('input, textarea'));
        const inp = inputs.find(i => (i.value || '').includes('google-site-verification='));
        if (inp) return inp.value.trim();
        const codeEls = Array.from(document.querySelectorAll('code, pre'));
        for (const c of codeEls) {
            const m = (c.innerText || '').match(/google-site-verification=[^ \n\t\r<"']+/);
            if (m) return m[0];
        }
        const m = document.body.innerText.match(/google-site-verification=[^ \n\t\r<"']+/);
        return m ? m[0] : null;
    }).catch(() => null);
}

// ── Best-effort Cloudflare TXT upsert (same logic as /api/manage/verify-domain) ──
async function upsertCloudflareTxt(domainName, txtToken, log = () => {}) {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (!fs.existsSync(configPath)) return false;
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const cfEmail = config.cloudflareEmail;
        const cfKey = config.cloudflareKey;
        if (!cfEmail || !cfKey) return false;

        const cfHeaders = { 'X-Auth-Email': cfEmail, 'X-Auth-Key': cfKey, 'Content-Type': 'application/json' };
        const zoneParts = domainName.split('.').slice(-2).join('.');
        const zoneRes = await axios.get(`https://api.cloudflare.com/client/v4/zones?name=${zoneParts}`, { headers: cfHeaders });
        const zoneId = zoneRes.data.result?.[0]?.id;
        if (!zoneId) {
            log(`[Verify] No Cloudflare zone found for ${domainName} (tried ${zoneParts})`);
            return false;
        }
        const txtRes = await axios.get(
            `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=TXT&name=${domainName}`,
            { headers: cfHeaders }
        );
        const existing = (txtRes.data.result || []).find(r => r.content === txtToken);
        if (existing) {
            log(`[Verify] TXT record already present for ${domainName}`);
            return true;
        }
        const old = (txtRes.data.result || []).find(r => r.content.startsWith('google-site-verification='));
        if (old) await axios.delete(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${old.id}`, { headers: cfHeaders }).catch(() => {});
        await axios.post(
            `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
            { type: 'TXT', name: domainName, content: txtToken, ttl: 1 },
            { headers: cfHeaders }
        );
        log(`[Verify] TXT record upserted in Cloudflare for ${domainName}`);
        return true;
    } catch (e) {
        log(`[Verify] Cloudflare upsert warning: ${e.message}`);
        return false;
    }
}

// ── Tick the confirmation checkbox beside the "Come back here…" text ──────────
async function clickConfirmCheckbox(page, log = () => {}) {
    const action = await page.evaluate((phrase) => {
        const isChecked = (el) => {
            if (!el) return false;
            if (el.getAttribute && el.getAttribute('aria-checked') === 'true') return true;
            const input = el.querySelector && el.querySelector('input[type="checkbox"]');
            if (input && input.checked) return true;
            return false;
        };
        // Find a real clickable checkbox control near the phrase text
        const findCheckbox = (container) => {
            let input = container.querySelector && container.querySelector('input[type="checkbox"]');
            if (input) return { type: 'input', el: input };
            let rc = container.querySelector && container.querySelector('[role="checkbox"]');
            if (rc) return { type: 'role', el: rc };
            let pc = container.querySelector && container.querySelector('paper-checkbox, mat-checkbox, material-checkbox');
            if (pc) return { type: 'host', el: pc };
            return null;
        };

        const els = Array.from(document.querySelectorAll('label, div, span, li, paper-checkbox, mat-checkbox, material-checkbox, [role="checkbox"]'));
        const candidates = els.filter(el => {
            const t = ((el.textContent || '').trim()).toLowerCase();
            return t.includes(phrase) && t.length < 500;
        });
        candidates.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);

        for (const el of candidates) {
            let cb = findCheckbox(el);
            if (!cb) {
                // the container itself may be the checkbox host
                if (el.matches && el.matches('paper-checkbox, mat-checkbox, material-checkbox, [role="checkbox"]')) cb = { type: 'host', el };
            }
            if (!cb) continue;
            if (isChecked(cb.el)) return 'already-checked';
            try {
                cb.el.click();
                return 'clicked-' + cb.type;
            } catch (e) { continue; }
        }

        // Fallback: click the first visible unchecked checkbox on the page
        const boxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
        for (const b of boxes) {
            if (b.getBoundingClientRect().width === 0) continue;
            const checked = b.getAttribute('aria-checked') === 'true' || (b.checked === true);
            if (!checked) {
                try { b.click(); return 'clicked-fallback'; } catch (e) { continue; }
            }
        }
        return 'none';
    }, CHECKBOX_PHRASE);

    log(`[Verify] Confirm checkbox: ${action}`);
    await sleep(1500);

    // Verify it actually got checked; retry via keyboard if not
    let state = await page.evaluate((phrase) => {
        const el = Array.from(document.querySelectorAll('label, div, span, li, paper-checkbox, mat-checkbox, material-checkbox, [role="checkbox"]'))
            .find(e => ((e.textContent || '').trim().toLowerCase()).includes(phrase));
        if (!el) return 'not-found';
        if (el.getAttribute && el.getAttribute('aria-checked') === 'true') return 'checked';
        const input = el.querySelector && el.querySelector('input[type="checkbox"]');
        if (input) return input.checked ? 'checked' : 'unchecked';
        return 'unknown';
    }, CHECKBOX_PHRASE).catch(() => 'error');

    if (state === 'unchecked') {
        log(`[Verify] Checkbox not checked after click — toggling via native input`);
        await page.evaluate((phrase) => {
            const el = Array.from(document.querySelectorAll('div, span, label, li'))
                .find(e => ((e.textContent || '').trim().toLowerCase()).includes(phrase));
            if (!el) return;
            const input = el.querySelector && el.querySelector('input[type="checkbox"]');
            if (input) {
                input.click();
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, CHECKBOX_PHRASE).catch(() => {});
        await sleep(1500);
        state = await page.evaluate((phrase) => {
            const el = Array.from(document.querySelectorAll('div, span, label, li, [role="checkbox"]'))
                .find(e => ((e.textContent || '').trim().toLowerCase()).includes(phrase));
            if (!el) return 'not-found';
            if (el.getAttribute && el.getAttribute('aria-checked') === 'true') return 'checked';
            const input = el.querySelector && el.querySelector('input[type="checkbox"]');
            if (input) return input.checked ? 'checked' : 'unchecked';
            return 'unknown';
        }, CHECKBOX_PHRASE).catch(() => 'error');
    }

    log(`[Verify] Checkbox final state: ${state}`);
    return state === 'checked';
}

// ── Press the confirm / verify button ─────────────────────────────────────────
async function clickConfirmButton(page, log = () => {}) {
    const info = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], paper-button, mat-button'));
        const visible = btns.filter(b => {
            try { return b.offsetParent !== null && b.getBoundingClientRect().width > 0; } catch (e) { return false; }
        });
        const textOf = (b) => (b.innerText || b.textContent || '').trim().toLowerCase();
        const pick = (keywords) => visible.find(b => {
            const t = textOf(b);
            return t && t.length < 40 && keywords.some(k => t.includes(k));
        });
        let btn = pick(['confirm', 'verify', 'check now', 'activate', 'submit', 'continue']);
        if (!btn) btn = pick(['next']);
        if (!btn) return { found: false };
        return {
            found: true,
            label: textOf(btn),
            disabled: btn.disabled === true || btn.getAttribute('aria-disabled') === 'true' || btn.hasAttribute('disabled')
        };
    }).catch(() => ({ found: false }));

    if (!info.found) {
        log(`[Verify] Confirm button not found`);
        return false;
    }
    if (info.disabled) {
        log(`[Verify] Confirm button is DISABLED ("${info.label}") — checkbox likely not registered`);
        return false;
    }

    const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], paper-button, mat-button'));
        const visible = btns.filter(b => {
            try { return b.offsetParent !== null && b.getBoundingClientRect().width > 0; } catch (e) { return false; }
        });
        const textOf = (b) => (b.innerText || b.textContent || '').trim().toLowerCase();
        const pick = (keywords) => visible.find(b => {
            const t = textOf(b);
            return t && t.length < 40 && keywords.some(k => t.includes(k));
        });
        let btn = pick(['confirm', 'verify', 'check now', 'activate', 'submit', 'continue']);
        if (!btn) btn = pick(['next']);
        if (!btn) return false;
        try { btn.click(); return true; } catch (e) { return false; }
    }).catch(() => false);

    log(`[Verify] Confirm button clicked: "${info.label}" (disabled=${info.disabled})`);
    await sleep(2000);
    const afterText = await page.evaluate(() => document.body.innerText.substring(0, 220).replace(/\n+/g, ' ')).catch(() => '');
    log(`[Verify] After confirm — page: ${afterText}`);
    return clicked;
}

// ── Poll Directory API until domain.verified === true ─────────────────────────
async function waitForDomainVerified(keyData, adminEmail, domain, timeoutMs, log = () => {}, shouldStop = () => false) {
    const { google } = await import('googleapis');
    const auth = new google.auth.JWT({
        email: keyData.client_email,
        key: keyData.private_key,
        scopes: ['https://www.googleapis.com/auth/admin.directory.domain'],
        subject: adminEmail
    });
    const admin = google.admin({ version: 'directory_v1', auth });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (shouldStop()) return false;
        try {
            const res = await admin.domains.get({ customer: 'my_customer', domainName: domain });
            if (res.data.verified) {
                log(`[Verify] ✅ ${domain} is now verified`);
                return true;
            }
        } catch (e) {
            log(`[Verify] domains.get check for ${domain}: ${e.response?.data?.error?.message || e.message}`);
        }
        await sleep(5000);
    }
    log(`[Verify] ⏳ ${domain} not yet verified after ${Math.round(timeoutMs / 1000)}s`);
    return false;
}

// ── Get the per-account cid from the Admin Console domains page ───────────────
// Opens https://admin.google.com/u/0/ac/domains/manage, presses the "Verify"
// action for the domain, and reads the `cid` from the resulting getsetup URL.
// The cid always looks like `cid=01n26agf` (starts with cid=, ends with &).
// On some accounts the Verify action opens the flow in a NEW TAB instead of
// navigating the current one — both are handled here.
async function getCidForDomain(page, domain, log = () => {}) {
    const browser = page.browser();
    const MANAGE_URL = 'https://admin.google.com/u/0/ac/domains/manage';
    log(`[Verify] Opening Admin Console domains page for ${domain}…`);
    await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(6000);

    if (page.url().includes('accounts.google.com')) {
        log(`[Verify] Admin Console bounced to login — session lost (${page.url()})`);
        return null;
    }

    // Hook popups BEFORE clicking: the verification flow may open a new tab
    const popupPromise = new Promise((resolve) => {
        const handler = async (target) => {
            if (target.type() !== 'page') return;
            const p = await target.page().catch(() => null);
            if (p) resolve(p);
        };
        browser.on('targetcreated', handler);
        setTimeout(() => { browser.off('targetcreated', handler); resolve(null); }, 25000);
    });

    const clicked = await page.evaluate((domain) => {
        const text = (el) => (el.textContent || '').trim().toLowerCase();
        const rows = Array.from(document.querySelectorAll('tr, div[role="row"], li, div.row, md-list-item, material-list-item, div[role="listitem"]'));
        const row = rows.find(r => {
            const t = text(r);
            return t.includes(domain.toLowerCase()) && (t.includes('verify') || t.includes('vérifier'));
        });
        const scope = row || document;
        const btns = Array.from(scope.querySelectorAll('button, a, [role="button"], [role="link"], paper-button, mat-button, [data-tooltip]'));
        const visible = btns.filter(b => {
            try { return b.offsetParent !== null && b.getBoundingClientRect().width > 0; } catch (e) { return false; }
        });
        const pick = visible.find(b => {
            const t = text(b);
            const tip = (b.getAttribute && b.getAttribute('data-tooltip')) || '';
            return t && t.length < 60 && (t.includes('verify') || t.includes('vérifier') || tip.toLowerCase().includes('verify'));
        });
        if (pick) { pick.click(); return { clicked: true, label: text(pick) }; }
        return { clicked: false };
    }, domain).catch(() => ({ clicked: false }));

    if (!clicked.clicked) {
        log(`[Verify] No "Verify" action found for ${domain}`);
        return null;
    }
    log(`[Verify] Clicked "${clicked.label}" for ${domain}`);

    // Wait a moment for a possible popup, else assume in-page navigation
    const popup = await Promise.race([popupPromise, sleep(2500).then(() => null)]);
    const cidPage = popup || page;
    if (popup) log(`[Verify] Verification flow opened in a new tab`);

    // Wait for the getsetup URL and extract the cid
    for (let i = 0; i < 12; i++) {
        await sleep(1000);
        const url = cidPage.url();
        const m = url.match(/[?&]cid=([A-Za-z0-9_-]+)/);
        if (m) {
            log(`[Verify] Extracted cid=${m[1]} (${url.substring(0, 110)}…)`);
            if (popup) await popup.close().catch(() => {});
            return m[1];
        }
        if (i === 11) log(`[Verify] No cid found in URL: ${url.substring(0, 160)}`);
    }
    if (popup) await popup.close().catch(() => {});
    return null;
}

// ── Verify a single unverified domain on an authenticated page ────────────────
async function verifyDomainOnPage(page, domain, keyData, adminEmail, log = () => {}, shouldStop = () => false, cid = '00tkujf8') {
    if (shouldStop()) return { domain, status: 'skipped', error: 'Stopped by user' };

    const url = CODES_URL(domain, cid);
    log(`[Verify] Navigating to codes page for ${domain}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(4500);

    const hasControls = await page.waitForFunction(() => {
        const txt = document.body.innerText.toLowerCase();
        const hasPhrase = txt.includes('come back here and confirm') ||
                          txt.includes('verification code') ||
                          txt.includes('txt record') ||
                          txt.includes('google-site-verification') ||
                          txt.includes('copy the below code') ||
                          txt.includes('add verification code') ||
                          txt.includes('domain name service');
        const hasBtn = Array.from(document.querySelectorAll('button, [role="button"]')).some(b => {
            const t = (b.innerText || '').toLowerCase();
            return (t.includes('verify') || t.includes('confirm') || t.includes('continue')) && b.offsetParent !== null;
        });
        return hasPhrase || hasBtn;
    }, { timeout: 20000 }).then(() => true).catch(() => false);

    if (!hasControls) {
        const snippet = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => '');
        log(`[Verify] No verification controls found for ${domain}. URL: ${page.url()}. Text: ${snippet.replace(/\n+/g, ' ').substring(0, 150)}`);
        return { domain, status: 'error', error: 'No verification controls found' };
    }

    // Best-effort: make sure the TXT record exists before confirming
    const token = await extractTxtToken(page);
    if (token) {
        log(`[Verify] TXT token present for ${domain}`);
        const ok = await upsertCloudflareTxt(domain, token, log);
        if (ok) await sleep(4000);
    } else {
        log(`[Verify] No TXT token extractable for ${domain} — DNS may already be configured`);
    }

    const cbOk = await clickConfirmCheckbox(page, log);
    if (!cbOk) {
        log(`[Verify] ⚠️ Checkbox could not be checked for ${domain} — confirmation may fail`);
    }

    const btnClicked = await clickConfirmButton(page, log);
    if (!btnClicked) {
        return { domain, status: 'error', error: 'Confirm button not found or disabled' };
    }

    log(`[Verify] Waiting up to 45s for ${domain} to verify…`);
    const verified = await waitForDomainVerified(keyData, adminEmail, domain, 45000, log, shouldStop);
    return {
        domain,
        status: verified ? 'verified' : 'pending',
        error: verified ? null : 'Not verified yet (may take longer than 45s)'
    };
}

// ── Main entry: verify all unverified domains for one account (one session) ──
export async function verifyUnverifiedDomains(account, opts = {}) {
    const {
        unverifiedDomains = [],
        keyData = null,
        adminEmail = account.email,
        log = () => {},
        shouldStop = () => false,
        proxy = null,
    } = opts;
    const { email, password } = account;

    const results = [];
    let browser = null;
    try {
        log(`[Account] ${email} — ${unverifiedDomains.length} unverified domain(s)`);
        if (!password) throw new Error('No password available for account');

        browser = await launchBrowser(proxy);

        // Retry the login (fresh page each attempt) — transient failures like
        // LOGIN_FAILED or detaching nodes under concurrency usually succeed on
        // a second try.
        let page = null;
        let loginErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (shouldStop()) break;
            try {
                page = await googleLogin(browser, email, password, log);
                break;
            } catch (e) {
                loginErr = e;
                log(`[Account] Login attempt ${attempt}/3 failed: ${e.message}`);
                if (attempt < 3) await sleep(6000);
            }
        }
        if (!page) throw loginErr || new Error('LOGIN_FAILED');
        log(`[Account] Logged in as ${email}`);

        // cid is per-account (constant across all of an account's domains), so
        // fetch it once and reuse — avoids re-opening the Admin Console for
        // every domain, which was the main cause of slowness.
        let cid = null;

        for (const domain of unverifiedDomains) {
            if (shouldStop()) {
                log(`[Account] Stop requested — skipping remaining domains`);
                results.push({ domain, status: 'skipped', error: 'Stopped by user' });
                break;
            }
            if (!cid) {
                // Retry the Admin Console Verify click up to 3 times before
                // giving up on this domain — the click or navigation often
                // fails transiently under concurrency, and the session is
                // still alive so a fresh reload usually succeeds.
                for (let attempt = 1; attempt <= 3; attempt++) {
                    cid = await getCidForDomain(page, domain, log);
                    if (cid) break;
                    log(`[Account] cid fetch attempt ${attempt}/3 failed for ${domain}`);
                    if (attempt < 3) await sleep(5000);
                }
                if (!cid) {
                    log(`[Account] Could not obtain cid for ${domain}`);
                    results.push({ domain, status: 'error', error: 'Could not obtain cid from Admin Console (Verify action not found or no cid in URL)' });
                    continue;
                }
            }
            let r = await verifyDomainOnPage(page, domain, keyData, adminEmail, log, shouldStop, cid);
            if (r.status === 'error' && r.error.includes('No verification controls')) {
                // Stale/wrong cid (e.g. codes page 403'd) — re-fetch once
                log(`[Account] Codes page rejected cid for ${domain} — re-fetching from Admin Console…`);
                cid = await getCidForDomain(page, domain, log);
                if (cid) r = await verifyDomainOnPage(page, domain, keyData, adminEmail, log, shouldStop, cid);
            }
            results.push(r);
        }

        await browser.close().catch(() => {});
        return { email, results };
    } catch (e) {
        if (browser) await browser.close().catch(() => {});
        log(`[Account] ${email} failed: ${e.message}`);
        return { email, results, error: e.message };
    }
}
