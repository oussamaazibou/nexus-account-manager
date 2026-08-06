const { TOTP } = require('otplib');
const secret = 'JBSWY3DPEHPK3PXP';

async function test() {
    try {
        const totp = new TOTP({ secret });
        console.log('TOTP instance created.');
        // Try calculate method? Or generate?
        // In some libraries, generate() works if secret is set.
        // Or generate(secret)?

        // Try different methods
        try { console.log('generate({ secret }):', await totp.generate({ secret })); } catch (e) { console.log('generate({ secret }) failed:', e.message); }
        try { console.log('generate(secret):', await totp.generate(secret)); } catch (e) { console.log('generate(secret) failed:', e.message); }

    } catch (e) {
        console.log('Error:', e);
    }
}
test();
