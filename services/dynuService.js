
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
     * Dynu free dynamic-DNS top-level domains (e.g. dynu.com, dynu.net,
     * dynuddns.net, ...). The apex of these belongs to Dynu itself, so an
     * account never owns a bare matching zone — each created host is its own
     * zone. Used to detect that Dynu manages a domain before the host exists.
     */
    async listTopLevels() {
        try {
            const resp = await axios.get(`${this.baseUrl}/dns/toplevel`, { headers: this.headers(), timeout: 15000 });
            return this.unwrap(resp).topLevels || [];
        } catch (e) {
            console.error('Dynu Service Error (listTopLevels):', e.message);
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
     * Detect the server's current public IPv4 address (used for the host's
     * A record). Returns null when all sources fail.
     */
    async getPublicIp() {
        const urls = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://checkip.amazonaws.com'];
        for (const url of urls) {
            try {
                const resp = await axios.get(url, { timeout: 10000 });
                const ip = String(resp.data || '').trim().split('\n')[0].trim();
                if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip;
            } catch (e) { /* try next source */ }
        }
        return null;
    }

    /**
     * Create a Dynamic DNS host (managed domain) in Dynu for `hostname`.
     * This is the API equivalent of "Add Dynamic DNS" in the Dynu dashboard.
     * Enables Wildcard IPv4/IPv6 aliases and the IPv6 toggle, and (when an IP
     * is supplied) creates the host's A record pointing at it. Dynu rejects
     * partial payloads with HTTP 501 "Argument Exception" (their validation
     * error), so a full writable-fields payload is sent first.
     * Returns { success, zoneId, hostname, already, method, error }.
     */
    async createHost(hostname, ipv4Address = null) {
        const hasIp = !!ipv4Address;
        const attempts = [
            {
                label: 'full',
                body: {
                    name: hostname,
                    group: '',
                    // Only include ipv4 fields when a real address is known —
                    // never write a fake 0.0.0.0 A record into Dynu.
                    ...(hasIp ? {
                        ipv4Address,
                        ipv4: true,
                        ipv4WildcardAlias: true
                    } : {}),
                    ipv6Address: '',
                    ttl: 300,
                    ipv6: true,
                    ipv6WildcardAlias: true,
                    allowZoneTransfer: false,
                    dnssec: false
                }
            },
            {
                label: 'minimal',
                body: {
                    name: hostname,
                    group: '',
                    ttl: 300
                }
            }
        ];
        let lastError = '';
        for (const { label, body } of attempts) {
            try {
                const resp = await axios.post(`${this.baseUrl}/dns`, body, { headers: this.headers(), timeout: 15000 });
                const data = this.unwrap(resp);
                const id = data && (data.id ?? (data.domains?.[0]?.id ?? null));
                if (id) {
                    return { success: true, zoneId: id, hostname: data.name || hostname, already: false, method: `POST /dns (${label})`, record: data };
                }
                lastError += `${label} -> no id in response: ${JSON.stringify(data)}; `;
            } catch (e) {
                const ex = e.dynu || e.response?.data?.exception;
                const bodyStr = e.response?.data ? JSON.stringify(e.response.data) : '';
                const detail = ex
                    ? `[${ex.statusCode} ${ex.type}] ${ex.message}`
                    : `HTTP ${e.response?.status || '?'} ${bodyStr || e.message}`;
                const low = (String(ex?.message || '') + ' ' + bodyStr + ' ' + String(e.message)).toLowerCase();
                if (low.includes('exist') || low.includes('conflict') || low.includes('duplicate') || low.includes('already')) {
                    return { success: true, already: true, method: `POST /dns (${label})`, error: detail };
                }
                lastError += `${label} -> ${detail}; `;
            }
        }
        return { success: false, error: lastError.trim() };
    }

    /**
     * Ensure the Dynamic DNS host exists for `hostname`.
     * Checks the zone list for an exact-name match first (getroot resolves the
     * parent zone, so it cannot tell whether the subdomain host itself exists),
     * then creates it via POST /dns. Re-checks after a create failure in case
     * of a race. When `ipv4Address` is supplied, also points the host's A
     * record at that IP. Returns { success, zoneId, hostname, already,
     * aRecord?, error }.
     */
    async ensureHost(hostname, ipv4Address = null) {
        const lower = String(hostname).toLowerCase();
        // When no IP is given, resolve the server's public IP automatically so
        // the host's A record always points at where the app is actually
        // running (never a placeholder like 0.0.0.0).
        if (!ipv4Address) {
            ipv4Address = await this.getPublicIp();
        }
        const match = (zones) => zones.find(z => String(z.name).toLowerCase() === lower);
        const existing = match(await this.listZones());
        let zoneId = existing ? existing.id : null;
        let already = !!existing;
        if (!existing) {
            const created = await this.createHost(lower, ipv4Address);
            if (created.success) {
                zoneId = created.zoneId;
                already = !!created.already;
            } else {
                const nowExisting = match(await this.listZones());
                if (nowExisting) {
                    zoneId = nowExisting.id;
                    already = true;
                } else {
                    return created;
                }
            }
        }

        let aRecord = null;
        if (zoneId && ipv4Address) {
            const aRes = await this.upsertARecord(zoneId, lower, ipv4Address);
            aRecord = aRes.success
                ? { already: !!aRes.already, ip: ipv4Address }
                : { error: aRes.error };
        }
        return { success: true, zoneId, hostname: lower, already, aRecord };
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

    /**
     * List every DNS record in a zone (all types).
     * Used by the Dynu domain manager UI.
     */
    async listAllRecords(zoneId) {
        try {
            const resp = await axios.get(`${this.baseUrl}/dns/${zoneId}/record`, {
                headers: this.headers(),
                timeout: 15000
            });
            return this.unwrap(resp).dnsRecords || [];
        } catch (e) {
            console.error('Dynu Service Error (listAllRecords):', e.message);
            return [];
        }
    }

    /**
     * Add an arbitrary DNS record to a zone. `record` must contain
     * `recordType` plus the type-specific fields (nodeName, textData,
     * ipv4Address, ipv6Address, host, priority, port, weight, ...).
     * Used by the Dynu domain manager UI.
     */
    async addRecord(zoneId, record) {
        try {
            const resp = await axios.post(`${this.baseUrl}/dns/${zoneId}/record`, {
                nodeName: record.nodeName || '',
                recordType: record.recordType,
                ttl: record.ttl ?? 300,
                state: record.state ?? true,
                group: record.group || '',
                ...record.body
            }, { headers: this.headers(), timeout: 15000 });
            const data = this.unwrap(resp);
            return { success: true, record: data };
        } catch (e) {
            const ex = e.dynu || e.response?.data?.exception;
            const detail = ex
                ? `[${ex.statusCode} ${ex.type}] ${ex.message}`
                : `HTTP ${e.response?.status || '?'} ${JSON.stringify(e.response?.data || {}) || e.message}`;
            console.error('Dynu Service Error (addRecord):', detail);
            return { success: false, error: detail };
        }
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
        let resolved = await this.findZoneId(recordName);
        if (!resolved) {
            for (let i = 0; i < 3 && !resolved; i++) {
                await new Promise(r => setTimeout(r, 1500));
                resolved = await this.findZoneId(recordName);
            }
        }
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
     * Remove a domain entirely from Dynu DNS service (DELETE /dns/{id}).
     * Deletes the zone and all of its records.
     */
    async deleteZone(zoneId) {
        try {
            await axios.delete(`${this.baseUrl}/dns/${zoneId}`, { headers: this.headers(), timeout: 15000 });
            return true;
        } catch (e) {
            console.error('Dynu Service Error (deleteZone):', e.message);
            return false;
        }
    }

    async addARecord(zoneId, nodeName, ipv4Address) {
        try {
            const resp = await axios.post(`${this.baseUrl}/dns/${zoneId}/record`, {
                nodeName: nodeName || '',
                recordType: 'A',
                ipv4Address,
                ttl: 300,
                state: true,
                group: ''
            }, { headers: this.headers(), timeout: 15000 });
            const data = this.unwrap(resp);
            return { success: true, record: data };
        } catch (e) {
            console.error('Dynu Service Error (addARecord):', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Point the A record at the host root at `ipv4Address`. No-op when an
     * identical A record exists; otherwise replaces any stale A at the node.
     */
    async upsertARecord(zoneId, hostname, ipv4Address) {
        const records = await this.listRecords(zoneId, 'A');
        const lowerName = hostname.toLowerCase();
        const matches = records.filter(r => {
            const host = (r.hostname || '').toLowerCase();
            const n = (r.nodeName || '').toLowerCase();
            return host === lowerName || n === '';
        });
        const existing = matches.find(r => {
            const ip = String(r.ipv4Address || r.content || '').trim();
            return ip === ipv4Address;
        });
        if (existing) return { success: true, zoneId, already: true };

        for (const rec of matches) {
            await this.deleteRecord(zoneId, rec.id);
        }
        const added = await this.addARecord(zoneId, '', ipv4Address);
        if (!added.success) return { success: false, error: added.error };
        return { success: true, zoneId };
    }

    /**
     * Upsert a google-site-verification TXT record at the given hostname:
     * no-op when the exact token already exists, otherwise remove any stale
     * google-site-verification= record for the hostname and add the new one.
     */
    async upsertTxt(recordName, token) {
        let resolved = await this.findZoneId(recordName);
        if (!resolved) {
            // The host may have just been created via POST /dns — give Dynu a
            // moment before giving up.
            for (let i = 0; i < 3 && !resolved; i++) {
                await new Promise(r => setTimeout(r, 1500));
                resolved = await this.findZoneId(recordName);
            }
        }
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
