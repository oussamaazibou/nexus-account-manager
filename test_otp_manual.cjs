const thirtyTwo = require('thirty-two');
const crypto = require('crypto');

function generateTOTP(secret) {
    const key = thirtyTwo.decode(secret);
    const time = Math.floor(Date.now() / 1000 / 30);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeUInt32BE(0, 0);
    timeBuffer.writeUInt32BE(time, 4);

    const hmac = crypto.createHmac('sha1', key);
    hmac.update(timeBuffer);
    const hmacResult = hmac.digest();

    const offset = hmacResult[hmacResult.length - 1] & 0xf;
    const code = (
        ((hmacResult[offset] & 0x7f) << 24) |
        ((hmacResult[offset + 1] & 0xff) << 16) |
        ((hmacResult[offset + 2] & 0xff) << 8) |
        (hmacResult[offset + 3] & 0xff)
    ) % 1000000;

    return code.toString().padStart(6, '0');
}

console.log('TOTP:', generateTOTP('JBSWY3DPEHPK3PXP'));
