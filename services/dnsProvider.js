
import axios from 'axios';
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
            // Registered domains whose DNS is hosted on Dynu: the zone is not in
            // the account yet, so nothing matches above. Detect ownership from the
            // domain's authoritative nameservers instead (ns1-5.dynu.com/net).
            const apex = parts.slice(-2).join('.');
            const node = parts.slice(0, -2).join('.');
            let nsHosts = await getAuthoritativeNs(lower);
            if (!nsHosts.length) nsHosts = await getAuthoritativeNs(apex);
            if (nsHosts.some(ns => /^ns\d*\.dynu\.(com|net)$/i.test(ns))) {
                return {
                    provider: 'dynu',
                    zoneId: null,
                    zoneName: apex,
                    node,
                    freeDomain: false,
                    dynu: { service: dynu }
                };
            }
        } catch (e) {
            console.warn(`[DNS] Dynu detection error: ${e.message}`);
        }
    }

    return { provider: null };
}

// Resolve the authoritative nameservers of a domain via the public DNS-over-
// HTTPS endpoint (dns.google). Returns lower-cased hostnames (e.g. ns1.dynu.com).
async function getAuthoritativeNs(domain) {
    try {
        const resp = await axios.get('https://dns.google/resolve', {
            params: { name: domain, type: 'NS' },
            timeout: 8000
        });
        const answers = resp.data && resp.data.Answer;
        if (!Array.isArray(answers)) return [];
        return answers.map(a => String(a.data || '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
    } catch (e) {
        return [];
    }
}

// Domains hosted on Dynu have no zone in the account until it exists:
//  - free dynamic-DNS domains (dynu.net, ...) need the Dynamic DNS host created,
//  - registered domains on Dynu nameservers (NS-detected, zoneId null) need the
//    apex zone created.
// `det` comes from detectDnsProvider. `hostname` is the name to create (the full
// domain for free domains, the apex zone for registered ones). Returns true when
// the zone/host is (or already was) ready.
async function ensureDynuHost(det, hostname, log, domain) {
    const dynu = det.dynu && det.dynu.service;
    if (!dynu) return false;
    const kind = det.freeDomain ? 'Dynamic DNS host' : `Dynu zone "${hostname}"`;
    log(`[DNS] ${domain} is on Dynu but the ${kind} is not in the account — creating it first…`);
    const hostRes = await dynu.ensureHost(hostname);
    if (!hostRes.success) {
        log(`[DNS] Could not create Dynu ${kind} for ${hostname}: ${hostRes.error}`);
        return false;
    }
    log(`[DNS] Dynu ${kind} ready for ${hostname}${hostRes.already ? ' (already existed)' : ''}${hostRes.zoneId ? ` [zoneId=${hostRes.zoneId}]` : ''}`);
    return true;
}

// Upsert the google-site-verification TXT record on whichever provider owns
// the zone. Returns { success, provider?, error?, already? }.
export async function upsertDnsTxt(domain, token, config = {}, log = () => {}) {
    const det = await detectDnsProvider(domain, config);
    if (!det.provider) {
        const cfOk = !!(config.cloudflareEmail || '').trim() && !!(config.cloudflareKey || '').trim();
        const dynuOk = !!(config.dynuApiKey || '').trim();
        log(`[DNS] No DNS provider found for ${domain} (Cloudflare ${cfOk ? 'configured' : 'not configured'} · Dynu ${dynuOk ? 'configured' : 'NOT configured — add your Dynu API key in Settings → Dynu'})`);
        return { success: false, error: `No DNS provider found for ${domain}` };
    }

    if (det.provider === 'cloudflare') {
        const res = await det.cloudflare.service.upsertTxt(det.zoneId, domain, token);
        return { ...res, provider: 'cloudflare' };
    }

    // Dynu: when the zone does not exist yet (free dynamic-DNS domain or an
    // NS-detected registered domain), create the zone/host before adding the
    // TXT record. This makes the whole verify flow Dynu-aware: host → record → verify.
    if (det.freeDomain || det.zoneId == null) {
        const hostname = det.freeDomain ? domain : det.zoneName;
        const ok = await ensureDynuHost(det, hostname, log, domain);
        if (!ok) return { success: false, error: `Could not create Dynu zone for ${domain}` };
    }

    const res = await det.dynu.service.upsertTxt(domain, token);
    return { ...res, provider: 'dynu' };
}

// Point the domain's MX records at Google Workspace mail (SMTP.GOOGLE.COM).
// Returns { success, provider?, error?, already? }.
export async function upsertDnsMx(domain, config = {}, log = () => {}) {
    const det = await detectDnsProvider(domain, config);
    if (!det.provider) {
        const cfOk = !!(config.cloudflareEmail || '').trim() && !!(config.cloudflareKey || '').trim();
        const dynuOk = !!(config.dynuApiKey || '').trim();
        log(`[DNS] No DNS provider found for ${domain} (Cloudflare ${cfOk ? 'configured' : 'not configured'} · Dynu ${dynuOk ? 'configured' : 'NOT configured — add your Dynu API key in Settings → Dynu'})`);
        return { success: false, error: `No DNS provider found for ${domain}` };
    }

    if (det.provider === 'cloudflare') {
        const res = await det.cloudflare.service.addMxRecord(det.zoneId, domain, 'SMTP.GOOGLE.COM', 1);
        return { ...res, provider: 'cloudflare' };
    }

    // Same Dynu zone-first handling as upsertDnsTxt.
    if (det.freeDomain || det.zoneId == null) {
        const hostname = det.freeDomain ? domain : det.zoneName;
        const ok = await ensureDynuHost(det, hostname, log, domain);
        if (!ok) return { success: false, error: `Could not create Dynu zone for ${domain}` };
    }

    const res = await det.dynu.service.upsertMx(domain, 'SMTP.GOOGLE.COM', 1);
    return { ...res, provider: 'dynu' };
}
