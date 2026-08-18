"use strict";
const { getOTPForAccount } = require('./generateOTP.cjs');
/**
 * Universal OTP Handler - Automatically detects and fills OTP requests
 * Use this in ANY Puppeteer automation to handle OTP automatically
 *
 * @param {Page} page - Puppeteer page instance
 * @param {string} email - Email address of the account
 * @param {number} timeout - Max time to wait for OTP request (ms)
 * @returns {Promise<boolean>} - True if OTP was handled, false if no OTP requested
 */
async function handleOTPIfRequested(page, email, timeout = 10000) {
    try {
        console.log(`[Auto-OTP] Checking if OTP is requested for ${email}...`);
        // Wait for OTP input to appear (with timeout)
        const otpInput = await page.waitForSelector('input[name="totpPin"], input[type="tel"], input[placeholder*="code"], input[id*="otp"], input[id*="totp"], input[aria-label*="verification"]', { timeout: timeout }).catch(() => null);
        if (!otpInput) {
            console.log('[Auto-OTP] No OTP requested, continuing...');
            return false;
        }
        console.log('[Auto-OTP] ✓ OTP input detected!');
        console.log('[Auto-OTP] Generating OTP code...');
        // Generate OTP from saved secret key (async - fetches from SSH)
        const otp = await getOTPForAccount(email);
        console.log(`[Auto-OTP] Generated code: ${otp}`);
        // Enter OTP automatically
        await page.type('input[name="totpPin"], input[type="tel"], input[placeholder*="code"], input[id*="otp"], input[id*="totp"], input[aria-label*="verification"]', otp);
        console.log('[Auto-OTP] ✓ OTP entered automatically');
        // Wait a bit for the input to register
        await new Promise(r => setTimeout(r, 500));
        // Try to find and click Next/Submit button
        const submitted = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"]'));
            const nextBtn = buttons.find(btn => {
                const text = (btn.innerText || btn.textContent || btn.value || '').toLowerCase();
                return text.includes('next') || text.includes('submit') || text.includes('verify') ||
                    text.includes('continue') || text.includes('suivant') || text.includes('vérifier');
            });
            if (nextBtn) {
                nextBtn.click();
                return true;
            }
            return false;
        });
        if (submitted) {
            console.log('[Auto-OTP] ✓ Clicked Next/Submit button');
        }
        else {
            // If no button found, try pressing Enter
            await page.keyboard.press('Enter');
            console.log('[Auto-OTP] ✓ Pressed Enter to submit');
        }
        await new Promise(r => setTimeout(r, 2000));
        console.log('[Auto-OTP] ✅ OTP handled successfully!');
        return true;
    }
    catch (error) {
        console.error(`[Auto-OTP] Error: ${error.message}`);
        return false;
    }
}
/**
 * Enhanced login function with automatic OTP handling
 * Use this for ANY Google login that might require OTP
 *
 * @param {Page} page - Puppeteer page instance
 * @param {string} email - Email address
 * @param {string} password - Password
 * @param {string} targetUrl - Optional URL to navigate to first
 * @returns {Promise<void>}
 */
async function loginWithAutoOTP(page, email, password, targetUrl = null) {
    try {
        console.log(`[Auto-Login] Starting login for ${email}...`);
        // Navigate to URL if provided
        if (targetUrl) {
            console.log(`[Auto-Login] Navigating to ${targetUrl}...`);
            await page.goto(targetUrl, { waitUntil: 'networkidle2' });
        }
        // 1. Enter Email
        console.log('[Auto-Login] Entering email...');
        const emailInput = await page.waitForSelector('input[type="email"]', { timeout: 10000 });
        await emailInput.type(email);
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 2000));
        // 2. Enter Password
        console.log('[Auto-Login] Entering password...');
        const passwordInput = await page.waitForSelector('input[type="password"]', { timeout: 30000 });
        await passwordInput.type(password);
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3000));
        // 3. Automatically handle OTP if requested
        const otpHandled = await handleOTPIfRequested(page, email, 10000);
        if (otpHandled) {
            console.log('[Auto-Login] ✅ Login completed with OTP!');
        }
        else {
            console.log('[Auto-Login] ✅ Login completed (no OTP required)!');
        }
        // Wait for final navigation
        await new Promise(r => setTimeout(r, 3000));
    }
    catch (error) {
        console.error(`[Auto-Login] Error: ${error.message}`);
        throw error;
    }
}
/**
 * Add OTP monitoring to existing page
 * This will continuously monitor the page and auto-fill OTP if it appears
 * Useful for long-running sessions where OTP might be requested at any time
 *
 * @param {Page} page - Puppeteer page instance
 * @param {string} email - Email address
 */
async function enableAutoOTPMonitoring(page, email) {
    console.log(`[Auto-OTP Monitor] Enabled for ${email}`);
    // Set up mutation observer to detect OTP inputs
    await page.evaluateOnNewDocument((emailAddress) => {
        window.__autoOTPEmail = emailAddress;
        const observer = new MutationObserver((mutations) => {
            const otpInput = document.querySelector('input[name="totpPin"], input[type="tel"], input[placeholder*="code"], input[id*="otp"]');
            if (otpInput && !otpInput.hasAttribute('data-otp-handled')) {
                otpInput.setAttribute('data-otp-handled', 'true');
                console.log('[Auto-OTP Monitor] OTP input detected, triggering handler...');
                window.__otpDetected = true;
            }
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }, email);
    // Periodically check if OTP was detected
    const checkInterval = setInterval(async () => {
        const otpDetected = await page.evaluate(() => window.__otpDetected);
        if (otpDetected) {
            console.log('[Auto-OTP Monitor] OTP detected by monitor, handling...');
            await handleOTPIfRequested(page, email, 1000);
            await page.evaluate(() => { window.__otpDetected = false; });
        }
    }, 1000);
    // Store interval ID for cleanup
    page.__otpMonitorInterval = checkInterval;
}
/**
 * Disable OTP monitoring
 * @param {Page} page - Puppeteer page instance
 */
function disableAutoOTPMonitoring(page) {
    if (page.__otpMonitorInterval) {
        clearInterval(page.__otpMonitorInterval);
        console.log('[Auto-OTP Monitor] Disabled');
    }
}
module.exports = {
    handleOTPIfRequested,
    loginWithAutoOTP,
    enableAutoOTPMonitoring,
    disableAutoOTPMonitoring
};
