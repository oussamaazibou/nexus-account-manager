import React, { useState, useEffect, useCallback } from 'react';

interface CloudflareDomain {
    id: string;
    name: string;
    cfStatus: string;
    domainStatus: 'Spam' | 'Inbox';
    isUsed: boolean;
    nameServers: string[];
    createdOn: string;
}

interface TxtRecord {
    id: string;
    name: string;
    content: string;
    ttl: number;
    modified: string;
}

const API_URL = '/api';

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

// ── TXT Records Panel ────────────────────────────────────────────────────────
const TxtPanel: React.FC<{ domain: CloudflareDomain; onClose: () => void }> = ({ domain, onClose }) => {
    const [records, setRecords] = useState<TxtRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editContent, setEditContent] = useState('');
    const [saving, setSaving] = useState(false);
    // Add new record
    const [adding, setAdding] = useState(false);
    const [newName, setNewName] = useState('');
    const [newContent, setNewContent] = useState('');
    const [addSaving, setAddSaving] = useState(false);

    const fetchRecords = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`${API_URL}/domains/${domain.id}/txt-records`);
            const data = await res.json();
            if (data.success) setRecords(data.records);
            else setError(data.error);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [domain.id]);

    useEffect(() => { fetchRecords(); }, [fetchRecords]);

    const startEdit = (rec: TxtRecord) => {
        setEditingId(rec.id);
        setEditContent(rec.content);
    };

    const cancelEdit = () => { setEditingId(null); setEditContent(''); };

    const saveEdit = async (rec: TxtRecord) => {
        if (!editContent.trim()) return;
        setSaving(true);
        try {
            const res = await fetch(`${API_URL}/domains/${domain.id}/txt-records/${rec.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: rec.name, content: editContent.trim(), ttl: rec.ttl })
            });
            const data = await res.json();
            if (data.success) {
                setRecords(prev => prev.map(r => r.id === rec.id ? { ...r, content: editContent.trim() } : r));
                setEditingId(null);
                toast('TXT record updated', 'ok');
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setSaving(false);
        }
    };

    const saveNewRecord = async () => {
        if (!newName.trim() || !newContent.trim()) return;
        setAddSaving(true);
        try {
            const res = await fetch(`${API_URL}/domains/${domain.id}/txt-records`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName.trim(), content: newContent.trim(), ttl: 1 })
            });
            const data = await res.json();
            if (data.success) {
                const r = data.record;
                setRecords(prev => [...prev, { id: r.id, name: r.name, content: r.content, ttl: r.ttl, modified: r.modified_on || '' }]);
                setNewName('');
                setNewContent('');
                setAdding(false);
                toast('TXT record added', 'ok');
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setAddSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="bg-[#0f172a] border border-white/10 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
                    <div>
                        <h3 className="font-black text-lg">TXT Records</h3>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">{domain.name}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => { setAdding(true); setEditingId(null); }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-black transition-all"
                        >
                            + Add Record
                        </button>
                        <button onClick={fetchRecords} disabled={loading} className="p-2 rounded-lg hover:bg-white/10 transition-all text-[var(--text-muted)] disabled:opacity-50">
                            {loading ? <Spinner /> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>}
                        </button>
                        <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 transition-all text-[var(--text-muted)]">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                    </div>
                </div>

                {/* Add new record form */}
                {adding && (
                    <div className="px-6 py-4 border-b border-white/10 bg-indigo-500/5 space-y-3 shrink-0">
                        <div className="text-xs font-black uppercase tracking-widest text-indigo-400">New TXT Record</div>
                        <div className="flex gap-3">
                            <input
                                type="text"
                                placeholder={`Name (e.g. @ or ${domain.name})`}
                                value={newName}
                                onChange={e => setNewName(e.target.value)}
                                className="w-40 shrink-0 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                            />
                            <input
                                type="text"
                                placeholder="TXT content / value"
                                value={newContent}
                                onChange={e => setNewContent(e.target.value)}
                                className="flex-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                            />
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={saveNewRecord}
                                disabled={addSaving || !newName.trim() || !newContent.trim()}
                                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black transition-all disabled:opacity-50"
                            >
                                {addSaving ? <><Spinner /> Saving…</> : '✓ Save Record'}
                            </button>
                            <button onClick={() => { setAdding(false); setNewName(''); setNewContent(''); }} className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-black transition-all">
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Body */}
                <div className="flex-1 overflow-y-auto">
                    {loading && records.length === 0 ? (
                        <div className="flex items-center justify-center py-16 text-[var(--text-muted)] gap-3">
                            <Spinner size={18} /> Loading TXT records…
                        </div>
                    ) : error ? (
                        <div className="m-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">❌ {error}</div>
                    ) : records.length === 0 ? (
                        <div className="text-center py-16 text-[var(--text-muted)]">
                            <div className="text-3xl mb-2">📭</div>
                            <div className="font-black">No TXT records found</div>
                        </div>
                    ) : (
                        <div className="divide-y divide-white/5">
                            {records.map(rec => (
                                <div key={rec.id} className="px-6 py-4 hover:bg-white/[0.02] transition-colors">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="min-w-0 flex-1 space-y-1">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-black text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded font-mono">TXT</span>
                                                <span className="text-sm font-bold truncate">{rec.name}</span>
                                                <span className="text-[10px] text-[var(--text-muted)] shrink-0">TTL {rec.ttl === 1 ? 'Auto' : rec.ttl}s</span>
                                            </div>

                                            {editingId === rec.id ? (
                                                <div className="space-y-2 mt-2">
                                                    <textarea
                                                        value={editContent}
                                                        onChange={e => setEditContent(e.target.value)}
                                                        rows={3}
                                                        className="w-full px-3 py-2 rounded-lg bg-black/40 border border-indigo-500/50 text-sm font-mono text-[var(--text-main)] focus:outline-none resize-y"
                                                        autoFocus
                                                    />
                                                    <div className="flex gap-2">
                                                        <button
                                                            onClick={() => saveEdit(rec)}
                                                            disabled={saving}
                                                            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black transition-all disabled:opacity-50"
                                                        >
                                                            {saving ? <><Spinner /> Saving…</> : '✓ Save'}
                                                        </button>
                                                        <button onClick={cancelEdit} className="px-4 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-black transition-all">
                                                            Cancel
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="text-xs text-[var(--text-muted)] font-mono break-all bg-black/20 rounded-lg px-3 py-2 mt-1">
                                                    {rec.content}
                                                </div>
                                            )}
                                        </div>

                                        {editingId !== rec.id && (
                                            <button
                                                onClick={() => startEdit(rec)}
                                                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-indigo-500/20 hover:text-indigo-400 text-[var(--text-muted)] text-xs font-black transition-all"
                                            >
                                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                                Edit
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="px-6 py-3 border-t border-white/10 text-xs text-[var(--text-muted)] shrink-0">
                    {records.length} TXT record{records.length !== 1 ? 's' : ''} · {domain.name}
                </div>
            </div>
        </div>
    );
};

// ── Bulk Add Domains Panel ────────────────────────────────────────────────────
type Provider = 'namecheap' | 'spaceship' | 'nicnames';

interface BulkAddRow {
    domain: string;
    cfStatus: string;
    ns: string[];
    providerStatus: string;
    error: string | null;
    state: 'queued' | 'processing' | 'done' | 'failed';
}

const PROVIDERS: { id: Provider; label: string; icon: string; color: string }[] = [
    { id: 'namecheap', label: 'Namecheap', icon: '🌐', color: 'cyan' },
    { id: 'spaceship', label: 'Spaceship', icon: '🚀', color: 'violet' },
    { id: 'nicnames', label: 'Nicnames', icon: '🏷️', color: 'emerald' },
];

const BulkAddPanel: React.FC<{ onClose: () => void; onDone: () => void }> = ({ onClose, onDone }) => {
    const [domainsText, setDomainsText] = useState('');
    const [provider, setProvider] = useState<Provider>('spaceship');
    const [rows, setRows] = useState<BulkAddRow[]>([]);
    const [running, setRunning] = useState(false);
    const [done, setDone] = useState(false);

    const parsed = domainsText.split('\n').map(l => l.trim()).filter(Boolean);
    const stats = {
        total: rows.length,
        ok: rows.filter(r => r.state === 'done').length,
        failed: rows.filter(r => r.state === 'failed').length,
        pending: rows.filter(r => r.state === 'queued' || r.state === 'processing').length,
    };

    const providerInfo = PROVIDERS.find(p => p.id === provider)!;

    const startAdding = async () => {
        if (parsed.length === 0) return;
        setRunning(true);
        setDone(false);

        // Init rows as queued
        const initRows: BulkAddRow[] = parsed.map(d => ({
            domain: d.toLowerCase().trim(),
            cfStatus: 'queued',
            ns: [],
            providerStatus: 'queued',
            error: null,
            state: 'queued'
        }));
        setRows(initRows);

        // Process in batches of 3
        const BATCH = 3;
        for (let i = 0; i < initRows.length; i += BATCH) {
            const batch = initRows.slice(i, i + BATCH);

            // Mark batch as processing
            setRows(prev => {
                const next = [...prev];
                for (let j = i; j < Math.min(i + BATCH, prev.length); j++) {
                    next[j] = { ...next[j], state: 'processing', cfStatus: 'adding…', providerStatus: 'waiting…' };
                }
                return next;
            });

            try {
                const res = await fetch(`${API_URL}/domains/bulk-add`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ domains: batch.map(r => r.domain), provider })
                });
                const data = await res.json();
                if (data.success && Array.isArray(data.results)) {
                    setRows(prev => {
                        const next = [...prev];
                        data.results.forEach((r: any, idx: number) => {
                            const pos = i + idx;
                            if (pos < next.length) {
                                next[pos] = {
                                    ...next[pos],
                                    cfStatus: r.cfStatus || 'done',
                                    ns: r.ns || [],
                                    providerStatus: r.providerStatus || 'done',
                                    error: r.error || null,
                                    state: r.error || r.providerStatus === 'failed' ? 'failed' : 'done'
                                };
                            }
                        });
                        return next;
                    });
                } else {
                    setRows(prev => {
                        const next = [...prev];
                        for (let j = i; j < Math.min(i + BATCH, prev.length); j++) {
                            next[j] = { ...next[j], state: 'failed', error: data.error || 'Request failed', cfStatus: 'failed', providerStatus: 'failed' };
                        }
                        return next;
                    });
                }
            } catch (e: any) {
                setRows(prev => {
                    const next = [...prev];
                    for (let j = i; j < Math.min(i + BATCH, prev.length); j++) {
                        next[j] = { ...next[j], state: 'failed', error: e.message, cfStatus: 'failed', providerStatus: 'failed' };
                    }
                    return next;
                });
            }
        }

        setRunning(false);
        setDone(true);
        onDone();
    };

    const StatusBadge: React.FC<{ status: string; isProvider?: boolean }> = ({ status, isProvider }) => {
        if (status === 'queued') return <span className="text-[10px] font-black text-white/30 uppercase tracking-wider">Queued</span>;
        if (status === 'adding…' || status === 'waiting…' || status === 'processing') return (
            <span className="flex items-center gap-1 text-[10px] font-black text-amber-400 uppercase tracking-wider">
                <Spinner size={10} /> {isProvider ? 'Updating…' : 'Adding…'}
            </span>
        );
        if (status === 'pending') return <span className="text-[10px] font-black text-amber-400 uppercase tracking-wider">Pending</span>;
        if (status === 'active' || status === 'updated') return <span className="text-[10px] font-black text-emerald-400 uppercase tracking-wider">✓ Done</span>;
        if (status === 'failed') return <span className="text-[10px] font-black text-red-400 uppercase tracking-wider">✕ Failed</span>;
        return <span className="text-[10px] font-black text-emerald-400 uppercase tracking-wider">✓ {status}</span>;
    };

    return (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={e => { if (e.target === e.currentTarget && !running) onClose(); }}>
            <div className="bg-[#0a0f1e] border border-white/10 rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">

                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0 bg-gradient-to-r from-indigo-950/50 to-purple-950/30">
                    <div>
                        <h3 className="font-black text-xl tracking-tight">Add Domains Bulk</h3>
                        <p className="text-xs text-white/40 mt-0.5">Cloudflare Zone + Registrar NS Update</p>
                    </div>
                    <button onClick={onClose} disabled={running}
                        className="p-2 rounded-lg hover:bg-white/10 transition-all text-white/40 disabled:opacity-30">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
                    {/* Left panel — input */}
                    <div className="md:w-80 shrink-0 border-r border-white/10 p-5 flex flex-col gap-5 overflow-y-auto">

                        {/* Provider selector */}
                        <div>
                            <div className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-3">Registrar Provider</div>
                            <div className="flex flex-col gap-2">
                                {PROVIDERS.map(p => (
                                    <button key={p.id} onClick={() => setProvider(p.id)} disabled={running}
                                        className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-black transition-all disabled:opacity-50 ${provider === p.id
                                            ? p.color === 'cyan' ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                                                : p.color === 'violet' ? 'bg-violet-500/20 border-violet-500/50 text-violet-300'
                                                    : 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                                            : 'bg-white/5 border-white/10 text-white/50 hover:bg-white/10'
                                        }`}>
                                        <span className="text-lg">{p.icon}</span>
                                        <span>{p.label}</span>
                                        {provider === p.id && <span className="ml-auto text-[10px]">✓</span>}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Domains textarea */}
                        <div className="flex-1">
                            <div className="flex items-center justify-between mb-3">
                                <div className="text-[10px] font-black uppercase tracking-widest text-white/40">Domains List</div>
                                {parsed.length > 0 && <span className="text-[10px] font-black text-indigo-400">{parsed.length} domains</span>}
                            </div>
                            <textarea
                                value={domainsText}
                                onChange={e => setDomainsText(e.target.value)}
                                disabled={running}
                                placeholder={"example.com\ntest.net\nmydomain.org\n..."}
                                className="w-full h-48 px-3 py-3 rounded-xl bg-black/40 border border-white/10 text-sm font-mono text-white/80 placeholder-white/20 focus:outline-none focus:border-indigo-500 resize-none disabled:opacity-50"
                            />
                        </div>

                        {/* Start button */}
                        <button
                            onClick={startAdding}
                            disabled={running || parsed.length === 0}
                            className={`w-full py-4 rounded-xl font-black text-sm uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-40
                                ${providerInfo.color === 'cyan' ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-600/30'
                                : providerInfo.color === 'violet' ? 'bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-600/30'
                                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30'}`}
                        >
                            {running ? <><Spinner size={14} /> Processing…</> : `${providerInfo.icon} Start Adding (${parsed.length})`}
                        </button>

                        {done && (
                            <div className="px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-sm text-center">
                                <div className="font-black text-emerald-400">✓ Complete!</div>
                                <div className="text-xs text-white/40 mt-1">{stats.ok} added · {stats.failed} failed</div>
                            </div>
                        )}
                    </div>

                    {/* Right panel — results */}
                    <div className="flex-1 flex flex-col overflow-hidden">
                        {/* Stats bar */}
                        {rows.length > 0 && (
                            <div className="grid grid-cols-4 gap-0 border-b border-white/10 shrink-0">
                                {[
                                    { label: 'Total', val: stats.total, color: 'text-white/60' },
                                    { label: 'Success', val: stats.ok, color: 'text-emerald-400' },
                                    { label: 'Failed', val: stats.failed, color: 'text-red-400' },
                                    { label: 'Pending', val: stats.pending, color: 'text-amber-400' },
                                ].map(s => (
                                    <div key={s.label} className="flex flex-col items-center py-3 border-r border-white/5 last:border-0">
                                        <div className={`text-xl font-black ${s.color}`}>{s.val}</div>
                                        <div className="text-[9px] uppercase font-bold text-white/30 tracking-widest mt-0.5">{s.label}</div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Results table */}
                        <div className="flex-1 overflow-y-auto">
                            {rows.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-full text-white/20 gap-3">
                                    <div className="text-5xl">🌐</div>
                                    <div className="font-black text-sm">Paste domains and press Start</div>
                                    <div className="text-xs">Results will appear here in real-time</div>
                                </div>
                            ) : (
                                <table className="w-full text-sm">
                                    <thead className="sticky top-0 bg-[#0a0f1e] z-10">
                                        <tr className="border-b border-white/10">
                                            <th className="text-left px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-white/30">Domain</th>
                                            <th className="text-center px-3 py-2.5 text-[10px] font-black uppercase tracking-widest text-white/30">Cloudflare</th>
                                            <th className="text-center px-3 py-2.5 text-[10px] font-black uppercase tracking-widest text-white/30">NS Update</th>
                                            <th className="text-left px-3 py-2.5 text-[10px] font-black uppercase tracking-widest text-white/30">Nameservers</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-white/5">
                                        {rows.map((row, idx) => (
                                            <tr key={idx} className={`transition-colors ${row.state === 'done' ? 'bg-emerald-500/3' : row.state === 'failed' ? 'bg-red-500/3' : row.state === 'processing' ? 'bg-amber-500/3' : ''}`}>
                                                <td className="px-4 py-3">
                                                    <div className="font-bold text-xs text-white/80 font-mono">{row.domain}</div>
                                                    {row.error && (
                                                        <div className="text-[10px] text-red-400 mt-0.5 font-mono truncate max-w-[180px]" title={row.error}>
                                                            {row.error}
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="px-3 py-3 text-center">
                                                    <StatusBadge status={row.cfStatus} />
                                                </td>
                                                <td className="px-3 py-3 text-center">
                                                    <StatusBadge status={row.providerStatus} isProvider />
                                                </td>
                                                <td className="px-3 py-3">
                                                    {row.ns.length > 0 ? (
                                                        <div className="space-y-0.5">
                                                            {row.ns.map((ns, ni) => (
                                                                <div key={ni} className="text-[10px] text-indigo-400 font-mono">{ns}</div>
                                                            ))}
                                                        </div>
                                                    ) : (
                                                        <span className="text-[10px] text-white/20">—</span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ── Main Domains Page ────────────────────────────────────────────────────────
const Domains: React.FC = () => {
    const [domains, setDomains] = useState<CloudflareDomain[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [search, setSearch] = useState('');
    const [updatingStatus, setUpdatingStatus] = useState<Record<string, boolean>>({});
    const [filterStatus, setFilterStatus] = useState<'All' | 'Spam' | 'Inbox'>('All');
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [bulkUpdating, setBulkUpdating] = useState(false);
    const [deletingZones, setDeletingZones] = useState(false);
    const [txtDomain, setTxtDomain] = useState<CloudflareDomain | null>(null);
    const [showBulkAdd, setShowBulkAdd] = useState(false);

    const fetchDomains = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`${API_URL}/domains/cloudflare`);
            const data = await res.json();
            if (data.success) {
                setDomains(data.domains);
                setSelected(new Set());
            } else {
                setError(data.error || 'Failed to load domains');
            }
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchDomains(); }, [fetchDomains]);

    const updateStatus = async (domainName: string, domainStatus: 'Spam' | 'Inbox') => {
        setUpdatingStatus(prev => ({ ...prev, [domainName]: true }));
        try {
            const res = await fetch(`${API_URL}/domains/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domainName, domainStatus })
            });
            const data = await res.json();
            if (data.success) {
                setDomains(prev => prev.map(d => d.name === domainName ? { ...d, domainStatus } : d));
                toast(`${domainName} → ${domainStatus}`, 'ok');
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setUpdatingStatus(prev => ({ ...prev, [domainName]: false }));
        }
    };

    const toggleUsed = async (domainName: string, isUsed: boolean) => {
        setUpdatingStatus(prev => ({ ...prev, [domainName]: true }));
        try {
            const res = await fetch(`${API_URL}/domains/used`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domainName, isUsed })
            });
            const data = await res.json();
            if (data.success) {
                setDomains(prev => prev.map(d => d.name === domainName ? { ...d, isUsed } : d));
                toast(`${domainName} marked as ${isUsed ? 'Used' : 'Free'}`, 'ok');
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setUpdatingStatus(prev => ({ ...prev, [domainName]: false }));
        }
    };

    const bulkUpdateStatus = async (domainStatus: 'Spam' | 'Inbox') => {
        if (selected.size === 0) return;
        setBulkUpdating(true);
        let ok = 0;
        for (const domainName of Array.from(selected)) {
            try {
                const res = await fetch(`${API_URL}/domains/status`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ domainName, domainStatus })
                });
                const data = await res.json();
                if (data.success) {
                    setDomains(prev => prev.map(d => d.name === domainName ? { ...d, domainStatus } : d));
                    ok++;
                }
            } catch {}
        }
        toast(`${ok}/${selected.size} domains → ${domainStatus}`, ok === selected.size ? 'ok' : 'info');
        setSelected(new Set());
        setBulkUpdating(false);
    };

    const filtered = domains.filter(d => {
        const matchSearch = d.name.toLowerCase().includes(search.toLowerCase());
        const matchStatus = filterStatus === 'All' || d.domainStatus === filterStatus;
        return matchSearch && matchStatus;
    }).sort((a, b) => new Date(b.createdOn).getTime() - new Date(a.createdOn).getTime());

    const spamCount = domains.filter(d => d.domainStatus === 'Spam').length;
    const inboxCount = domains.filter(d => d.domainStatus === 'Inbox').length;

    const toggleSelect = (name: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            next.has(name) ? next.delete(name) : next.add(name);
            return next;
        });
    };

    const toggleSelectAll = () => {
        if (selected.size === filtered.length) setSelected(new Set());
        else setSelected(new Set(filtered.map(d => d.name)));
    };

    const deleteSelectedZones = async () => {
        if (selected.size === 0) return;
        if (!confirm(`⚠️ Delete ${selected.size} domain(s) from Cloudflare?\n\nThis will remove the zone and ALL its DNS records. This cannot be undone.`)) return;
        setDeletingZones(true);
        let ok = 0, fail = 0;
        for (const name of Array.from(selected)) {
            const zone = domains.find(d => d.name === name);
            if (!zone) { fail++; continue; }
            try {
                const res = await fetch(`${API_URL}/domains/cloudflare/${zone.id}`, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) ok++; else fail++;
            } catch { fail++; }
        }
        if (ok > 0) {
            setDomains(prev => prev.filter(d => !selected.has(d.name)));
            toast(`${ok} domain(s) deleted${fail > 0 ? `, ${fail} failed` : ''}`, fail > 0 ? 'err' : 'ok');
        } else {
            toast(`All ${fail} deletion(s) failed`, 'err');
        }
        setSelected(new Set());
        setDeletingZones(false);
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-700">
            {txtDomain && <TxtPanel domain={txtDomain} onClose={() => setTxtDomain(null)} />}
            {showBulkAdd && <BulkAddPanel onClose={() => setShowBulkAdd(false)} onDone={() => { fetchDomains(); }} />}

            <div className="space-y-1">
                <h2 className="text-3xl md:text-4xl font-black tracking-tightest uppercase">Domains</h2>
                <p className="text-[var(--text-muted)] text-sm font-medium">Cloudflare domains · Inbox/Spam status · TXT DNS records</p>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4">
                <div className="glass-card p-4 text-center">
                    <div className="text-2xl font-black text-indigo-400">{domains.length}</div>
                    <div className="text-xs text-[var(--text-muted)] uppercase font-bold mt-1">Total</div>
                </div>
                <div className="glass-card p-4 text-center">
                    <div className="text-2xl font-black text-emerald-400">{inboxCount}</div>
                    <div className="text-xs text-[var(--text-muted)] uppercase font-bold mt-1">Inbox</div>
                </div>
                <div className="glass-card p-4 text-center">
                    <div className="text-2xl font-black text-red-400">{spamCount}</div>
                    <div className="text-xs text-[var(--text-muted)] uppercase font-bold mt-1">Spam</div>
                </div>
            </div>

            {/* Controls */}
            <div className="glass-card p-4 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                <input
                    type="text"
                    placeholder="Search domains..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)]"
                />
                <div className="flex gap-2 flex-wrap">
                    {(['All', 'Inbox', 'Spam'] as const).map(f => (
                        <button
                            key={f}
                            onClick={() => setFilterStatus(f)}
                            className={`px-4 py-2.5 rounded-xl text-sm font-black transition-all ${filterStatus === f
                                ? f === 'Spam' ? 'bg-red-600 text-white' : f === 'Inbox' ? 'bg-emerald-600 text-white' : 'bg-indigo-600 text-white'
                                : 'bg-white/5 hover:bg-white/10 text-[var(--text-muted)]'
                            }`}
                        >
                            {f}
                        </button>
                    ))}
                    <button
                        onClick={() => setShowBulkAdd(true)}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-black transition-all shadow-lg shadow-indigo-600/20"
                    >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        Add Domains
                    </button>
                    <button
                        onClick={fetchDomains}
                        disabled={loading}
                        className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-sm font-black transition-all disabled:opacity-50"
                    >
                        {loading ? <Spinner /> : '🔄'}
                    </button>
                </div>
            </div>

            {/* Bulk actions */}
            {selected.size > 0 && (
                <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-sm">
                    <span className="font-black text-indigo-400">{selected.size} selected</span>
                    <div className="flex gap-2 ml-auto">
                        <button onClick={() => bulkUpdateStatus('Inbox')} disabled={bulkUpdating} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-black text-xs transition-all disabled:opacity-50">
                            {bulkUpdating ? '⏳' : '✓ Mark Inbox'}
                        </button>
                        <button onClick={() => bulkUpdateStatus('Spam')} disabled={bulkUpdating} className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-black text-xs transition-all disabled:opacity-50">
                            {bulkUpdating ? '⏳' : '✕ Mark Spam'}
                        </button>
                        <button onClick={deleteSelectedZones} disabled={deletingZones} className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-white font-black text-xs transition-all disabled:opacity-50">
                            {deletingZones ? '⏳ Deleting...' : '🗑 Delete from CF'}
                        </button>
                        <button onClick={() => setSelected(new Set())} className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-black transition-all">
                            Clear
                        </button>
                    </div>
                </div>
            )}

            {error && (
                <div className="p-4 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl">
                    ❌ {error} — Make sure Cloudflare credentials are configured in Settings.
                </div>
            )}

            {loading && domains.length === 0 && (
                <div className="text-center py-16 text-[var(--text-muted)] flex flex-col items-center gap-3">
                    <Spinner size={24} />
                    <div className="font-black">Loading Cloudflare domains…</div>
                </div>
            )}

            {!loading && !error && domains.length === 0 && (
                <div className="text-center py-16 text-[var(--text-muted)]">
                    <div className="text-5xl mb-3">🌐</div>
                    <div className="font-black text-lg">No domains found</div>
                    <div className="text-sm mt-2">Configure Cloudflare API credentials in Settings and refresh.</div>
                </div>
            )}

            {filtered.length > 0 && (
                <div className="glass-card overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-white/10">
                                    <th className="px-5 py-3 w-10">
                                        <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleSelectAll} className="cursor-pointer" />
                                    </th>
                                    <th className="text-left px-5 py-3 text-xs font-black uppercase tracking-widest text-[var(--text-muted)]">Domain</th>
                                    <th className="text-left px-5 py-3 text-xs font-black uppercase tracking-widest text-[var(--text-muted)]">CF Status</th>
                                    <th className="text-left px-5 py-3 text-xs font-black uppercase tracking-widest text-[var(--text-muted)]">Added</th>
                                    <th className="text-center px-5 py-3 text-xs font-black uppercase tracking-widest text-[var(--text-muted)]">Status</th>
                                    <th className="text-center px-5 py-3 text-xs font-black uppercase tracking-widest text-[var(--text-muted)]">DNS</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {filtered.map(d => (
                                    <tr key={d.id} className={`transition-colors hover:bg-white/[0.03] ${selected.has(d.name) ? 'bg-indigo-500/5' : ''}`}>
                                        <td className="px-5 py-3.5">
                                            <input type="checkbox" checked={selected.has(d.name)} onChange={() => toggleSelect(d.name)} className="cursor-pointer" />
                                        </td>
                                        <td className="px-5 py-3.5">
                                            <div className="flex flex-col gap-1.5">
                                                <div className="font-bold text-sm">{d.name}</div>
                                                <button 
                                                    onClick={() => toggleUsed(d.name, !d.isUsed)} 
                                                    disabled={updatingStatus[d.name]}
                                                    title="Click to toggle usage status"
                                                    className={`w-max flex items-center gap-1 text-[10px] px-2 py-0.5 rounded uppercase tracking-wider font-black transition-colors ${d.isUsed ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30 shadow-[0_0_10px_rgba(249,115,22,0.1)]' : 'bg-white/5 text-[var(--text-muted)] border border-white/10 hover:bg-white/10'}`}
                                                >
                                                    {d.isUsed ? '🔒 In Use' : '🔓 Free'}
                                                </button>
                                            </div>
                                        </td>
                                        <td className="px-5 py-3.5">
                                            <span className={`text-xs px-2.5 py-1 rounded-full font-black uppercase tracking-wider ${d.cfStatus === 'active' ? 'bg-emerald-500/20 text-emerald-400' : d.cfStatus === 'pending' ? 'bg-amber-500/20 text-amber-400' : 'bg-white/10 text-[var(--text-muted)]'}`}>
                                                {d.cfStatus}
                                            </span>
                                        </td>
                                        <td className="px-5 py-3.5 text-xs text-[var(--text-muted)]">
                                            {d.createdOn ? new Date(d.createdOn).toLocaleDateString() : '—'}
                                        </td>
                                        <td className="px-5 py-3.5">
                                            <div className="flex items-center justify-center gap-2">
                                                <button
                                                    onClick={() => updateStatus(d.name, 'Inbox')}
                                                    disabled={updatingStatus[d.name]}
                                                    className={`px-3.5 py-1.5 rounded-lg text-xs font-black transition-all disabled:opacity-50 ${d.domainStatus === 'Inbox' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20' : 'bg-white/5 hover:bg-emerald-600/20 text-[var(--text-muted)] hover:text-emerald-400 border border-white/10'}`}
                                                >
                                                    ✓ Inbox
                                                </button>
                                                <button
                                                    onClick={() => updateStatus(d.name, 'Spam')}
                                                    disabled={updatingStatus[d.name]}
                                                    className={`px-3.5 py-1.5 rounded-lg text-xs font-black transition-all disabled:opacity-50 ${d.domainStatus === 'Spam' ? 'bg-red-600 text-white shadow-lg shadow-red-600/20' : 'bg-white/5 hover:bg-red-600/20 text-[var(--text-muted)] hover:text-red-400 border border-white/10'}`}
                                                >
                                                    ✕ Spam
                                                </button>
                                            </div>
                                        </td>
                                        <td className="px-5 py-3.5 text-center">
                                            <button
                                                onClick={() => setTxtDomain(d)}
                                                className="flex items-center gap-1.5 mx-auto px-3.5 py-1.5 rounded-lg bg-violet-500/10 hover:bg-violet-500/30 text-violet-400 text-xs font-black transition-all border border-violet-500/20"
                                            >
                                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>
                                                TXT
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="px-5 py-3 border-t border-white/10 text-xs text-[var(--text-muted)] flex items-center justify-between">
                        <span>Showing {filtered.length} of {domains.length} domains</span>
                        {selected.size > 0 && <span className="text-indigo-400 font-bold">{selected.size} selected</span>}
                    </div>
                </div>
            )}
        </div>
    );
};

export default Domains;
