
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
            const resp = await axios.get(`${this.baseUrl}/dns`, { headers: this.headers(), timeout: 15000 });
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
            const resp = await axios.get(`${this.baseUrl}/dns/getroot/${encodeURIComponent(domain)}`, { headers: this.headers(), timeout: 15000 });
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

    /**
     * Create a Dynamic DNS host (managed domain) in Dynu for `hostname`.
     * This is the API equivalent of "Add Dynamic DNS" in the Dynu dashboard.
     * Returns { success, zoneId, hostname, already, error }.
     */
    async createHost(hostname) {
        try {
            const resp = await axios.post(`${this.baseUrl}/dns`, {
                name: hostname,
                group: '',
                state: true,
                ipv4Address: '',
                ipv6Address: ''
            }, { headers: this.headers(), timeout: 15000 });
            const data = this.unwrap(resp);
            return { success: true, zoneId: data.id, hostname: data.name, already: false, record: data };
        } catch (e) {
            const msg = String(e.message || '').toLowerCase();
            if (msg.includes('exist') || msg.includes('conflict') || msg.includes('duplicate') || msg.includes('already')) {
                return { success: true, already: true, error: e.message };
            }
            return { success: false, error: e.message };
        }
    }

    /**
     * Ensure the Dynamic DNS host exists for `hostname`.
     * Checks the zone list for an exact-name match first (getroot resolves the
     * parent zone, so it cannot tell whether the subdomain host itself exists),
     * then creates it via POST /dns. Re-checks after a create failure in case
     * of a race. Returns { success, zoneId, hostname, already, error }.
     */
    async ensureHost(hostname) {
        const lower = String(hostname).toLowerCase();
        const match = (zones) => zones.find(z => String(z.name).toLowerCase() === lower);
        const existing = match(await this.listZones());
        if (existing) return { success: true, already: true, zoneId: existing.id, hostname: existing.name };

        const created = await this.createHost(lower);
        if (created.success) return created;

        const nowExisting = match(await this.listZones());
        if (nowExisting) return { success: true, already: true, zoneId: nowExisting.id, hostname: nowExisting.name };
        return created;
    }

    async listRecords(zoneId, recordType) {
        try {
            const resp = await axios.get(`${this.baseUrl}/dns/${zoneId}/record`, {
                headers: this.headers(),
                params: { recordType },
                timeout: 15000
            });
            const records = this.unwrap(resp).dnsRecords || [];
            return records.filter(r => r.recordType === recordType);
        } catch (e) {
            console.error(`Dynu Service Error (list${recordType}Records):`, e.message);
            return [];
        }
    }

    async listTxtRecords(zoneId) {
        return this.listRecords(zoneId, 'TXT');
    }

    async listMxRecords(zoneId) {
        return this.listRecords(zoneId, 'MX');
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
            }, { headers: this.headers(), timeout: 15000 });
            const data = this.unwrap(resp);
            return { success: true, record: data };
        } catch (e) {
            console.error('Dynu Service Error (addTxtRecord):', e.message);
            return { success: false, error: e.message };
        }
    }

    async addMxRecord(zoneId, nodeName, host, priority = 1) {
        try {
            const resp = await axios.post(`${this.baseUrl}/dns/${zoneId}/record`, {
                nodeName: nodeName || '',
                recordType: 'MX',
                host,
                priority,
                ttl: 300,
                state: true,
                group: ''
            }, { headers: this.headers(), timeout: 15000 });
            const data = this.unwrap(resp);
            return { success: true, record: data };
        } catch (e) {
            console.error('Dynu Service Error (addMxRecord):', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Upsert an MX record pointing `recordName` at `host` with `priority`.
     * No-op when an identical MX already exists; otherwise replaces any stale
     * MX at the same node.
     */
    async upsertMx(recordName, host, priority = 1) {
        const resolved = await this.findZoneId(recordName);
        if (!resolved) return { success: false, error: `No Dynu zone found for ${recordName}` };

        const { zoneId, node } = resolved;
        const records = await this.listMxRecords(zoneId);
        const lowerName = recordName.toLowerCase();
        const matches = records.filter(r => {
            const hostname = (r.hostname || '').toLowerCase();
            const n = (r.nodeName || '').toLowerCase();
            return hostname === lowerName || (node ? n === node.toLowerCase() : n === '');
        });

        const existing = matches.find(r =>
            String(r.host || '').toUpperCase() === String(host).toUpperCase() &&
            Number(r.priority) === Number(priority)
        );
        if (existing) return { success: true, provider: 'dynu', zoneId, already: true };

        for (const rec of matches) {
            await this.deleteRecord(zoneId, rec.id);
        }

        const added = await this.addMxRecord(zoneId, node, host, priority);
        if (!added.success) return { success: false, error: added.error };
        return { success: true, provider: 'dynu', zoneId };
    }

    async deleteRecord(zoneId, recordId) {
        try {
            await axios.delete(`${this.baseUrl}/dns/${zoneId}/record/${recordId}`, { headers: this.headers(), timeout: 15000 });
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
