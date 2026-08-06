const otplib = require('otplib');
const secret = 'JBSWY3DPEHPK3PXP';

async function test() {
    try {
        const token = await otplib.generate(secret);
        console.log('Token:', token);
    } catch (e) {
        console.log('Error:', e);
    }
}
test();
