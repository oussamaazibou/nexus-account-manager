
import axios from 'axios';

export default class CloudflareService {
    constructor(email, apiKey) {
        this.email = email;
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.cloudflare.com/client/v4';
    }

    async getZoneId(domain) {
        try {
            // Query Cloudflare with exactly the domain passed in (no internal slicing).
            // The caller is responsible for passing the correct zone candidate.
            console.log(`☁️  Fetching Zone ID for: ${domain}`);

            const response = await axios.get(`${this.baseUrl}/zones`, {
                headers: {
                    'X-Auth-Email': this.email,
                    'X-Auth-Key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                params: {
                    name: domain,
                    status: 'active'
                },
                timeout: 15000
            });

            if (response.data.success && response.data.result.length > 0) {
                return response.data.result[0].id;
            }

            throw new Error(`Zone not found for domain: ${domain}`);
        } catch (error) {
            console.error('Cloudflare Service Error (getZoneId):', error.message);
            return null;
        }
    }

    async addTxtRecord(zoneId, recordName, content) {
        try {
            console.log(`☁️  Adding TXT record to Zone ${zoneId}: ${recordName} -> ${content}`);

            const response = await axios.post(`${this.baseUrl}/zones/${zoneId}/dns_records`, {
                type: 'TXT',
                name: recordName,
                content: content,
                ttl: 120 // Auto or low TTL
            }, {
                headers: {
                    'X-Auth-Email': this.email,
                    'X-Auth-Key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            });

            if (response.data.success) {
                return { success: true, result: response.data.result };
            }

            throw new Error(`Failed to add record: ${JSON.stringify(response.data.errors)}`);
        } catch (error) {
            // Check if record already exists error
            if (error.response && error.response.data && error.response.data.errors) {
                const errorMsg = JSON.stringify(error.response.data.errors);
                console.error('Cloudflare API Error:', errorMsg);
                return { success: false, error: errorMsg };
            }
            console.error('Cloudflare Service Error (addTxtRecord):', error.message);
            return { success: false, error: error.message };
        }
    }

    async upsertTxt(zoneId, recordName, token) {
        try {
            console.log(`☁️  Upserting TXT record ${recordName} -> ${token}`);

            // List existing TXT records for this exact name
            const listRes = await axios.get(`${this.baseUrl}/zones/${zoneId}/dns_records`, {
                headers: {
                    'X-Auth-Email': this.email,
                    'X-Auth-Key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                params: { type: 'TXT', name: recordName },
                timeout: 15000
            });
            const existing = (listRes.data.result || []).find(r => r.content === token);
            if (existing) return { success: true, already: true };

            // Remove any stale google-site-verification record for this name first
            const old = (listRes.data.result || []).find(r => r.content.startsWith('google-site-verification='));
            if (old) {
                await axios.delete(`${this.baseUrl}/zones/${zoneId}/dns_records/${old.id}`, {
                    headers: {
                        'X-Auth-Email': this.email,
                        'X-Auth-Key': this.apiKey,
                        'Content-Type': 'application/json'
                    },
                    timeout: 15000
                }).catch(() => {});
            }

            return this.addTxtRecord(zoneId, recordName, token);
        } catch (error) {
            console.error('Cloudflare Service Error (upsertTxt):', error.message);
            return { success: false, error: error.message };
        }
    }

    async addMxRecord(zoneId, recordName, mailServer, priority = 1) {
        try {
            console.log(`☁️  Adding MX record to Zone ${zoneId}: ${recordName} -> ${mailServer} (Priority: ${priority})`);

            const response = await axios.post(`${this.baseUrl}/zones/${zoneId}/dns_records`, {
                type: 'MX',
                name: recordName,
                content: mailServer,
                priority: priority,
                ttl: 120
            }, {
                headers: {
                    'X-Auth-Email': this.email,
                    'X-Auth-Key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            });

            if (response.data.success) {
                return { success: true, result: response.data.result };
            }

            throw new Error(`Failed to add MX record: ${JSON.stringify(response.data.errors)}`);
        } catch (error) {
            if (error.response && error.response.data && error.response.data.errors) {
                const errorMsg = JSON.stringify(error.response.data.errors);
                console.error('Cloudflare API Error:', errorMsg);
                return { success: false, error: errorMsg };
            }
            console.error('Cloudflare Service Error (addMxRecord):', error.message);
            return { success: false, error: error.message };
        }
    }
}
