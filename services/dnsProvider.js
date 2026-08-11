
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
            // Dynu free dynamic-DNS domains (dynu.net, dynuddns.net, ...): the
            // apex belongs to Dynu, so no account zone matches until the host is
            // created. Detect ownership from the top-levels list instead.
            const topLevels = await dynu.listTopLevels();
            const ownedTl = topLevels.find(tl => lower === tl.toLowerCase() || lower.endsWith('.' + tl.toLowerCase()));
            if (ownedTl) {
                return {
                    provider: 'dynu',
                    zoneId: null,
                    zoneName: ownedTl.toLowerCase(),
                    node: lower.slice(0, -(ownedTl.length + 1)),
                    freeDomain: true,
                    dynu: { service: dynu }
                };
            }
        } catch (e) {
            console.warn(`[DNS] Dynu detection error: ${e.message}`);
        }
    }

    return { provider: null };
}

// Dynu free dynamic-DNS domains (dynu.net, dynuddns.net, ...) have no apex
// zone in the account until the host is created, so before any record can be
// placed the Dynamic DNS host must exist. `det` comes from detectDnsProvider,
// which flags these with freeDomain:true (zoneId null). Returns true when the
// host is (or already was) ready.
async function ensureDynuHost(det, domain, log) {
    const dynu = det.dynu && det.dynu.service;
    if (!dynu) return false;
    log(`[DNS] Dynu ${det.freeDomain ? 'free domain' : 'host not found'} for ${domain} — creating Dynamic DNS host first…`);
    const hostRes = await dynu.ensureHost(domain);
    if (!hostRes.success) {
        log(`[DNS] Could not create Dynu host for ${domain}: ${hostRes.error}`);
        return false;
    }
    log(`[DNS] Dynamic DNS host ready for ${domain}${hostRes.already ? ' (already existed)' : ''}${hostRes.zoneId ? ` [zoneId=${hostRes.zoneId}]` : ''}`);
    return true;
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

    // Dynu: when the host does not exist yet (free dynamic-DNS domain), create
    // the Dynamic DNS host before adding the TXT record. This makes the whole
    // verify flow Dynu-aware: host → record → verify.
    if (det.freeDomain || det.zoneId == null) {
        const ok = await ensureDynuHost(det, domain, log);
        if (!ok) return { success: false, error: `Could not create Dynu dynamic-DNS host for ${domain}` };
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

    // Same Dynu host-first handling as upsertDnsTxt.
    if (det.freeDomain || det.zoneId == null) {
        const ok = await ensureDynuHost(det, domain, log);
        if (!ok) return { success: false, error: `Could not create Dynu dynamic-DNS host for ${domain}` };
    }

    const res = await det.dynu.service.upsertMx(domain, 'SMTP.GOOGLE.COM', 1);
    return { ...res, provider: 'dynu' };
}
