const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Generate TOTP (Time-based One-Time Password) from secret key
 * @param {string} secret - Base32 encoded secret key
 * @returns {string} 6-digit OTP code
 */
function generateTOTP(secret) {
    try {
        const base32 = require('thirty-two');
        const crypto = require('crypto');

        // Get current Unix timestamp
        const epoch = Math.floor(Date.now() / 1000);
        const timeStep = 30; // Google Authenticator uses 30-second intervals
        const counter = Math.floor(epoch / timeStep);

        // Create 8-byte buffer for counter
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64BE(BigInt(counter));

        // Decode base32 secret key (Google Authenticator uses base32, NOT base64!)
        const cleanSecret = String(secret).replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
        const secretBuffer = base32.decode(cleanSecret);

        // Generate HMAC-SHA1
        const hmac = crypto.createHmac('sha1', secretBuffer);
        hmac.update(buffer);
        const hash = hmac.digest();

        // Dynamic truncation
        const offset = hash[hash.length - 1] & 0x0f;
        const binary = ((hash[offset] & 0x7f) << 24) |
            ((hash[offset + 1] & 0xff) << 16) |
            ((hash[offset + 2] & 0xff) << 8) |
            (hash[offset + 3] & 0xff);

        // Generate 6-digit OTP
        const otp = (binary % 1000000).toString().padStart(6, '0');
        return otp;
    } catch (error) {
        throw new Error(`Failed to generate OTP: ${error.message}`);
    }
}

/**
 * Get secret key from SSH server
 * @param {string} email - Email address
 * @returns {Promise<string>} Secret key
 */
async function getSecretKeyFromSSH(email) {
    const { Client } = require('ssh2');

    return new Promise((resolve, reject) => {
        const conn = new Client();

        conn.on('ready', () => {
            const remotePath = `/home/brightmindscampus/${email}/${email}_authenticator_secret_key.txt`;
            console.log(`[OTP Generator] SSH connected. Fetching from: ${remotePath}`);

            conn.sftp((err, sftp) => {
                if (err) {
                    conn.end();
                    return reject(new Error(`SFTP error: ${err.message}`));
                }

                sftp.readFile(remotePath, 'utf8', (err, data) => {
                    conn.end();

                    if (err) {
                        return reject(new Error(`Failed to read secret key from SSH: ${err.message}`));
                    }

                    const secret = data.trim();
                    console.log(`[OTP Generator] Secret key fetched successfully (length: ${secret.length} chars)`);
                    console.log(`[OTP Generator] Secret key preview: ${secret.substring(0, 10)}...`);
                    resolve(secret);
                });
            });
        });

        conn.on('error', (err) => {
            reject(new Error(`SSH connection error: ${err.message}`));
        });

        // Connect to SSH server
        require('dotenv').config();
        conn.connect({
            host: process.env.SSH_HOST || '46.224.9.127',
            port: parseInt(process.env.SSH_PORT) || 22,
            username: process.env.SSH_USER || 'root',
            password: process.env.SSH_PASSWORD || 'JnsQ3G98JU027QP'
        });
    });
}

/**
 * Get OTP for a specific email account (fetches from SSH server)
 * @param {string} email - Email address
 * @returns {Promise<string>} 6-digit OTP code
 */
async function getOTPForAccount(email) {
    try {
        // 1. Check LOCAL file first
        const localPath = path.join(__dirname, 'secrets', `${email}_secret.txt`);
        if (fs.existsSync(localPath)) {
            console.log(`[OTP Generator] Found local secret key at: ${localPath}`);
            const secret = fs.readFileSync(localPath, 'utf8').trim();
            if (secret) {
                const otp = generateTOTP(secret);
                console.log(`[OTP Generator] Generated OTP for ${email}: ${otp}`);
                return otp;
            }
        }

        // 2. Fetch from SSH if not found locally
        console.log(`[OTP Generator] Local key not found. Fetching secret key from SSH server for ${email}...`);
        const secret = await getSecretKeyFromSSH(email);

        if (!secret) {
            throw new Error(`Secret key is empty for ${email}`);
        }

        const otp = generateTOTP(secret);
        console.log(`[OTP Generator] Generated OTP for ${email}: ${otp}`);
        console.log(`[OTP Generator] Valid for next ${30 - (Math.floor(Date.now() / 1000) % 30)} seconds`);

        return otp;
    } catch (error) {
        console.error(`[OTP Generator] Error: ${error.message}`);
        throw error;
    }
}

/**
 * List all accounts that have secret keys
 * @returns {string[]} Array of email addresses
 */
function listAccounts() {
    const secretsDir = path.join(__dirname, 'secrets');

    if (!fs.existsSync(secretsDir)) {
        console.log('[OTP Generator] No secrets directory found');
        return [];
    }

    const files = fs.readdirSync(secretsDir);
    const accounts = files
        .filter(file => file.endsWith('_secret.txt'))
        .map(file => file.replace('_secret.txt', ''));

    return accounts;
}

// CLI Usage
if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Usage:');
        console.log('  node generateOTP.cjs <email>           - Generate OTP for specific account');
        console.log('  node generateOTP.cjs --list            - List all accounts with secret keys');
        console.log('');
        console.log('Examples:');
        console.log('  node generateOTP.cjs contact@example.com');
        console.log('  node generateOTP.cjs --list');
        process.exit(1);
    }

    if (args[0] === '--list' || args[0] === '-l') {
        console.log('[OTP Generator] Available accounts:');
        const accounts = listAccounts();
        if (accounts.length === 0) {
            console.log('  No accounts found');
        } else {
            accounts.forEach(account => console.log(`  - ${account}`));
        }
    } else {
        const email = args[0];
        (async () => {
            try {
                const otp = await getOTPForAccount(email);
                console.log('');
                console.log('═══════════════════════════════════');
                console.log(`  OTP CODE: ${otp}`);
                console.log('═══════════════════════════════════');
            } catch (error) {
                console.error(`Failed to generate OTP: ${error.message}`);
                process.exit(1);
            }
        })();
    }
}

// Export for use in other modules
module.exports = {
    generateTOTP,
    getOTPForAccount,
    listAccounts
};
