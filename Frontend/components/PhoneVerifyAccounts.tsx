
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Icons } from '../constants';

interface PhoneAccount {
    id: string;
    email: string;
    password: string;
    status: 'queued' | 'verifying' | 'done' | 'failed' | 'account_not_found';
    addedAt?: string;
    verifiedBy?: string;
}

const API_URL = '/api';
const BATCH_SIZE = 20;

const GEO_OPTIONS = [
    { code: 'ID', label: 'Indonesia', flag: '🇮🇩' },
    { code: 'CO', label: 'Colombia',  flag: '🇨🇴' },
    { code: 'RU', label: 'Russia',    flag: '🇷🇺' },
    { code: 'US', label: 'USA',       flag: '🇺🇸' },
    { code: 'IN', label: 'India',     flag: '🇮🇳' },
];

const toast = (msg: string, type: 'ok' | 'err' | 'info' = 'info') => {
    const c = document.getElementById('toast-container'); if (!c) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
    el.innerHTML = `<span style="font-weight:700">${type === 'ok' ? '✓' : type === 'err' ? '✕' : 'ℹ'}</span><span>${msg}</span>`;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'all 0.3s'; setTimeout(() => el.remove(), 300); }, 3500);
};

// ─── Per-account verify state ─────────────────────────────────────────────────
type VerifyStep = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 6=bypassed (no phone needed)
interface VerifySlot {
    step: VerifyStep;   // 0=idle, 1=login browser, 2=getting number, 3=entering number, 4=waiting SMS, 5=entering code
    phone?: string;
    activationId?: string;
    code?: string;
    error?: string;
    attempt?: number;  // 1, 2, or 3
}

// ─── Bulk progress ─────────────────────────────────────────────────────────────
interface BulkProgress {
    total: number;
    done: number;       // finished (done or failed)
    succeeded: number;
    failed: number;
    running: boolean;
}

