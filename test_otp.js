const otplib = require('otplib');
console.log('otplib:', otplib);
console.log('authenticator:', otplib.authenticator);

try {
    const { authenticator } = require('otplib');
    console.log('{ authenticator }:', authenticator);
} catch (e) {
    console.log('Destructuring error:', e.message);
}
