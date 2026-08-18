import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import UserAgent from 'user-agents';
import http from 'http';
import https from 'https';

process.setMaxListeners(0);

// ─── Utilities ──────────────────────────────────────────────────────────────
export function formatLogArg(arg) {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
}

// ─── Name pools for user generation ─────────────────────────────────────────
export const FIRST_NAMES = [
    'James','Mary','Robert','Patricia','John','Jennifer','Michael','Linda',
    'David','Elizabeth','William','Barbara','Richard','Susan','Joseph','Jessica',
    'Thomas','Sarah','Christopher','Karen','Charles','Lisa','Daniel','Nancy',
    'Matthew','Betty','Anthony','Margaret','Mark','Sandra','Donald','Ashley',
    'Steven','Dorothy','Andrew','Kimberly','Paul','Emily','Joshua','Donna',
    'Kenneth','Michelle','Kevin','Carol','Brian','Amanda','George','Melissa',
    'Timothy','Deborah','Ronald','Stephanie','Edward','Rebecca','Jason','Sharon',
    'Jeffrey','Laura','Ryan','Cynthia','Jacob','Kathleen','Gary','Amy',
];
export const LAST_NAMES = [
    'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis',
    'Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson',
    'Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson',
    'White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker',
    'Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill',
    'Flores','Green','Adams','Nelson','Baker','Hall','Rivera','Campbell',
    'Mitchell','Carter','Roberts','Gomez','Phillips','Evans','Turner','Diaz',
    'Parker','Cruz','Edwards','Collins','Reyes','Stewart','Morris','Morales',
];

export function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Indian Address Data ─────────────────────────────────────────────────────
const INDIAN_STATES = [
    'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
    'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
    'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
    'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
    'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
    'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
    'Andaman and Nicobar Islands', 'Chandigarh', 'Delhi',
    'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'
];
const INDIAN_CITIES_BY_STATE = {
    'Maharashtra': ['Mumbai', 'Pune', 'Nagpur', 'Thane', 'Nashik', 'Aurangabad', 'Navi Mumbai'],
    'Karnataka': ['Bangalore', 'Mysore', 'Mangalore', 'Hubli', 'Belgaum', 'Udupi'],
    'Tamil Nadu': ['Chennai', 'Coimbatore', 'Madurai', 'Salem', 'Tiruchirappalli', 'Tirunelveli'],
    'Delhi': ['New Delhi', 'Delhi', 'Dwarka', 'Rohini', 'Karol Bagh'],
    'Telangana': ['Hyderabad', 'Warangal', 'Nizamabad', 'Karimnagar'],
    'West Bengal': ['Kolkata', 'Howrah', 'Durgapur', 'Asansol', 'Siliguri'],
    'Gujarat': ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Bhavnagar'],
    'Rajasthan': ['Jaipur', 'Jodhpur', 'Udaipur', 'Kota', 'Bikaner'],
    'Uttar Pradesh': ['Lucknow', 'Kanpur', 'Agra', 'Varanasi', 'Allahabad', 'Noida', 'Greater Noida', 'Ghaziabad'],
    'Kerala': ['Kochi', 'Thiruvananthapuram', 'Kozhikode', 'Thrissur', 'Kollam'],
    'Madhya Pradesh': ['Bhopal', 'Indore', 'Jabalpur', 'Gwalior', 'Ujjain'],
    'Punjab': ['Chandigarh', 'Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala'],
    'Haryana': ['Gurugram', 'Faridabad', 'Panipat', 'Ambala', 'Karnal'],
    'Bihar': ['Patna', 'Gaya', 'Bhagalpur', 'Muzaffarpur', 'Darbhanga'],
    'Odisha': ['Bhubaneswar', 'Cuttack', 'Rourkela', 'Brahmapur'],
    'Jharkhand': ['Ranchi', 'Jamshedpur', 'Dhanbad', 'Bokaro'],
    'Chhattisgarh': ['Raipur', 'Bhilai', 'Bilaspur', 'Korba'],
    'Assam': ['Guwahati', 'Silchar', 'Dibrugarh', 'Jorhat'],
    'Himachal Pradesh': ['Shimla', 'Dharamshala', 'Manali', 'Solan'],
    'Uttarakhand': ['Dehradun', 'Haridwar', 'Rishikesh', 'Nainital'],
    'Goa': ['Panaji', 'Margao', 'Vasco da Gama', 'Mapusa'],
    'Andhra Pradesh': ['Visakhapatnam', 'Vijayawada', 'Tirupati', 'Guntur', 'Kurnool'],
    'Sikkim': ['Gangtok', 'Namchi', 'Pelling'],
    'Tripura': ['Agartala', 'Udaipur', 'Dharmanagar'],
    'Meghalaya': ['Shillong', 'Tura', 'Jowai'],
    'Manipur': ['Imphal', 'Thoubal', 'Bishnupur'],
    'Nagaland': ['Kohima', 'Dimapur', 'Mokokchung'],
    'Mizoram': ['Aizawl', 'Lunglei', 'Champhai'],
    'Arunachal Pradesh': ['Itanagar', 'Naharlagun', 'Pasighat'],
};
const INDIAN_STREETS = [
    'MG Road', 'Park Street', 'Station Road', 'Gandhi Road', 'Nehru Street',
    'Civil Lines', 'Main Road', 'Cross Road', 'Brigade Road',
    'Commercial Street', 'Residency Road', 'Anna Salai',
    'Linking Road', 'SV Road', 'Mall Road', 'Ring Road',
    'Park Avenue', 'Marine Drive', 'Cunningham Road', 'Lavelle Road',
    'Richmond Road', 'Infantry Road', 'Sardar Patel Road', 'Cathedral Road',
    'Rajiv Gandhi Salai', 'GST Road', 'Poonamallee High Road', 'Arcot Road',
    'Sarojini Nagar', 'Karol Bagh Market', 'Connaught Place',
    'Sector 18', 'Sector 22', 'Phase 7', 'Sector 14', 'DLF Phase 1',
    'Velachery Main Road', 'OMR', 'ECR', 'Medavakkam Main Road',
    'Jubilee Hills Road 36', 'Banjara Hills Road 12', 'Begumpet',
    'Old Mahabalipuram Road'
];
const INDIAN_LANDMARKS = [
    'Near Bus Stand', 'Opposite City Mall', 'Behind Railway Station',
    'Near Metro Station', 'Opposite Park', 'Near Temple', 'Near Hospital',
    'Near School', 'Near Market', 'Opposite Bank', 'Near Police Station',
    'Behind Post Office', 'Near Airport', 'Opposite Stadium', 'Near Lake',
    'Near Garden', 'Opposite Mall', 'Behind Petrol Pump', 'Near Highway',
    'Near College', 'Near Community Hall', 'Near Bus Stop', 'Opposite Cinema'
];
const INDIAN_PIN_PREFIXES = {
    'Maharashtra': ['400', '401', '410', '411', '412', '413', '421', '422'],
    'Karnataka': ['560', '561', '562', '570', '571', '572', '573'],
    'Tamil Nadu': ['600', '601', '602', '603', '620', '621', '625'],
    'Delhi': ['110', '111'],
    'Telangana': ['500', '501', '502', '503'],
    'West Bengal': ['700', '711', '712'],
    'Gujarat': ['380', '390', '395'],
    'Rajasthan': ['302', '303'],
    'Uttar Pradesh': ['201', '202', '226'],
    'Kerala': ['680', '682', '695'],
    'Madhya Pradesh': ['462', '452', '482'],
    'Punjab': ['140', '141', '143', '160'],
    'Haryana': ['122', '121', '132'],
    'Bihar': ['800', '801', '802'],
    'Odisha': ['751', '753', '769'],
    'Jharkhand': ['834', '831'],
    'Chhattisgarh': ['492', '493'],
    'Assam': ['781', '788'],
    'Himachal Pradesh': ['171', '176'],
    'Uttarakhand': ['248', '249'],
    'Goa': ['403', '404'],
    'Andhra Pradesh': ['520', '521', '522', '530'],
    'Sikkim': ['737', '738'],
    'Tripura': ['799'],
    'Meghalaya': ['793'],
    'Manipur': ['795'],
    'Nagaland': ['797'],
    'Mizoram': ['796'],
    'Arunachal Pradesh': ['791'],
};

export function generateIndianAddress() {
    const state = pickRandom(INDIAN_STATES);
    const cities = INDIAN_CITIES_BY_STATE[state] || [state];
    const city = pickRandom(cities);
    const pinPrefixes = INDIAN_PIN_PREFIXES[state] || ['110'];
    const pinPrefix = pickRandom(pinPrefixes);
    const pin = pinPrefix + String(randInt(100, 999)).padStart(3, '0');
    const houseNumber = randInt(1, 500);
    const street = pickRandom(INDIAN_STREETS);
    const landmark = pickRandom(INDIAN_LANDMARKS);
    return {
        state, city, pin,
        addressLine1: `${houseNumber}, ${street}`,
        addressLine2: landmark,
    };
}

