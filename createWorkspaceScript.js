import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import SMSService from './services/smsService.js';
// import { CountryNames, generatePhoneNumber } from "phone-number-generator-js";
const CountryNames = {
    "Aruba": "Aruba",
    "Afghanistan": "Afghanistan",
    "Angola": "Angola",
    "Albania": "Albania",
    "United_Arab_Emirates": "United Arab Emirates",
    "Argentina": "Argentina",
    "Australia": "Australia",
    "Austria": "Austria",
    "Belgium": "Belgium",
    "Brazil": "Brazil",
    "Canada": "Canada",
    "Switzerland": "Switzerland",
    "Chile": "Chile",
    "China": "China",
    "Germany": "Germany",
    "Denmark": "Denmark",
    "Algeria": "Algeria",
    "Egypt": "Egypt",
    "Spain": "Spain",
    "France": "France",
    "United_Kingdom": "United Kingdom",
    "United_States": "United States",
    "Georgia": "Georgia",
    "Greece": "Greece",
    "Hong_Kong": "Hong Kong",
    "Hungary": "Hungary",
    "Indonesia": "Indonesia",
    "India": "India",
    "Ireland": "Ireland",
    "Israel": "Israel",
    "Italy": "Italy",
    "Japan": "Japan",
    "Kazakhstan": "Kazakhstan",
    "Kenya": "Kenya",
    "Morocco": "Morocco",
    "Mexico": "Mexico",
    "Malaysia": "Malaysia",
    "Nigeria": "Nigeria",
    "Netherlands": "Netherlands",
    "Norway": "Norway",
    "New_Zealand": "New Zealand",
    "Pakistan": "Pakistan",
    "Peru": "Peru",
    "Philippines": "Philippines",
    "Poland": "Poland",
    "Portugal": "Portugal",
    "Qatar": "Qatar",
    "Romania": "Romania",
    "Russian_Federation": "Russian Federation",
    "Saudi_Arabia": "Saudi Arabia",
    "Singapore": "Singapore",
    "Thailand": "Thailand",
    "Turkey": "Turkey",
    "Taiwan": "Taiwan",
    "Ukraine": "Ukraine",
    "Viet_Nam": "Viet Nam",
    "South_Africa": "South Africa"
};

function generatePhoneNumber(options) {
    const randomDigits = (len) => {
        let res = '';
        for (let i = 0; i < len; i++) res += Math.floor(Math.random() * 10);
        return res;
    };
    
    // Simple mock generators for common countries
    const country = options.countryName;
    if (country === "United States" || country === "Canada") return `1${randomDigits(10)}`;
    if (country === "United Kingdom") return `447${randomDigits(9)}`;
    if (country === "Morocco") return `2126${randomDigits(8)}`;
    if (country === "France") return `336${randomDigits(8)}`;
    if (country === "Germany") return `4915${randomDigits(9)}`;
    
    return `1${randomDigits(9)}`; // Generic fallback
}

import UserAgent from 'user-agents';
import { fileURLToPath } from 'url';



// RESIDENTIAL PROXY CONFIGURATION
const USE_PROXY = process.env.USE_PROXY === 'true' || false;
const PROXY_HOST = process.env.PROXY_HOST || "192.155.103.209";
const PROXY_PORT = process.env.PROXY_PORT || "9000";
const PROXY_USERNAME = process.env.PROXY_USERNAME || "geonode_jRI3FdCAGk-type-datacenter-country-gb";
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || "1ce539b6-2df3-4d75-911e-554d8f1e928b";
// ========================================

// API SAVE CONFIGURATION
const API_SAVE_ENABLED = false; // Set to true to enable API saving
const API_URL = "https://your-api-endpoint.com/accounts"; // Your API endpoint
const API_REGION = "us-east-1"; // API region
// ========================================

// Test proxy connection before starting
async function testProxyConnection() {
    if (!USE_PROXY) {
        return true;
    }

    console.log("\n========================================");
    console.log("🔍 Testing Proxy Connection...");
    console.log("========================================");
    console.log(`Proxy: ${PROXY_HOST}:${PROXY_PORT}`);
    console.log(`Username: ${PROXY_USERNAME}`);

    try {
        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-spki-list'
        ];

        // Try different proxy formats
        const proxyFormats = [
            `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_HOST}:${PROXY_PORT}`,
            `socks5://${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_HOST}:${PROXY_PORT}`,
            `${PROXY_HOST}:${PROXY_PORT}` // Without auth in URL, will use authenticate()
        ];

        for (let i = 0; i < proxyFormats.length; i++) {
            const proxyFormat = proxyFormats[i];
            console.log(`\nAttempt ${i + 1}: Testing format: ${proxyFormat.includes('@') ? proxyFormat.split('@')[0].split('//')[0] + '://***:***@' + proxyFormat.split('@')[1] : proxyFormat}`);

            let browser = null;
            try {
                const args = [...launchArgs, `--proxy-server=${proxyFormat}`];

                // Window Tiling Logic
                // Assume 1920x1080 screen, 2x2 grid for 4 threads or 3x2 for 6
                // Threads are 1-indexed usually? Using loop index i+1 or passed threadId

                // Let's assume this function is for testing, so maybe just 1 window.
                // But for the main script class `CreateWorkspaceScript`:

                // ... Wait, this is `testProxyConnection`. 
                // I need to modify the main class `CreateWorkspaceScript` constructor or `run` method.
                // Let's check where `browser` is launched in the main class.

                browser = await puppeteer.launch({
                    headless: true, // Use headless for testing
                    args: args,
                    ignoreDefaultArgs: ['--enable-automation']
                });

                const page = await browser.newPage();

                // If using format without auth in URL, use authenticate()
                if (!proxyFormat.includes('@')) {
                    await page.authenticate({
                        username: PROXY_USERNAME,
                        password: PROXY_PASSWORD
                    });
                }

                // Test connection to a simple endpoint
                console.log('   Testing connection to httpbin.org...');
                const response = await page.goto('http://httpbin.org/ip', {
                    waitUntil: 'networkidle0',
                    timeout: 30000
                });

                if (response && response.ok()) {
                    const content = await page.content();
                    console.log('   ✅ Successfully connected through proxy!');

                    // Try to extract IP from response
                    const ipMatch = content.match(/"origin":\s*"([^"]+)"/);
                    if (ipMatch) {
                        console.log(`   🌍 Proxy IP: ${ipMatch[1]}`);
                    }

                    console.log("\n========================================");
                    console.log("✅ PROXY TEST PASSED");
                    console.log(`Using format: ${proxyFormat.includes('@') ? proxyFormat.split('//')[0] : 'standard with authenticate()'}`);
                    console.log("========================================\n");

                    // Store the working format
                    const result = { success: true, format: proxyFormat, useAuthenticate: !proxyFormat.includes('@') };

                    // Always close browser before returning
                    await browser.close();
                    browser = null;

                    return result;
                }

            } catch (error) {
                console.log(`   ❌ Failed: ${error.message}`);
            } finally {
                // Always close browser in finally block to ensure cleanup
                if (browser) {
                    try {
                        await browser.close();
                    } catch (closeError) {
                        // Ignore close errors
                    }
                    browser = null;
                }
            }
        }

        // If all formats failed
        console.log("\n========================================");
        console.log("❌ PROXY TEST FAILED");
        console.log("========================================");
        console.log("Unable to connect through proxy.");
        console.log("Please check:");
        console.log("1. Proxy credentials are correct");
        console.log("2. Proxy server is online");
        console.log("3. Your IP is whitelisted (if required)");
        console.log("4. Proxy protocol (HTTP/SOCKS5)");
        console.log("========================================\n");

        return { success: false };

    } catch (error) {
        console.log("\n========================================");
        console.log("❌ PROXY TEST ERROR");
        console.log("========================================");
        console.log(`Error: ${error.message}`);
        console.log("========================================\n");
        return { success: false };
    }
}

export default class Google {

    constructor(proxyConfig) {

        // SMS Service Initialization
        const SMS_API_KEY = '52f6060efdA770541bf3e867A6ccbdAb';
        this.smsService = new SMSService(SMS_API_KEY);
        this.activationId = null;

        const instituionsFile = fs.readFileSync('words.txt', 'utf-8');
        const instituions = instituionsFile.split('\n').map(name => name.trim()).filter(Boolean);

        const numberOfStudentsList = ["1 - 100", "100 - 500", "500 - 1000", "1000 - 2000", "2000 - 5000", "5000 - 10000", "10000+"];

        const educationsList = ["Higher education"]

        // Each process gets completely fresh randomization
        // This helps avoid patterns that Google might detect
        this.firstName = this.#generateRandomName();
        this.lastName = this.#generateRandomName();
        this.instituion = instituions[Math.floor(Math.random() * instituions.length)];

        // Generate random phone number (UK)
        // Format: +212 6xxx xxxxxx or +212 7xxx xxxxxx
        this.country = 'MA'; // Morocco
        this.number = this.#generateRandomPhoneNumber();

        this.total = numberOfStudentsList[Math.floor(Math.random() * numberOfStudentsList.length)];
        this.education = educationsList[Math.floor(Math.random() * educationsList.length)];
        // Randomize username to avoid patterns
        const usernameOptions = ["support"];
        this.username = usernameOptions[Math.floor(Math.random() * usernameOptions.length)];
        this.password = this.#generateRandomPassword();
        this.threadId = null;
        this.proxyConfig = proxyConfig; // Store working proxy config
    }

