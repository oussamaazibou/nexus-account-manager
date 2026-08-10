
import CloudflareService from './cloudflareService.js';
import DynuService from './dynuService.js';

/**
 * Shared DNS-provider abstraction for Google Workspace domain verification.
 *
 * Auto-detection order: Cloudflare first, then Dynu. Whichever provider owns
 * the zone for the given domain wins.
 */

// Try to find which DNS provider owns the zone for a domain.
// Returns { provider: 'cloudflare' | 'dynu' | null, zoneId?, zoneName?, node?,
//           cloudflare?: { service }, dynu?: { service } }.
export async function detectDnsProvider(domain, config = {}) {
    const lower = domain.toLowerCase();
    const parts = lower.split('.');

    // Candidate zones from most-specific to least-specific (handles multi-label
    // TLDs like co.uk / com.br): e.g. a.b.example.co.uk -> example.co.uk, co.uk
    const candidates = [];
    for (let i = parts.length - 2; i >= 1; i--) candidates.push(parts.slice(i).join('.'));
    candidates.push(lower);

    // 1) Cloudflare first — progressive zone scan
    if (config.cloudflareEmail && config.cloudflareKey) {
        try {
            const cf = new CloudflareService(config.cloudflareEmail, config.cloudflareKey);
            for (const candidate of candidates) {
                const zoneId = await cf.getZoneId(candidate);
                if (zoneId) {
                    return { provider: 'cloudflare', zoneId, zoneName: candidate, cloudflare: { service: cf } };
                }
            }
        } catch (e) {
            console.warn(`[DNS] Cloudflare detection error: ${e.message}`);
        }
    }

    // 2) Dynu — getroot resolves subdomains natively, zone-list scan as fallback
    if (config.dynuApiKey) {
        try {
            const dynu = new DynuService(config.dynuApiKey);
            const resolved = await dynu.findZoneId(lower);
            if (resolved) {
                return { provider: 'dynu', zoneId: resolved.zoneId, zoneName: resolved.zoneName, node: resolved.node, dynu: { service: dynu } };
            }
        } catch (e) {
            console.warn(`[DNS] Dynu detection error: ${e.message}`);
        }
    }

    return { provider: null };
}

// Upsert the google-site-verification TXT record on whichever provider owns
// the zone. Returns { success, provider?, error?, already? }.
export async function upsertDnsTxt(domain, token, config = {}, log = () => {}) {
    const det = await detectDnsProvider(domain, config);
    if (!det.provider) {
        log(`[DNS] No Cloudflare or Dynu zone found for ${domain}`);
        return { success: false, error: `No DNS provider found for ${domain}` };
    }

    if (det.provider === 'cloudflare') {
        const res = await det.cloudflare.service.upsertTxt(det.zoneId, domain, token);
        return { ...res, provider: 'cloudflare' };
    }

    const res = await det.dynu.service.upsertTxt(domain, token);
    return { ...res, provider: 'dynu' };
}

// Point the domain's MX records at Google Workspace mail (SMTP.GOOGLE.COM).
// Returns { success, provider?, error?, already? }.
export async function upsertDnsMx(domain, config = {}, log = () => {}) {
    const det = await detectDnsProvider(domain, config);
    if (!det.provider) {
        log(`[DNS] No Cloudflare or Dynu zone found for ${domain}`);
        return { success: false, error: `No DNS provider found for ${domain}` };
    }

    if (det.provider === 'cloudflare') {
        const res = await det.cloudflare.service.addMxRecord(det.zoneId, domain, 'SMTP.GOOGLE.COM', 1);
        return { ...res, provider: 'cloudflare' };
    }

    const res = await det.dynu.service.upsertMx(domain, 'SMTP.GOOGLE.COM', 1);
    return { ...res, provider: 'dynu' };
}