const PhoneVerifyAccounts: React.FC = () => {
    const [accounts, setAccounts] = useState<PhoneAccount[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [geoMap, setGeoMap] = useState<Record<string, string>>({});
    const [verifyState, setVerifyState] = useState<Record<string, VerifySlot>>({});
    const pollRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});

    const [heroBalance, setHeroBalance] = useState<string | null>(null);
    const [fetchingBalance, setFetchingBalance] = useState(false);

    // Bulk batch state
    const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
    const bulkCancelRef = useRef(false);
    const [bulkGeo, setBulkGeo] = useState('ID');

    // ── Fetch ──────────────────────────────────────────────────────────────────
    const fetchAccounts = useCallback(async () => {
        try {
            const session = localStorage.getItem('nexus_session');
            const me = session ? JSON.parse(session) : null;
            const isAdm = me?.role === 'admin';
            const uname = isAdm ? 'admin' : (me?.username || 'global');
            const res = await fetch(`${API_URL}/phone-verified-accounts?user=${uname}`);
            if (res.ok) setAccounts(await res.json());
        } catch (e) {
            console.error('Fetch phone accounts error:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    const fetchHeroBalance = useCallback(async () => {
        setFetchingBalance(true);
        try {
            const res = await fetch(`${API_URL}/phone-verify/balance`);
            const data = await res.json();
            if (data.success) setHeroBalance(data.balance);
            else toast(`Balance err: ${data.error}`, 'err');
        } catch (e) {
            toast('Failed to fetch Hero balance', 'err');
        } finally {
            setFetchingBalance(false);
        }
    }, []);

    useEffect(() => {
        fetchAccounts();
        fetchHeroBalance();
        const iv = setInterval(fetchAccounts, 5000);
        return () => {
            clearInterval(iv);
            Object.values(pollRefs.current).forEach(clearInterval);
        };
    }, [fetchAccounts, fetchHeroBalance]);

    // ── Per-account helpers ────────────────────────────────────────────────────
    const setSlot = (id: string, step: VerifyStep, extra: Partial<VerifySlot> = {}) =>
        setVerifyState(prev => ({ ...prev, [id]: { ...(prev[id] || { step: 0 }), step, ...extra } }));

    const stopPoll = (id: string) => {
        if (pollRefs.current[id]) { clearInterval(pollRefs.current[id]); delete pollRefs.current[id]; }
    };

    // ── Core verify logic: Gmail login → Hero SMS → 3-attempt retry ────────────
    const startVerify = useCallback(async (acc: PhoneAccount): Promise<boolean> => {
        const geo = geoMap[acc.id] || 'ID';
        stopPoll(acc.id);

        // Step 1 – Launching browser & logging in
        setSlot(acc.id, 1, { phone: undefined, code: undefined, activationId: undefined, error: undefined, attempt: 1 });

        let activationId = '';
        let phone = '';
        let attempt = 1;
        let phoneRejected = false;

        // Call start: Login Gmail + get Hero SMS number + enter it in Google
        let startSuccess = false;
        try {
            const res = await fetch(`${API_URL}/phone-verify/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: acc.email, password: acc.password, geo })
            });
            const data = await res.json();
            if (!data.success) {
                const isNotFound = data.error === 'ACCOUNT_NOT_FOUND';
                setSlot(acc.id, 0, { error: isNotFound ? 'Account does not exist on Google' : (data.error || 'Failed to start') });
                setAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, status: isNotFound ? 'account_not_found' : 'failed' } : a));
                return false;
            }
            if (data.doneDirectly) {
                setSlot(acc.id, 6, { code: 'BYPASSED' });
                setAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, status: 'done' } : a));
                toast(`✅ ${acc.email} logged in directly!`, 'ok');
                return true;
            }
            
            if (data.phoneRejected) {
                phoneRejected = true;
            } else {
                activationId = data.activationId;
                phone = data.phone;
            }
            attempt = data.attempt || 1;
            startSuccess = true;
        } catch (e: any) {
            setSlot(acc.id, 0, { error: 'Connection error: ' + e.message });
            return false;
        }

        setAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, status: 'verifying' } : a));

        const POLL_INTERVAL = 5000;
        const MAX_POLLS = 18; // 18 × 5s = 90s
        const MAX_PHONE_ATTEMPTS = 3;

        let codeReceived = false;

        // Loop up to 3 attempts
        while (attempt <= MAX_PHONE_ATTEMPTS && !codeReceived) {
            if (!phoneRejected) {
                setSlot(acc.id, 4, { phone, activationId, attempt });

                await new Promise<void>((resolve) => {
                    let polls = 0;
                    pollRefs.current[acc.id] = setInterval(async () => {
                        polls++;
                        if (polls > MAX_POLLS) {
                            stopPoll(acc.id); resolve(); return;
                        }
                        try {
                            const r = await fetch(`${API_URL}/phone-verify/code?activationId=${activationId}&email=${encodeURIComponent(acc.email)}`);
                            const d = await r.json();
                            if (d.status === 'received' && d.code) {
                                stopPoll(acc.id);
                                // Step 5 – Entering code in browser
                                setSlot(acc.id, 5, { phone, activationId, code: d.code, attempt });
                                setAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, status: 'done' } : a));
                                toast(`✅ ${acc.email} → SMS: ${d.code}`, 'ok');
                                codeReceived = true; resolve();
                            } else if (d.status === 'cancelled') {
                                stopPoll(acc.id); resolve();
                            }
                        } catch { /* keep polling */ }
                    }, POLL_INTERVAL);
                });

                if (codeReceived) return true;
            }

            if (attempt < MAX_PHONE_ATTEMPTS) {
                // Wait before retrying
                await new Promise(r => setTimeout(r, 2000));
                try {
                    const retryRes = await fetch(`${API_URL}/phone-verify/retry-number`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: acc.email, oldActivationId: activationId })
                    });
                    const retryData = await retryRes.json();
                    if (!retryData.success) {
                        // Retry failed (e.g., max attempts reached or hero error)
                        break;
                    }
                    activationId = retryData.activationId;
                    phone = retryData.phone;
                    attempt = retryData.attempt;
                    phoneRejected = false; // Reset for next loop
                } catch (e) {
                    break;
                }
            } else {
                break;
            }
        }

        if (codeReceived) return true;

        // Failed or Timed out
        setSlot(acc.id, 0, { phone, activationId, error: `Failed: No SMS code received after ${MAX_PHONE_ATTEMPTS} attempts` });
        setAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, status: 'failed' } : a));
        fetch(`${API_URL}/phone-verify/close-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: acc.email, status: 'failed' }) }).catch(() => {});
        return false;
    }, [geoMap]);

    // ── Remove ─────────────────────────────────────────────────────────────────
    const removeAccount = async (acc: PhoneAccount) => {
        stopPoll(acc.id);
        setVerifyState(prev => { const n = { ...prev }; delete n[acc.id]; return n; });
        try {
            await fetch(`${API_URL}/phone-verified-accounts`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: acc.email })
            });
            setAccounts(prev => prev.filter(a => a.id !== acc.id));
        } catch (e) { console.error('Remove error:', e); }
    };

    // ── Selection ──────────────────────────────────────────────────────────────
    const toggleSelect = (id: string) => {
        const next = new Set(selectedIds);
        if (next.has(id)) next.delete(id); else next.add(id);
        setSelectedIds(next);
    };
    const toggleSelectAll = () => {
        if (selectedIds.size === accounts.length) setSelectedIds(new Set());
        else setSelectedIds(new Set(accounts.map(a => a.id)));
    };

    const handleSelectFailed = () => {
        const failedIds = accounts.filter(a => a.status === 'failed').map(a => a.id);
        if (failedIds.length === 0) return toast('No failed accounts found', 'info');
        setSelectedIds(new Set(failedIds));
    };

    const handleSelectNotFound = () => {
        const notFoundIds = accounts.filter(a => a.status === 'account_not_found').map(a => a.id);
        if (notFoundIds.length === 0) return toast('No "Account Not Found" accounts', 'info');
        setSelectedIds(new Set(notFoundIds));
    };

    // ── Bulk Delete ────────────────────────────────────────────────────────────
    const handleBulkDelete = async () => {
        if (selectedIds.size === 0) return;
        for (const acc of accounts.filter(a => selectedIds.has(a.id))) await removeAccount(acc);
        setSelectedIds(new Set());
        toast('Deleted selected accounts', 'ok');
    };

    // ── Bulk Start — BATCH OF 10 ───────────────────────────────────────────────
    // Runs 10 accounts concurrently; when ALL 10 finish (done or failed),
    // automatically starts the next 10, and so on until all selected are done.
    const startingRef = useRef(false);
    
    const handleBulkStart = async (autoQueue?: PhoneAccount[] | any) => {
        const queue = (Array.isArray(autoQueue) ? autoQueue : null) || accounts.filter(a => selectedIds.has(a.id));
        if (queue.length === 0) return;

        bulkCancelRef.current = false;
        startingRef.current = true;
        // Apply bulk GEO to all selected accounts before starting
        setGeoMap(prev => {
            const next = { ...prev };
            queue.forEach(acc => { next[acc.id] = bulkGeo; });
            return next;
        });
        if (!autoQueue) setSelectedIds(new Set());

        const total = queue.length;
        let done = 0, succeeded = 0, failed = 0;
        let queueIndex = 0;

        setBulkProgress({ total, done, succeeded, failed, running: true });

        // Worker function: keeps pulling from queue until empty or cancelled
        const runWorker = async () => {
            while (queueIndex < total && !bulkCancelRef.current) {
                const currentIdx = queueIndex++;
                if (currentIdx >= total) break;

                const acc = queue[currentIdx];
                const ok = await startVerify(acc);
                
                done++;
                if (ok) succeeded++; else failed++;
                
                // Update progress after each individual finish
                setBulkProgress(prev => 
                    prev ? { ...prev, done, succeeded, failed, running: queueIndex < total || (done < total) } : null
                );
            }
        };

        // Start BATCH_SIZE workers concurrently
        const workers = Array.from({ length: Math.min(BATCH_SIZE, total) }, () => runWorker());
        
        // Wait for all workers to finish
        await Promise.all(workers);

        setBulkProgress(prev => prev ? { ...prev, running: false } : null);
        startingRef.current = false;
        toast(`✅ Bulk done — ${succeeded}/${total} verified`, 'ok');
        setTimeout(() => setBulkProgress(null), 8000);
    };

    // Auto-start queued accounts when they appear
    useEffect(() => {
        if (!loading && !bulkProgress?.running && !startingRef.current) {
            const autoEmailsStr = localStorage.getItem('nexus_auto_verify_emails');
            if (autoEmailsStr) {
                try {
                    const autoEmails = JSON.parse(autoEmailsStr);
                    const targets = accounts.filter(a => a.status === 'queued' && autoEmails.includes(a.email));
                    if (targets.length > 0) {
                        // Remove started ones from localStorage
                        const remaining = autoEmails.filter((e: string) => !targets.some(t => t.email === e));
                        if (remaining.length === 0) localStorage.removeItem('nexus_auto_verify_emails');
                        else localStorage.setItem('nexus_auto_verify_emails', JSON.stringify(remaining));
                        
                        handleBulkStart(targets);
                    }
                } catch (e) {}
            }
        }
    }, [accounts, loading, bulkProgress?.running]);

    // ── File Upload ────────────────────────────────────────────────────────────
    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        setUploading(true);
        setUploadProgress(null);
        try {
            const text = await file.text();
            const parsed = text.split('\n')
                .map(l => l.trim())
                .filter(l => l.includes('@'))
                .map(line => {
                    const idx = line.indexOf(':');
                    if (idx > -1) {
                        return { email: line.substring(0, idx).trim(), password: line.substring(idx + 1).trim() };
                    }
                    return { email: line, password: '' };
                })
                .filter(a => a.email);
            if (parsed.length === 0) { toast('No valid accounts found.', 'err'); setUploading(false); return; }
            setUploadProgress({ done: 0, total: parsed.length });
            const session = localStorage.getItem('nexus_session');
            const me = session ? JSON.parse(session) : null;
            const res = await fetch(`${API_URL}/accounts/verify-phone/bulk`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accounts: parsed, verifiedBy: me?.username || 'ALL' })
            });
            const data = await res.json();
            if (data.success) {
                setUploadProgress({ done: data.queued, total: parsed.length });
                toast(`Queued ${data.queued} account(s)${data.skipped > 0 ? ` (${data.skipped} skipped)` : ''}`, 'ok');
                await fetchAccounts();
            } else { toast('Upload failed: ' + data.error, 'err'); }
        } catch (err: any) { toast('Error: ' + err.message, 'err'); }
        finally { setUploading(false); setTimeout(() => setUploadProgress(null), 4000); }
    };

    // ── Status / Step config ───────────────────────────────────────────────────
    const statusConfig: Record<PhoneAccount['status'], { label: string; color: string }> = {
        queued:            { label: 'QUEUED',            color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
        verifying:         { label: 'VERIFYING',         color: 'text-teal-400 bg-teal-400/10 border-teal-400/20 animate-pulse' },
        done:              { label: 'DONE ✓',            color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
        failed:            { label: 'FAILED',            color: 'text-rose-400 bg-rose-400/10 border-rose-400/20' },
        account_not_found: { label: 'ACCOUNT NOT FOUND', color: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20' },
    };

    const stepLabel = (step: number, attempt?: number) => {
        const att = attempt ? ` (${attempt}/3)` : '';
        if (step === 1) return { text: 'Launching browser & logging in...', color: 'text-blue-400' };
        if (step === 2) return { text: `Getting phone number${att}...`, color: 'text-amber-400' };
        if (step === 3) return { text: `Entering number in Google${att}...`, color: 'text-indigo-400' };
        if (step === 4) return { text: `Waiting for SMS${att}...`, color: 'text-teal-400' };
        if (step === 5) return { text: 'Entering code in browser...', color: 'text-emerald-400' };
        return null;
    };

    // ── Render ─────────────────────────────────────────────────────────────────
    return (
        <div className="space-y-6 animate-in fade-in duration-500 pb-28">

            {/* Header */}
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
                <div>
                    <h2 className="text-2xl sm:text-3xl font-black tracking-tightest uppercase flex items-center gap-3">
                        <span className="text-teal-400"><Icons.Phone /></span>
                        Verify Phone Active
                    </h2>
                    <p className="text-[var(--text-muted)] mt-2 text-sm font-medium">
                        {accounts.length} account(s) queued for phone SMS verification via Hero SMS.
                    </p>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                    <label className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest cursor-pointer transition-all ${uploading ? 'bg-teal-700/50 text-teal-300 cursor-wait' : 'bg-teal-600 hover:bg-teal-500 text-white'}`}>
                        <input ref={fileInputRef} type="file" accept=".txt,.csv" className="hidden" onChange={handleFileUpload} disabled={uploading} />
                        {uploading ? (
                            <><svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                            {uploadProgress ? `${uploadProgress.done}/${uploadProgress.total}` : 'Uploading...'}</>
                        ) : (
                            <><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                            Upload TXT</>
                        )}
                    </label>
                    <button onClick={handleSelectFailed} className="flex items-center gap-2 px-4 py-2.5 glass-card text-xs font-black uppercase tracking-widest text-rose-400 hover:bg-rose-500/10 rounded-xl transition-all">
                        <Icons.AlertTriangle size={14} />
                        Select Failed
                    </button>
                    <button onClick={handleSelectNotFound} className="flex items-center gap-2 px-4 py-2.5 glass-card text-xs font-black uppercase tracking-widest text-yellow-400 hover:bg-yellow-500/10 rounded-xl transition-all">
                        <Icons.AlertTriangle size={14} />
                        Not Found
                    </button>
                    <button onClick={fetchAccounts} className="flex items-center gap-2 px-4 py-2.5 glass-card text-xs font-black uppercase tracking-widest text-teal-400 hover:bg-teal-500/10 rounded-xl transition-all">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 21h5v-5" /></svg>
                        Refresh
                    </button>
                    <button onClick={fetchHeroBalance} disabled={fetchingBalance} className="flex items-center gap-2 px-4 py-2.5 glass-card text-xs font-black tracking-widest text-emerald-400 hover:bg-emerald-500/10 rounded-xl transition-all border border-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed" title="Click to refresh balance">
                        <svg className={fetchingBalance ? "animate-spin" : ""} xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                        <span className="font-mono">{heroBalance !== null ? `$${heroBalance}` : '---'}</span>
                    </button>
                </div>
            </div>

            {/* Bulk Progress Banner */}
            {bulkProgress && (
                <div className="glass-card px-5 py-4 flex flex-col gap-3 border border-teal-500/30">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm font-black text-teal-300">
                            {bulkProgress.running ? (
                                <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                            ) : (
                                <span className="text-emerald-400">✓</span>
                            )}
                            {bulkProgress.running ? `Bulk Processing — Batch ${Math.ceil(bulkProgress.done / BATCH_SIZE) + (bulkProgress.done % BATCH_SIZE !== 0 || bulkProgress.done === 0 ? 0 : 0)}` : 'Bulk Complete'}
                        </div>
                        <div className="flex items-center gap-4 text-xs font-bold">
                            <span className="text-emerald-400">✓ {bulkProgress.succeeded}</span>
                            <span className="text-rose-400">✕ {bulkProgress.failed}</span>
                            <span className="text-[var(--text-muted)]">{bulkProgress.done}/{bulkProgress.total}</span>
                            {bulkProgress.running && (
                                <button onClick={() => { bulkCancelRef.current = true; }} className="text-amber-400 hover:text-amber-300 uppercase tracking-widest text-[9px] font-black">Cancel</button>
                            )}
                        </div>
                    </div>
                    {/* Progress bar */}
                    <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-teal-500 rounded-full transition-all duration-500"
                            style={{ width: `${bulkProgress.total > 0 ? Math.round((bulkProgress.done / bulkProgress.total) * 100) : 0}%` }}
                        />
                    </div>
                    <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-widest">
                        Running {BATCH_SIZE} accounts concurrently — next batch starts automatically when current finishes
                    </div>
                </div>
            )}

            {/* Info hint */}
            <div className="glass-card px-5 py-3 flex items-center gap-3 text-xs text-[var(--text-muted)]">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                <span>
                    Upload <code className="bg-white/5 px-1.5 py-0.5 rounded font-mono text-teal-300">email:password</code> TXT →
                    select GEO → click <strong>Start</strong> per account  <em>or</em>  select accounts and click <strong>Start All</strong> to run <strong>{BATCH_SIZE} at a time</strong>.
                </span>
            </div>

            {/* GEO legend */}
            <div className="flex items-center gap-3 flex-wrap">
                {GEO_OPTIONS.map(g => (
                    <div key={g.code} className="glass-card px-4 py-2 flex items-center gap-2 text-xs font-bold">
                        <span className="text-base">{g.flag}</span>
                        <span className="text-[var(--text-muted)]">{g.label}</span>
                        <span className="text-[var(--text-muted)] opacity-40 font-mono text-[10px]">{g.code}</span>
                    </div>
                ))}
                <span className="text-[10px] text-[var(--text-muted)] opacity-40 uppercase tracking-widest">Hero SMS GEO</span>
            </div>

            {/* Table */}
            <div className="glass-card overflow-hidden shadow-2xl">
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse min-w-[820px]">
                        <thead>
                            <tr className="bg-theme-surface border-b border-theme-glass">
                                <th className="px-4 py-5 w-12 text-center">
                                    <input type="checkbox"
                                        checked={selectedIds.size === accounts.length && accounts.length > 0}
                                        onChange={toggleSelectAll}
                                        className="w-4 h-4 rounded border-theme-glass bg-theme-surface text-teal-500 cursor-pointer"
                                    />
                                </th>
                                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Email</th>
                                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">GEO</th>
                                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Phone Number</th>
                                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">SMS Code</th>
                                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest text-center">Status</th>
                                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-theme-glass">
                            {loading ? (
                                <tr><td colSpan={7} className="px-6 py-24 text-center">
                                    <div className="flex flex-col items-center gap-3 text-teal-400">
                                        <svg className="animate-spin w-8 h-8" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                                        <span className="text-xs font-bold uppercase tracking-widest opacity-60">Loading...</span>
                                    </div>
                                </td></tr>
                            ) : accounts.length === 0 ? (
                                <tr><td colSpan={7} className="px-6 py-24 text-center">
                                    <div className="flex flex-col items-center gap-3">
                                        <span className="text-4xl">📱</span>
                                        <span className="text-[var(--text-muted)] text-sm font-medium italic">No accounts queued for phone verification.</span>
                                        <span className="text-[10px] text-[var(--text-muted)] opacity-50 uppercase tracking-widest">Upload a TXT file (email:password) to get started</span>
                                    </div>
                                </td></tr>
                            ) : accounts.map(acc => {
                                const vs = verifyState[acc.id];
                                const step = vs?.step ?? 0;
                                const sl = stepLabel(step, vs?.attempt);
                                const geo = geoMap[acc.id] || 'ID';
                                const isRunning = step >= 1 && acc.status !== 'done' && acc.status !== 'failed' && acc.status !== 'account_not_found';

                                return (
                                    <tr key={acc.id} className={`hover:bg-teal-500/5 transition-all group ${selectedIds.has(acc.id) ? 'bg-teal-500/10' : ''}`}>
                                        <td className="px-4 py-4 text-center">
                                            <input type="checkbox" checked={selectedIds.has(acc.id)} onChange={() => toggleSelect(acc.id)}
                                                className="w-4 h-4 rounded border-theme-glass bg-theme-surface text-teal-500 cursor-pointer"
                                            />
                                        </td>

                                        {/* Email + live step */}
                                        <td className="px-4 py-4">
                                            <div className="flex flex-col gap-1">
                                                <div className="flex items-center gap-2">
                                                    <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                                        acc.status === 'done' ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]' :
                                                        acc.status === 'verifying' ? 'bg-teal-400 animate-pulse' :
                                                        acc.status === 'failed' ? 'bg-rose-500' :
                                                        acc.status === 'account_not_found' ? 'bg-yellow-400' : 'bg-amber-400'
                                                    }`} />
                                                    <span className="font-bold text-sm text-[var(--text-main)] truncate max-w-[150px] md:max-w-xs">{acc.email}</span>
                                                    {(() => {
                                                        const session = localStorage.getItem('nexus_session');
                                                        const me = session ? JSON.parse(session) : null;
                                                        if (me?.role === 'admin' && acc.verifiedBy && acc.verifiedBy !== 'ALL') {
                                                            return (
                                                                <span className="text-[10px] bg-white/5 border border-white/10 px-2 py-0.5 rounded-md font-black text-[var(--text-muted)] uppercase tracking-tighter shrink-0">
                                                                    By: {acc.verifiedBy}
                                                                </span>
                                                            );
                                                        }
                                                        return null;
                                                    })()}
                                                </div>
                                                {sl && isRunning && (
                                                    <div className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest ${sl.color}`}>
                                                        <svg className="animate-spin shrink-0" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                                                        {sl.text}
                                                    </div>
                                                )}
                                                {vs?.error && (
                                                    <div className="text-[10px] text-rose-400 font-bold truncate max-w-[220px]" title={vs.error}>✕ {vs.error}</div>
                                                )}
                                            </div>
                                        </td>

                                        {/* GEO selector */}
                                        <td className="px-4 py-4">
                                            <select value={geo}
                                                onChange={e => setGeoMap(prev => ({ ...prev, [acc.id]: e.target.value }))}
                                                disabled={isRunning}
                                                className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs font-bold text-[var(--text-main)] outline-none cursor-pointer appearance-none disabled:opacity-40"
                                            >
                                                {GEO_OPTIONS.map(g => (
                                                    <option key={g.code} value={g.code} className="bg-[#0f172a]">{g.flag} {g.label}</option>
                                                ))}
                                            </select>
                                        </td>

                                        {/* Phone number */}
                                        <td className="px-4 py-4">
                                            {vs?.phone ? (
                                                <div className="flex items-center gap-2 cursor-pointer"
                                                    onClick={() => { navigator.clipboard.writeText(vs.phone!); toast('Phone copied', 'ok'); }}
                                                    title="Click to copy">
                                                    <span className="text-sm font-mono font-bold text-teal-300">{vs.phone}</span>
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-muted)] opacity-50"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                                                </div>
                                            ) : <span className="text-xs text-[var(--text-muted)] opacity-30 italic">—</span>}
                                        </td>

                                        {/* SMS Code */}
                                        <td className="px-4 py-4">
                                            {vs?.code ? (
                                                <div className="flex items-center gap-2 cursor-pointer"
                                                    onClick={() => { navigator.clipboard.writeText(vs.code!); toast('Code copied', 'ok'); }}
                                                    title="Click to copy">
                                                    <span className="text-base font-mono font-black text-emerald-400 tracking-widest">{vs.code}</span>
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-muted)] opacity-50"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                                                </div>
                                            ) : step === 3 ? (
                                                <div className="flex items-center gap-1.5 text-[10px] text-teal-400 font-bold uppercase tracking-widest">
                                                    <svg className="animate-pulse" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/></svg>
                                                    Waiting...
                                                </div>
                                            ) : <span className="text-xs text-[var(--text-muted)] opacity-30 italic">—</span>}
                                        </td>

                                        {/* Status badge */}
                                        <td className="px-4 py-4 text-center">
                                            <span className={`inline-flex items-center px-2.5 py-1 rounded-md border text-[9px] font-black uppercase tracking-widest ${statusConfig[acc.status].color}`}>
                                                {statusConfig[acc.status].label}
                                            </span>
                                        </td>

                                        {/* Actions */}
                                        <td className="px-4 py-4 text-right">
                                            <div className="flex items-center justify-end gap-1 md:opacity-40 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    onClick={() => startVerify(acc)}
                                                    disabled={isRunning}
                                                    title={isRunning ? 'Processing...' : acc.status === 'done' ? 'Run again' : 'Start phone verification'}
                                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest border transition-all disabled:opacity-40 disabled:cursor-not-allowed
                                                        ${acc.status === 'done' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20' : 'bg-teal-500/10 border-teal-500/20 text-teal-400 hover:bg-teal-500/20'}`}
                                                >
                                                    {isRunning ? (
                                                        <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                                                    ) : (
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                                    )}
                                                    {isRunning ? (vs?.attempt ? `Attempt ${vs.attempt}/3` : `Step ${step}/5`) : (acc.status === 'done' || vs?.code) ? 'Retry' : 'Start'}
                                                </button>
                                                <button onClick={() => removeAccount(acc)} title="Remove" className="p-2 text-rose-500 hover:bg-rose-500/10 rounded-xl transition-all">
                                                    <Icons.Trash />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Floating Bulk Action Bar */}
            {selectedIds.size > 0 && (
                <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-10 w-[90%] max-w-xl">
                    <div className="bg-[#0f172a] rounded-2xl px-6 py-4 shadow-2xl flex items-center justify-between gap-4 border border-white/10 backdrop-blur-xl">
                        <div className="flex flex-col">
                            <span className="text-sm font-black text-white">{selectedIds.size} SELECTED</span>
                            <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-widest">{BATCH_SIZE} concurrent per batch</span>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                            {/* Bulk GEO Selector */}
                            <div className="flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-xl px-2 py-1">
                                <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest">GEO</span>
                                <select
                                    value={bulkGeo}
                                    onChange={e => setBulkGeo(e.target.value)}
                                    className="bg-transparent text-xs font-black text-white outline-none cursor-pointer appearance-none"
                                >
                                    {GEO_OPTIONS.map(g => (
                                        <option key={g.code} value={g.code} className="bg-[#0f172a]">
                                            {g.flag} {g.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <button
                                onClick={handleBulkStart}
                                className="bg-teal-600 text-white px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-teal-500 transition-all active:scale-95 flex items-center gap-1.5"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                Start All
                            </button>
                            <button onClick={handleBulkDelete} className="bg-rose-600 text-white px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-rose-500 transition-all active:scale-95">
                                Delete
                            </button>
                            <button onClick={() => setSelectedIds(new Set())} className="p-2 text-white/60 hover:text-white transition-colors">
                                <Icons.X size={18} />
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PhoneVerifyAccounts;
