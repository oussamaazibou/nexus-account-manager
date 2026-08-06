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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CODES_URL = (domain) =>
    `https://workspace.google.com/u/0/getsetup/domain/verification/codes?cid=00tkujf8&domain=${encodeURIComponent(domain)}&continue_url=https%3A%2F%2Fadmin.google.com%2Fac%2Fdomains%2Fmanage%3Futm_source%3Dog_am&origin=ac_manage_domains`;

const CHECKBOX_PHRASE = 'come back here and confirm';

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

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const t = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(t)) req.abort();
        else req.continue();
    });

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    log(`[Login] Opening Google sign-in for ${email}`);
    await page.goto(
        'https://accounts.google.com/v3/signin/identifier?hl=en&flowName=GlifWebSignIn',
        { waitUntil: 'domcontentloaded', timeout: 45000 }
    );
    await sleep(1200);

    // Email
    const emailEl = await page.waitForSelector('input[type="email"], input[name="identifier"], #identifierId', { visible: true, timeout: 30000 });
    await emailEl.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await emailEl.type(email, { delay: 12 });
    await sleep(200);
    await emailEl.press('Enter').catch(() => page.keyboard.press('Enter'));
    await sleep(3000);

    // Password (may be skipped if remembered / already logged in)
    let pwEl = null;
    try {
        pwEl = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 18000 });
    } catch (e) { /* password not requested */ }

    if (pwEl) {
        await pwEl.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await pwEl.type(password, { delay: 12 });
        await sleep(200);
        await pwEl.press('Enter').catch(() => page.keyboard.press('Enter'));
        await sleep(3000);
    }

    // TOTP / Authenticator challenge
    for (let i = 0; i < 3; i++) {
        const otpInput = await page.$('input[name="totpPin"], input[id*="totp"], input[id*="otp"], input[type="tel"]').catch(() => null);
        if (!otpInput) break;
        const isTOTP = await page.evaluate(() => {
            const t = document.body.innerText.toLowerCase();
            return t.includes('google authenticator') || t.includes('get a verification code') || !!document.querySelector('input[name="totpPin"]');
        }).catch(() => false);

        if (isTOTP) {
            log(`[Login] TOTP requested for ${email}`);
            let otpCode = null;
            try {
                otpCode = await genOtp.getOTPForAccount(email);
            } catch (otpErr) {
                log(`[Login] OTP generation failed: ${otpErr.message}`);
            }
            if (otpCode) {
                const inp = await page.waitForSelector('input[name="totpPin"], input[id*="totp"], input[type="tel"]', { visible: true, timeout: 5000 }).catch(() => otpInput);
                await inp.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await inp.type(otpCode, { delay: 20 });
                await sleep(400);
                await inp.press('Enter').catch(() => page.keyboard.press('Enter'));
                await sleep(2500);
                continue;
            }
        }
        break;
    }

    try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch (e) { /* might not fire */ }
    await sleep(1500);

    const url = page.url();
    log(`[Login] After login URL: ${url}`);

    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
    if (pageText.includes("couldn't find your google account") ||
        pageText.includes("could not find your google account") ||
        pageText.includes("no google account found") ||
        pageText.includes("enter a valid email") ||
        pageText.includes("this account was recently deleted")) {
        throw new Error('ACCOUNT_NOT_FOUND');
    }
    if (pageText.includes("prove you're not a robot") || pageText.includes('enter the text you hear or see')) {
        throw new Error('CAPTCHA_BLOCKED');
    }
    if (pageText.includes('enter the code shown on your phone') || pageText.includes('phone number to verify')) {
        throw new Error('PHONE_VERIFICATION_REQUIRED');
    }

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
        const els = Array.from(document.querySelectorAll('label, div, span, li, paper-checkbox, mat-checkbox, [role="checkbox"]'));
        const candidates = els.filter(el => {
            const t = ((el.textContent || '').trim()).toLowerCase();
            return t.includes(phrase) && t.length < 500;
        });
        // Most specific (shortest text) first
        candidates.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);

        const isChecked = (el) => {
            if (el instanceof HTMLElement) {
                if (el.getAttribute('aria-checked') === 'true') return true;
                const input = el.querySelector('input[type="checkbox"]');
                if (input && input.checked) return true;
                if (el.classList.contains('is-checked') || el.classList.contains('checked')) return true;
            }
            return false;
        };

        for (const el of candidates) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (isChecked(el)) return 'already-checked';
            try {
                el.click();
            } catch (err) {
                continue;
            }
            return 'clicked-label';
        }

        // Fallback: click any visible unchecked checkbox (the codes page has few)
        const boxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
        for (const b of boxes) {
            const rect = b.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const checked = b.getAttribute('aria-checked') === 'true' || (b.checked === true);
            if (!checked) {
                try { b.click(); return 'clicked-input'; } catch (err) { continue; }
            }
        }
        return 'none';
    }, CHECKBOX_PHRASE);

    log(`[Verify] Confirm checkbox: ${action}`);
    await sleep(1200);
    return action !== 'none';
}

// ── Press the confirm / verify button ─────────────────────────────────────────
async function clickConfirmButton(page, log = () => {}) {
    const clickedText = await page.evaluate(() => {
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
        if (!btn) return null;
        const label = textOf(btn);
        try { btn.click(); return label; } catch (e) { return null; }
    });

    if (clickedText) {
        log(`[Verify] Confirm button clicked: "${clickedText}"`);
        return true;
    }
    log(`[Verify] Confirm button not found`);
    return false;
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

// ── Verify a single unverified domain on an authenticated page ────────────────
async function verifyDomainOnPage(page, domain, keyData, adminEmail, log = () => {}, shouldStop = () => false) {
    if (shouldStop()) return { domain, status: 'skipped', error: 'Stopped by user' };

    const url = CODES_URL(domain);
    log(`[Verify] Navigating to codes page for ${domain}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(4500);

    const hasControls = await page.waitForFunction(() => {
        const txt = document.body.innerText.toLowerCase();
        const hasPhrase = txt.includes('come back here and confirm') ||
                          txt.includes('verification code') ||
                          txt.includes('txt record') ||
                          txt.includes('google-site-verification');
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

    await clickConfirmCheckbox(page, log);

    const btnClicked = await clickConfirmButton(page, log);
    if (!btnClicked) {
        return { domain, status: 'error', error: 'Confirm button not found' };
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
        const page = await googleLogin(browser, email, password, log);
        log(`[Account] Logged in as ${email}`);

        for (const domain of unverifiedDomains) {
            if (shouldStop()) {
                log(`[Account] Stop requested — skipping remaining domains`);
                results.push({ domain, status: 'skipped', error: 'Stopped by user' });
                break;
            }
            const r = await verifyDomainOnPage(page, domain, keyData, adminEmail, log, shouldStop);
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
