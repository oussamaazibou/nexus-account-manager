import React, { useState, useEffect, useRef } from 'react';

interface AppPasswordAccount {
    id: string;
    email: string;
    password: string;
    appPassword?: string;
    secretKey?: string;
    otp?: string;
    otpTimer?: number;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    error?: string;
}

const API_URL = '/api';

const AppPasswords: React.FC = () => {
    const [accounts, setAccounts] = useState<AppPasswordAccount[]>([]);
    const [loading, setLoading] = useState(false);
    const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [uploadMsg, setUploadMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Timers for OTP countdown
    const otpTimers = React.useRef<Record<string, NodeJS.Timeout>>({});

    const loadAccounts = async () => {
        setLoading(true);
        try {
            const res = await fetch(`${API_URL}/app-passwords/list`);
            if (res.ok) {
                const data = await res.json();
                setAccounts(data);
            }
        } catch (error) {
            console.error('Failed to load app password accounts', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadAccounts();
        return () => {
            // Cleanup otp timers
            Object.values(otpTimers.current).forEach(t => clearTimeout(t));
        };
    }, []);

    const generateAppPassword = async (acc: AppPasswordAccount) => {
        setProcessingIds(prev => new Set(prev).add(acc.id));
        setAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, status: 'processing' } : a));
        try {
            const res = await fetch(`${API_URL}/app-passwords/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: acc.email, password: acc.password })
            });
            const data = await res.json();
            if (data.success) {
                setAccounts(prev => prev.map(a => a.id === acc.id
                    ? { ...a, status: 'completed', appPassword: data.appPassword, secretKey: data.secretKey }
                    : a));
            } else {
                setAccounts(prev => prev.map(a => a.id === acc.id
                    ? { ...a, status: 'failed', error: data.error }
                    : a));
            }
        } catch (e: any) {
            setAccounts(prev => prev.map(a => a.id === acc.id
                ? { ...a, status: 'failed', error: e.message }
                : a));
        } finally {
            setProcessingIds(prev => { const n = new Set(prev); n.delete(acc.id); return n; });
        }
    };

    const getOTP = async (acc: AppPasswordAccount) => {
        try {
            const res = await fetch(`${API_URL}/app-passwords/otp?secret=${acc.secretKey}`);
            const data = await res.json();
            if (data.success) {
                setAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, otp: data.otp, otpTimer: 30 } : a));

                // Countdown
                let secs = 30;
                if (otpTimers.current[acc.id]) clearInterval(otpTimers.current[acc.id] as any);
                otpTimers.current[acc.id] = setInterval(() => {
                    secs--;
                    setAccounts(prev => prev.map(a => {
                        if (a.id !== acc.id) return a;
                        if (secs <= 0) {
                            clearInterval(otpTimers.current[acc.id] as any);
                            return { ...a, otp: undefined, otpTimer: undefined };
                        }
                        return { ...a, otpTimer: secs };
                    }));
                }, 1000) as any;
            }
        } catch (e) {
            console.error('Failed to get OTP', e);
        }
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploadMsg(null);
        const text = await file.text();
        try {
            const res = await fetch(`${API_URL}/app-passwords/upload-list`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: text })
            });
            const data = await res.json();
            if (data.success) {
                setUploadMsg({ type: 'success', text: `✅ Imported ${data.imported} users from file` });
                setAccounts(data.accounts);
                setSelectedIds(new Set());
            } else {
                setUploadMsg({ type: 'error', text: `❌ ${data.error}` });
            }
        } catch (err: any) {
            setUploadMsg({ type: 'error', text: `❌ ${err.message}` });
        }

        // Reset file input
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const toast = (msg: string, type: 'ok'|'err'|'info' = 'info') => {
        const c = document.getElementById('toast-container'); if (!c) return;
        const el = document.createElement('div');
        el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
        el.innerHTML = `<span style="font-weight:700">${type==='ok'?'✓':type==='err'?'✕':'ℹ'}</span><span>${msg}</span>`;
        c.appendChild(el);
        setTimeout(()=>{ el.style.opacity='0'; el.style.transition='all 0.3s'; setTimeout(()=>el.remove(),300); }, 3500);
    };

    const handleClearList = async () => {
        await fetch(`${API_URL}/app-passwords/list`, { method: 'DELETE' });
        setAccounts([]);
        setSelectedIds(new Set());
        toast('List cleared', 'ok');
        setUploadMsg(null);
    };

    const toggleSelect = (id: string) => {
        const next = new Set(selectedIds);
        if (next.has(id)) next.delete(id); else next.add(id);
        setSelectedIds(next);
    };

    const toggleSelectAll = () => {
        if (selectedIds.size === accounts.length) setSelectedIds(new Set());
        else setSelectedIds(new Set(accounts.map(a => a.id)));
    };

    const handleBulkGenerate = async () => {
        if (selectedIds.size === 0) return;
        const toProcess = accounts.filter(a => selectedIds.has(a.id) && a.status !== 'completed');
        for (const acc of toProcess) {
            await generateAppPassword(acc);
        }
    };

    const copyText = (text: string) => {
        navigator.clipboard.writeText(text).catch(() => { });
    };

    const doneCount = accounts.filter(a => a.status === 'completed').length;
    const failedCount = accounts.filter(a => a.status === 'failed').length;
    const pendingCount = accounts.filter(a => a.status === 'pending').length;

    return (
        <div className="space-y-6 animate-in fade-in duration-500 pb-24">
            {/* Header */}
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
                <div>
                    <h2 className="text-2xl sm:text-3xl font-black tracking-tightest uppercase flex items-center gap-3">
                        <span className="text-amber-400">
                            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>
                        </span>
                        App Passwords & OTP
                    </h2>
                    <p className="text-[var(--text-muted)] mt-2 text-sm font-medium">
                        Generate App Passwords for Workspace Users — saved to server <span className="text-amber-400 font-bold">46.224.9.127</span>
                    </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={loadAccounts} className="flex items-center gap-2 px-4 py-2 glass-card text-xs font-black uppercase tracking-widest text-amber-400 hover:bg-amber-400/10 rounded-xl transition-all">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 21h5v-5" /></svg>
                        Refresh
                    </button>
                </div>
            </div>

            {/* Upload + Stats Bar */}
            <div className="glass-card p-6 space-y-4">
                <div className="flex flex-wrap gap-4 items-center justify-between">
                    {/* Stats */}
                    <div className="flex items-center gap-6 text-sm font-bold">
                        <span className="text-[var(--text-muted)]">Total: <span className="text-[var(--text-main)]">{accounts.length}</span></span>
                        <span className="text-emerald-400">✅ Done: {doneCount}</span>
                        <span className="text-amber-400">⏳ Pending: {pendingCount}</span>
                        {failedCount > 0 && <span className="text-rose-400">❌ Failed: {failedCount}</span>}
                    </div>

                    {/* IP Info */}
                    <span className="text-xs text-[var(--text-muted)] font-mono">Server: <span className="text-amber-400">46.224.9.127</span></span>
                </div>

                {/* Upload & Actions */}
                <div className="flex flex-wrap gap-3 items-center">
                    {/* Upload File */}
                    <label className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-black uppercase tracking-widest cursor-pointer transition-all">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" x2="12" y1="3" y2="15" /></svg>
                        Upload File (email:password)
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".txt,.csv"
                            className="hidden"
                            onChange={handleFileUpload}
                        />
                    </label>

                    {/* Bulk Generate btn */}
                    <button
                        onClick={handleBulkGenerate}
                        disabled={selectedIds.size === 0}
                        className="px-5 py-2 bg-amber-500 text-black rounded-xl text-xs font-black uppercase tracking-widest hover:bg-amber-400 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Generate Selected ({selectedIds.size})
                    </button>

                    {/* Generate All Pending */}
                    <button
                        onClick={async () => {
                            const pending = accounts.filter(a => a.status === 'pending');
                            for (const acc of pending) await generateAppPassword(acc);
                        }}
                        disabled={pendingCount === 0}
                        className="px-5 py-2 bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-emerald-500 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Generate All ({pendingCount})
                    </button>

                    {/* Clear List */}
                    {accounts.length > 0 && (
                        <button
                            onClick={handleClearList}
                            className="px-4 py-2 bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-rose-500/20 transition-all ml-auto"
                        >
                            🗑️ Clear List
                        </button>
                    )}
                </div>

                {/* Upload feedback message */}
                {uploadMsg && (
                    <div className={`px-4 py-2 rounded-xl text-xs font-bold ${uploadMsg.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                        {uploadMsg.text}
                    </div>
                )}

                {/* File format hint */}
                <div className="text-[10px] text-[var(--text-muted)] opacity-60">
                    💡 Format fichier: <code className="bg-white/5 px-1 py-0.5 rounded">email:password</code> — wahd user f kol ligne. Compatible avec <code className="bg-white/5 px-1 py-0.5 rounded">created_users.txt</code>
                </div>
            </div>

            {/* Table */}
            <div className="glass-card overflow-hidden shadow-2xl">
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-theme-surface border-b border-theme-glass">
                                <th className="px-4 py-5 w-12 text-center">
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.size === accounts.length && accounts.length > 0}
                                        onChange={toggleSelectAll}
                                        className="w-4 h-4 rounded border-theme-glass bg-theme-surface text-amber-500 cursor-pointer"
                                    />
                                </th>
                                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">User Email</th>
                                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">App Password</th>
                                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest text-center">OTP</th>
                                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest text-center">Status</th>
                                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-theme-glass">
                            {loading ? (
                                <tr>
                                    <td colSpan={6} className="px-6 py-24 text-center">
                                        <div className="flex flex-col items-center gap-3 text-amber-400">
                                            <svg className="animate-spin w-8 h-8" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                                            <span className="text-xs font-bold uppercase tracking-widest opacity-60">Loading...</span>
                                        </div>
                                    </td>
                                </tr>
                            ) : accounts.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="px-6 py-24 text-center">
                                        <div className="flex flex-col items-center gap-4">
                                            <span className="text-5xl">🔐</span>
                                            <span className="text-[var(--text-muted)] text-sm font-bold">Mkaynin users</span>
                                            <div className="text-xs text-[var(--text-muted)] opacity-60 space-y-1 text-center">
                                                <p>1. Uplod fichier <code className="bg-white/10 px-1 rounded">email:password</code></p>
                                                <p>2. Wla cre8 users f "Account Manager" → itkhaznon automatic</p>
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                accounts.map(acc => (
                                    <tr key={acc.id} className={`hover:bg-amber-500/5 transition-all group ${selectedIds.has(acc.id) ? 'bg-amber-500/8' : ''}`}>
                                        <td className="px-4 py-4 text-center">
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.has(acc.id)}
                                                onChange={() => toggleSelect(acc.id)}
                                                className="w-4 h-4 rounded border-theme-glass bg-theme-surface text-amber-500 cursor-pointer"
                                            />
                                        </td>
                                        <td className="px-4 py-4">
                                            <span className="font-bold text-sm text-[var(--text-main)]">{acc.email}</span>
                                        </td>
                                        <td className="px-4 py-4">
                                            {acc.appPassword ? (
                                                <button
                                                    onClick={() => copyText(acc.appPassword!)}
                                                    title="Click to copy"
                                                    className="font-mono text-sm text-amber-400 font-bold bg-amber-400/10 px-2 py-1 rounded hover:bg-amber-400/20 transition-all cursor-copy"
                                                >
                                                    {acc.appPassword}
                                                </button>
                                            ) : (
                                                <span className="text-xs text-[var(--text-muted)] opacity-40 italic">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-4 text-center">
                                            {acc.otp ? (
                                                <div className="flex flex-col items-center gap-1">
                                                    <button
                                                        onClick={() => copyText(acc.otp!)}
                                                        className="font-mono text-white text-base font-black bg-indigo-600 px-3 py-1 rounded-lg hover:bg-indigo-500 transition-all cursor-copy"
                                                    >
                                                        {acc.otp}
                                                    </button>
                                                    <div className="w-16 bg-white/10 rounded-full h-1 overflow-hidden">
                                                        <div
                                                            className="h-1 bg-indigo-400 transition-all duration-1000"
                                                            style={{ width: `${((acc.otpTimer || 0) / 30) * 100}%` }}
                                                        />
                                                    </div>
                                                    <span className="text-[9px] text-indigo-400">{acc.otpTimer}s</span>
                                                </div>
                                            ) : (
                                                acc.secretKey ? (
                                                    <button
                                                        onClick={() => getOTP(acc)}
                                                        className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 hover:bg-indigo-500/20 px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all"
                                                    >
                                                        Get OTP
                                                    </button>
                                                ) : (
                                                    <span className="text-[10px] text-[var(--text-muted)] opacity-30">—</span>
                                                )
                                            )}
                                        </td>
                                        <td className="px-4 py-4 text-center">
                                            {acc.status === 'completed' && <span className="text-emerald-400 bg-emerald-400/10 px-2.5 py-1 rounded-md text-[9px] font-black uppercase tracking-widest border border-emerald-400/20">Done</span>}
                                            {acc.status === 'pending' && <span className="text-slate-400 bg-slate-400/10 px-2.5 py-1 rounded-md text-[9px] font-black uppercase tracking-widest border border-slate-400/20">Pending</span>}
                                            {acc.status === 'processing' && <span className="text-amber-400 bg-amber-400/10 px-2.5 py-1 rounded-md text-[9px] font-black uppercase tracking-widest border border-amber-400/20 animate-pulse">Running...</span>}
                                            {acc.status === 'failed' && <span className="text-rose-400 bg-rose-400/10 px-2.5 py-1 rounded-md text-[9px] font-black uppercase tracking-widest border border-rose-400/20" title={acc.error}>Failed</span>}
                                        </td>
                                        <td className="px-4 py-4 text-right">
                                            <button
                                                onClick={() => generateAppPassword(acc)}
                                                disabled={processingIds.has(acc.id) || acc.status === 'completed'}
                                                className="bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                            >
                                                {processingIds.has(acc.id) ? 'Running...' : acc.status === 'completed' ? '✅ Done' : 'Generate'}
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default AppPasswords;
