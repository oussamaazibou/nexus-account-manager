import { authenticator } from 'otplib';
console.log('authenticator:', authenticator);
if (authenticator) {
    const secret = 'JBSWY3DPEHPK3PXP';
    console.log('Code:', authenticator.generate(secret));
}
