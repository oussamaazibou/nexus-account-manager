const { TOTP } = require('otplib');
const secret = 'JBSWY3DPEHPK3PXP'; // Base32 secret

try {
    const totp = new TOTP();
    console.log('TOTP Code:', totp.generate(secret));
} catch (e) {
    console.log('Error:', e.message);
}