// ─── HeroSMS API ────────────────────────────────────────────────────────────
export class HeroSMSAPI {
    constructor(apiKey, baseUrl = 'https://api.hero-sms.com') {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
    }
    async _request(method, endpoint, data = null) {
        // baseUrl may be a bare host (append /stubs/handler_api.php) or already the full API endpoint
        const base = String(this.baseUrl || '').trim().replace(/\/+$/, '');
        const apiPath = /handler_api\.php$/i.test(base) ? '' : '/stubs/handler_api.php';
        const url = `${base}${apiPath}`;
        const params = new URLSearchParams({ api_key: this.apiKey, action: endpoint });
        if (data) Object.entries(data).forEach(([k, v]) => params.set(k, v));
        const fullUrl = `${url}?${params.toString()}`;
        return new Promise((resolve, reject) => {
            const lib = /^https:/i.test(fullUrl) ? https : http;
            const req = lib.get(fullUrl, { timeout: 30000 }, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => resolve(body ? body.split('\n').filter(Boolean) : []));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
    }
    async getBalance() {
        const res = await this._request('GET', 'getBalance');
        const balance = parseFloat(res[0]);
        return isNaN(balance) ? 0 : balance;
    }
    async getNumber(service = 'go', country = 6, maxPrice = 0.03) {
        const res = await this._request('GET', 'getNumber', { service, country, maxPrice: String(maxPrice) });
        if (!res.length) return null;
        const parts = res[0].split(':');
        if (parts[0] === 'ACCESS_NUMBER') return { activationId: parts[1], phone: parts[2], country };
        return null;
    }
    async getStatus(activationId) {
        const res = await this._request('GET', 'getStatus', { id: activationId });
        const line = res[0] || '';
        if (line === 'STATUS_WAIT_CODE') return { status: 'wait_code', code: null };
        if (line.startsWith('STATUS_OK:')) return { status: 'ok', code: line.split(':')[1] };
        if (line === 'STATUS_CANCEL') return { status: 'cancel', code: null };
        return { status: 'unknown', code: null, raw: line };
    }
    async setStatus(activationId, status) { await this._request('GET', 'setStatus', { id: activationId, status: String(status) }); }
    async cancelActivation(activationId) { await this.setStatus(activationId, 8); }
}

// ─── Logger ─────────────────────────────────────────────────────────────────
export class Logger {
    constructor(logDir) {
        this.logDir = logDir;
        this.logFile = null;
        this.enabled = true;
    }
    setFile(runId) {
        try {
            fs.mkdirSync(this.logDir, { recursive: true });
            this.logFile = path.join(this.logDir, `users_live_${runId}.log`);
        } catch { this.enabled = false; }
    }
    write(level, ...args) {
        const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatLogArg).join(' ')}`;
        if (this.enabled && this.logFile) {
            try { fs.appendFileSync(this.logFile, line + '\n', 'utf-8'); } catch { }
        }
        console.log(line);
    }
    info(...args) { this.write('INFO', ...args); }
    warn(...args) { this.write('WARN', ...args); }
    error(...args) { this.write('ERROR', ...args); }
}

// ─── IP Detection ───────────────────────────────────────────────────────────
export async function detectIP() {
    return new Promise((resolve) => {
        http.get('http://ip-api.com/json/?fields=61439', { timeout: 10000 }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    resolve({
                        ip: data.query || 'unknown',
                        country: data.country || 'unknown',
                        countryCode: data.countryCode || 'unknown',
                        region: data.regionName || 'unknown',
                        city: data.city || 'unknown',
                        isp: data.isp || 'unknown',
                        org: data.org || 'unknown',
                        as: data.as || 'unknown',
                        lat: data.lat || 0,
                        lon: data.lon || 0,
                    });
                } catch { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

// ─── Account Loader ─────────────────────────────────────────────────────────
// Format per line:  account:password          (auto-pick the unused domain)
//                   account:password:domain   (use this specific domain)
export function loadAccountsFromFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const accounts = [];
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        if (line.startsWith('#')) continue;
        const cleanLine = line.split(' | ')[0].trim();
        const parts = cleanLine.split(':');
        if (parts.length >= 2) {
            const email = parts[0];
            let domain = '';
            let password = parts.slice(1).join(':');
            const last = parts[parts.length - 1];
            if (parts.length >= 3 && /^@?[\w.-]+\.[a-zA-Z]{2,}$/.test(last)) {
                domain = last.replace(/^@/, '');
                password = parts.slice(1, -1).join(':');
            }
            if (email && password && !accounts.some(a => a.email === email)) {
                accounts.push({ email, password, domain });
            }
        }
    }
    return accounts;
}

export function parseCustomAccounts(input) {
    const accounts = [];
    const entries = input.split(',').map(s => s.trim()).filter(Boolean);
    for (const entry of entries) {
        const parts = entry.split(':');
        if (parts.length >= 2) {
            const email = parts[0];
            let domain = '';
            let password = parts.slice(1).join(':');
            const last = parts[parts.length - 1];
            if (parts.length >= 3 && /^@?[\w.-]+\.[a-zA-Z]{2,}$/.test(last)) {
                domain = last.replace(/^@/, '');
                password = parts.slice(1, -1).join(':');
            }
            accounts.push({ email, password, domain });
        }
    }
    return accounts;
}

// ─── 2Captcha + Auto-OTP bridges (CJS helpers already used elsewhere in the app) ──
const loadCaptchaSolver = () =>
    import('../captchaSolver.cjs')
        .then(m => m.solveGoogleLoginCaptchaIfPresent || null)
        .catch(() => null);
const loadOtpHandler = () =>
    import('../autoOTPHandler.cjs')
        .then(m => m.handleOTPIfRequested || null)
        .catch(() => null);

// ─── Google Workspace User Creator ──────────────────────────────────────────
export class GoogleWorkspaceUserCreator {
    constructor(email, password, options) {
        this.email = email;
        this.password = password;
        this.threadId = options.threadId || 0;
        this.headless = options.headless !== false;
        this.logger = options.logger || new Logger();
        this.skipSms = options.skipSms !== false;
        this.heroSms = options.heroSms || null;
        this.usersCount = options.usersCount || 9;
        this.targetDomain = options.targetDomain || '';
        this.HERO_SMS_MAX_PRICE = options.heroSmsMaxPrice || 0.03;
        this.HERO_SMS_RETRIES = Math.max(5, parseInt(process.env.HERO_SMS_PHONE_RETRIES, 10) || 10);
        this.HERO_SMS_PREFERRED_COUNTRIES = [
            { name: "Indonesia", id: 6 },
            { name: "Colombia", id: 33 },
        ];
        this.HERO_SMS_EXPLORATORY_COUNTRIES = [
            { name: "Philippines", id: 4 },
            { name: "Malaysia", id: 7 },
            { name: "Vietnam", id: 10 },
            { name: "Kenya", id: 8 },
            { name: "Romania", id: 32 },
            { name: "Argentina", id: 39 },
            { name: "South Africa", id: 31 },
            { name: "Thailand", id: 52 },
        ];
        this.HERO_SMS_PREFERRED_COUNTRY_WEIGHT = 0.8;
        this.HERO_SMS_COUNTRY_BY_NAME = {
            "Indonesia": 6, "Colombia": 33, "Philippines": 4, "Malaysia": 7,
            "Vietnam": 10, "Kenya": 8, "Romania": 32, "Argentina": 39,
            "South Africa": 31, "Thailand": 52,
        };
        this.browser = null;
        this.page = null;
        this.heroActivationId = null;
        this.heroPhoneInternational = null;
        this.usersCreated = 0;
        this.usedUsernames = new Set();
    }

    async #delay(min = 50, max = 200) {
        return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
    }

    async #humanType(element, text, delayMin = 35, delayMax = 95) {
        for (const char of text) {
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin)));
            await element.type(char, { delay: 0 });
            if (Math.random() < 0.03) await this.#delay(40, 120);
            if (Math.random() < 0.06) await this.#delay(120, 320);
        }
    }

    async #init(proxyConfig) {
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });
        this.agent = userAgent.toString();
        const args = [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-gpu', '--window-size=1366,768', '--disable-blink-features=AutomationControlled',
        ];
        if (proxyConfig) args.push(`--proxy-server=http://${proxyConfig.host}:${proxyConfig.port}`);
        if (!this.headless) args.push('--start-maximized');
        const executablePath = (
            process.env.PUPPETEER_EXECUTABLE_PATH ||
            process.env.CHROME_PATH ||
            ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
                .find(p => { try { return fs.existsSync(p); } catch { return false; } })
        );
        this.browser = await puppeteer.launch({
            headless: this.headless ? 'new' : false,
            args,
            ...(executablePath ? { executablePath } : {}),
            defaultViewport: this.headless ? { width: 1366, height: 768 } : null,
        });
        this.page = await this.browser.newPage();
        // Authenticated proxy support (host:port:user:pass lines from config.json)
        if (proxyConfig && proxyConfig.user && proxyConfig.pass) {
            try {
                await this.page.authenticate({ username: proxyConfig.user, password: proxyConfig.pass });
            } catch { }
        }
        await this.page.setUserAgent(this.agent);
        await this.page.setViewport({ width: 1366, height: 768 });
        await this.page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        this.page.setDefaultNavigationTimeout(60000);
        this.page.setDefaultTimeout(30000);
    }

