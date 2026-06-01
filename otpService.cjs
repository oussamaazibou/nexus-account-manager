const express = require('express');
const { getOTPForAccount, listAccounts } = require('./generateOTP.cjs');

const app = express();
const PORT = process.env.OTP_SERVICE_PORT || 3001;

// Middleware
app.use(express.json());

// CORS for local development
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

/**
 * GET /otp/:email
 * Generate OTP for specific account
 */
app.get('/otp/:email', (req, res) => {
    try {
        const email = req.params.email;
        console.log(`[OTP Service] Request for OTP: ${email}`);

        const otp = getOTPForAccount(email);
        const validFor = 30 - (Math.floor(Date.now() / 1000) % 30);

        res.json({
            success: true,
            email: email,
            otp: otp,
            validFor: validFor,
            expiresAt: new Date(Date.now() + (validFor * 1000)).toISOString()
        });
    } catch (error) {
        console.error(`[OTP Service] Error: ${error.message}`);
        res.status(404).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /accounts
 * List all accounts with secret keys
 */
app.get('/accounts', (req, res) => {
    try {
        const accounts = listAccounts();
        res.json({
            success: true,
            count: accounts.length,
            accounts: accounts
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        success: true,
        service: 'OTP Generator Service',
        status: 'running',
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  🔐 OTP Generator Service`);
    console.log(`  📡 Running on: http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════════════════════');
    console.log('');
    console.log('Available endpoints:');
    console.log(`  GET  /otp/:email     - Generate OTP for account`);
    console.log(`  GET  /accounts       - List all accounts`);
    console.log(`  GET  /health         - Health check`);
    console.log('');
    console.log('Examples:');
    console.log(`  curl http://localhost:${PORT}/otp/contact@example.com`);
    console.log(`  curl http://localhost:${PORT}/accounts`);
    console.log('');
});

module.exports = app;
