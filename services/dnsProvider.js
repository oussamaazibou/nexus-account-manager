
import CloudflareService from './cloudflareService.js';
import DynuService from './dynuService.js';

/**
 * Shared DNS-provider abstraction for Google Workspace domain verification.
 *
 * Auto-detection order: Cloudflare first, then Dynu. Whichever provider owns
 * the zone for the given domain wins.
 */

// Try to find which DNS provider owns the zone for a domain.
// Returns { provider: 'cloudflare' | 'dynu' | null, cloudflare?, dynu? }.
export async function detectDnsProvider(domain, config = {}) {
    const rootCandidate = domain.split('.').slice(-2).join('.');

    if (config.cloudflareEmail && config.cloudflareKey) {
        try {
            const cf = new CloudflareService(config.cloudflareEmail, config.cloudflareKey);
            const zoneId = (await cf.getZoneId(rootCandidate)) || (await cf.getZoneId(domain));
            if (zoneId) {
                return { provider: 'cloudflare', cloudflare: { service: cf, zoneId } };
            }
        } catch (e) {
            console.warn(`[DNS] Cloudflare detection error: ${e.message}`);
        }
    }

    if (config.dynuApiKey) {
        const dynu = new DynuService(config.dynuApiKey);
        const resolved = await dynu.findZoneId(domain);
        if (resolved) {
            return { provider: 'dynu', dynu: { service: dynu, zoneId: resolved.zoneId, node: resolved.node } };
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
        const { service, zoneId } = det.cloudflare;
        const res = await service.upsertTxt(zoneId, domain, token);
        return { ...res, provider: 'cloudflare' };
    }

    const res = await det.dynu.service.upsertTxt(domain, token);
    return { ...res, provider: 'dynu' };
}
