import axios from 'axios';

export default class SMSService {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://hero-sms.com/stubs/handler_api.php';
        this.service = 'go'; // 'go' is typically for Google/Gmail
    }

    async getBalance() {
        try {
            const response = await axios.get(this.baseUrl, {
                params: {
                    api_key: this.apiKey,
                    action: 'getBalance'
                }
            });

            if (response.data.includes('ACCESS_BALANCE')) {
                return parseFloat(response.data.split(':')[1]);
            }
            throw new Error(`Failed to get balance: ${response.data}`);
        } catch (error) {
            console.error('SMS Service Error (getBalance):', error.message);
            throw error;
        }
    }

    async getNumber(country = '0') { // 0 is usually random/default or Russia, check provider defaults
        try {
            // Ref: https://hero-sms.com/api (Standard SMS-Activate)
            const response = await axios.get(this.baseUrl, {
                params: {
                    api_key: this.apiKey,
                    action: 'getNumber',
                    service: this.service,
                    country: country
                }
            });

            // Expected response: ACCESS_NUMBER:$id:$number
            const data = response.data;
            if (data.includes('ACCESS_NUMBER')) {
                const parts = data.split(':');
                return {
                    success: true,
                    id: parts[1],
                    number: parts[2]
                };
            } else if (data === 'NO_NUMBERS') {
                return { success: false, error: 'NO_NUMBERS' };
            } else if (data === 'NO_BALANCE') {
                return { success: false, error: 'NO_BALANCE' };
            }

            throw new Error(`Unexpected response for getNumber: ${data}`);

        } catch (error) {
            console.error('SMS Service Error (getNumber):', error.message);
            return { success: false, error: error.message };
        }
    }

    async checkStatus(activationId) {
        try {
            const response = await axios.get(this.baseUrl, {
                params: {
                    api_key: this.apiKey,
                    action: 'getStatus',
                    id: activationId
                }
            });
            return response.data;
        } catch (error) {
            console.error(`[SMS] checkStatus error: ${error.message}`);
            return 'ERROR';
        }
    }

    async waitForCode(activationId, timeoutSeconds = 120) {
        const startTime = Date.now();
        const pollInterval = 5000; // 5 seconds

        while (Date.now() - startTime < timeoutSeconds * 1000) {
            const status = await this.checkStatus(activationId);

            if (status.includes('STATUS_OK')) {
                return { success: true, code: status.split(':')[1] };
            } else if (status === 'STATUS_CANCEL') {
                return { success: false, error: 'Activation cancelled' };
            } else if (status === 'STATUS_WAIT_CODE') {
                // Continue waiting
            } else {
                console.log(`[SMS] Status: ${status}`);
            }

            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        return { success: false, error: 'TIMEOUT' };
    }

    async setStatus(activationId, status) {
        // Status 1: Inform service that number is ready (sometimes needed)
        // Status 3: Request another code (if first one didn't work)
        // Status 6: Confirmation acts info (Code received and verified)
        // Status 8: Cancel activation
        try {
            const response = await axios.get(this.baseUrl, {
                params: {
                    api_key: this.apiKey,
                    action: 'setStatus',
                    id: activationId,
                    status: status
                }
            });
            return response.data;
        } catch (error) {
            console.error(`[SMS] setStatus error: ${error.message}`);
            return null;
        }
    }

    async cancelNumber(activationId) {
        return this.setStatus(activationId, 8);
    }

    async confirmSuccess(activationId) {
        return this.setStatus(activationId, 6);
    }
}