    async #init() {
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });

        // Window Tiling Logic
        const screenWidth = 1920;
        const screenHeight = 1080;
        const cols = 3; // 3 columns
        const rows = 2; // 2 rows (fits 6 threads nicely)
        const width = Math.floor(screenWidth / cols);
        const height = Math.floor(screenHeight / rows);

        let x = 0;
        let y = 0;

        if (this.threadId) {
            const id = parseInt(this.threadId) || 1;
            // Calculate grid position (0-indexed)
            const col = (id - 1) % cols;
            const row = Math.floor((id - 1) / cols) % rows;

            x = col * width;
            y = row * height;
        }

        // Build launch arguments with latest stealth techniques
        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            `--window-size=${width},${height}`,
            `--window-position=${x},${y}`,
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--allow-running-insecure-content',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-popup-blocking',
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-spki-list',
            '--disable-extensions',
            '--exclude-switches=enable-automation',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
            '--enable-features=NetworkService,NetworkServiceInProcess',
            '--force-color-profile=srgb',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-pings',
            '--password-store=basic',
            '--use-mock-keychain',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--mute-audio',
            '--no-first-run',
            '--safebrowsing-disable-auto-update',
            '--disable-client-side-phishing-detection',
            '--disable-component-update',
            '--disable-domain-reliability',
            '--disable-features=AudioServiceOutOfProcess',
            '--disable-features=RendererCodeIntegrity',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-ipc-flooding-protection'
        ];

        // Add proxy if enabled — either via USE_PROXY env or via proxyConfig passed directly
        if (this.proxyConfig) {
            launchArgs.push(`--proxy-server=${this.proxyConfig.format}`);
            console.log(`[Thread ${this.threadId}] 🌐 Using proxy: ${this.proxyConfig.host}:${this.proxyConfig.port}`);
        }

        this.browser = await puppeteer.launch({
            headless: true, // Set to false to see browsers (change to 'new' for headless)
            args: launchArgs,
            ignoreDefaultArgs: ['--enable-automation'],
            defaultViewport: null,
            handleSIGINT: false, // Let us handle cleanup
            handleSIGTERM: false,
            handleSIGHUP: false
        });

        // Ensure browser closes on process exit
        const cleanup = async () => {
            await this.closeBrowser();
        };
        process.once('exit', cleanup);
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);

        this.page = await this.browser.newPage();

        // Use authenticate() if needed
        if (this.proxyConfig) {
            const { user, pass } = this.proxyConfig;
            if (user && pass) {
                await this.page.authenticate({
                    username: user,
                    password: pass
                });
                console.log(`[Thread ${this.threadId}] 🔐 Proxy authenticated: ${user}`);
            }
        }

        this.agent = userAgent.toString();

        // Generate random fingerprint data once during init
        this.viewport = this.#getRandomViewport();
        this.timezone = this.#getRandomTimezone();
        this.locale = this.#getRandomLocale();
        this.platform = this.#getRandomPlatform();
        this.cores = this.#getRandomCores();
        this.memory = this.#getRandomMemory();
        this.languages = this.#getRandomLanguages();
        this.colorDepth = this.#getRandomColorDepth();
        this.pixelRatio = this.#getRandomPixelRatio();
        this.connection = this.#getRandomConnection();
        this.battery = this.#getRandomBattery();
    }

    #getRandomViewport() {
        const viewports = [
            { width: 1920, height: 1080 },
            { width: 1366, height: 768 },
            { width: 1440, height: 900 },
            { width: 1536, height: 864 },
            { width: 1280, height: 720 },
            { width: 1600, height: 900 }
        ];
        return viewports[Math.floor(Math.random() * viewports.length)];
    }

    #getRandomTimezone() {
        const timezones = [
            'America/New_York',
            'America/Chicago',
            'America/Los_Angeles',
            'America/Denver',
            'Europe/London',
            'Europe/Paris',
            'America/Toronto'
        ];
        return timezones[Math.floor(Math.random() * timezones.length)];
    }

    #getRandomLocale() {
        const locales = [
            'en-US,en;q=0.9',
            'en-GB,en;q=0.9',
            'en-CA,en;q=0.9',
            'en-US,en;q=0.9,es;q=0.8'
        ];
        return locales[Math.floor(Math.random() * locales.length)];
    }

    #getRandomPlatform() {
        const platforms = ['Win32', 'MacIntel', 'Linux x86_64'];
        return platforms[Math.floor(Math.random() * platforms.length)];
    }

    #getRandomCores() {
        return [2, 4, 6, 8, 12, 16][Math.floor(Math.random() * 6)];
    }

    #getRandomMemory() {
        return [2, 4, 8, 16][Math.floor(Math.random() * 4)];
    }

    #getRandomLanguages() {
        const languageSets = [
            ['en-US', 'en'],
            ['en-GB', 'en'],
            ['en-CA', 'en', 'fr'],
            ['en-US', 'en', 'es'],
            ['en-US', 'en', 'zh-CN']
        ];
        return languageSets[Math.floor(Math.random() * languageSets.length)];
    }

    #getRandomColorDepth() {
        return [24, 32][Math.floor(Math.random() * 2)];
    }

    #getRandomPixelRatio() {
        return [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)];
    }

    #getRandomConnection() {
        const connections = [
            { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
            { effectiveType: '4g', downlink: 5, rtt: 100, saveData: false },
            { effectiveType: '3g', downlink: 1.5, rtt: 200, saveData: false },
            { effectiveType: '4g', downlink: 8, rtt: 75, saveData: false }
        ];
        return connections[Math.floor(Math.random() * connections.length)];
    }

    #getRandomBattery() {
        return {
            charging: Math.random() > 0.5,
            chargingTime: Math.random() > 0.5 ? Infinity : Math.floor(Math.random() * 3600),
            dischargingTime: Math.floor(Math.random() * 7200) + 1800,
            level: Math.random() * 0.3 + 0.7 // 70-100%
        };
    }

    #generateRandomName() {
        const vowels = 'aeiou';
        const consonants = 'bcdfghjklmnpqrstvwxyz';
        const length = Math.floor(Math.random() * 3) + 5; // 5 to 7 characters
        let name = '';

        // Start with a capital letter
        name += consonants[Math.floor(Math.random() * consonants.length)].toUpperCase();

        for (let i = 1; i < length; i++) {
            if (i % 2 === 0) {
                // Consonant
                name += consonants[Math.floor(Math.random() * consonants.length)];
            } else {
                // Vowel
                name += vowels[Math.floor(Math.random() * vowels.length)];
            }
        }
        return name;
    }

    generateRandomSubdomain() {
        // Professional/Educational vocabulary
        const prefixes = [
            'learn', 'edu', 'study', 'school', 'campus', 'academy', 'class',
            'student', 'portal', 'online', 'digital', 'smart', 'tech', 'lab',
            'center', 'hub', 'connect', 'teach', 'train', 'course', 'program',
            'institute', 'college', 'university', 'knowledge', 'wisdom', 'bright',
            'elite', 'prime', 'top', 'best', 'global', 'world', 'future', 'next'
        ];

        const suffixes = [
            'hub', 'portal', 'zone', 'space', 'world', 'net', 'online', 'web',
            'platform', 'system', 'app', 'site', 'center', 'base', 'cloud',
            'academy', 'institute', 'school', 'campus', 'class', 'room', 'lab',
            'edu', 'learn', 'study', 'teach', 'train', 'pro', 'plus', 'max',
            'solutions', 'works', 'group', 'team', 'network'
        ];

        const adverbs = ['fast', 'pro', 'my', 'the', 'get', 'go', 'top', 'best', 'all'];

        // Randomly choose a pattern
        const pattern = Math.floor(Math.random() * 4);
        let subdomain = '';

        while (subdomain.length < 10) {
            if (pattern === 0) {
                // Pattern: prefix + suffix (e.g., learnhub)
                subdomain = `${prefixes[Math.floor(Math.random() * prefixes.length)]}${suffixes[Math.floor(Math.random() * suffixes.length)]}`;
            } else if (pattern === 1) {
                // Pattern: prefix + - + suffix (e.g., learn-hub)
                subdomain = `${prefixes[Math.floor(Math.random() * prefixes.length)]}-${suffixes[Math.floor(Math.random() * suffixes.length)]}`;
            } else if (pattern === 2) {
                // Pattern: adverb + prefix (e.g., myclass)
                subdomain = `${adverbs[Math.floor(Math.random() * adverbs.length)]}${prefixes[Math.floor(Math.random() * prefixes.length)]}`;
            } else {
                // Pattern: prefix + number (e.g., learn24)
                subdomain = `${prefixes[Math.floor(Math.random() * prefixes.length)]}${Math.floor(Math.random() * 100)}`;
            }

            // If still too short, append a random suffix or number to bulk it up
            if (subdomain.length < 10) {
                const extracheck = Math.random();
                if (extracheck > 0.5) {
                    subdomain += `-${suffixes[Math.floor(Math.random() * suffixes.length)]}`;
                } else {
                    subdomain += Math.floor(Math.random() * 1000);
                }
            }
        }

        return subdomain;
    }

    #generateRandomPhoneNumber() {
        // Generate valid Moroccan number (06xxxxxxxx or 07xxxxxxxx)
        const prefixes = ['06', '07'];
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        let number = prefix;
        for (let i = 0; i < 8; i++) {
            number += Math.floor(Math.random() * 10);
        }
        return number;
    }

    async #takeScreenshot(stepName) {
        try {
            // Check if page and browser still exist
            if (!this.page || !this.browser) {
                return; // Skip screenshot if browser is closed
            }

            // Create screenshots directory if it doesn't exist
            const screenshotsDir = './screenshots';
            if (!fs.existsSync(screenshotsDir)) {
                fs.mkdirSync(screenshotsDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `thread_${this.threadId}_${stepName}_${timestamp}.png`;
            const filepath = path.join(screenshotsDir, filename);

            await this.page.screenshot({
                path: filepath,
                fullPage: true
            });

            console.log(`[Thread ${this.threadId}] 📸 Screenshot saved: ${filename}`);
            return filepath;
        } catch (error) {
            // Silently skip screenshots if they fail - not critical
        }
    }

    async #check429Error() {
        try {
            // Check page title first (most reliable for error pages)
            const pageTitle = await this.page.title();
            if (pageTitle.includes('429') || pageTitle.toLowerCase().includes('too many requests')) {
                return true;
            }

            // Check for visible error text only (not in scripts or hidden elements)
            const has429Visible = await this.page.evaluate(() => {
                // Get only visible text from body
                const bodyText = document.body.innerText || '';

                // Check if it's specifically an error page
                // Look for "429 Too Many Requests" as a heading or prominent text
                const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
                const hasErrorHeading = headings.some(h =>
                    h.innerText.includes('429') ||
                    h.innerText.toLowerCase().includes('too many requests')
                );

                // If there's an error heading, it's definitely a 429 page
                if (hasErrorHeading) {
                    return true;
                }

                // Additional check: if page has very little content and mentions 429
                const hasMinimalContent = bodyText.length < 500; // Error pages are usually short
                const mentions429 = bodyText.includes('429') && bodyText.toLowerCase().includes('too many requests');

                if (hasMinimalContent && mentions429) {
                    return true;
                }

                // Check if the main content area exists (sign it's a real page, not error)
                const hasRealContent = document.querySelector('input[aria-label="Institution name, 128 characters maximum."]') !== null ||
                    document.querySelector('[role="combobox"]') !== null ||
                    bodyText.includes("Let's get started");

                // If it has real form content, it's not a 429 error
                if (hasRealContent) {
                    return false;
                }

                return false;
            });

            return has429Visible;

        } catch (error) {
            return false;
        }
    }

    async #setupPageSettings() {
        // Set randomized user agent
        await this.page.setUserAgent(this.agent);

        // Set viewport
        await this.page.setViewport({
            width: this.viewport.width,
            height: this.viewport.height,
            deviceScaleFactor: this.pixelRatio
        });

        // Set timezone
        try {
            await this.page.emulateTimezone(this.timezone);
        } catch (error) {
            console.log(`[Thread ${this.threadId}] ⚠️  Timezone emulation failed: ${error.message}`);
        }

        // Set locale and language via HTTP headers
        await this.page.setExtraHTTPHeaders({
            'Accept-Language': this.locale
        });

        // Use CDP to set advanced fingerprinting (with error handling)
        try {
            const client = await this.page.target().createCDPSession();

            // Override user agent and platform via CDP
            try {
                await client.send('Network.setUserAgentOverride', {
                    userAgent: this.agent,
                    acceptLanguage: this.locale,
                    platform: this.platform
                });
            } catch (error) {
                console.log(`[Thread ${this.threadId}] ⚠️  CDP UserAgent override failed: ${error.message}`);
            }

            // Set timezone via CDP
            try {
                await client.send('Emulation.setTimezoneOverride', {
                    timezoneId: this.timezone
                });
            } catch (error) {
                console.log(`[Thread ${this.threadId}] ⚠️  CDP Timezone override failed: ${error.message}`);
            }

            // Set locale via CDP
            try {
                await client.send('Emulation.setLocaleOverride', {
                    locale: this.locale.split(',')[0]
                });
            } catch (error) {
                console.log(`[Thread ${this.threadId}] ⚠️  CDP Locale override failed: ${error.message}`);
            }

            // Override geolocation
            try {
                await client.send('Emulation.setGeolocationOverride', {
                    latitude: 40.7128 + (Math.random() - 0.5) * 0.1,
                    longitude: -74.0060 + (Math.random() - 0.5) * 0.1,
                    accuracy: 100
                });
            } catch (error) {
                console.log(`[Thread ${this.threadId}] ⚠️  CDP Geolocation override failed: ${error.message}`);
            }

            await client.detach();
        } catch (error) {
            console.log(`[Thread ${this.threadId}] ⚠️  CDP session failed: ${error.message}`);
        }

        // Inject comprehensive fingerprint scripts BEFORE navigation
        await this.page.evaluateOnNewDocument((platform, cores, memory, languages, colorDepth, pixelRatio, connection, battery) => {
            try {
                // Remove webdriver property completely
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });

                // Remove webdriver from navigator prototype
                try {
                    delete navigator.__proto__.webdriver;
                } catch (e) { }

                // Override platform
                Object.defineProperty(navigator, 'platform', {
                    get: () => platform,
                    configurable: true
                });

                // Randomize hardware concurrency
                Object.defineProperty(navigator, 'hardwareConcurrency', {
                    get: () => cores,
                    configurable: true
                });

                // Randomize device memory
                Object.defineProperty(navigator, 'deviceMemory', {
                    get: () => memory,
                    configurable: true
                });

                // Override languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => languages,
                    configurable: true
                });

                // Override language
                Object.defineProperty(navigator, 'language', {
                    get: () => languages[0],
                    configurable: true
                });

                // Remove automation indicators
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

                // Enhanced Chrome runtime object
                window.navigator.chrome = {
                    runtime: {},
                    loadTimes: function () { },
                    csi: function () { },
                    app: {}
                };

                // Override permissions API (with error handling)
                try {
                    if (window.navigator.permissions && window.navigator.permissions.query) {
                        const originalQuery = window.navigator.permissions.query;
                        window.navigator.permissions.query = (parameters) => {
                            try {
                                if (parameters && parameters.name === 'notifications') {
                                    return Promise.resolve({ state: Notification.permission || 'default' });
                                }
                                return originalQuery(parameters);
                            } catch (e) {
                                return originalQuery(parameters);
                            }
                        };
                    }
                } catch (e) {
                    // Ignore permissions API errors
                }

                // Enhanced screen properties (simplified to avoid breaking)
                try {
                    const originalScreen = window.screen;
                    Object.defineProperty(window.screen, 'colorDepth', {
                        get: () => colorDepth,
                        configurable: true
                    });
                    Object.defineProperty(window.screen, 'pixelDepth', {
                        get: () => colorDepth,
                        configurable: true
                    });
                } catch (e) {
                    // Ignore screen property errors
                }

                // Device pixel ratio
                Object.defineProperty(window, 'devicePixelRatio', {
                    get: () => pixelRatio,
                    configurable: true
                });

                // Canvas fingerprint randomization (simplified to avoid breaking)
                try {
                    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
                    HTMLCanvasElement.prototype.toDataURL = function (type) {
                        const shift = Math.floor(Math.random() * 3) - 1;
                        const context = this.getContext('2d');
                        if (context && this.width > 0 && this.height > 0) {
                            try {
                                const imageData = context.getImageData(0, 0, this.width, this.height);
                                for (let i = 0; i < imageData.data.length; i += 4) {
                                    imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + shift));
                                }
                                context.putImageData(imageData, 0, 0);
                            } catch (e) {
                                // Ignore canvas errors
                            }
                        }
                        return originalToDataURL.apply(this, arguments);
                    };
                } catch (e) {
                    // Ignore canvas override errors
                }

                // Enhanced WebGL fingerprint randomization
                const getParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function (parameter) {
                    if (parameter === 37445) {
                        return 'Intel Inc.';
                    }
                    if (parameter === 37446) {
                        return 'Intel Iris OpenGL Engine';
                    }
                    if (parameter === 7936) { // VENDOR
                        return 'Intel Inc.';
                    }
                    if (parameter === 7937) { // RENDERER
                        return 'Intel Iris OpenGL Engine';
                    }
                    if (parameter === 7938) { // VERSION
                        return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
                    }
                    if (parameter === 35724) { // SHADING_LANGUAGE_VERSION
                        return 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
                    }
                    return getParameter.apply(this, arguments);
                };

                // WebGL2 fingerprint
                const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
                WebGL2RenderingContext.prototype.getParameter = function (parameter) {
                    if (parameter === 37445) {
                        return 'Intel Inc.';
                    }
                    if (parameter === 37446) {
                        return 'Intel Iris OpenGL Engine';
                    }
                    return getParameter2.apply(this, arguments);
                };

                // Enhanced Audio context fingerprint with more realistic values
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (AudioContext) {
                    const originalCreateDynamicsCompressor = AudioContext.prototype.createDynamicsCompressor;
                    AudioContext.prototype.createDynamicsCompressor = function () {
                        const compressor = originalCreateDynamicsCompressor.apply(this, arguments);
                        if (compressor.threshold) compressor.threshold.value = -50 + Math.random() * 0.1;
                        if (compressor.knee) compressor.knee.value = 40 + Math.random() * 0.1;
                        if (compressor.ratio) compressor.ratio.value = 12 + Math.random() * 0.1;
                        if (compressor.attack) compressor.attack.value = 0.003 + Math.random() * 0.0001;
                        if (compressor.release) compressor.release.value = 0.25 + Math.random() * 0.01;
                        return compressor;
                    };

                    // Add noise to audio buffer
                    const originalCreateAnalyser = AudioContext.prototype.createAnalyser;
                    AudioContext.prototype.createAnalyser = function () {
                        const analyser = originalCreateAnalyser.apply(this, arguments);
                        const originalGetFloatFrequencyData = analyser.getFloatFrequencyData;
                        analyser.getFloatFrequencyData = function (array) {
                            originalGetFloatFrequencyData.apply(this, arguments);
                            for (let i = 0; i < array.length; i++) {
                                array[i] += Math.random() * 0.0001 - 0.00005;
                            }
                        };
                        return analyser;
                    };
                }

                // Enhanced plugins with more realistic data
                let pluginsCache = null;
                let mimeTypesCache = null;

                Object.defineProperty(navigator, 'plugins', {
                    get: () => {
                        if (pluginsCache) return pluginsCache;

                        const pdfPlugin = {
                            0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
                            description: 'Portable Document Format',
                            filename: 'internal-pdf-viewer',
                            length: 1,
                            name: 'Chrome PDF Plugin'
                        };

                        const pdfViewer = {
                            0: { type: 'application/pdf', suffixes: 'pdf', description: '' },
                            description: '',
                            filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
                            length: 1,
                            name: 'Chrome PDF Viewer'
                        };

                        const naclPlugin = {
                            0: { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
                            1: { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
                            description: '',
                            filename: 'internal-nacl-plugin',
                            length: 2,
                            name: 'Native Client'
                        };

                        pluginsCache = [pdfPlugin, pdfViewer, naclPlugin];
                        pluginsCache.item = function (index) { return this[index] || null; };
                        pluginsCache.namedItem = function (name) { return this.find(p => p.name === name) || null; };
                        return pluginsCache;
                    },
                    configurable: true
                });

                // MimeTypes
                Object.defineProperty(navigator, 'mimeTypes', {
                    get: () => {
                        if (mimeTypesCache) return mimeTypesCache;

                        const plugins = navigator.plugins;
                        mimeTypesCache = [
                            { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: plugins[0] },
                            { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable', enabledPlugin: plugins[2] },
                            { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable', enabledPlugin: plugins[2] }
                        ];
                        mimeTypesCache.item = function (index) { return this[index] || null; };
                        mimeTypesCache.namedItem = function (name) { return this.find(m => m.type === name) || null; };
                        return mimeTypesCache;
                    },
                    configurable: true
                });

                // Connection API override
                if (navigator.connection || navigator.mozConnection || navigator.webkitConnection) {
                    const connectionObj = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
                    Object.defineProperty(connectionObj, 'effectiveType', {
                        get: () => connection.effectiveType,
                        configurable: true
                    });
                    Object.defineProperty(connectionObj, 'downlink', {
                        get: () => connection.downlink,
                        configurable: true
                    });
                    Object.defineProperty(connectionObj, 'rtt', {
                        get: () => connection.rtt,
                        configurable: true
                    });
                    Object.defineProperty(connectionObj, 'saveData', {
                        get: () => connection.saveData,
                        configurable: true
                    });
                }

                // Battery API override
                if (navigator.getBattery) {
                    const originalGetBattery = navigator.getBattery;
                    navigator.getBattery = function () {
                        return Promise.resolve({
                            charging: battery.charging,
                            chargingTime: battery.chargingTime,
                            dischargingTime: battery.dischargingTime,
                            level: battery.level,
                            addEventListener: function () { },
                            removeEventListener: function () { },
                            dispatchEvent: function () { return true; }
                        });
                    };
                }

                // Media devices override
                if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
                    const originalEnumerateDevices = navigator.mediaDevices.enumerateDevices;
                    navigator.mediaDevices.enumerateDevices = function () {
                        return originalEnumerateDevices.apply(this, arguments).then(devices => {
                            return devices.map(device => {
                                if (device.deviceId) {
                                    Object.defineProperty(device, 'deviceId', {
                                        get: () => device.deviceId,
                                        configurable: true
                                    });
                                }
                                return device;
                            });
                        });
                    };
                }

                // Font fingerprinting protection (simplified)
                try {
                    const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
                    const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

                    if (originalOffsetWidth && originalOffsetWidth.get) {
                        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
                            get: function () {
                                const width = originalOffsetWidth.get.call(this);
                                return width + (Math.random() * 0.1 - 0.05);
                            },
                            configurable: true
                        });
                    }

                    if (originalOffsetHeight && originalOffsetHeight.get) {
                        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
                            get: function () {
                                const height = originalOffsetHeight.get.call(this);
                                return height + (Math.random() * 0.1 - 0.05);
                            },
                            configurable: true
                        });
                    }
                } catch (e) {
                    // Ignore font fingerprinting errors
                }

                // Override toString methods to hide automation (simplified)
                try {
                    const originalToString = Function.prototype.toString;
                    Function.prototype.toString = function () {
                        try {
                            if (this === navigator.getBattery ||
                                this === navigator.permissions.query) {
                                return 'function () { [native code] }';
                            }
                            return originalToString.apply(this, arguments);
                        } catch (e) {
                            return originalToString.apply(this, arguments);
                        }
                    };
                } catch (e) {
                    // Ignore toString override errors
                }

            } catch (error) {
                // Silently catch any errors in fingerprinting to prevent breaking the page
                // Errors are caught silently to avoid breaking page functionality
            }

        }, this.platform, this.cores, this.memory, this.languages, this.colorDepth, this.pixelRatio, this.connection, this.battery);

        this.page.setDefaultTimeout(15000);
    }

    async #vistiCreatePage() {
        try {
            // Add random delay before navigation to avoid rate limiting
            const initialDelay = Math.floor(Math.random() * 3000) + 2000; // 2-5 seconds
            console.log(`[Thread ${this.threadId}] ⏳ Waiting ${(initialDelay / 1000).toFixed(1)}s before navigation...`);
            await new Promise(resolve => setTimeout(resolve, initialDelay));

            const targetUrl = "https://workspace.google.com/edu/signup/welcome?hl=en";
            console.log(`[Thread ${this.threadId}] 🌐 Navigating to: ${targetUrl}`);

            const response = await this.page.goto(targetUrl, {
                waitUntil: 'networkidle2',
                timeout: 90000
            });

            console.log(`[Thread ${this.threadId}] 📄 Navigation response received, status: ${response ? response.status() : 'unknown'}`);

            // Verify URL was actually loaded
            const currentUrl = this.page.url();
            console.log(`[Thread ${this.threadId}] 🔗 Current URL: ${currentUrl}`);

            if (!currentUrl.includes('workspace.google.com')) {
                console.log(`[Thread ${this.threadId}] ⚠️  URL mismatch! Expected workspace.google.com, got: ${currentUrl}`);
                await this.#takeScreenshot('url_mismatch');
            }

            // Check HTTP status code first
            if (response && response.status() === 429) {
                console.log(`[Thread ${this.threadId}] 🚫 HTTP 429 detected`);
                await this.#takeScreenshot('429_http_status');
                throw this.#createRateLimitError();
            }

            // Wait for page to stabilize and check if content loaded
            console.log(`[Thread ${this.threadId}] ⏳ Waiting for page to stabilize...`);
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Check if page actually loaded content
            const pageContent = await this.page.evaluate(() => {
                return document.body ? document.body.innerText : '';
            });

            console.log(`[Thread ${this.threadId}] 📝 Page content length: ${pageContent ? pageContent.length : 0} characters`);

            if (!pageContent || pageContent.length < 50) {
                console.log(`[Thread ${this.threadId}] ⚠️  Page content seems empty, waiting longer...`);
                await new Promise(resolve => setTimeout(resolve, 5000));

                // Check again
                const pageContent2 = await this.page.evaluate(() => {
                    return document.body ? document.body.innerText : '';
                });
                console.log(`[Thread ${this.threadId}] 📝 Page content after wait: ${pageContent2 ? pageContent2.length : 0} characters`);
            }

            // Check for 429 error in page content
            console.log(`[Thread ${this.threadId}] 🔍 Checking for rate limit errors...`);
            const has429 = await this.#check429Error();
            if (has429) {
                console.log(`[Thread ${this.threadId}] 🚫 Rate limit detected in page content`);
                await this.#takeScreenshot('429_rate_limit_detected');
                throw this.#createRateLimitError();
            }

            // Verify key elements are present
            console.log(`[Thread ${this.threadId}] 🔍 Checking for form elements...`);
            const hasForm = await this.page.evaluate(() => {
                return document.querySelector('input') !== null;
            });
            console.log(`[Thread ${this.threadId}] ${hasForm ? '✅' : '⚠️'} Form elements found: ${hasForm}`);

            console.log(`[Thread ${this.threadId}] ✅ Page loaded successfully`);

        } catch (error) {
            // Check if it's already a rate limit error
            if (error.isRateLimit) {
                throw error;
            }

            console.log(`[Thread ${this.threadId}] ❌ Navigation error: ${error.message}`);

            // Take screenshot on error
            await this.#takeScreenshot('navigation_error');

            // Check for 429 in error message
            if (error.message && (error.message.includes('429') || error.message.includes('Too Many Requests'))) {
                throw this.#createRateLimitError();
            }

            // Check for timeout errors
            if (error.message && error.message.includes('timeout')) {
                console.log(`[Thread ${this.threadId}] ⚠️  Page load timeout - page may still be loading`);
                const currentUrl = await this.page.url().catch(() => 'unknown');
                console.log(`[Thread ${this.threadId}] 🔗 URL at timeout: ${currentUrl}`);
            }

            throw error;
        }
    }

    #createRateLimitError() {
        console.log("\n========================================");
        console.log("🚫 RATE LIMIT DETECTED (429 Error)");
        console.log("========================================");
        console.log("Your IP has been blocked by Google.");
        if (USE_PROXY) {
            console.log("Proxy will rotate IP automatically on next request.");
        } else {
            console.log("Please change your IP address and restart.");
        }
        console.log("========================================\n");

        const rateLimitError = new Error('RATE_LIMIT_HIT');
        rateLimitError.isRateLimit = true;
        return rateLimitError;
    }

    async #selectTotalOfStudents() {
        await this.page.waitForSelector('span', { timeout: 10000 });
        const buttons = await this.page.$$('span');
        for (const button of buttons) {
            try {
                const text = await button.evaluate(el => el ? el.textContent : '');
                if (text && text.includes(this.total)) {
                    await button.click();
                    break;
                }
            } catch (error) {
                continue;
            }
        }

        try {
            await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
        } catch (error) { }
    }

    async #handleNext() {
        await this.page.waitForSelector('span', { timeout: 10000 });
        const buttons = await this.page.$$('span');
        for (const button of buttons) {
            try {
                const text = await button.evaluate(el => el ? el.textContent : '');
                if (text && text.includes("Next")) {
                    try {
                        await this.#humanLikeMouseMove(button);
                        await this.#humanLikeDelay(50, 150);
                        await button.click({ delay: Math.random() * 50 + 50 });
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }

        try {
            await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
        } catch (error) { }
    }

    async #handleAgree() {
        await this.page.waitForSelector('span', { timeout: 10000 });
        const buttons = await this.page.$$('span');
        for (const button of buttons) {
            try {
                const text = await button.evaluate(el => el ? el.textContent : '');
                if (text && text.includes("I Agree")) {
                    try {
                        await this.#humanLikeMouseMove(button);
                        await this.#humanLikeDelay(50, 150);
                        await button.click({ delay: Math.random() * 50 + 50 });
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }

        try {
            await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
        } catch (error) { }
    }

    async #handleAgreeAndContinue() {
        await this.page.waitForSelector('button', { timeout: 10000 });
        const buttons = await this.page.$$('button');
        for (const button of buttons) {
            try {
                const text = await button.evaluate(el => el ? el.textContent : '');
                if (text && text.includes("Agree and continue")) {
                    try {
                        await this.#humanLikeMouseMove(button);
                        await this.#humanLikeDelay(50, 150);
                        await button.click({ delay: Math.random() * 50 + 50 });
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }

        try {
            await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
        } catch (error) { }
    }

    async #humanLikeDelay(min = 50, max = 200) {
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    async #humanLikeMouseMove(element) {
        const box = await element.boundingBox();
        if (!box) return;

        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;

        // Move mouse in a slight curve
        const steps = 10;
        for (let i = 0; i <= steps; i++) {
            const progress = i / steps;
            const curveX = x + (Math.random() - 0.5) * 5;
            const curveY = y + (Math.random() - 0.5) * 5;
            await this.page.mouse.move(curveX, curveY, { steps: 1 });
            await this.#humanLikeDelay(10, 30);
        }
    }

    async #humanLikeType(element, text, delayMin = 80, delayMax = 150) {
        await element.click({ delay: Math.random() * 50 + 50 });
        await this.#humanLikeDelay(100, 200);

        for (const char of text) {
            await element.type(char, { delay: Math.random() * (delayMax - delayMin) + delayMin });
            // Occasionally add longer pauses (like thinking)
            if (Math.random() < 0.1) {
                await this.#humanLikeDelay(200, 500);
            }
        }
    }

    async #handleFirstNameInputClick() {
        await this.page.waitForSelector('span', { timeout: 10000 });
        const buttons = await this.page.$$('span');
        for (const button of buttons) {
            try {
                const text = await button.evaluate(el => el ? el.textContent : '');
                if (text && text.includes("First name")) {
                    try {
                        await this.#humanLikeMouseMove(button);
                        await this.#humanLikeDelay(50, 150);
                        await button.click({ delay: Math.random() * 50 + 50 });
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }

        try {
            await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
        } catch (error) { }
    }

    async #handleLastNameInputClick() {
        await this.page.waitForSelector('span', { timeout: 10000 });
        const buttons = await this.page.$$('span');
        for (const button of buttons) {
            try {
                const text = await button.evaluate(el => el ? el.textContent : '');
                if (text && text.includes("Last name")) {
                    try {
                        await button.click();
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }

        try {
            await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
        } catch (error) { }
    }

    async #handleClickingOkeyIgotIt() {
        try {
            await this.page.waitForSelector('button', { timeout: 5000 });
            const buttons = await this.page.$$('button');
            for (const button of buttons) {
                try {
                    const text = await button.evaluate(el => el ? el.textContent : '');
                    if (text && (text.includes("OK, got it") || text.includes("Agree"))) {
                        try {
                            await button.click();
                            await new Promise(resolve => setTimeout(resolve, 3000));
                            break;
                        } catch (error) {
                            continue;
                        }
                    }
                } catch (error) {
                    continue;
                }
            }
        } catch (error) { }

        try {
            await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
        } catch (error) { }
    }

    async #handleDomainInputClick() {
        await this.page.waitForSelector('span', { timeout: 10000 });
        const buttons = await this.page.$$('span');
        for (const button of buttons) {
            try {
                const text = await button.evaluate(el => el ? el.textContent : '');
                if (text && text.includes("Your domain name")) {
                    try {
                        await button.click();
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }

        try {
            await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
        } catch (error) { }
    }

    async #handleYesIhaveDomain() {
        await this.page.waitForSelector('span', { timeout: 10000 });
        const buttons = await this.page.$$('span');
        for (const button of buttons) {
            try {
                const text = await button.evaluate(el => el ? el.textContent : '');
                if (text && text.includes("Yes, I have one I can use")) {
                    try {
                        await button.click();
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }

        try {
            await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
        } catch (error) { }
    }

    async #selectRegion() {
        const element = await this.page.$('div[role="combobox"][aria-labelledby="ucc-6"]');
        if (!element) {
            throw new Error('Region combobox not found');
        }

        const selectedValue = await element.evaluate(el => el ? el.textContent.trim() : '');

        if (!selectedValue) {
            throw new Error('Could not get region value');
        }

        const cleaned = selectedValue.replace(/(Region)+/, '').trim().replace(" ", "_");

        // Dynamic country detection
        const keys = Object.keys(CountryNames);
        const key = keys.find((country) => {
            return country.includes(cleaned);
        });

        if (key) {
            this.country = CountryNames[key];
            console.log(`[Thread ${this.threadId}] 🌍 Detected Country: ${this.country}`);
            // Generate number for detected country
            this.number = this.#generateValidMobileNumber(this.country);
        } else {
            console.log(`[Thread ${this.threadId}] ⚠️  Country not found for region: ${cleaned}, defaulting to US`);
            this.country = "United States";
            this.number = this.#generateValidMobileNumber(this.country);
        }

        // Format phone number properly for Google's input
        // Remove any non-digit characters and ensure proper length
        this.number = this.number.replace(/\D/g, ''); // Remove non-digits

        // Special handling for some countries if needed, but usually raw digits work best
        // Google will format it automatically

        await new Promise(resolve => setTimeout(resolve, 500));
    }

    async #formatPhoneNumberForInput(phoneNumber, country) {
        // Remove all non-digits first
        let digits = phoneNumber.replace(/\D/g, '');
        return digits;
    }

    // Custom mobile number generator for specific countries where the library fails
    #generateValidMobileNumber(countryName) {
        // Helper for random digits
        const randomDigits = (length) => {
            let result = '';
            for (let i = 0; i < length; i++) {
                result += Math.floor(Math.random() * 10);
            }
            return result;
        };

        if (countryName === "Bulgaria") {
            // Bulgaria mobile: 087, 088, 089 + 7 digits (Total 10 digits with leading 0, or 9 significant digits)
            // Google expects the significant digits usually if country code is pre-filled (+359)
            // Valid prefixes: 87, 88, 89, 98 (some virtuals)
            const prefixes = ['87', '88', '89', '98'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }

        if (countryName === "Morocco") {
            // Morocco mobile: 06 or 07 + 8 digits
            const prefixes = ['6', '7'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(8)}`;
        }

        if (countryName === "United States") {
            // US: Area code + 7 digits. Avoid 555.
            const areaCode = Math.floor(Math.random() * 800) + 200; // 200-999
            return `${areaCode}${randomDigits(7)}`;
        }

        // Europe
        if (countryName === "United Kingdom") {
            // UK mobile: 07xxx xxxxxx (10 digits excluding leading 0)
            const prefixes = ['7'];
            return `7${randomDigits(9)}`;
        }
        if (countryName === "Germany") {
            // Germany mobile prefixes: 15, 16, 17 (+ 8-9 digits total? Usually 10-11 digits excluding 0? No, +49 1xx xxxxxxx)
            // Mobile (11 digits total usually): 015x, 016x, 017x
            // Google expects digits after +49.
            // E.g. 176 12345678 (10-11 digits)
            const prefixes = ['15', '16', '17'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(8)}`;
        }
        if (countryName === "France") {
            // France mobile: 06, 07 (+ 8 digits) -> 9 digits total
            const prefixes = ['6', '7'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(8)}`;
        }
        if (countryName === "Spain") {
            // Spain mobile: 6, 7 (+ 8 digits) -> 9 digits total
            const prefixes = ['6', '7'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(8)}`;
        }
        if (countryName === "Italy") {
            // Italy mobile: 3xx (+ 6-7 digits) -> 9-10 digits total. Usually 10.
            return `3${randomDigits(9)}`;
        }
        if (countryName === "Netherlands") {
            // Netherlands mobile: 06 (+ 8 digits) -> 9 digits total
            return `6${randomDigits(8)}`;
        }
        if (countryName === "Poland") { // +48 9 digits
            const prefixes = ['5', '6', '7', '8'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(8)}`;
        }
        if (countryName === "Romania") { // +40 7xx xxx xxx (9 digits)
            return `7${randomDigits(8)}`;
        }
        if (countryName === "Belgium") {
            // Belgium mobile: 04xx xxx xxx (9 digits excluding 0)
            // +32 4xx xxx xxx
            const prefixes = ['70', '71', '72', '73', '74', '75', '76', '77', '78', '79'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `4${prefix}${randomDigits(6)}`;
        }
        if (countryName === "Estonia") {
            // Estonia mobile: 5xxx xxxx or 8xxx xxxx (7-8 digits)
            // +372 5xxx xxxx
            const prefixes = ['5', '8'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }
        if (countryName === "Czech Republic") {
            // Czech mobile: 6xx xxx xxx or 7xx xxx xxx (9 digits)
            // +420 xxx xxx xxx
            const prefixes = ['60', '70', '72', '73', '77'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }
        if (countryName === "Slovakia") {
            // Slovakia mobile: 9xx xxx xxx (9 digits)
            // +421 9xx xxx xxx
            return `9${randomDigits(8)}`;
        }
        if (countryName === "Hungary") {
            // Hungary mobile: 20, 30, 31, 50, 70 (+ 7 digits) = 9 digits
            // +36 xx xxx xxxx
            const prefixes = ['20', '30', '31', '50', '70'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }
        if (countryName === "Croatia") {
            // Croatia mobile: 9x xxx xxxx (9 digits)
            // +385 9x xxx xxxx
            const prefixes = ['91', '92', '95', '97', '98', '99'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }
        if (countryName === "Slovenia") {
            // Slovenia mobile: 3x, 4x, 5x, 6x (+ 6 digits) = 8 digits
            // +386 xx xxx xxx
            const prefixes = ['30', '31', '40', '41', '51', '64', '65', '68', '69', '70', '71'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(6)}`;
        }
        if (countryName === "Lithuania") {
            // Lithuania mobile: 6xx xxxxx (8 digits)
            // +370 6xx xxxxx
            return `6${randomDigits(7)}`;
        }
        if (countryName === "Latvia") {
            // Latvia mobile: 2xxx xxxx (8 digits)
            // +371 2xxx xxxx
            return `2${randomDigits(7)}`;
        }
        if (countryName === "Greece") {
            // Greece mobile: 69x xxx xxxx (10 digits)
            // +30 69x xxx xxxx
            const prefixes = ['693', '694', '695', '696', '697', '698', '699'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }
        if (countryName === "Portugal") {
            // Portugal mobile: 9x xxx xxxx (9 digits)
            // +351 9x xxx xxxx
            const prefixes = ['91', '92', '93', '96'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }
        if (countryName === "Austria") {
            // Austria mobile: 6xx xxxxxxx (10-11 digits excluding 0)
            // +43 6xx xxxxxxx
            const prefixes = ['650', '660', '664', '676', '680', '699'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }
        if (countryName === "Switzerland") {
            // Switzerland mobile: 7x xxx xx xx (9 digits)
            // +41 7x xxx xx xx
            const prefixes = ['74', '75', '76', '77', '78', '79'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }
        if (countryName === "Denmark") {
            // Denmark mobile: xxxx xxxx (8 digits, no specific prefix)
            // +45 xxxx xxxx
            // Common mobile prefixes: 2, 3, 4, 5, 6, 7, 8, 9
            const firstDigit = Math.floor(Math.random() * 8) + 2; // 2-9
            return `${firstDigit}${randomDigits(7)}`;
        }
        if (countryName === "Sweden") {
            // Sweden mobile: 7x xxx xx xx (9 digits)
            // +46 7x xxx xx xx
            const prefixes = ['70', '72', '73', '76', '79'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }
        if (countryName === "Norway") {
            // Norway mobile: 4xx xx xxx or 9xx xx xxx (8 digits)
            // +47 xxx xx xxx
            const prefixes = ['4', '9'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }
        if (countryName === "Finland") {
            // Finland mobile: 4x xxx xxxx or 50 xxx xxxx (9-10 digits)
            // +358 4x xxx xxxx
            const prefixes = ['40', '41', '42', '43', '44', '45', '46', '50'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }
        if (countryName === "Ireland") {
            // Ireland mobile: 8x xxx xxxx (9 digits)
            // +353 8x xxx xxxx
            const prefixes = ['83', '85', '86', '87', '88', '89'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }


        // Oceania
        if (countryName === "Australia") {
            // Australia mobile: 04xx xxx xxx (9 digits excluding 0)
            return `4${randomDigits(8)}`;
        }
        if (countryName === "New Zealand") {
            // NZ mobile: 02x (+ 6-8 digits) -> 8-10 digits excluding 0.
            // Common: 021, 022, 027
            // Format +64 2x xxx xxxx
            const prefixes = ['21', '22', '27'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`;
        }

        // Asia
        if (countryName === "India") {
            // India mobile: 6-9 (+ 9 digits) -> 10 digits
            const prefixes = ['6', '7', '8', '9'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(9)}`;
        }
        if (countryName === "China") {
            // China mobile: 1 (+ 10 digits) -> 11 digits
            return `1${randomDigits(10)}`;
        }
        if (countryName === "Japan") {
            // Japan mobile: 070, 080, 090 (+ 8 digits) -> 10 digits excluding 0?
            // +81 70 xxxx xxxx (10 digits)
            const prefixes = ['70', '80', '90'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(8)}`;
        }
        if (countryName === "Indonesia") {
            // Indonesia mobile: 8xx (+ 7-9 digits?) -> 10-12 digits usually
            return `8${randomDigits(10)}`;
        }
        if (countryName === "Vietnam") {
            // Vietnam mobile: 3, 5, 7, 8, 9 (+ 8 digits) -> 9 digits
            const prefixes = ['3', '5', '7', '8', '9'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(8)}`;
        }
        if (countryName === "Philippines") {
            // Philippines mobile: 9xx (+ 7 digits) -> 10 digits
            return `9${randomDigits(9)}`;
        }
        if (countryName === "Thailand") {
            // Thailand mobile: 6, 8, 9 (+ 8 digits) -> 9 digits
            const prefixes = ['6', '8', '9'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(8)}`;
        }
        if (countryName === "Turkey") {
            // Turkey mobile: 5xx (+ 7 digits) -> 10 digits
            const prefixes = ['50', '53', '54', '55'];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            return `${prefix}${randomDigits(7)}`; // 5xx + 7 = 10 digits
        }

        // Fallback to local generator
        try {
            return generatePhoneNumber({ countryName: countryName, withoutCountryCode: true }).replace(/\D/g, '');
        } catch (e) {
            // Last resort fallback
            const randomDigits = (len) => {
                let res = '';
                for (let i = 0; i < len; i++) res += Math.floor(Math.random() * 10);
                return res;
            };
            return `1${randomDigits(9)}`; 
        }
    }

    // Helper to generate a new number for the current country
    async #regeneratePhoneNumber() {
        if (this.country) {
            this.number = this.#generateValidMobileNumber(this.country);
            console.log(`[Thread ${this.threadId}] 🔄 Generated new number for ${this.country}: ${this.number}`);
        }
    }

    async #waitForSelectorWithRetry(selector, options = {}) {
        const maxRetries = 3;
        const timeout = options.timeout || 15000;

        for (let i = 0; i < maxRetries; i++) {
            try {
                await this.page.waitForSelector(selector, { timeout: timeout / maxRetries, visible: true });
                return await this.page.$(selector);
            } catch (error) {
                if (i === maxRetries - 1) {
                    // Try alternative selectors
                    const alternatives = options.alternatives || [];
                    for (const altSelector of alternatives) {
                        try {
                            await this.page.waitForSelector(altSelector, { timeout: 2000, visible: true });
                            return await this.page.$(altSelector);
                        } catch (e) {
                            continue;
                        }
                    }
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    async #verifyInputFilled(selector, expectedValue, alternatives = []) {
        // Wait a bit for input to be filled
        await new Promise(resolve => setTimeout(resolve, 500));

        const value = await this.page.evaluate((sel, alt) => {
            const input = document.querySelector(sel) ||
                (alt.length > 0 ? document.querySelector(alt[0]) : null);
            if (input) {
                return input.value || input.textContent || '';
            }
            return null;
        }, selector, alternatives);

        if (!value || value.length === 0) {
            console.log(`[Thread ${this.threadId}] ⚠️  Input verification failed for ${selector}`);
            return false;
        }

        // Check if value matches (allowing for formatting differences)
        const normalizedValue = value.replace(/\s|-|\(|\)/g, '');
        const normalizedExpected = expectedValue.replace(/\s|-|\(|\)/g, '');

        if (normalizedValue.includes(normalizedExpected) || normalizedExpected.includes(normalizedValue)) {
            return true;
        }

        console.log(`[Thread ${this.threadId}] ⚠️  Input value mismatch. Expected: ${expectedValue}, Got: ${value}`);
        return false;
    }

    async #checkSuccess() {
        try {
            const is_signin = await this.page.evaluate(() => {
                return document.body.textContent.includes('Sign in')
            });
            return is_signin;
        } catch (error) {
            return false;
        }
    }

    async #checkAntiSpamError() {
        try {
            const hasError = await this.page.evaluate(() => {
                const bodyText = document.body ? document.body.textContent : '';
                const pageTitle = document.title || '';

                // Check for anti-spam error messages
                const errorIndicators = [
                    "Sorry, we can't complete your signup",
                    "can't complete your signup",
                    "prevent spammers from using Google Workspace",
                    "refuses to create domains",
                    "Google Security Checklist",
                    "limit",
                    "blocked"
                ];

                // Check if any error indicator is present
                const hasErrorText = errorIndicators.some(indicator =>
                    bodyText.includes(indicator) || pageTitle.includes(indicator)
                );

                // Also check URL for error patterns
                const url = window.location.href || '';
                const hasErrorUrl = url.includes('error') || url.includes('blocked') || url.includes('denied');

                return hasErrorText || hasErrorUrl;
            });

            return hasError;
        } catch (error) {
            return false;
        }
    }


    #generateRandomPassword(length = 12) {
        const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const lower = 'abcdefghijklmnopqrstuvwxyz';
        const numbers = '0123456789';

        const allChars = upper + lower + numbers;

        let password = '';
        for (let i = 0; i < length; i++) {
            const randIndex = Math.floor(Math.random() * allChars.length);
            password += allChars[randIndex];
        }

        return password;
    }

    async #saveToAPI(email, password) {
        if (!API_SAVE_ENABLED) {
            return; // Skip if API saving is disabled
        }

        try {
            await axios.post(`${API_URL}api/create-workspace-account`, {
                email: email,
                password: password,
                region: API_REGION
            });
            console.log(`[Thread ${this.threadId}] 📤 Saved to API`);
        } catch (error) {
            console.log(`[Thread ${this.threadId}] ⚠️  API save failed: ${error.message}`);
        }
    }

    async closeBrowser() {
        if (this.browser) {
            try {
                // Get all pages and close them first
                const pages = await this.browser.pages();
                await Promise.all(pages.map(page => page.close().catch(() => { })));

                // Close browser with timeout
                await Promise.race([
                    this.browser.close(),
                    new Promise((resolve) => setTimeout(resolve, 5000)) // 5 second timeout
                ]);
            } catch (error) {
                // Force kill if normal close fails
                try {
                    if (this.browser.process()) {
                        this.browser.process().kill('SIGKILL');
                    }
                } catch (killError) {
                    // Ignore kill errors
                }
            }
            this.browser = null;
            this.page = null;
        }
    }

    async createAccount(domain, threadId) {
        this.threadId = threadId;

        // Generate random subdomain for the domain
        const subdomain = this.generateRandomSubdomain();
        const fullDomain = `${subdomain}.${domain}`;

        // OLD CODE - Use main domain directly (no subdomain)
        // const fullDomain = domain;

        console.log(`[Thread ${threadId}] Processing: ${fullDomain}`);
        console.log(`[Thread ${threadId}] 👤 Generated Name: ${this.firstName} ${this.lastName}`);
        console.log(`[Thread ${threadId}] 🔗 Subdomain Length: ${subdomain.length} chars (Subdomain: ${subdomain})`);

        let errorOccurred = false;
        let errorToThrow = null;

        try {
            console.log(`[Thread ${threadId}] 🚀 Starting account creation for ${fullDomain}`);

            console.log(`[Thread ${threadId}] 🔧 Step 1/10: Initializing browser...`);
            await this.#init();
            console.log(`[Thread ${threadId}] ✅ Browser initialized`);

            console.log(`[Thread ${threadId}] 🔧 Step 2/10: Setting up page settings and fingerprinting...`);
            await this.#setupPageSettings();
            console.log(`[Thread ${threadId}] ✅ Page settings configured`);

            console.log(`[Thread ${threadId}] 🔧 Step 3/10: Navigating to signup page...`);
            await this.#vistiCreatePage();
            console.log(`[Thread ${threadId}] ✅ Signup page loaded`);

            console.log(`[Thread ${threadId}] 🔧 Step 4/10: Handling initial popups...`);
            try {
                await this.#handleClickingOkeyIgotIt();
                console.log(`[Thread ${threadId}] ✅ Popup handled`);
            } catch (error) {
                console.log(`[Thread ${threadId}] ℹ️  No popup to handle`);
            }

            console.log(`[Thread ${threadId}] ⏳ Waiting 2s before form filling...`);
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Random delay before starting form
            const formDelay = Math.random() * 2000 + 1000;
            console.log(`[Thread ${threadId}] 🔧 Step 5/10: Filling institution form...`);
            console.log(`[Thread ${threadId}] ⏳ Waiting ${(formDelay / 1000).toFixed(1)}s before form...`);
            await new Promise(resolve => setTimeout(resolve, formDelay));

            console.log(`[Thread ${threadId}] 🔍 Looking for institution name input...`);
            const institutionSelector = 'input[aria-label="Institution name, 128 characters maximum."]';
            const institutionInput = await this.#waitForSelectorWithRetry(institutionSelector, {
                timeout: 15000,
                alternatives: ['input[aria-label*="Institution"]', 'input[placeholder*="Institution"]', 'input[type="text"]']
            });

            if (institutionInput) {
                console.log(`[Thread ${threadId}] ✍️  Typing institution: ${this.instituion}`);
                // Clear any existing value first
                await institutionInput.click({ clickCount: 3 }); // Triple click to select all
                await this.#humanLikeType(institutionInput, this.instituion);

                // Verify it was filled
                const verified = await this.#verifyInputFilled(institutionSelector, this.instituion);
                if (!verified) {
                    console.log(`[Thread ${threadId}] ⚠️  Retrying institution input...`);
                    await institutionInput.click({ clickCount: 3 });
                    await institutionInput.type(this.instituion, { delay: Math.random() * 50 + 50 });
                }
            } else {
                throw new Error('Institution input not found');
            }
            console.log(`[Thread ${threadId}] ✅ Institution name entered`);

            // Random delay after typing
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));

            console.log(`[Thread ${threadId}] 🔍 Looking for student count combobox...`);
            const combobox = await this.page.waitForSelector('[role="combobox"]', { timeout: 10000 });
            console.log(`[Thread ${threadId}] ✅ Combobox found, clicking...`);
            await this.#humanLikeMouseMove(combobox);
            await this.#humanLikeDelay(50, 150);
            await combobox.click({ delay: Math.random() * 50 + 50 });
            console.log(`[Thread ${threadId}] 🔍 Waiting for dropdown options...`);
            await this.page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 10000 });
            console.log(`[Thread ${threadId}] ✅ Dropdown opened`);

            console.log(`[Thread ${threadId}] 🔧 Step 6/10: Selecting student count: ${this.total}`);
            await this.#selectTotalOfStudents();
            console.log(`[Thread ${threadId}] ✅ Student count selected`);

            // Random delay before scrolling
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));

            // Scroll slowly like a human
            await this.page.evaluate(() => {
                window.scrollBy(0, 300);
            });
            await new Promise(resolve => setTimeout(resolve, 200));
            await this.page.evaluate(() => {
                window.scrollBy(0, 300);
            });
            await new Promise(resolve => setTimeout(resolve, 200));
            await this.page.evaluate(() => {
                window.scrollBy(0, 400);
            });

            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));

            const educationInput = await this.page.$(`input[aria-label="${this.education}"]`);
            if (educationInput) {
                await this.#humanLikeMouseMove(educationInput);
                await this.#humanLikeDelay(50, 150);
                await educationInput.click({ delay: Math.random() * 50 + 50 });
            } else {
                await this.page.click(`input[aria-label="${this.education}"]`);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));

            console.log(`[Thread ${threadId}] 🔧 Step 7/10: Selecting region...`);
            await this.#selectRegion();
            console.log(`[Thread ${threadId}] ✅ Region selected: ${this.country}`);

            // Random delay after region selection
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1500 + 800));

            console.log(`[Thread ${threadId}] 🔧 Step 8/10: Filling personal information...`);
            await this.#handleNext();

            console.log(`[Thread ${threadId}] ✍️  Entering first name: ${this.firstName}`);
            await this.#handleFirstNameInputClick();
            const firstNameInput = await this.page.$('input[aria-label*="First name"], input[placeholder*="First name"]');
            if (firstNameInput) {
                await this.#humanLikeType(firstNameInput, this.firstName);
            } else {
                await this.page.keyboard.type(this.firstName, { delay: Math.random() * 100 + 100 });
            }
            console.log(`[Thread ${threadId}] ✅ First name entered`);

            console.log(`[Thread ${threadId}] ✍️  Entering last name: ${this.lastName}`);
            await this.#handleLastNameInputClick();
            const lastNameInput = await this.page.$('input[aria-label*="Last name"], input[placeholder*="Last name"]');
            if (lastNameInput) {
                await this.#humanLikeType(lastNameInput, this.lastName);
            } else {
                await this.page.keyboard.type(this.lastName, { delay: Math.random() * 100 + 100 });
            }
            console.log(`[Thread ${threadId}] ✅ Last name entered`);

            console.log(`[Thread ${threadId}] 🔍 Looking for email input...`);
            const emailSelector = 'input[type="email"]';
            const emailValue = `${this.firstName}.${this.lastName}@gmail.com`;
            const emailInput = await this.#waitForSelectorWithRetry(emailSelector, {
                timeout: 15000,
                alternatives: ['input[aria-label*="email"]', 'input[placeholder*="email"]', 'input[name*="email"]']
            });

            if (emailInput) {
                console.log(`[Thread ${threadId}] ✍️  Typing email: ${emailValue}`);
                await emailInput.click({ clickCount: 3 });
                await this.#humanLikeType(emailInput, emailValue);

                // Verify email was filled
                const emailVerified = await this.#verifyInputFilled(emailSelector, emailValue);
                if (!emailVerified) {
                    console.log(`[Thread ${threadId}] ⚠️  Retrying email input...`);
                    await emailInput.click({ clickCount: 3 });
                    await emailInput.type(emailValue, { delay: Math.random() * 50 + 50 });
                }
            } else {
                throw new Error('Email input not found');
            }
            console.log(`[Thread ${threadId}] ✅ Email entered`);

            console.log(`[Thread ${threadId}] 🔍 Looking for phone input...`);
            const phoneSelector = 'input[id="phone-input"]';
            const phoneInput = await this.#waitForSelectorWithRetry(phoneSelector, {
                timeout: 15000,
                alternatives: ['input[aria-label*="phone"]', 'input[placeholder*="phone"]', 'input[type="tel"]', 'input[name*="phone"]']
            });

            if (phoneInput) {
                let phoneVerified = false;
                let phoneAttempts = 0;
                const maxPhoneAttempts = 3;

                while (!phoneVerified && phoneAttempts < maxPhoneAttempts) {
                    phoneAttempts++;

                    if (phoneAttempts > 1) {
                        console.log(`[Thread ${threadId}] 🔄 Phone attempt ${phoneAttempts}/${maxPhoneAttempts}...`);
                        await this.#regeneratePhoneNumber();
                    }

                    // Format phone number properly
                    const formattedPhone = await this.#formatPhoneNumberForInput(this.number, this.country);
                    console.log(`[Thread ${threadId}] ✍️  Typing phone: ${formattedPhone} (country: ${this.country})`);

                    // Clear and type phone number
                    await phoneInput.click({ clickCount: 3 });
                    // Type phone number character by character to allow browser formatting
                    for (const char of formattedPhone) {
                        await phoneInput.type(char, { delay: Math.random() * 80 + 50 });
                    }

                    // Wait a bit for browser to format it
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    // Verify phone was filled (check if it contains our digits)
                    const phoneDigits = this.number.replace(/\D/g, '');
                    const isFilled = await this.#verifyInputFilled(phoneSelector, phoneDigits, [
                        'input[type="tel"]', 'input[name*="phone"]'
                    ]);

                    if (isFilled) {
                        // Check for ANY validation error
                        const hasError = await this.page.evaluate(() => {
                            const errorElement = document.querySelector('[jsname="B34EJ"]'); // Common Google error container
                            if (errorElement && errorElement.textContent && errorElement.textContent.length > 0) {
                                const text = errorElement.textContent.toLowerCase();
                                return text.includes("format") ||
                                    text.includes("valid") ||
                                    text.includes("recognized") ||
                                    text.includes("cannot be used") ||
                                    text.includes("verify");
                            }
                            return false;
                        });

                        if (!hasError) {
                            phoneVerified = true;
                            console.log(`[Thread ${threadId}] ✅ Phone entered and valid`);
                        } else {
                            console.log(`[Thread ${threadId}] ⚠️  Phone number validation error detected (Rejected by Google)`);
                            phoneVerified = false; // Explicitly mark as failed
                        }
                    }

                    if (!phoneVerified) {
                        console.log(`[Thread ${threadId}] ⚠️  Retrying phone input (Attempt ${phoneAttempts}/${maxPhoneAttempts})...`);
                        await phoneInput.click({ clickCount: 3 });
                        await this.page.keyboard.press('Backspace'); // Clear input
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }

                if (!phoneVerified) {
                    throw new Error(`Failed to enter valid phone number after ${maxPhoneAttempts} attempts`);
                }

            } else {
                throw new Error('Phone input not found');
            }

            await new Promise(resolve => setTimeout(resolve, 500));

            await this.#handleNext();

            await this.#handleYesIhaveDomain();

            await new Promise(resolve => setTimeout(resolve, 500));

            console.log(`[Thread ${threadId}] 🔍 Looking for domain input...`);
            await this.#handleDomainInputClick();
            const domainSelector = 'input[aria-label*="domain"], input[placeholder*="domain"]';
            const domainInput = await this.#waitForSelectorWithRetry(domainSelector, {
                timeout: 15000,
                alternatives: ['input[name*="domain"]', 'input[type="text"]']
            });

            if (domainInput) {
                console.log(`[Thread ${threadId}] ✍️  Typing domain: ${fullDomain}`);
                await domainInput.click({ clickCount: 3 });
                await this.#humanLikeType(domainInput, fullDomain);

                // Verify domain was filled
                const domainVerified = await this.#verifyInputFilled(domainSelector, fullDomain);
                if (!domainVerified) {
                    console.log(`[Thread ${threadId}] ⚠️  Retrying domain input...`);
                    await domainInput.click({ clickCount: 3 });
                    await domainInput.type(fullDomain, { delay: Math.random() * 50 + 50 });
                }
            } else {
                throw new Error('Domain input not found');
            }
            console.log(`[Thread ${threadId}] ✅ Domain entered`);

            // Add more realistic delays to reduce detection
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));

            await this.#handleNext();

            // Random delay between steps
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1500 + 800));

            await this.#handleNext();

            // Random delay before agreement
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));

            await this.#handleAgree();

            console.log(`[Thread ${threadId}] 🔍 Looking for username input...`);
            const usernameSelector = 'input[maxlength="64"]';
            const usernameInput = await this.#waitForSelectorWithRetry(usernameSelector, {
                timeout: 15000,
                alternatives: ['input[aria-label*="username"]', 'input[placeholder*="username"]', 'input[name*="username"]', 'input[type="text"][maxlength="64"]']
            });

            if (usernameInput) {
                console.log(`[Thread ${threadId}] ✍️  Typing username: ${this.username}`);
                await usernameInput.click({ clickCount: 3 });
                await this.#humanLikeType(usernameInput, this.username);

                // Verify username was filled
                const usernameVerified = await this.#verifyInputFilled(usernameSelector, this.username);
                if (!usernameVerified) {
                    console.log(`[Thread ${threadId}] ⚠️  Retrying username input...`);
                    await usernameInput.click({ clickCount: 3 });
                    await usernameInput.type(this.username, { delay: Math.random() * 50 + 50 });
                }
            } else {
                throw new Error('Username input not found');
            }
            console.log(`[Thread ${threadId}] ✅ Username entered`);


            // Longer delay before password entry (like reading the form)
            await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));

            console.log(`[Thread ${threadId}] 🔍 Looking for password inputs...`);
            const passwordInputs = await this.page.$$('input[type="password"]');

            if (passwordInputs.length === 0) {
                // Try alternative selectors
                const altInputs = await this.page.$$('input[aria-label*="password"], input[placeholder*="password"]');
                if (altInputs.length > 0) {
                    passwordInputs.push(...altInputs);
                }
            }

            if (passwordInputs.length === 0) {
                throw new Error('Password input not found');
            }

            console.log(`[Thread ${threadId}] ✍️  Typing password in ${passwordInputs.length} field(s)...`);
            for (let i = 0; i < passwordInputs.length; i++) {
                const input = passwordInputs[i];
                await input.click({ clickCount: 3 });
                await this.#humanLikeType(input, this.password);

                // Verify password was filled (check length, not exact value for security)
                await new Promise(resolve => setTimeout(resolve, 300));
                const passwordLength = await input.evaluate(el => el.value ? el.value.length : 0);
                if (passwordLength === 0) {
                    console.log(`[Thread ${threadId}] ⚠️  Password field ${i + 1} empty, retrying...`);
                    await input.click({ clickCount: 3 });
                    await input.type(this.password, { delay: Math.random() * 50 + 30 });
                }
            }
            console.log(`[Thread ${threadId}] ✅ Password entered`);

            // Random delay after password entry
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1500 + 800));

            // Scroll down slowly like a human
            await this.page.evaluate(() => {
                window.scrollBy(0, 500);
            });
            await new Promise(resolve => setTimeout(resolve, 300));
            await this.page.evaluate(() => {
                window.scrollBy(0, 500);
            });

            // Random delay before final submission
            await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));

            console.log(`[Thread ${threadId}] 🔧 Step 10/10: Submitting form...`);
            await this.#handleAgreeAndContinue();
            console.log(`[Thread ${threadId}] ✅ Form submitted`);

            // Wait for page to process submission
            console.log(`[Thread ${threadId}] ⏳ Waiting for submission to process...`);
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Check for success or errors multiple times
            let success = false;
            let antiSpamError = false;

            console.log(`[Thread ${threadId}] 🔍 Checking for success/errors (up to 10 attempts)...`);
            for (let i = 0; i < 10; i++) {
                console.log(`[Thread ${threadId}] 🔍 Check attempt ${i + 1}/10...`);
                await new Promise(resolve => setTimeout(resolve, 3000));

                // Check for anti-spam error first
                antiSpamError = await this.#checkAntiSpamError();
                if (antiSpamError) {
                    await this.#takeScreenshot('anti_spam_error');
                    const errorMsg = "Google anti-spam detection blocked signup";
                    console.log(`[Thread ${threadId}] 🚫 Anti-spam error detected: ${errorMsg}`);
                    throw new Error(errorMsg);
                }

                // Check for success
                const isSuccess = await this.#checkSuccess();
                if (isSuccess) {
                    const email = `${this.username}@${fullDomain}`;
                    console.log(`[Thread ${threadId}] ✅✅✅ SUCCESS: ${email}`);

                    // Always save to text file
                    const credentials = `${email}:${this.password}\r\n`;
                    try {
                        fs.appendFileSync('accounts.txt', credentials, 'utf-8');
                        console.log(`[Thread ${threadId}] 💾 Saved to accounts.txt`);
                    } catch (error) {
                        console.log(`[Thread ${threadId}] ⚠️  File save failed: ${error.message}`);
                    }

                    // Conditionally save to API
                    await this.#saveToAPI(email, this.password);

                    success = true;
                    break;
                } else {
                    console.log(`[Thread ${threadId}] ⏳ Not successful yet, waiting...`);
                }

                // If we've checked multiple times and no success, check for other errors
                if (i >= 5) {
                    const pageContent = await this.page.evaluate(() => {
                        return document.body ? document.body.textContent : '';
                    });

                    // Check for other error patterns
                    if (pageContent.includes('error') || pageContent.includes('Error') ||
                        pageContent.includes('failed') || pageContent.includes('Failed')) {
                        console.log(`[Thread ${threadId}] ⚠️  Possible error detected on page`);
                        await this.#takeScreenshot('possible_error');
                    }
                }
            }

            if (!success && !antiSpamError) {
                console.log(`[Thread ${threadId}] ⏱️  Timeout - no success confirmation received`);
                await this.#takeScreenshot('timeout_no_success');
                throw new Error("Account creation timeout - no success confirmation received");
            }
        } catch (error) {
            errorOccurred = true;
            errorToThrow = error;

            // Check if it's a rate limit error
            if (error.isRateLimit) {
                // Don't take screenshot for rate limit, just close and throw
            } else {
                // Take screenshot BEFORE closing browser
                await this.#takeScreenshot('final_error');
            }
        } finally {
            // Always close browser - with timeout to prevent hanging
            try {
                await Promise.race([
                    this.closeBrowser(),
                    new Promise((resolve) => {
                        setTimeout(() => {
                            console.log(`[Thread ${threadId}] ⚠️  Browser close timeout, forcing cleanup...`);
                            if (this.browser && this.browser.process()) {
                                try {
                                    this.browser.process().kill('SIGKILL');
                                } catch (e) { }
                            }
                            this.browser = null;
                            this.page = null;
                            resolve();
                        }, 10000); // 10 second timeout
                    })
                ]);
            } catch (closeError) {
                // Force cleanup if close fails
                if (this.browser && this.browser.process()) {
                    try {
                        this.browser.process().kill('SIGKILL');
                    } catch (e) { }
                }
                this.browser = null;
                this.page = null;
            }

            // Throw error after browser is closed
            if (errorOccurred && errorToThrow) {
                throw errorToThrow;
            }
        }
    }
}

// Worker function to process a single domain (direct execution, no child processes)
async function processDomain(domain, threadId, totalDomains, currentIndex, delayMs, proxyConfig) {
    // Add staggered delay before starting
    if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    console.log(`[Thread ${threadId}] [${currentIndex}/${totalDomains}] Starting: ${domain}`);

    try {
        const google = new Google(proxyConfig); // Pass proxy config to instance
        await google.createAccount(domain, threadId);
        console.log(`[Thread ${threadId}] ✓ Completed: ${domain}`);
        return { success: true, domain };
    } catch (error) {
        // Check if it's a rate limit error
        if (error.isRateLimit) {
            throw error; // Re-throw to stop the entire process
        }

        const isAntiSpam = error.message && error.message.includes('anti-spam');
        const errorType = isAntiSpam ? '🚫 Anti-spam blocked' : '✗ Failed';

        console.log(`[Thread ${threadId}] ${errorType}: ${domain} - ${error.message}`);

        // Save failed domain to a file
        const failedEntry = `${domain} - ${error.message}\n`;
        fs.appendFileSync('failed_domains.txt', failedEntry, 'utf-8');

        return {
            success: false,
            domain,
            error: error.message,
            isAntiSpam: isAntiSpam
        };
    }
}

// Main execution with concurrency control
async function main() {
    // Test proxy first if enabled
    let proxyConfig = null;
    if (USE_PROXY) {
        const testResult = await testProxyConnection();
        if (!testResult.success) {
            console.log("❌ Proxy test failed. Please fix proxy configuration before continuing.");
            process.exit(1);
        }
        proxyConfig = testResult;
    }

    // Read domains from domains.txt file
    const domainsFile = fs.readFileSync('domains.txt', 'utf-8');
    const domains = domainsFile.split('\n').map(domain => domain.trim()).filter(Boolean);

    console.log(`Found ${domains.length} domains to process`);
    console.log(`Running with 3 concurrent threads`);
    console.log(`Proxy: ${USE_PROXY ? '✅ ENABLED' : '❌ DISABLED'}`);
    if (USE_PROXY) {
        console.log(`Proxy Server: ${PROXY_HOST}:${PROXY_PORT}`);
    }
    console.log(`API Saving: ${API_SAVE_ENABLED ? '✅ ENABLED' : '❌ DISABLED'}`);
    if (API_SAVE_ENABLED) {
        console.log(`API URL: ${API_URL}`);
        console.log(`API Region: ${API_REGION}`);
    }
    console.log(`Screenshots will be saved in ./screenshots/ folder`);
    console.log("================================\n");

    const CONCURRENT_THREADS = 15; // Reduced from 5 to 3 for better success rate
    const STAGGER_DELAY = 8000; // Increased to 8 seconds between each thread start
    const FAILURE_RATE_THRESHOLD = 0.5; // 50% failure rate threshold
    const results = {
        successful: 0,
        failed: 0,
        antiSpamBlocked: 0,
        total: domains.length
    };

    // Process domains in batches
    try {
        for (let i = 0; i < domains.length; i += CONCURRENT_THREADS) {
            const batch = domains.slice(i, i + CONCURRENT_THREADS);
            const batchNumber = Math.floor(i / CONCURRENT_THREADS) + 1;
            const totalBatches = Math.ceil(domains.length / CONCURRENT_THREADS);

            console.log(`\n========================================`);
            console.log(`Batch ${batchNumber}/${totalBatches} (${batch.length} domains)`);
            console.log(`========================================\n`);

            // Create promises for concurrent execution with staggered starts
            const promises = batch.map((domain, index) => {
                const threadId = (i + index + 1);
                const currentIndex = i + index + 1;
                const delayMs = index * STAGGER_DELAY; // Stagger each thread by 8 seconds
                return processDomain(domain, threadId, domains.length, currentIndex, delayMs, proxyConfig);
            });

            // Wait for all promises in this batch to complete
            const batchResults = await Promise.all(promises);

            // Update results
            batchResults.forEach(result => {
                if (result.success) {
                    results.successful++;
                } else {
                    results.failed++;
                    if (result.isAntiSpam) {
                        results.antiSpamBlocked++;
                    }
                }
            });

            // Calculate current failure rate
            const totalProcessed = results.successful + results.failed;
            const failureRate = totalProcessed > 0 ? results.failed / totalProcessed : 0;
            const antiSpamRate = totalProcessed > 0 ? results.antiSpamBlocked / totalProcessed : 0;

            console.log(`\n========================================`);
            console.log(`Batch ${batchNumber}/${totalBatches} Complete`);
            console.log(`Successful: ${batchResults.filter(r => r.success).length}/${batch.length}`);
            console.log(`Failed: ${batchResults.filter(r => !r.success).length}/${batch.length}`);
            if (results.antiSpamBlocked > 0) {
                console.log(`🚫 Anti-spam blocked: ${results.antiSpamBlocked}`);
            }
            console.log(`Overall Failure Rate: ${(failureRate * 100).toFixed(2)}%`);
            console.log(`Anti-spam Rate: ${(antiSpamRate * 100).toFixed(2)}%`);
            console.log(`========================================\n`);

            // Check if failure rate is too high
            if (totalProcessed >= 5 && failureRate >= FAILURE_RATE_THRESHOLD) {
                console.log("\n⚠️  ⚠️  ⚠️  WARNING: HIGH FAILURE RATE DETECTED ⚠️  ⚠️  ⚠️");
                console.log("========================================");
                console.log(`Current Failure Rate: ${(failureRate * 100).toFixed(2)}%`);
                console.log(`Threshold: ${(FAILURE_RATE_THRESHOLD * 100).toFixed(2)}%`);
                console.log(`Successful: ${results.successful}`);
                console.log(`Failed: ${results.failed}`);
                if (results.antiSpamBlocked > 0) {
                    console.log(`Anti-spam Blocked: ${results.antiSpamBlocked}`);
                }
                console.log("========================================");
                console.log("RECOMMENDATIONS:");
                console.log("1. Reduce concurrent threads");
                console.log("2. Increase delays between actions");
                console.log("3. Use residential proxies with rotation");
                console.log("4. Wait longer between batches");
                console.log("5. Check if IP is flagged");
                console.log("========================================\n");
            }

            // Add longer delay between batches (not after the last batch)
            if (i + CONCURRENT_THREADS < domains.length) {
                const delaySeconds = 20 + Math.floor(Math.random() * 10); // 20-30 seconds
                console.log(`Waiting ${delaySeconds} seconds before next batch...\n`);
                await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
            }
        }
    } catch (error) {
        if (error.isRateLimit) {
            // Rate limit hit - stop everything
            console.log("\n========================================");
            console.log("⛔ PROCESS STOPPED DUE TO RATE LIMIT");
            console.log("========================================");
            console.log(`Processed: ${results.successful + results.failed}/${results.total} domains`);
            console.log(`Successful: ${results.successful}`);
            console.log(`Failed: ${results.failed}`);
            if (USE_PROXY) {
                console.log("\n⚠️  Proxy will rotate IP on restart!");
            } else {
                console.log("\n⚠️  Change your IP address before restarting!");
            }
            console.log("========================================\n");
            process.exit(1);
        }
        throw error;
    }

    // Final summary
    const totalProcessed = results.successful + results.failed;
    const finalFailureRate = totalProcessed > 0 ? results.failed / totalProcessed : 0;
    const finalSuccessRate = totalProcessed > 0 ? results.successful / totalProcessed : 0;

    console.log("\n========================================");
    console.log("All domains processed!");
    console.log("========================================");
    console.log(`Total Domains: ${results.total}`);
    console.log(`Processed: ${totalProcessed}`);
    console.log(`Successful: ${results.successful}`);
    console.log(`Failed: ${results.failed}`);
    if (results.antiSpamBlocked > 0) {
        console.log(`🚫 Anti-spam Blocked: ${results.antiSpamBlocked}`);
    }
    console.log(`Success Rate: ${(finalSuccessRate * 100).toFixed(2)}%`);
    console.log(`Failure Rate: ${(finalFailureRate * 100).toFixed(2)}%`);
    console.log(`Screenshots saved in: ./screenshots/`);

    if (finalFailureRate >= FAILURE_RATE_THRESHOLD) {
        console.log("\n⚠️  FINAL WARNING: HIGH FAILURE RATE");
        console.log("Consider adjusting your strategy before next run.");
    }

    console.log("========================================\n");
}

// Run the main function ONLY if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
}
