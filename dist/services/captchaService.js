var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _CaptchaService_instances, _CaptchaService_waitForSolution;
import axios from 'axios';
class CaptchaService {
    constructor(apiKey) {
        _CaptchaService_instances.add(this);
        this.apiKey = apiKey;
        this.baseUrl = 'http://2captcha.com';
    }
    async getBalance() {
        try {
            const response = await axios.get(`${this.baseUrl}/res.php`, {
                params: {
                    key: this.apiKey,
                    action: 'getbalance',
                    json: 1
                }
            });
            if (response.data.status === 1) {
                return parseFloat(response.data.request);
            }
            throw new Error(`Failed to get balance: ${response.data.request}`);
        }
        catch (error) {
            console.error('Captcha Service Error (getBalance):', error.message);
            return 0;
        }
    }
    async solveRecaptchaV2(siteKey, pageUrl) {
        try {
            console.log('🧩 Sending reCAPTCHA to 2Captcha...');
            // Step 1: Request to solve
            const response = await axios.get(`${this.baseUrl}/in.php`, {
                params: {
                    key: this.apiKey,
                    method: 'userrecaptcha',
                    googlekey: siteKey,
                    pageurl: pageUrl,
                    json: 1
                }
            });
            if (response.data.status !== 1) {
                throw new Error(`2Captcha Request Failed: ${response.data.request}`);
            }
            const requestId = response.data.request;
            console.log(`🧩 Captcha queued. ID: ${requestId}`);
            // Step 2: Poll for solution
            return await __classPrivateFieldGet(this, _CaptchaService_instances, "m", _CaptchaService_waitForSolution).call(this, requestId);
        }
        catch (error) {
            console.error('Captcha Service Error (solveRecaptchaV2):', error.message);
            return { success: false, error: error.message };
        }
    }
    async solveImageCaptcha(base64Image) {
        try {
            console.log('🧩 Sending Image Captcha to 2Captcha...');
            const response = await axios.post(`${this.baseUrl}/in.php`, {
                key: this.apiKey,
                method: 'base64',
                body: base64Image,
                json: 1
            });
            if (response.data.status !== 1) {
                throw new Error(`2Captcha Request Failed: ${response.data.request}`);
            }
            const requestId = response.data.request;
            console.log(`🧩 Captcha queued. ID: ${requestId}`);
            return await __classPrivateFieldGet(this, _CaptchaService_instances, "m", _CaptchaService_waitForSolution).call(this, requestId);
        }
        catch (error) {
            console.error('Captcha Service Error (solveImageCaptcha):', error.message);
            return { success: false, error: error.message };
        }
    }
}
_CaptchaService_instances = new WeakSet(), _CaptchaService_waitForSolution = async function _CaptchaService_waitForSolution(requestId, timeoutSeconds = 120) {
    const startTime = Date.now();
    const pollInterval = 5000; // 5 seconds
    while (Date.now() - startTime < timeoutSeconds * 1000) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        try {
            const response = await axios.get(`${this.baseUrl}/res.php`, {
                params: {
                    key: this.apiKey,
                    action: 'get',
                    id: requestId,
                    json: 1
                }
            });
            if (response.data.status === 1) {
                return { success: true, solution: response.data.request };
            }
            if (response.data.request === 'CAPCHA_NOT_READY') {
                process.stdout.write('.');
                continue;
            }
            if (response.data.request.includes('ERROR')) {
                return { success: false, error: response.data.request };
            }
        }
        catch (error) {
            console.error(`Error polling captcha: ${error.message}`);
        }
    }
    return { success: false, error: 'TIMEOUT' };
};
export default CaptchaService;
