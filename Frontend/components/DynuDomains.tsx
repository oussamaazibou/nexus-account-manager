import React, { useState, useEffect, useCallback } from 'react';

const API_URL = '/api';

interface WorkspaceAccount {
    email: string;
    password: string;
    domain: string;
    cached: boolean;
}

interface DynuProvisioned {
    baseDomain: string;
    subdomain: string;
    adminEmail: string;
    provider: string | null;
    verified: boolean;
    createdAt: string;
}

interface DynuStore {
    baseDomains: string[];
    provisioned: DynuProvisioned[];
}

const toast = (msg: string, type: 'ok' | 'err' | 'info' = 'info') => {
    const c = document.getElementById('toast-container'); if (!c) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
    el.innerHTML = `<span style="font-weight:700">${type === 'ok' ? '✓' : type === 'err' ? '✕' : 'ℹ'}</span><span>${msg}</span>`;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'all 0.3s'; setTimeout(() => el.remove(), 300); }, 3500);
};

const Spinner = ({ size = 14 }: { size?: number }) => (
    <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
);

const DynuDomains: React.FC = () => {
    const [accounts, setAccounts] = useState<WorkspaceAccount[]>([]);
    const [selectedEmail, setSelectedEmail] = useState('');
    const [store, setStore] = useState<DynuStore>({ baseDomains: [], provisioned: [] });
    const [baseDomainsText, setBaseDomainsText] = useState('');
    const [savingBases, setSavingBases] = useState(false);
    const [removingBase, setRemovingBase] = useState<string | null>(null);
    const [provisioning, setProvisioning] = useState<string | null>(null);
    const [verifying, setVerifying] = useState<string | null>(null);

    const loadStore = useCallback(async () => {
        try {
            const res = await fetch(`${API_URL}/dynu/domains`);
            if (res.ok) setStore(await res.json());
        } catch (e) { /* ignore */ }
    }, []);

    useEffect(() => {
        fetch(`${API_URL}/manage/accounts`)
            .then(r => r.ok ? r.json() : [])
            .then((list: WorkspaceAccount[]) => {
                setAccounts(list);
                if (list.length && !selectedEmail) setSelectedEmail(list[0].email);
            })
            .catch(() => {});
        loadStore();
    }, [loadStore]);

    const saveBaseDomains = async () => {
        const domains = baseDomainsText.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
        if (!domains.length) return;
        setSavingBases(true);
        try {
            const res = await fetch(`${API_URL}/dynu/domains`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseDomains: domains })
            });
            const data = await res.json();
            if (data.success) {
                setStore(prev => ({ ...prev, baseDomains: data.baseDomains }));
                setBaseDomainsText('');
                toast(`Stored ${domains.length} base domain(s)`, 'ok');
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setSavingBases(false);
        }
    };

    const removeBaseDomain = async (baseDomain: string) => {
        setRemovingBase(baseDomain);
        try {
            const res = await fetch(`${API_URL}/dynu/domains`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseDomain })
            });
            const data = await res.json();
            if (data.success) {
                setStore(prev => ({
                    baseDomains: prev.baseDomains.filter(d => d !== baseDomain),
                    provisioned: prev.provisioned.filter(p => p.baseDomain !== baseDomain)
                }));
                toast(`Removed ${baseDomain}`, 'ok');
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setRemovingBase(null);
        }
    };

    const provision = async (baseDomain: string) => {
        if (!selectedEmail) return toast('Select a workspace account first', 'err');
        setProvisioning(baseDomain);
        try {
            const res = await fetch(`${API_URL}/dynu/provision`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminEmail: selectedEmail, baseDomain })
            });
            const data = await res.json();
            if (data.success) {
                toast(`Provisioned ${data.subdomain} (${data.provider || 'no DNS provider'})`, data.verified ? 'ok' : 'info');
                await loadStore();
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setProvisioning(null);
        }
    };

    const reverify = async (rec: DynuProvisioned) => {
        setVerifying(rec.subdomain);
        try {
            const res = await fetch(`${API_URL}/manage/verify-domain`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminEmail: rec.adminEmail, domainName: rec.subdomain })
            });
            const data = await res.json();
            if (data.success) {
                toast(`Verified ${rec.subdomain}`, 'ok');
                await loadStore();
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setVerifying(null);
        }
    };

    const baseCount = store.baseDomains.length;
    const provisionedCount = store.provisioned.length;
    const verifiedCount = store.provisioned.filter(p => p.verified).length;

    return (
        <div className="space-y-8 animate-in fade-in duration-700 pb-24">

            {/* Header */}
            <div className="space-y-2">
                <h2 className="text-3xl md:text-4xl font-black tracking-tightest uppercase">Dynu Domains</h2>
                <p className="text-[var(--text-muted)] text-sm font-medium">
                    Generate unique subdomains and verify them via Cloudflare or Dynu DNS
                </p>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="glass-card p-5">
                    <div className="text-2xl font-black text-cyan-400">{baseCount}</div>
                    <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-black mt-1">Base Domains</div>
                </div>
                <div className="glass-card p-5">
                    <div className="text-2xl font-black text-indigo-400">{provisionedCount}</div>
                    <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-black mt-1">Subdomains</div>
                </div>
                <div className="glass-card p-5">
                    <div className="text-2xl font-black text-emerald-400">{verifiedCount}</div>
                    <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-black mt-1">Verified</div>
                </div>
                <div className="glass-card p-5">
                    <div className="text-2xl font-black text-amber-400">{provisionedCount - verifiedCount}</div>
                    <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-black mt-1">Pending</div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* LEFT: Account + base domains */}
                <div className="lg:col-span-1 space-y-4">
                    <div className="glass-card p-5 space-y-4">
                        <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">Target Workspace</h3>
                        <select
                            value={selectedEmail}
                            onChange={e => setSelectedEmail(e.target.value)}
                            className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] appearance-none cursor-pointer"
                        >
                            {accounts.map(a => (
                                <option key={a.email} value={a.email}>{a.email}</option>
                            ))}
                        </select>
                        {accounts.length === 0 && (
                            <p className="text-[11px] text-amber-400">No workspace accounts found — add some to result_accounts.txt</p>
                        )}
                    </div>

                    <div className="glass-card p-5 space-y-4">
                        <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">Add Base Domains</h3>
                        <textarea
                            rows={5}
                            placeholder={'example.com\nanother.org\none-per-line'}
                            value={baseDomainsText}
                            onChange={e => setBaseDomainsText(e.target.value)}
                            style={{ resize: 'vertical' }}
                            className="w-full px-4 py-2 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-cyan-500 text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                        />
                        <button
                            onClick={saveBaseDomains}
                            disabled={savingBases || !baseDomainsText.trim()}
                            className="w-full py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-black text-sm transition-all disabled:opacity-50"
                        >
                            {savingBases ? '⏳ Saving...' : '＋ Save Base Domains'}
                        </button>
                        <p className="text-[10px] text-[var(--text-muted)]">Base domains are stored on the server. Provisioning creates a unique subdomain like <span className="font-mono text-cyan-400">x7k2q9.{store.baseDomains[0] || 'yourdomain.com'}</span> and adds it to the selected Workspace.</p>
                    </div>

                    {/* Base domain list */}
                    <div className="glass-card p-5 space-y-3">
                        <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">Stored Base Domains</h3>
                        {store.baseDomains.length === 0 && (
                            <p className="text-[11px] text-[var(--text-muted)]">No base domains yet.</p>
                        )}
                        {store.baseDomains.map(d => (
                            <div key={d} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/3 border border-white/5">
                                <span className="flex-1 text-sm font-mono text-[var(--text-main)]">{d}</span>
                                <button
                                    onClick={() => provision(d)}
                                    disabled={provisioning === d || !selectedEmail}
                                    className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-black text-[11px] transition-all disabled:opacity-50"
                                >
                                    {provisioning === d ? <Spinner size={12} /> : 'Provision'}
                                </button>
                                <button
                                    onClick={() => removeBaseDomain(d)}
                                    disabled={removingBase === d}
                                    className="px-2.5 py-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-400 font-black text-[11px] transition-all disabled:opacity-50"
                                >
                                    {removingBase === d ? <Spinner size={12} /> : '✕'}
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                {/* RIGHT: provisioned subdomains */}
                <div className="lg:col-span-2 space-y-4">
                    <div className="glass-card p-5 space-y-4">
                        <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">Provisioned Subdomains</h3>
                        {store.provisioned.length === 0 && (
                            <div className="text-center py-10 text-[var(--text-muted)] text-sm">
                                No subdomains provisioned yet.
                            </div>
                        )}
                        <div className="space-y-2">
                            {[...store.provisioned].reverse().map(rec => (
                                <div key={rec.subdomain} className="px-4 py-3 rounded-xl bg-white/3 border border-white/5 space-y-2">
                                    <div className="flex items-center gap-3">
                                        <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${rec.verified ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
                                            {rec.verified ? '✓' : '⏳'}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold font-mono text-[var(--text-main)] truncate">{rec.subdomain}</div>
                                            <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">{rec.adminEmail}</div>
                                        </div>
                                        <span className={`text-[10px] px-2 py-1 rounded font-black uppercase ${rec.provider === 'cloudflare' ? 'bg-orange-500/15 text-orange-400' : rec.provider === 'dynu' ? 'bg-cyan-500/15 text-cyan-400' : 'bg-white/5 text-[var(--text-muted)]'}`}>
                                            {rec.provider || 'no provider'}
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className={`text-[11px] font-bold ${rec.verified ? 'text-emerald-400' : 'text-amber-400'}`}>
                                            {rec.verified ? 'Verified' : 'Pending verification'}
                                        </span>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => reverify(rec)}
                                                disabled={verifying === rec.subdomain}
                                                className="px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 font-black text-[11px] transition-all disabled:opacity-50"
                                            >
                                                {verifying === rec.subdomain ? <Spinner size={12} /> : 'Re-verify'}
                                            </button>
                                            <button
                                                onClick={() => { navigator.clipboard?.writeText(rec.subdomain).then(() => toast(`Copied ${rec.subdomain}`, 'ok')).catch(() => toast(rec.subdomain, 'info')); }}
                                                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[var(--text-muted)] font-black text-[11px] transition-all"
                                            >
                                                Copy
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default DynuDomains;
