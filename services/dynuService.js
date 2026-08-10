
import axios from 'axios';

/**
 * Dynu DNS REST client (https://api.dynu.com/v2).
 *
 * Auth is the `API-Key` header. Zone ids are integers. Every response is
 * wrapped in `{ statusCode, ... }` and errors come back as HTTP 200 with a
 * body like `{ exception: { statusCode, type, message } }`.
 *
 * For Google Workspace domain verification we only need TXT records:
 *   GET  /dns/getroot/{hostname}        -> resolve the zone for a hostname
 *   GET  /dns/{id}/record?recordType=TXT -> list TXT records
 *   POST /dns/{id}/record                -> add record (nodeName/recordType/textData)
 *   DELETE /dns/{id}/record/{dnsRecordId}
 */
export default class DynuService {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.dynu.com/v2';
    }

    headers() {
        return {
            'API-Key': this.apiKey,
            'Content-Type': 'application/json',
            accept: 'application/json'
        };
    }

    unwrap(resp) {
        if (resp.data && resp.data.exception) {
            const e = new Error(resp.data.exception.message || 'Dynu API error');
            e.dynu = resp.data.exception;
            throw e;
        }
        return resp.data;
    }

    async listZones() {
        try {
            const resp = await axios.get(`${this.baseUrl}/dns`, { headers: this.headers() });
            return this.unwrap(resp).domains || [];
        } catch (e) {
            console.error('Dynu Service Error (listZones):', e.message);
            return [];
        }
    }

    /**
     * Resolve the zone that hosts `domain` and the node name relative to it.
     * Returns { zoneId, zoneName, node } or null when Dynu does not manage it.
     */
    async findZoneId(domain) {
        // 1) getroot resolves subdomains natively (covers unique subdomains).
        try {
            const resp = await axios.get(`${this.baseUrl}/dns/getroot/${encodeURIComponent(domain)}`, { headers: this.headers() });
            const data = this.unwrap(resp);
            if (data && data.id) {
                return { zoneId: data.id, zoneName: data.domainName, node: data.node || '' };
            }
        } catch (e) {
            console.error('Dynu Service Error (getroot):', e.message);
        }

        // 2) Fallback: match the deepest parent zone present in the zone list.
        const zones = await this.listZones();
        const parts = domain.toLowerCase().split('.');
        for (let i = 0; i < parts.length - 1; i++) {
            const candidate = parts.slice(i).join('.');
            const zone = zones.find(z => String(z.name).toLowerCase() === candidate);
            if (zone) {
                return { zoneId: zone.id, zoneName: zone.name, node: parts.slice(0, i).join('.') };
            }
        }
        return null;
    }

    async listTxtRecords(zoneId) {
        try {
            const resp = await axios.get(`${this.baseUrl}/dns/${zoneId}/record`, {
                headers: this.headers(),
                params: { recordType: 'TXT' }
            });
            const records = this.unwrap(resp).dnsRecords || [];
            return records.filter(r => r.recordType === 'TXT');
        } catch (e) {
            console.error('Dynu Service Error (listTxtRecords):', e.message);
            return [];
        }
    }

    async addTxtRecord(zoneId, nodeName, textData) {
        try {
            const resp = await axios.post(`${this.baseUrl}/dns/${zoneId}/record`, {
                nodeName: nodeName || '',
                recordType: 'TXT',
                textData,
                ttl: 300,
                state: true,
                group: ''
            }, { headers: this.headers() });
            const data = this.unwrap(resp);
            return { success: true, record: data };
        } catch (e) {
            console.error('Dynu Service Error (addTxtRecord):', e.message);
            return { success: false, error: e.message };
        }
    }

    async deleteRecord(zoneId, recordId) {
        try {
            await axios.delete(`${this.baseUrl}/dns/${zoneId}/record/${recordId}`, { headers: this.headers() });
            return true;
        } catch (e) {
            console.error('Dynu Service Error (deleteRecord):', e.message);
            return false;
        }
    }

    /**
     * Upsert a google-site-verification TXT record at the given hostname:
     * no-op when the exact token already exists, otherwise remove any stale
     * google-site-verification= record for the hostname and add the new one.
     */
    async upsertTxt(recordName, token) {
        const resolved = await this.findZoneId(recordName);
        if (!resolved) return { success: false, error: `No Dynu zone found for ${recordName}` };

        const { zoneId, node } = resolved;
        const records = await this.listTxtRecords(zoneId);
        const lowerName = recordName.toLowerCase();
        const matches = records.filter(r => {
            const host = (r.hostname || '').toLowerCase();
            const n = (r.nodeName || '').toLowerCase();
            return host === lowerName || (node ? n === node.toLowerCase() : n === '');
        });

        const existing = matches.find(r => String(r.textData || '').trim() === token);
        if (existing) return { success: true, provider: 'dynu', zoneId, already: true };

        for (const rec of matches) {
            if (String(rec.textData || '').startsWith('google-site-verification=')) {
                await this.deleteRecord(zoneId, rec.id);
            }
        }

        const added = await this.addTxtRecord(zoneId, node, token);
        if (!added.success) return { success: false, error: added.error };
        return { success: true, provider: 'dynu', zoneId };
    }
}