    async #clickButton(labelTexts) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const clicked = await this.page.evaluate((texts) => {
                    const sel = 'button, [role="button"], input[type="submit"], input[type="button"]';
                    const candidates = document.querySelectorAll(sel);
                    let best = null, bestScore = 0;
                    for (const el of candidates) {
                        const text = (el.textContent || el.value || '').toLowerCase().trim();
                        const aria = (el.getAttribute('aria-label') || '').toLowerCase().trim();
                        const label = text || aria;
                        if (!label) continue;
                        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
                        const rect = el.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) continue;
                        for (const t of texts) {
                            const tl = t.toLowerCase();
                            if (label.includes(tl)) {
                                const score = label.length;
                                if (score > bestScore) { bestScore = score; best = el; }
                            }
                        }
                    }
                    if (!best) return false;
                    best.scrollIntoView({ block: 'center' });
                    best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                    best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                    best.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    return true;
                }, labelTexts);
                if (clicked) return true;
            } catch {
                return true;
            }
            await this.#delay(600, 1000);
        }
        return false;
    }

    async #realClickButton(labelTexts) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const coords = await this.page.evaluate((texts) => {
                    const sel = 'button, [role="button"], input[type="submit"], input[type="button"], a[role="link"]';
                    const candidates = document.querySelectorAll(sel);
                    let best = null, bestScore = 0;
                    for (const el of candidates) {
                        const text = (el.textContent || el.value || '').toLowerCase().trim();
                        const aria = (el.getAttribute('aria-label') || '').toLowerCase().trim();
                        const label = text || aria;
                        if (!label) continue;
                        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
                        const rect = el.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) continue;
                        for (const t of texts) {
                            const tl = t.toLowerCase();
                            if (label === tl) {
                                const score = 10000 - label.length;
                                if (score > bestScore) { bestScore = score; best = el; }
                            } else if (label.includes(tl)) {
                                const score = 1000 + label.length;
                                if (score > bestScore) { bestScore = score; best = el; }
                            }
                        }
                    }
                    if (!best) return null;
                    best.scrollIntoView({ block: 'center' });
                    const r = best.getBoundingClientRect();
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                }, labelTexts);
                if (coords) {
                    await this.#delay(150, 300);
                    await this.page.mouse.click(coords.x, coords.y);
                    return true;
                }
            } catch { }
            await this.#delay(600, 1000);
        }
        return false;
    }

    async #realClickElement(selector) {
        try {
            const box = await this.page.evaluate((sel) => {
                const els = [...document.querySelectorAll(sel)];
                const vis = els.find(e => {
                    const r = e.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                });
                if (!vis) return null;
                vis.scrollIntoView({ block: 'center', behavior: 'instant' });
                const r = vis.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }, selector).catch(() => null);
            if (!box) return false;
            await this.#delay(100, 250);
            await this.page.mouse.click(box.x, box.y);
            return true;
        } catch { return false; }
    }

    async #focusVisibleInput(selector) {
        try {
            const isVisible = (sel) => this.page.evaluate((s) => {
                return [...document.querySelectorAll(s)].some(e => {
                    const r = e.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                });
            }, sel).catch(() => false);

            for (let i = 0; i < 10; i++) {
                if (await isVisible(selector)) break;
                await this.#delay(500, 800);
            }
            if (!(await isVisible(selector))) return false;

            const checkFocused = (sel) => this.page.evaluate((s) => {
                const a = document.activeElement;
                const els = [...document.querySelectorAll(s)].filter(e => {
                    const r = e.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                });
                return els.some(el => !!a && (a === el || el.contains(a) || (a.matches && a.matches(s))));
            }, selector).catch(() => false);

            const handle = await this.page.$(selector).catch(() => null);
            if (handle) {
                await handle.evaluate(e => e.scrollIntoView({ block: 'center' })).catch(() => {});
                await this.#delay(150, 300);
                await handle.click().catch(() => {});
                await this.#delay(200, 350);
                if (await checkFocused(selector)) return true;
            }

            await this.#realClickElement(selector);
            await this.#delay(200, 350);
            if (await checkFocused(selector)) return true;

            await this.page.evaluate((sel) => {
                const el = [...document.querySelectorAll(sel)].find(e => {
                    const r = e.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                });
                if (el) el.focus();
            }, selector).catch(() => {});
            await this.#delay(150, 250);
            return await checkFocused(selector);
        } catch { return false; }
    }

    async #fillField(selector, value) {
        try {
            const el = await this.page.$(selector);
            if (!el) return false;
            const tag = await el.evaluate(e => e.tagName).catch(() => '');
            if (!tag) return false;
            await el.evaluate((e, text) => {
                e.focus();
                const proto = window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) {
                    setter.call(e, '');
                    e.dispatchEvent(new Event('input', { bubbles: true }));
                    setter.call(e, text);
                    e.dispatchEvent(new Event('input', { bubbles: true }));
                    e.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    e.value = text;
                    e.dispatchEvent(new Event('input', { bubbles: true }));
                    e.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, value).catch(() => {});
            await this.#delay(300, 600);
            return true;
        } catch { return false; }
    }

    async run(proxyConfig) {
        this.logger.info(`[${this.threadId}] Starting user creation for: ${this.email}`);
        try {
            await this.#init(proxyConfig);
            await this.#delay(1000, 2000);
            const loggedIn = await this.#login();
            if (!loggedIn) {
                this.logger.warn(`[${this.threadId}] Login failed for ${this.email} — skipping`);
                return false;
            }
            await this.#handleCheckoutPage();
            await this.#navigateToGetupgrade();
            const created = await this.#createUsers();
            if (!created) {
                this.logger.warn(`[${this.threadId}] ❌ User creation did not complete for ${this.email}`);
                return false;
            }
            this.logger.info(`[${this.threadId}] ✅ All ${this.usersCount} users created for ${this.email}`);
            return true;
        } catch (err) {
            this.logger.warn(`[${this.threadId}] ❌ Error creating users for ${this.email}: ${err.message}`);
            return false;
        } finally {
            await this.#cleanup();
        }
    }

    #onWorkspacePage() {
        try {
            const u = this.page.url() || '';
            const urlObj = new URL(u);
            const hostname = urlObj.hostname;
            const path = urlObj.pathname;
            return path.includes('/getupgrade') || path.includes('/admin') || hostname === 'admin.google.com';
        } catch { return false; }
    }

    #isCheckoutPage() {
        try {
            const url = this.page.url() || '';
            return url.includes('workspace.google.com') && /\/checkout(\b|\/|[\?#])/.test(url);
        } catch { return false; }
    }

    async #onSpeedbumpPage() {
        try {
            const url = this.page.url() || '';
            const path = new URL(url).pathname;
            return /speedbump|workspacetermsofservice/i.test(path) || /signin\/speedbump/i.test(url);
        } catch { return false; }
    }

    async #clickElement(selector, options = {}) {
        const { clickCount = 1, retries = 3, delay = 300 } = options;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const el = await this.page.$(selector);
                if (!el) return false;
                const box = await el.boundingBox().catch(() => null);
                if (!box) {
                    await el.evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => {});
                    await this.#delay(200, 400);
                }
                await el.click({ clickCount });
                return true;
            } catch {
                if (attempt < retries) await this.#delay(delay, delay + 200);
            }
        }
        return false;
    }

    // 2Captcha: Google image captcha (img#captchaimg) during login
    async #handleCaptcha() {
        try {
            const solver = await loadCaptchaSolver();
            if (!solver) return false;
            const solved = await solver(this.page, this.password);
            if (solved) this.logger.info(`[${this.threadId}] 🤖 2Captcha solved`);
            return solved;
        } catch (err) {
            this.logger.warn(`[${this.threadId}] ⚠️  Captcha error: ${err.message}`);
            return false;
        }
    }

    // Auto-OTP: TOTP/authenticator code challenge (generateOTP via SSH, shared with other flows)
    async #handleOtp() {
        try {
            const hasOtpInput = await this.page.evaluate(() => {
                return !!document.querySelector(
                    'input[name="totpPin"], input[id*="totp"], input[name*="otp"], input[aria-label*="authenticator"], input[placeholder*="code"], input[aria-label*="verification"], input[aria-label*="enter the code"], input[aria-label*="6-digit"]'
                );
            }).catch(() => false);
            if (!hasOtpInput) return false;
            const handler = await loadOtpHandler();
            if (!handler) return false;
            const handled = await handler(this.page, this.email, 8000);
            if (handled) this.logger.info(`[${this.threadId}] 🔑 OTP handled`);
            return handled;
        } catch (err) {
            this.logger.warn(`[${this.threadId}] ⚠️  OTP error: ${err.message}`);
            return false;
        }
    }

    async #login() {
        this.logger.info(`[${this.threadId}] 🔐 Logging in: ${this.email}`);
        const continueUrl = encodeURIComponent('https://workspace.google.com/checkout?uj=2606-checkoutentry-signup-coreflow-accountredirect');
        const loginUrl = `https://accounts.google.com/v3/signin/identifier?Email=${encodeURIComponent(this.email)}&continue=${continueUrl}&service=CPanel&sacu=1&skipvpage=true&flowName=GlifWebSignIn&flowEntry=ServiceLogin`;
        await this.page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await this.#delay(2500, 3500);

        let emailDone = false;
        const emailSel = 'input[type="email"], input#identifierId, input[name="identifier"]';
        const pwSel = 'input[type="password"], input[name="Passwd"], input[name="password"]';

        const passwordVisible = () => this.page.evaluate((sel) => {
            return [...document.querySelectorAll(sel)].some(e => {
                const r = e.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
        }, pwSel).catch(() => false);
        let onPasswordStep = await passwordVisible();

        if (!onPasswordStep) {
            try {
                await this.page.waitForSelector(emailSel, { timeout: 8000 });
                await this.#realClickElement(emailSel);
                await this.#delay(150, 300);
                await this.page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (el) { el.focus(); el.select(); }
                }, emailSel).catch(() => {});
                await this.#delay(100, 200);
                await this.page.keyboard.press('Backspace');
                await this.#delay(100, 200);
                await this.page.keyboard.type(this.email, { delay: 25 + Math.random() * 40 });
                await this.#delay(300, 500);

                const emailOk = await this.page.evaluate((sel, expected) => {
                    const el = document.querySelector(sel);
                    return !!el && (el.value || '') === expected;
                }, emailSel, this.email).catch(() => false);
                if (!emailOk) {
                    await this.#realClickElement(emailSel);
                    await this.#delay(150, 300);
                    await this.page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        if (el) { el.focus(); el.select(); }
                    }, emailSel).catch(() => {});
                    await this.#delay(100, 200);
                    await this.page.keyboard.press('Backspace');
                    await this.#delay(100, 200);
                    await this.page.keyboard.type(this.email, { delay: 25 + Math.random() * 40 });
                    await this.#delay(300, 500);
                }

                await this.page.keyboard.press('Enter');
                await this.#delay(800, 1200);
                onPasswordStep = await passwordVisible();
                for (let e = 0; e < 5 && !onPasswordStep; e++) {
                    await this.#realClickButton(['Next', 'Suivant', 'Suivante', 'Continue', 'Weiter']);
                    await this.#delay(800, 1200);
                    onPasswordStep = await passwordVisible();
                }
                for (let p = 0; p < 15 && !onPasswordStep; p++) {
                    onPasswordStep = await passwordVisible();
                    if (onPasswordStep) break;
                    await this.#delay(500, 800);
                }
                if (!onPasswordStep) {
                    this.logger.warn(`[${this.threadId}] ⚠️  Did not advance to password step after entering email`);
                    return false;
                }
                emailDone = true;
            } catch {
            }
        }

        let pwFound = onPasswordStep;
        for (let p = 0; p < 30 && !pwFound; p++) {
            pwFound = await passwordVisible();
            if (pwFound) break;
            await this.#delay(500, 800);
        }
        if (!pwFound) {
            if (!emailDone) {
                await this.page.screenshot({ path: `login_error_${this.threadId}.png` }).catch(() => {});
            }
            this.logger.warn(`[${this.threadId}] ⚠️  Password input not found`);
            return false;
        }
        let typed = false;
        for (let attempt = 0; attempt < 5 && !typed; attempt++) {
            const focusedOk = await this.#focusVisibleInput(pwSel);
            if (!focusedOk) {
                this.logger.warn(`[${this.threadId}] ⚠️  Password field not focused (attempt ${attempt + 1}/5) — waiting...`);
                await this.#delay(600, 1000);
                continue;
            }
            await this.page.keyboard.press('Backspace');
            await this.#delay(100, 200);
            await this.page.keyboard.type(this.password, { delay: 30 + Math.random() * 40 });
            typed = true;
        }
        if (!typed) {
            this.logger.warn(`[${this.threadId}] ⚠️  Could not focus password field — aborting login`);
            return false;
        }
        await this.#delay(500, 800);
        await this.page.keyboard.press('Enter');
        await this.#delay(800, 1200);
        // 2Captcha support: Google may show an image captcha after submitting the password
        await this.#handleCaptcha();
        await this.#delay(1200, 1800);
        const pwStillShown = await this.page.evaluate((sel) => !!document.querySelector(sel), pwSel).catch(() => false);
        if (pwStillShown) {
            await this.#realClickButton(['Next', 'Sign in', 'Suivant', 'Se connecter', 'Connexion']);
        }
        await this.#delay(1500, 2500);
        const stillPw = await this.page.evaluate((sel) => !!document.querySelector(sel), pwSel).catch(() => false);
        if (stillPw) {
            await this.page.keyboard.press('Enter');
            await this.#delay(2000, 3000);
        }
        await this.#delay(2000, 3000);

        const smsChallenge = await this.page.evaluate(() => {
            const txt = (document.body && document.body.innerText) || '';
            const url = location.href || '';
            const isChallenge = url.includes('/challenge/');
            const hasPhoneInput = !!document.querySelector('input[type="tel"], input[aria-label*="phone" i], input[aria-label*="mobile" i]');
            const hasCodeOrOtpInput = !!document.querySelector(
                'input[name="totpPin"], input[id*="totp"], input[name*="otp"], input[aria-label*="authenticator"], input[placeholder*="code"], input[id*="otp"], input[aria-label*="verification"], input#idvPin, input#code, input[name="code"], input[name="pin"]'
            );
            const asksPhone = /enter.{0,30}(phone|mobile) number|verify.{0,30}(phone|mobile)|phone verification|send.{0,20}(code|sms)|text message/i.test(txt);
            return isChallenge && hasPhoneInput && !hasCodeOrOtpInput && asksPhone;
        }).catch(() => false);

        if (smsChallenge) {
            if (this.skipSms || !this.heroSms) {
                this.logger.warn(`[${this.threadId}] 📱 SMS challenge detected but SMS handling is disabled — falling through`);
            } else {
                const handled = await this.#handleSms();
                if (handled) {
                    this.logger.info(`[${this.threadId}] ✅ SMS challenge resolved`);
                } else {
                    this.logger.warn(`[${this.threadId}] ⚠️ SMS challenge could not be resolved — falling through to challenge loop (OTP/2FA may apply)`);
                }
            }
        }

        let reached = false;
        for (let i = 0; i < 40; i++) {
            if (this.#onWorkspacePage()) { reached = true; break; }
            if (await this.#onSpeedbumpPage()) { await this.#handleSpeedbump(); continue; }
            if (await this.#handleChallengePage()) { await this.#delay(1000, 2000); continue; }
            if (await this.#handleConfirmIdentifier()) { continue; }
            await this.#delay(1000, 1500);
        }
        if (!reached) {
            for (let i = 0; i < 20; i++) {
                if (this.#onWorkspacePage()) { reached = true; break; }
                if (await this.#handleConfirmIdentifier()) { continue; }
                await this.#delay(1000, 1500);
            }
        }
        if (!reached) {
            this.logger.warn(`[${this.threadId}] ⚠️  Did not reach workspace after login: ${this.page.url()}`);
            await this.page.screenshot({ path: `login_stuck_${this.threadId}.png` }).catch(() => {});
            return false;
        }
        this.logger.info(`[${this.threadId}] ✅ Login successful: ${this.page.url()}`);
        return true;
    }

    async #handleSms() {
        this.logger.info(`[${this.threadId}] 📱 Handling SMS challenge...`);
        try {
            const maxAttempts = this.HERO_SMS_RETRIES;
            const countryQueue = this.#buildHeroSmsCountryQueue(maxAttempts);
            this.logger.info(`[${this.threadId}] 📱 SMS country queue: ${countryQueue.map(c => `${c.name}(${c.id})`).join(' → ')}`);
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const bodyText = await this.page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
                if (/too many failed attempts|try again in a few hours/i.test(bodyText)) {
                    this.logger.warn(`[${this.threadId}] ❌ Account is rate-limited (Too many failed attempts)`);
                    return false;
                }
                const entry = countryQueue[attempt - 1] || this.#selectHeroSmsCountry();
                const country = entry.id;
                this.logger.info(`[${this.threadId}] 📱 SMS attempt ${attempt}/${maxAttempts} (country: ${entry.name}/${country})`);
                const activation = await this.heroSms.getNumber('go', country, this.HERO_SMS_MAX_PRICE);
                if (!activation) {
                    this.logger.warn(`[${this.threadId}] ⚠️  No SMS number available`);
                    continue;
                }
                this.heroActivationId = activation.activationId;
                this.heroPhoneInternational = `+${activation.phone}`;
                this.logger.info(`[${this.threadId}] 📱 Rented: ${this.heroPhoneInternational}`);
                let phoneInput = await this.page.$('input[type="tel"], input[aria-label*="phone" i], input[aria-label*="mobile" i]');
                if (phoneInput) {
                    await phoneInput.click({ clickCount: 3 });
                    await this.#delay(150, 300);
                    await this.#humanType(phoneInput, this.heroPhoneInternational);
                    await this.#delay(500, 800);
                }
                await this.#clickButton(['Next', 'Send', 'Continue']);
                await this.#delay(3000, 5000);
                let hasCode = false;
                for (let i = 0; i < 20; i++) {
                    hasCode = await this.page.evaluate(() => !!document.querySelector('input#idvPin, input#code, input[name="code"], input[name="pin"], input[aria-label*="code" i], input[aria-label*="verification" i], input[aria-label*="OTP" i]')).catch(() => false);
                    if (hasCode) break;
                    await this.#delay(1000, 1500);
                }
                if (!hasCode) {
                    this.logger.warn(`[${this.threadId}] ⚠️  Code input did not appear`);
                    await this.heroSms.cancelActivation(this.heroActivationId);
                    this.heroActivationId = null;
                    continue;
                }
                this.logger.info(`[${this.threadId}] 📱 Polling for SMS code...`);
                let code = null;
                for (let i = 0; i < 18; i++) {
                    const status = await this.heroSms.getStatus(this.heroActivationId);
                    if (status.code) { code = status.code; break; }
                    await this.#delay(5000, 6000);
                }
                if (!code) {
                    this.logger.warn(`[${this.threadId}] ⚠️  No SMS code received`);
                    await this.heroSms.cancelActivation(this.heroActivationId);
                    this.heroActivationId = null;
                    continue;
                }
                this.logger.info(`[${this.threadId}] ✅ SMS code: ${code}`);
                const codeInput = await this.page.$('input#idvPin, input#code, input[name="code"], input[name="pin"], input[aria-label*="code" i], input[aria-label*="verification" i], input[aria-label*="OTP" i]');
                if (codeInput) {
                    await codeInput.click({ clickCount: 3 });
                    await this.#humanType(codeInput, code);
                    await this.#delay(500, 800);
                }
                await this.#clickButton(['Verify', 'Next', 'Continue']);
                await this.#delay(2000, 3000);
                await this.heroSms.setStatus(this.heroActivationId, 6);
                this.heroActivationId = null;
                this.logger.info(`[${this.threadId}] ✅ SMS verified`);
                return true;
            }
        } catch (err) {
            this.logger.warn(`[${this.threadId}] ⚠️  SMS error: ${err.message}`);
        }
        if (this.heroActivationId) { try { await this.heroSms.cancelActivation(this.heroActivationId); } catch { } this.heroActivationId = null; }
        return false;
    }

    #selectHeroSmsCountry() {
        const configuredCountry = process.env.HERO_SMS_COUNTRY;
        if (configuredCountry && /^\d+$/.test(configuredCountry)) {
            return { name: `custom-${configuredCountry}`, id: parseInt(configuredCountry, 10), forced: true };
        }
        if (configuredCountry && this.HERO_SMS_COUNTRY_BY_NAME[configuredCountry]) {
            return { name: configuredCountry, id: this.HERO_SMS_COUNTRY_BY_NAME[configuredCountry], forced: true };
        }
        const pool = Math.random() < this.HERO_SMS_PREFERRED_COUNTRY_WEIGHT
            ? this.HERO_SMS_PREFERRED_COUNTRIES
            : this.HERO_SMS_EXPLORATORY_COUNTRIES;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    #shuffleHeroSmsCountries(countries) {
        const shuffled = [...countries];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    #buildHeroSmsCountryQueue(maxAttempts) {
        const attempts = Math.max(1, Number.isFinite(maxAttempts) ? maxAttempts : 1);
        const configuredCountry = process.env.HERO_SMS_COUNTRY;
        if (configuredCountry) {
            const forced = this.#selectHeroSmsCountry();
            return Array.from({ length: attempts }, () => forced);
        }
        const exploratorySlots = attempts >= 3
            ? Math.max(1, Math.round(attempts * (1 - this.HERO_SMS_PREFERRED_COUNTRY_WEIGHT)))
            : 0;
        const preferredSlots = attempts - exploratorySlots;
        const preferred = this.#shuffleHeroSmsCountries(this.HERO_SMS_PREFERRED_COUNTRIES);
        const exploratory = this.#shuffleHeroSmsCountries(this.HERO_SMS_EXPLORATORY_COUNTRIES);
        const queue = [];
        for (let i = 0; i < preferredSlots; i++) {
            queue.push(preferred[i % preferred.length]);
        }
        for (let i = 0; i < exploratorySlots; i++) {
            queue.push(exploratory[i % exploratory.length]);
        }
        return queue.slice(0, attempts);
    }

    async #handleSpeedbump() {
        this.logger.info(`[${this.threadId}] 🚧 Checking speedbump...`);
        try {
            const isSb = await this.#onSpeedbumpPage();
            if (!isSb) return false;
            for (let a = 1; a <= 3; a++) {
                await this.#clickButton(['I understand', 'I Understand', 'Understand', 'Continue', 'Next']);
                await this.#delay(2000, 3000);
                const still = await this.#onSpeedbumpPage();
                if (!still) { this.logger.info(`[${this.threadId}] ✅ Speedbump cleared`); return true; }
            }
        } catch { }
        return false;
    }

    async #handleConfirmIdentifier() {
        try {
            const state = await this.page.evaluate(() => {
                const url = location.href || '';
                const txt = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
                return {
                    shouldAdvance: /\/signin\/confirmidentifier/i.test(url) ||
                        (/verify it.?s you/i.test(txt) && /please sign in again|to continue|confirm/i.test(txt)),
                };
            });
            if (!state.shouldAdvance) return false;
            this.logger.info(`[${this.threadId}] 🔐 Confirm-identifier page detected, clicking Next...`);
            await this.#clickButton(['Next', 'Continue']);
            await this.#delay(2500, 3500);
            return true;
        } catch { return false; }
    }

    async #fillCheckoutInput(labelTerms, value) {
        for (const frame of [this.page.mainFrame(), ...this.page.frames()]) {
            try {
                const filled = await frame.evaluate((terms, val) => {
                    const inputs = [...document.querySelectorAll('input, textarea')];
                    for (const input of inputs) {
                        const rect = input.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) continue;
                        const text = (input.placeholder || '') + ' ' + (input.getAttribute('aria-label') || '') + ' ' +
                                    (input.name || '') + ' ' + (input.id || '');
                        const p = text.toLowerCase();
                        if (!terms.some(t => p.includes(t))) continue;
                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                        if (setter) {
                            setter.call(input, '');
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            setter.call(input, String(val));
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                        } else {
                            input.value = String(val);
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        input.dispatchEvent(new Event('blur', { bubbles: true }));
                        return true;
                    }
                    return false;
                }, labelTerms, value);
                if (filled) return true;
            } catch {}
        }
        return false;
    }

    async #selectCheckoutDropdown(labelTerms, value) {
        for (const frame of [this.page.mainFrame(), ...this.page.frames()]) {
            try {
                const done = await frame.evaluate((terms, val) => {
                    const isVis = (el) => el.isConnected && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
                    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    const selectEls = [...document.querySelectorAll('select')];
                    for (const sel of selectEls) {
                        if (!isVis(sel)) continue;
                        const txt = (sel.getAttribute('aria-label') || '') + ' ' + (sel.name || '') + ' ' + (sel.id || '');
                        if (!terms.some(t => txt.toLowerCase().includes(t))) continue;
                        const opts = [...sel.options];
                        for (const opt of opts) {
                            if (norm(opt.textContent) === norm(val) || norm(opt.value) === norm(val)) {
                                sel.value = opt.value;
                                sel.dispatchEvent(new Event('change', { bubbles: true }));
                                return true;
                            }
                        }
                    }
                    const combos = [...document.querySelectorAll('[role="combobox"], [role="listbox"]')];
                    for (const combo of combos) {
                        if (!isVis(combo)) continue;
                        const txt = (combo.getAttribute('aria-label') || '') + ' ' + (combo.getAttribute('placeholder') || '');
                        if (!terms.some(t => txt.toLowerCase().includes(t))) continue;
                        combo.click();
                        return true;
                    }
                    return false;
                }, labelTerms, value);
                if (done) {
                    if (value) {
                        await this.#delay(500, 1000);
                        await this.page.keyboard.type(String(value), { delay: 30 });
                        await this.#delay(300, 600);
                        await this.page.keyboard.press('Enter');
                    }
                    return true;
                }
            } catch {}
        }
        return false;
    }

    async #handleCheckoutPage() {
        if (!this.#isCheckoutPage()) return false;
        this.logger.info(`[${this.threadId}] 🛒 On checkout page — completing trial setup...`);
        await this.#delay(3000, 5000);

        await this.#clickButton(['Continue to trial', 'Start trial', 'Get started', 'Skip', 'Continue setup', 'Continue']);
        await this.#delay(2000, 3000);

        if (!this.#isCheckoutPage()) {
            this.logger.info(`[${this.threadId}] ✅ Checkout handling completed (button click was enough)`);
            return true;
        }

        const addr = generateIndianAddress();
        this.logger.info(`[${this.threadId}] 🏠 Filling Indian address: ${addr.addressLine1}, ${addr.city}, ${addr.state} ${addr.pin}`);

        for (let attempt = 1; attempt <= 3; attempt++) {
            await this.#fillCheckoutInput(['street', 'address line 1', 'address line1', 'address1', 'address'], addr.addressLine1);
            await this.#delay(200, 400);
            await this.#fillCheckoutInput(['apt', 'suite', 'landmark', 'address line 2', 'address line2', 'address2'], addr.addressLine2);
            await this.#delay(200, 400);
            await this.#fillCheckoutInput(['city', 'town', 'locality'], addr.city);
            await this.#delay(200, 400);
            await this.#fillCheckoutInput(['pin code', 'pin', 'zip', 'postal', 'pincode'], addr.pin);
            await this.#delay(200, 400);

            await this.#selectCheckoutDropdown(['state', 'province', 'region'], addr.state);
            await this.#delay(300, 600);

            await this.#clickButton(['Save', 'Save address', 'Apply', 'OK', 'Done', 'Confirm', 'Continue', 'Next']);
            await this.#delay(2000, 3000);

            const stillOpen = await this.#fillCheckoutInput(['street', 'address line', 'city', 'pin', 'zip'], 'dummy').then(r => r).catch(() => false);
            if (!stillOpen) {
                this.logger.info(`[${this.threadId}] ✅ Address saved`);
                break;
            }
            this.logger.info(`[${this.threadId}] ⚠️ Address form still open, retrying...`);
        }

        this.logger.info(`[${this.threadId}] ✅ Checkout handling done`);
        return true;
    }

    async #isChallengePage() {
        try {
            const url = this.page.url() || '';
            return url.includes('/signin/challenge/') && !url.includes('speedbump');
        } catch { return false; }
    }

    async #handleChallengePage() {
        try {
            if (!(await this.#isChallengePage())) return false;
            this.logger.info(`[${this.threadId}] 🔐 Handling post-login challenge...`);
            // 2Captcha image captcha
            if (await this.#handleCaptcha()) return true;
            // Auto-OTP (TOTP / authenticator) challenge
            if (await this.#handleOtp()) return true;
            // Password re-entry (challenge/pwd)
            const pwSel = 'input[type="password"], input[name="password"]';
            const pwEl = await this.page.$(pwSel).catch(() => null);
            if (pwEl) {
                await this.#fillField(pwSel, this.password);
                await this.#clickButton(['Next', 'Verify', 'Sign in', 'Continue']);
                this.logger.info(`[${this.threadId}] ✅ Password challenge submitted`);
                return true;
            }
            // SMS/2FA code challenge
            const codeSel = 'input#idvPin, input#code, input[name="code"], input[name="pin"]';
            const codeEl = await this.page.$(codeSel).catch(() => null);
            if (codeEl && this.heroSms && !this.skipSms) {
                const handled = await this.#handleSms();
                if (handled) return true;
            }
            // Unknown challenge — try clicking any submit button
            await this.#clickButton(['Next', 'Verify', 'Continue', 'I understand']);
            return true;
        } catch { return false; }
    }

    async #navigateToGetupgrade() {
        const BULK_ADD_URL = 'https://admin.google.com/ac/user/bulkadd';
        this.logger.info(`[${this.threadId}] 🚀 Navigating to Admin bulk add page...`);

        const atBulkAdd = () => this.page.evaluate(() => {
            const url = location.href || '';
            if (!url.includes('/bulkadd')) return false;
            const n = (document.body && document.body.innerText || '').toLowerCase();
            return n.includes('first name') && n.includes('last name');
        }).catch(() => false);

        for (let i = 0; i < 4; i++) {
            await this.page.goto(BULK_ADD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await this.#delay(2500, 3500);
            if (await atBulkAdd()) {
                this.logger.info(`[${this.threadId}] ✅ Reached Admin bulk add`);
                return true;
            }
            const cur = this.page.url() || '';
            if (cur.includes('getupgrade') || cur.includes('/discover') || (cur.includes('workspace.google.com') && !cur.includes('accounts.google.com'))) {
                this.logger.info(`[${this.threadId}] 🔁 Redirected to ${cur} — forcing Admin bulk add`);
                continue;
            }
            if (!cur.includes('accounts.google.com')) break;
        }
        if (await atBulkAdd()) {
            this.logger.info(`[${this.threadId}] ✅ Reached Admin bulk add`);
            return true;
        }

        for (let attempt = 0; attempt < 3; attempt++) {
            if (await atBulkAdd()) {
                this.logger.info(`[${this.threadId}] ✅ Reached Admin bulk add`);
                return true;
            }
            try {
                const isLogin = (this.page.url() || '').includes('accounts.google.com');
                if (!isLogin) break;

                this.logger.info(`[${this.threadId}] 🔐 Re-authenticating for getupgrade...`);
                const loginUrl = `https://accounts.google.com/v3/signin/identifier?Email=${encodeURIComponent(this.email)}&continue=${encodeURIComponent(BULK_ADD_URL)}&service=CPanel&sacu=1&skipvpage=true&flowName=GlifWebSignIn&flowEntry=ServiceLogin`;
                await this.page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await this.#delay(2000, 3000);

                const emailSel = 'input[type="email"], input#identifierId, input[name="identifier"]';
                const pwSel = 'input[type="password"], input[name="password"]';
                const reauthPwVisible = await this.page.evaluate((sel) => {
                    return [...document.querySelectorAll(sel)].some(e => {
                        const r = e.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    });
                }, pwSel).catch(() => false);
                if (!reauthPwVisible) {
                    const emailEl = await this.page.$(emailSel).catch(() => null);
                    if (emailEl) {
                        const isFilled = await emailEl.evaluate(el => (el.value || '').length > 0).catch(() => false);
                        if (!isFilled) {
                            await this.#realClickElement(emailSel);
                            await this.#delay(150, 300);
                            await this.page.evaluate((sel) => {
                                const el = document.querySelector(sel);
                                if (el) { el.focus(); el.select(); }
                            }, emailSel).catch(() => {});
                            await this.#delay(100, 200);
                            await this.page.keyboard.type(this.email, { delay: 25 + Math.random() * 40 });
                            await this.#delay(300, 500);
                            await this.page.keyboard.press('Enter');
                            await this.#delay(800, 1200);
                            for (let e = 0; e < 5; e++) {
                                const pwNow = await this.page.evaluate((sel) => {
                                    return [...document.querySelectorAll(sel)].some(el => {
                                        const r = el.getBoundingClientRect();
                                        return r.width > 0 && r.height > 0;
                                    });
                                }, pwSel).catch(() => false);
                                if (pwNow) break;
                                await this.#realClickButton(['Next', 'Suivant', 'Suivante', 'Continue']);
                                await this.#delay(800, 1200);
                            }
                            await this.#delay(1500, 2500);
                        }
                    }
                }

                let reauthPwFound = false;
                for (let q = 0; q < 20; q++) {
                    reauthPwFound = await this.page.evaluate((sel) => {
                        return [...document.querySelectorAll(sel)].some(e => {
                            const r = e.getBoundingClientRect();
                            return r.width > 0 && r.height > 0;
                        });
                    }, pwSel).catch(() => false);
                    if (reauthPwFound) break;
                    await this.#delay(500, 800);
                }
                if (reauthPwFound) {
                    for (let q = 0; q < 5; q++) {
                        const focusedOk = await this.#focusVisibleInput(pwSel);
                        if (!focusedOk) {
                            await this.#delay(600, 1000);
                            continue;
                        }
                        await this.page.keyboard.press('Backspace');
                        await this.#delay(100, 200);
                        await this.page.keyboard.type(this.password, { delay: 25 + Math.random() * 40 });
                        await this.#delay(300, 600);
                        break;
                    }
                }
                await this.#realClickButton(['Next', 'Sign in', 'Suivant', 'Se connecter', 'Connexion']);
                await this.#delay(3000, 5000);
                await this.#handleSpeedbump();
            } catch (err) {
                this.logger.warn(`[${this.threadId}] ⚠️  Re-auth attempt ${attempt + 1} failed: ${err.message}`);
            }
        }

        const atBulkAddFinal = () => this.page.evaluate(() => {
            const url = location.href || '';
            if (!url.includes('/bulkadd')) return false;
            const n = (document.body && document.body.innerText || '').toLowerCase();
            return n.includes('first name') && n.includes('last name');
        }).catch(() => false);
        for (let i = 0; i < 30; i++) {
            if (await atBulkAddFinal()) { this.logger.info(`[${this.threadId}] ✅ Reached Admin bulk add`); return true; }
            if (await this.#handleChallengePage()) { await this.#delay(1000, 2000); continue; }
            const cur = this.page.url() || '';
            if (!cur.includes('accounts.google.com')) {
                this.logger.info(`[${this.threadId}] 🔁 On ${cur} — forcing Admin bulk add`);
                await this.page.goto(BULK_ADD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await this.#delay(1500, 2500);
            }
            await this.#delay(1000, 1500);
        }
        this.logger.warn(`[${this.threadId}] ⚠️  Could not reach Admin bulk add: ${this.page.url()}`);
        return false;
    }

    async #createUsers() {
        this.logger.info(`[${this.threadId}] 👥 Creating ${this.usersCount} users on Admin bulk add page...`);
        await this.#delay(1500, 2500);

        const formReady = await this.page.waitForFunction(() => {
            const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/\*/g, '');
            const visible = (el) => {
                if (!el || !el.isConnected) return false;
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden') return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            };
            const hasBtn = [...document.querySelectorAll('button, [role="button"]')].some(b => {
                if (!visible(b)) return false;
                const t = norm(b.textContent || b.getAttribute('aria-label') || '');
                return t.includes('add another user') || t.includes('add user');
            });
            const headers = [...document.querySelectorAll('th, td, div, span, label, [role="columnheader"]')].filter(visible);
            const hasFirst = headers.some(h => norm(h.textContent) === 'first name');
            const hasLast = headers.some(h => norm(h.textContent) === 'last name');
            return hasBtn || (hasFirst && hasLast);
        }, { timeout: 45000 }).then(() => true).catch(() => false);
        if (!formReady) {
            this.logger.warn(`[${this.threadId}] ⚠️ Bulk add form not found at ${this.page.url()}`);
            return false;
        }
        await this.#delay(1000, 1500);

        const setupRows = () => this.page.evaluate(() => {
            const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/\*/g, '');
            const visible = (el) => {
                if (!el || !el.isConnected) return false;
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden') return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            };
            const center = (el) => {
                const r = el.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            };

            [...document.querySelectorAll('[data-bulk-field]')].forEach(el => {
                el.removeAttribute('data-bulk-row');
                el.removeAttribute('data-bulk-field');
            });

            let firstHeader = null, lastHeader = null;
            for (const el of [...document.querySelectorAll('th, td, div, span, label, [role="columnheader"]')]) {
                if (!visible(el)) continue;
                const t = norm(el.textContent);
                if (!t || t.length > 40) continue;
                if (el.querySelector('input')) continue;
                if (!firstHeader && t === 'first name') firstHeader = el;
                if (!lastHeader && t === 'last name') lastHeader = el;
            }
            const firstX = firstHeader ? center(firstHeader).x : null;
            const lastX = lastHeader ? center(lastHeader).x : null;
            const headerY = firstHeader ? center(firstHeader).y : (lastHeader ? center(lastHeader).y : null);

            const rows = [];
            for (const el of [...document.querySelectorAll('input, select, [role="combobox"], [role="listbox"], [aria-haspopup], [role="button"], [role="menuitem"]')]) {
                if (!visible(el)) continue;
                const c = center(el);
                let row = rows.find(r => Math.abs(r.y - c.y) < 8);
                if (!row) { row = { y: c.y, els: [] }; rows.push(row); }
                row.els.push({ el, x: c.x, y: c.y });
            }
            rows.sort((a, b) => a.y - b.y);

            let taggedRows = 0;
            rows.forEach((row, ri) => {
                row.els.sort((a, b) => a.x - b.x);
                const candidates = row.els.filter(it => headerY == null || it.y >= headerY - 4);
                if (candidates.length === 0) return;
                const isDropdown = (e) => {
                    const tag = e.tagName;
                    const role = (e.getAttribute('role') || '').toLowerCase();
                    const hasPopup = e.getAttribute('aria-haspopup') != null;
                    return tag === 'SELECT' || tag === 'BUTTON' || role === 'combobox' || role === 'listbox' || role === 'button' || hasPopup;
                };
                const textCandidates = candidates.filter(it => !isDropdown(it.el));
                const pick = (colX) => {
                    if (colX == null) return null;
                    let best = null, bestD = 1e9;
                    for (const it of textCandidates) {
                        const d = Math.abs(it.x - colX);
                        if (d < bestD) { bestD = d; best = it.el; }
                    }
                    return (best && bestD < 60) ? best : null;
                };
                let first = pick(firstX);
                let last = pick(lastX);
                if (!first || !last) {
                    const textInputs = textCandidates.map(it => it.el)
                        .filter(e => !['checkbox', 'radio', 'submit', 'button', 'hidden', 'file'].includes((e.type || 'text').toLowerCase()));
                    if (!first && textInputs.length >= 1) first = textInputs[0];
                    if (!last && textInputs.length >= 2) last = textInputs[1];
                }
                if (!first || !last || first === last) return;
                first.setAttribute('data-bulk-row', String(ri));
                first.setAttribute('data-bulk-field', 'first');
                last.setAttribute('data-bulk-row', String(ri));
                last.setAttribute('data-bulk-field', 'last');
                const textInputs = textCandidates.map(it => it.el)
                    .filter(e => !['checkbox', 'radio', 'submit', 'button', 'hidden', 'file'].includes((e.type || 'text').toLowerCase()));
                const alias = textInputs.find(t => t !== first && t !== last && center(t).x > center(last).x);
                if (alias) {
                    alias.setAttribute('data-bulk-row', String(ri));
                    alias.setAttribute('data-bulk-field', 'alias');
                }
                const dropdownEls = candidates.map(it => it.el).filter(isDropdown);
                const domain = dropdownEls.find(d => center(d).x > center(last).x) || dropdownEls[0];
                if (domain) {
                    domain.setAttribute('data-bulk-row', String(ri));
                    domain.setAttribute('data-bulk-field', 'domain');
                }
                taggedRows++;
            });

            const rowCount = rows.filter(r => r.els.some(it => headerY == null || it.y >= headerY - 4)).length;
            return { rowCount, taggedRows, headerFound: firstHeader != null || lastHeader != null };
        }).catch(() => ({ rowCount: 0, taggedRows: 0, headerFound: false }));

        let rows = await setupRows();
        this.logger.info(`[${this.threadId}] 📊 Initial rows detected: ${rows.rowCount} (header found: ${rows.headerFound}, tagged rows: ${rows.taggedRows})`);

        let guard = 0;
        while (rows.taggedRows < this.usersCount && guard < 20) {
            const clicked = await this.#realClickButton(['Add another user', 'Add user', 'add another', 'Ajouter un utilisateur']);
            if (!clicked) {
                this.logger.warn(`[${this.threadId}] ⚠️ Could not find "+ Add another user" button`);
                break;
            }
            await this.#delay(1200, 1800);
            rows = await setupRows();
            guard++;
        }
        await this.#delay(800, 1200);
        rows = await setupRows();
        this.logger.info(`[${this.threadId}] 📊 Rows after adding: ${rows.rowCount} (target ${this.usersCount}, tagged rows: ${rows.taggedRows})`);

        const fillField = async (rowIdx, field, value, allowSuffix) => {
            const sel = `input[data-bulk-row="${rowIdx}"][data-bulk-field="${field}"]`;
            for (let attempt = 0; attempt < 3; attempt++) {
                const handle = await this.page.$(sel).catch(() => null);
                if (!handle) return false;
                await handle.evaluate(e => e.scrollIntoView({ block: 'center' })).catch(() => {});
                await this.#delay(150, 300);
                await handle.click().catch(() => {});
                await this.#delay(150, 300);
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('KeyA');
                await this.page.keyboard.up('Control');
                await this.page.keyboard.press('Backspace');
                await this.#delay(100, 200);
                await this.page.keyboard.type(value, { delay: 20 + Math.random() * 30 });
                await this.#delay(150, 250);
                const landed = await this.page.evaluate((s, expected, allowSuffix) => {
                    const el = document.querySelector(s);
                    if (!el) return false;
                    const v = (el.value || '');
                    if (v === expected) return true;
                    return allowSuffix && v.toLowerCase().startsWith(expected.toLowerCase());
                }, sel, value, allowSuffix).catch(() => false);
                if (landed) return true;
                await this.#delay(400, 700);
            }
            return false;
        };

        const taggedList = await this.page.evaluate((limit) => {
            const firsts = [...document.querySelectorAll('input[data-bulk-field="first"]')];
            const out = [];
            for (const el of firsts) {
                const row = el.getAttribute('data-bulk-row');
                const last = document.querySelector(`input[data-bulk-row="${row}"][data-bulk-field="last"]`);
                if (last) out.push(row);
                if (out.length >= limit) break;
            }
            return out;
        }, this.usersCount).catch(() => []);

        let filledCount = 0;
        for (const row of taggedList) {
            const firstName = pickRandom(FIRST_NAMES);
            const lastName = pickRandom(LAST_NAMES);
            const username = this.#makeUsername();
            const okFirst = await fillField(row, 'first', firstName);
            await this.#delay(150, 300);
            const okLast = await fillField(row, 'last', lastName);
            await this.#delay(150, 300);
            const okAlias = await fillField(row, 'alias', username, true);
            await this.#delay(150, 300);
            const okDomain = await this.#selectOtherDomain(row, this.targetDomain);
            await this.#delay(150, 300);
            filledCount += (okFirst && okLast && okAlias) ? 1 : 0;
            this.logger.info(`[${this.threadId}] 👤 Row ${filledCount}/${this.usersCount}: ${firstName} ${lastName} (${username}) (first:${okFirst}, last:${okLast}, alias:${okAlias}, domain:${okDomain})`);
        }

        await this.#delay(1500, 2500);
        let continueClicked = false;
        for (let i = 0; i < 8 && !continueClicked; i++) {
            continueClicked = await this.#realClickButton(['Continue', 'Continuer', 'Next', 'Suivant', 'Add these users', 'Add ' + filledCount + ' users', 'Add users', 'Confirm']);
            if (!continueClicked) await this.#delay(1000, 1500);
        }
        this.logger.info(`[${this.threadId}] ▶️ ${continueClicked ? 'Clicked Continue — user creation submitted' : '⚠️ Continue button not found'}`);
        await this.#delay(1500, 2500);

        let completed = false;
        for (let w = 0; w < 70 && !completed; w++) {
            completed = await this.page.evaluate(() => {
                const txt = (document.body && document.body.innerText) || '';
                const n = txt.toLowerCase();
                const formStillShown = n.includes('first name') && n.includes('last name');
                const hasTempPw = n.includes('temporary password') || n.includes('temp password');
                const hasAdded = /(\d+\s+users?\s*(added|created))|(users?\s*(added|created)\s*successfully)|(all\s+\d+\s+users?)/i.test(n);
                return hasTempPw || (hasAdded && !formStillShown);
            }).catch(() => false);
            if (!completed) {
                if (w > 0 && w % 15 === 0) {
                    this.logger.info(`[${this.threadId}] ⏳ Still waiting for user creation to complete (${w * 1.2} s)...`);
                }
                await this.#delay(1000, 1300);
            } else {
                this.logger.info(`[${this.threadId}] ✅ User creation completed — credentials displayed`);
            }
        }
        if (!completed) {
            this.logger.warn(`[${this.threadId}] ⏱ Timed out waiting for credentials after ${filledCount} users — closing anyway`);
            const snippet = await this.page.evaluate(() => (document.body && document.body.innerText || '').slice(0, 400)).catch(() => '');
            this.logger.warn(`[${this.threadId}] 📋 Page text at timeout: ${snippet}`);
            await this.page.screenshot({ path: `bulkadd-fail-${this.threadId}.png` }).catch(() => {});
        } else if (!continueClicked) {
            this.logger.warn(`[${this.threadId}] ⚠️ Completion detected but Continue was never clicked — not counting as created`);
        }
        if (continueClicked && completed && filledCount > 0) {
            this.usersCreated += filledCount;
            this.logger.info(`[${this.threadId}] 🎉 Bulk add form submitted (${filledCount} users)`);
            return true;
        }
        this.logger.warn(`[${this.threadId}] ❌ Bulk add did not complete (filled:${filledCount}, continue:${continueClicked}, completed:${completed})`);
        return false;
    }

    async #selectOtherDomain(row, targetDomain) {
        const sel = `[data-bulk-row="${row}"][data-bulk-field="domain"]`;
        const norm = (s) => String(s || '')
            .toLowerCase()
            .replace(/^[@\s]+/, '')
            .replace(/[@\s]+$/, '')
            .replace(/[\u2713\u2714\u25cf\u25c9\u2717\u2715]/g, '')
            .trim();

        const currentDomain = await this.page.evaluate((row) => {
            const norm = (s) => String(s || '').toLowerCase().replace(/^@/, '').trim();
            const aliasEl = document.querySelector(`[data-bulk-row="${row}"][data-bulk-field="alias"]`);
            if (aliasEl) {
                const v = String(aliasEl.value || aliasEl.textContent || '');
                const at = v.lastIndexOf('@');
                if (at >= 0) return norm(v.slice(at + 1));
            }
            const trig = document.querySelector(`[data-bulk-row="${row}"][data-bulk-field="domain"]`);
            if (trig) return norm(trig.textContent || '');
            return '';
        }, row).catch(() => '');
        const pick = targetDomain ? norm(targetDomain) : '';
        this.logger.info(`[${this.threadId}] 🔎 Domain picker row ${row}: current="${currentDomain}"${pick ? ` target="${pick}"` : ' (auto: unused domain)'}`);

        const snapshot = () => this.page.evaluate((sel, cur, pick) => {
            const norm = (s) => String(s || '').toLowerCase().replace(/^@/, '').trim();
            const seen = new Set();
            const opts = [];
            [...document.querySelectorAll('[role="option"], [role="menuitem"], [role="listbox"] li, [role="listbox"] div')]
                .forEach(e => {
                    if (seen.has(e)) return; seen.add(e);
                    const r = e.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) opts.push(e);
                });
            if (!opts.length) return { open: 0, target: null, texts: [] };
            let target = null;
            if (pick) {
                target = opts.find(o => norm(o.textContent || '') === pick);
            } else {
                for (const o of opts) {
                    const t = norm(o.textContent || '');
                    if (t && t !== norm(cur) && t.includes('.')) { target = o; break; }
                }
            }
            if (!target) target = opts.find(o => norm(o.textContent || '') !== norm(cur)) || opts[0];
            target.scrollIntoView({ block: 'center' });
            const r = target.getBoundingClientRect();
            return {
                open: opts.length,
                target: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
                texts: opts.map(o => norm(o.textContent || '')).slice(0, 6),
            };
        }, sel, currentDomain, pick).catch(() => ({ open: 0, target: null, texts: [] }));

        const triggerCoords = () => this.page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, sel).catch(() => null);

        const verifyChanged = () => this.page.evaluate((sel, cur) => {
            const el = document.querySelector(sel);
            const norm = (s) => String(s || '').toLowerCase().replace(/^@/, '').trim();
            const t = el ? norm(el.textContent || '') : '';
            return t !== '' && t !== norm(cur);
        }, sel, currentDomain).catch(() => false);

        const clickTarget = async (state) => {
            await this.#delay(150, 300);
            await this.page.mouse.click(state.target.x, state.target.y);
            await this.#delay(400, 700);
            return await verifyChanged();
        };

        let lastState = 'no handle found';
        for (let attempt = 0; attempt < 4; attempt++) {
            const handle = await this.page.$(sel).catch(() => null);
            if (!handle) { lastState = 'domain element not found'; break; }
            const tag = await handle.evaluate(e => e.tagName).catch(() => '');

            if (tag === 'SELECT') {
                const picked = await this.page.evaluate((sel, cur, pick) => {
                    const el = document.querySelector(sel);
                    if (!el) return false;
                    const norm = (s) => String(s || '').toLowerCase().replace(/^@/, '').trim();
                    const opts = [...el.options];
                    let idx = -1;
                    if (pick) idx = opts.findIndex(o => norm(o.textContent || o.value || '') === pick);
                    if (idx < 0) {
                        for (let i = 0; i < opts.length; i++) {
                            const t = norm(opts[i].textContent || opts[i].value || '');
                            if (t && t !== norm(cur) && t.includes('.')) { idx = i; break; }
                        }
                    }
                    if (idx < 0) idx = Math.min(1, opts.length - 1);
                    el.value = opts[idx].value;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }, sel, currentDomain, pick).catch(() => false);
                await this.#delay(300, 500);
                return picked;
            }

            let state = await snapshot();
            if (state.target) {
                if (await clickTarget(state)) return true;
                lastState = 'option clicked but trigger domain did not change';
                continue;
            }

            const tcoords = await triggerCoords();
            if (!tcoords) { lastState = 'trigger not found'; break; }
            await this.#delay(120, 250);
            await this.page.mouse.click(tcoords.x, tcoords.y);
            await this.#delay(350, 600);

            state = await snapshot();
            if (state.target) {
                if (await clickTarget(state)) return true;
                lastState = 'option clicked but trigger domain did not change';
                continue;
            }
            lastState = `menu not open after trigger click (open:${state.open} texts:[${(state.texts || []).join(', ')}])`;
        }
        this.logger.warn(`[${this.threadId}] ⚠️ Domain picker row ${row} failed: ${lastState}`);
        return false;
    }

    #makeUsername() {
        const chars = 'abcdefghijklmnopqrstuvwxyz';
        const len = 8;
        let username;
        do {
            username = '';
            for (let i = 0; i < len; i++) {
                username += chars[Math.floor(Math.random() * chars.length)];
            }
        } while (this.usedUsernames.has(username));
        this.usedUsernames.add(username);
        return username;
    }

    async #cleanup() {
        if (this.heroActivationId && this.heroSms) { try { await this.heroSms.cancelActivation(this.heroActivationId); } catch { } this.heroActivationId = null; }
        if (this.browser) { try { await this.browser.close(); } catch { } this.browser = null; this.page = null; }
    }
}
