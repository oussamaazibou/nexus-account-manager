import React, { useState, useEffect, useRef } from 'react';

const API_URL = '/api';

interface ResultAccount {
    id: string;
    email: string;
    password: string;
    collection?: string;
}

interface CreatedUser {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
}

interface AccountResult {
    adminEmail: string;
    created: CreatedUser[];
    failed: { email: string; error: string }[];
    status: 'pending' | 'running' | 'done' | 'error';
    error?: string;
}

interface WorkspaceUsers {
    adminEmail: string;
    adminPassword: string;
    active: string[];
    suspended: string[];
    error: string | null;
    status: 'pending' | 'running' | 'done' | 'error';
}

const CopyAllBtn: React.FC<{ lines: string[]; label?: string }> = ({ lines, label }) => {
    const [copied, setCopied] = useState(false);
    const handle = () => {
        navigator.clipboard.writeText(lines.join('\n'));
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
    };
    return (
        <button
            onClick={handle}
            disabled={lines.length === 0}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-black transition-all disabled:opacity-40
                bg-white/5 hover:bg-white/10 text-[var(--text-muted)] hover:text-white"
        >
            {copied
                ? <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>Copied!</>
                : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>{label || 'Copy All'}</>
            }
        </button>
    );
};

const CreateUsers: React.FC = () => {
    const [accounts, setAccounts] = useState<ResultAccount[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [usersPerAccount, setUsersPerAccount] = useState(9);
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState<AccountResult[]>([]);
    const [done, setDone] = useState(false);
    const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());

    const [userCounts, setUserCounts] = useState<Record<string, number | null>>({});
    const [loadingCounts, setLoadingCounts] = useState(false);
    const [countsLoaded, setCountsLoaded] = useState(false);
    const abortRef = useRef<boolean>(false);

    // List users state
    const [listingUsers, setListingUsers] = useState(false);
    const [workspaceUsers, setWorkspaceUsers] = useState<WorkspaceUsers[]>([]);
    const [listDone, setListDone] = useState(false);
    const [listProgress, setListProgress] = useState(0);

    useEffect(() => {
        fetch(`${API_URL}/result-accounts`)
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data)) setAccounts(data.map((item: any) => ({
                    id: item.id,
                    email: item.data?.userEmail || item.email || '',
                    password: item.data?.userPassword || item.password || '',
                    collection: item.collection,
                })));
            })
            .catch(() => {});
    }, []);

    const loadUserCounts = async () => {
        if (accounts.length === 0 || loadingCounts) return;
        setLoadingCounts(true);
        setCountsLoaded(false);
        abortRef.current = false;
        const emails = accounts.map(a => a.email);
        const CHUNK = 30;
        for (let i = 0; i < emails.length; i += CHUNK) {
            if (abortRef.current) break;
            const chunk = emails.slice(i, i + CHUNK);
            try {
                const res = await fetch(`${API_URL}/manage/bulk-user-counts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ emails: chunk })
                });
                const data = await res.json();
                if (data.results) {
                    const patch: Record<string, number | null> = {};
                    data.results.forEach((r: any) => { patch[r.email] = r.count; });
                    setUserCounts(prev => ({ ...prev, ...patch }));
                }
            } catch {}
        }
        setLoadingCounts(false);
        setCountsLoaded(true);
    };

    const handleListUsers = async () => {
        const selected = accounts.filter(a => selectedIds.has(a.id));
        if (selected.length === 0 || listingUsers) return;
        setListingUsers(true);
        setListDone(false);
        setListProgress(0);

        const initial: WorkspaceUsers[] = selected.map(a => ({
            adminEmail: a.email, adminPassword: a.password, active: [], suspended: [], error: null, status: 'pending'
        }));
        setWorkspaceUsers(initial);

        const BATCH = 5;
        let processed = 0;

        for (let i = 0; i < selected.length; i += BATCH) {
            const batch = selected.slice(i, i + BATCH);

            // Mark batch as running
            setWorkspaceUsers(prev => prev.map(w =>
                batch.some(a => a.email === w.adminEmail) ? { ...w, status: 'running' } : w
            ));

            try {
                const res = await fetch(`${API_URL}/manage/list-workspace-users`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ emails: batch.map(a => a.email) })
                });
                const data = await res.json();
                if (data.results) {
                    setWorkspaceUsers(prev => prev.map(w => {
                        const found = data.results.find((r: any) => r.adminEmail === w.adminEmail);
                        if (!found) return w;
                        return {
                            ...w,
                            active: found.active || [],
                            suspended: found.suspended || [],
                            error: found.error || null,
                            status: found.error ? 'error' : 'done'
                        };
                    }));
                }
            } catch (e: any) {
                setWorkspaceUsers(prev => prev.map(w =>
                    batch.some(a => a.email === w.adminEmail)
                        ? { ...w, status: 'error', error: e.message }
                        : w
                ));
            }

            processed += batch.length;
            setListProgress(Math.round((processed / selected.length) * 100));
        }

        setListingUsers(false);
        setListDone(true);
    };

    const toggleSelect = (id: string) => {
        setSelectedIds(prev => {
            const n = new Set(prev);
            n.has(id) ? n.delete(id) : n.add(id);
            return n;
        });
    };

    const toggleAll = () => {
        if (selectedIds.size === accounts.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(accounts.map(a => a.id)));
        }
    };

    const selectEmpty = () => {
        const emptyIds = accounts.filter(a => userCounts[a.email] === 0).map(a => a.id);
        setSelectedIds(new Set(emptyIds));
    };

    const toggleExpand = (email: string) => {
        setExpandedAccounts(prev => {
            const n = new Set(prev);
            n.has(email) ? n.delete(email) : n.add(email);
            return n;
        });
    };

    const handleCreate = async () => {
        const selected = accounts.filter(a => selectedIds.has(a.id));
        if (selected.length === 0 || usersPerAccount < 1) return;
        setRunning(true);
        setDone(false);
        const initial: AccountResult[] = selected.map(a => ({
            adminEmail: a.email, created: [], failed: [], status: 'pending'
        }));
        setResults(initial);

        for (let i = 0; i < selected.length; i++) {
            const acc = selected[i];
            setResults(prev => prev.map(r => r.adminEmail === acc.email ? { ...r, status: 'running' } : r));
            try {
                const res = await fetch(`${API_URL}/manage/create-users-random`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ adminEmail: acc.email, adminPassword: acc.password, count: usersPerAccount })
                });
                const data = await res.json();
                if (data.success) {
                    setResults(prev => prev.map(r =>
                        r.adminEmail === acc.email
                            ? { ...r, status: 'done', created: data.created || [], failed: data.failed || [] }
                            : r
                    ));
                    setUserCounts(prev => ({ ...prev, [acc.email]: (prev[acc.email] ?? 0) + (data.created?.length ?? 0) }));
                } else {
                    setResults(prev => prev.map(r =>
                        r.adminEmail === acc.email ? { ...r, status: 'error', error: data.error || 'Unknown error' } : r
                    ));
                }
            } catch (e: any) {
                setResults(prev => prev.map(r =>
                    r.adminEmail === acc.email ? { ...r, status: 'error', error: e.message } : r
                ));
            }
        }
        setRunning(false);
        setDone(true);
    };

    const totalCreated = results.reduce((s, r) => s + r.created.length, 0);
    const totalFailed = results.reduce((s, r) => s + r.failed.length, 0);

    const downloadAll = () => {
        const lines: string[] = [];
        results.forEach(r => r.created.forEach(u => lines.push(`${u.email}:${u.password}`)));
        const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'created_users.txt'; a.click();
        URL.revokeObjectURL(url);
    };

    const countedEmails = Object.keys(userCounts).length;
    const emptyCount = accounts.filter(a => userCounts[a.email] === 0).length;

    // Group accounts by collection
    const grouped: Record<string, ResultAccount[]> = {};
    accounts.forEach(a => {
        const key = a.collection || 'No Collection';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(a);
    });
    const collectionNames = Object.keys(grouped).sort();

    const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set());

    const toggleCollection = (col: string) => {
        setExpandedCollections(prev => {
            const n = new Set(prev);
            n.has(col) ? n.delete(col) : n.add(col);
            return n;
        });
    };

    const toggleSelectCollection = (col: string) => {
        const ids = grouped[col].map(a => a.id);
        const allSelected = ids.every(id => selectedIds.has(id));
        setSelectedIds(prev => {
            const n = new Set(prev);
            if (allSelected) ids.forEach(id => n.delete(id));
            else ids.forEach(id => n.add(id));
            return n;
        });
    };

    // Aggregate all active/suspended across all workspace results as email:password
    const allActive = workspaceUsers.flatMap(w => w.active.map(e => `${e}:${w.adminPassword}`));
    const allSuspended = workspaceUsers.flatMap(w => w.suspended.map(e => `${e}:${w.adminPassword}`));

    return (
        <div className="workspace-page space-y-6 max-w-6xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-black tracking-tightest uppercase mb-1">Create Users</h2>
                    <p className="text-[var(--text-muted)] text-sm">Bulk-create random workspace users from your result accounts.</p>
                </div>
                <div className="w-12 h-12 rounded-2xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Account Selector */}
                <div className="lg:col-span-2 glass-card p-5 space-y-4">
                    <div className="flex items-center justify-between border-b border-white/10 pb-3">
                        <h3 className="font-black">Select Accounts</h3>
                        <div className="flex items-center gap-2 flex-wrap justify-end">
                            <span className="text-xs text-[var(--text-muted)]">{selectedIds.size} / {accounts.length} selected</span>
                            {countsLoaded && emptyCount > 0 && (
                                <button onClick={selectEmpty} className="text-xs font-black px-3 py-1.5 rounded-lg bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/40 transition-all">
                                    Select Empty ({emptyCount})
                                </button>
                            )}
                            <button onClick={toggleAll} className="text-xs font-black px-3 py-1.5 rounded-lg bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/40 transition-all">
                                {selectedIds.size === accounts.length ? 'Deselect All' : 'Select All'}
                            </button>
                            <button
                                onClick={loadUserCounts}
                                disabled={loadingCounts || accounts.length === 0}
                                className="text-xs font-black px-3 py-1.5 rounded-lg bg-amber-600/20 text-amber-400 hover:bg-amber-600/40 transition-all disabled:opacity-50 flex items-center gap-1.5"
                            >
                                {loadingCounts
                                    ? <><svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>{countedEmails}/{accounts.length}</>
                                    : countsLoaded ? '↻ Refresh Counts' : '👁 Load Counts'
                                }
                            </button>
                        </div>
                    </div>

                    <div className="space-y-1 max-h-96 overflow-y-auto pr-1">
                        {accounts.length === 0 ? (
                            <div className="text-center py-10 text-[var(--text-muted)] text-sm">No result accounts found</div>
                        ) : (
                            collectionNames.map(col => {
                                const colAccounts = grouped[col];
                                const allSel = colAccounts.every(a => selectedIds.has(a.id));
                                const someSel = !allSel && colAccounts.some(a => selectedIds.has(a.id));
                                const isOpen = expandedCollections.has(col);
                                const selCount = colAccounts.filter(a => selectedIds.has(a.id)).length;
                                return (
                                    <div key={col} className="rounded-xl overflow-hidden border border-white/8">
                                        {/* Collection header */}
                                        <div className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-all select-none ${allSel ? 'bg-indigo-600/15' : someSel ? 'bg-indigo-600/8' : 'bg-black/20'} hover:bg-indigo-600/10`}>
                                            {/* Select-all checkbox */}
                                            <div
                                                onClick={() => toggleSelectCollection(col)}
                                                className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-all ${allSel ? 'bg-indigo-500 border-indigo-500' : someSel ? 'bg-indigo-500/40 border-indigo-500' : 'border-white/20 bg-transparent'}`}
                                            >
                                                {allSel && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5"><polyline points="20 6 9 17 4 12"/></svg>}
                                                {someSel && <div className="w-2 h-0.5 bg-indigo-300 rounded"/>}
                                            </div>
                                            {/* Collection name — clicking toggles expand */}
                                            <div className="flex-1 min-w-0" onClick={() => toggleCollection(col)}>
                                                <span className="font-black text-sm text-[var(--text-main)]">{col}</span>
                                                <span className="ml-2 text-xs text-[var(--text-muted)]">{colAccounts.length} accounts</span>
                                                {selCount > 0 && <span className="ml-2 text-xs font-black text-indigo-400">{selCount} selected</span>}
                                            </div>
                                            {/* Chevron */}
                                            <div onClick={() => toggleCollection(col)} className="shrink-0 text-[var(--text-muted)]">
                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                                            </div>
                                        </div>

                                        {/* Account rows */}
                                        {isOpen && (
                                            <div className="divide-y divide-white/5 bg-black/10">
                                                {colAccounts.map(acc => {
                                                    const count = userCounts[acc.email];
                                                    const hasUsers = count !== undefined && count !== null && count > 0;
                                                    return (
                                                        <label
                                                            key={acc.id}
                                                            className={`flex items-center gap-3 pl-10 pr-4 py-2.5 cursor-pointer transition-all ${
                                                                selectedIds.has(acc.id)
                                                                    ? 'bg-indigo-600/10'
                                                                    : hasUsers
                                                                        ? 'bg-amber-500/5 hover:bg-amber-500/10'
                                                                        : 'hover:bg-white/5'
                                                            }`}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={selectedIds.has(acc.id)}
                                                                onChange={() => toggleSelect(acc.id)}
                                                                className="w-3.5 h-3.5 accent-indigo-500 shrink-0"
                                                            />
                                                            <div className="flex-1 min-w-0">
                                                                <div className="font-mono text-xs text-[var(--text-main)] truncate">{acc.email}</div>
                                                            </div>
                                                            <div className="flex items-center gap-2 shrink-0">
                                                                {loadingCounts && count === undefined && (
                                                                    <svg className="animate-spin text-[var(--text-muted)]" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                                                )}
                                                                {count !== undefined && count !== null && (
                                                                    <span className={`text-xs font-black px-2 py-0.5 rounded-full ${count === 0 ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                                                                        {count === 0 ? 'empty' : `${count}`}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* Config Panel */}
                <div className="glass-card p-5 space-y-5">
                    <h3 className="font-black border-b border-white/10 pb-3">Configuration</h3>

                    <div className="space-y-2">
                        <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Users per Account</label>
                        <input
                            type="number" min={1} value={usersPerAccount}
                            onChange={e => setUsersPerAccount(Math.max(1, parseInt(e.target.value) || 1))}
                            className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)]"
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Password</label>
                        <div className="px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm text-[var(--text-muted)]">Admin account password (auto)</div>
                    </div>

                    <div className="rounded-xl bg-black/20 border border-white/5 p-4 space-y-1.5 text-xs text-[var(--text-muted)]">
                        <div className="flex justify-between"><span>Accounts selected</span><span className="font-black text-[var(--text-main)]">{selectedIds.size}</span></div>
                        <div className="flex justify-between"><span>Users per account</span><span className="font-black text-[var(--text-main)]">{usersPerAccount}</span></div>
                        <div className="flex justify-between border-t border-white/10 pt-1.5 mt-1.5"><span>Total users</span><span className="font-black text-emerald-400">{selectedIds.size * usersPerAccount}</span></div>
                    </div>

                    {/* List Users button */}
                    <button
                        onClick={handleListUsers}
                        disabled={listingUsers || selectedIds.size === 0}
                        className="w-full py-2.5 rounded-xl bg-violet-600/20 hover:bg-violet-600/40 text-violet-400 font-black text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 border border-violet-500/20"
                    >
                        {listingUsers ? (
                            <>
                                <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                {listProgress}% Loading...
                            </>
                        ) : (
                            <>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                                List Users
                            </>
                        )}
                    </button>

                    <button
                        onClick={handleCreate}
                        disabled={running || selectedIds.size === 0}
                        className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm transition-all shadow-[0_0_20px_rgba(16,185,129,0.3)] disabled:opacity-50 disabled:shadow-none flex items-center justify-center gap-2"
                    >
                        {running ? (
                            <><svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Creating...</>
                        ) : `➕ Create ${selectedIds.size * usersPerAccount} Users`}
                    </button>
                </div>
            </div>

            {/* List Users Results */}
            {workspaceUsers.length > 0 && (
                <div className="glass-card p-5 space-y-4">
                    <div className="flex items-center justify-between border-b border-white/10 pb-3">
                        <div>
                            <h3 className="font-black flex items-center gap-2">
                                <span className="text-violet-400">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                                </span>
                                User List
                            </h3>
                            {listDone && (
                                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                                    <span className="text-emerald-400 font-bold">{allActive.length} active</span>
                                    {allSuspended.length > 0 && <span className="text-rose-400 font-bold ml-2">{allSuspended.length} suspended</span>}
                                </p>
                            )}
                        </div>
                        {listingUsers && (
                            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                                <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                {workspaceUsers.filter(w => w.status === 'done' || w.status === 'error').length} / {workspaceUsers.length} done
                            </div>
                        )}
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {/* Active Users */}
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 overflow-hidden">
                            <div className="flex items-center justify-between px-4 py-3 border-b border-emerald-500/20">
                                <div className="flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block"></span>
                                    <span className="font-black text-sm text-emerald-400">Active</span>
                                    <span className="text-xs text-[var(--text-muted)]">({allActive.length})</span>
                                </div>
                                <CopyAllBtn lines={allActive} label={`Copy ${allActive.length}`} />
                            </div>
                            <div className="max-h-64 overflow-y-auto divide-y divide-white/5">
                                {allActive.length === 0 ? (
                                    <div className="text-center py-6 text-xs text-[var(--text-muted)]">
                                        {listingUsers ? 'Loading...' : 'No active users'}
                                    </div>
                                ) : (
                                    allActive.map(line => (
                                        <div key={line} className="flex items-center justify-between px-4 py-2 text-xs group">
                                            <span className="font-mono text-emerald-300 truncate flex-1">{line.split(':')[0]}</span>
                                            <button
                                                onClick={() => navigator.clipboard.writeText(line)}
                                                className="opacity-0 group-hover:opacity-100 transition-opacity text-[var(--text-muted)] hover:text-emerald-400 ml-2 shrink-0"
                                            >
                                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>

                        {/* Suspended Users */}
                        <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 overflow-hidden">
                            <div className="flex items-center justify-between px-4 py-3 border-b border-rose-500/20">
                                <div className="flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full bg-rose-400 inline-block"></span>
                                    <span className="font-black text-sm text-rose-400">Suspended</span>
                                    <span className="text-xs text-[var(--text-muted)]">({allSuspended.length})</span>
                                </div>
                                <CopyAllBtn lines={allSuspended} label={`Copy ${allSuspended.length}`} />
                            </div>
                            <div className="max-h-64 overflow-y-auto divide-y divide-white/5">
                                {allSuspended.length === 0 ? (
                                    <div className="text-center py-6 text-xs text-[var(--text-muted)]">
                                        {listingUsers ? 'Loading...' : 'No suspended users'}
                                    </div>
                                ) : (
                                    allSuspended.map(line => (
                                        <div key={line} className="flex items-center justify-between px-4 py-2 text-xs group">
                                            <span className="font-mono text-rose-300 truncate flex-1">{line.split(':')[0]}</span>
                                            <button
                                                onClick={() => navigator.clipboard.writeText(line)}
                                                className="opacity-0 group-hover:opacity-100 transition-opacity text-[var(--text-muted)] hover:text-rose-400 ml-2 shrink-0"
                                            >
                                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Per-account breakdown */}
                    {listDone && workspaceUsers.some(w => w.error) && (
                        <div className="space-y-1">
                            <p className="text-xs font-black text-rose-400">Failed accounts:</p>
                            {workspaceUsers.filter(w => w.error).map(w => (
                                <div key={w.adminEmail} className="text-xs px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-between">
                                    <span className="font-mono text-rose-300">{w.adminEmail}</span>
                                    <span className="text-rose-400/70">{w.error?.substring(0, 50)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Create Users Results */}
            {results.length > 0 && (
                <div className="glass-card p-5 space-y-4">
                    <div className="flex items-center justify-between border-b border-white/10 pb-3">
                        <div>
                            <h3 className="font-black">Creation Results</h3>
                            {done && (
                                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                                    <span className="text-emerald-400 font-bold">{totalCreated} created</span>
                                    {totalFailed > 0 && <span className="text-rose-400 font-bold ml-2">{totalFailed} failed</span>}
                                </p>
                            )}
                        </div>
                        {done && totalCreated > 0 && (
                            <button onClick={downloadAll} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/40 font-black text-xs transition-all">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                                Download All (.txt)
                            </button>
                        )}
                    </div>

                    <div className="space-y-3">
                        {results.map(r => (
                            <div key={r.adminEmail} className="rounded-xl border border-white/10 overflow-hidden">
                                <button
                                    onClick={() => toggleExpand(r.adminEmail)}
                                    className="w-full flex items-center justify-between px-4 py-3 bg-black/20 hover:bg-black/30 transition-all text-left"
                                >
                                    <div className="flex items-center gap-3">
                                        {r.status === 'running' && <svg className="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>}
                                        {r.status === 'done' && <span className="text-emerald-400 shrink-0">✅</span>}
                                        {r.status === 'error' && <span className="text-rose-400 shrink-0">❌</span>}
                                        {r.status === 'pending' && <span className="text-[var(--text-muted)] shrink-0">⏳</span>}
                                        <span className="font-mono text-sm font-bold text-[var(--text-main)] truncate">{r.adminEmail}</span>
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0">
                                        {r.status === 'done' && (
                                            <><span className="text-xs font-black text-emerald-400">{r.created.length} created</span>
                                            {r.failed.length > 0 && <span className="text-xs font-black text-rose-400">{r.failed.length} failed</span>}</>
                                        )}
                                        {r.status === 'running' && <span className="text-xs text-[var(--text-muted)]">In progress...</span>}
                                        {r.status === 'error' && <span className="text-xs text-rose-400">{r.error?.substring(0, 40)}</span>}
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${expandedAccounts.has(r.adminEmail) ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                                    </div>
                                </button>

                                {expandedAccounts.has(r.adminEmail) && r.created.length > 0 && (
                                    <div className="divide-y divide-white/5 max-h-64 overflow-y-auto">
                                        {r.created.map(u => (
                                            <div key={u.email} className="flex items-center gap-4 px-4 py-2.5 text-xs">
                                                <span className="text-emerald-400 font-mono flex-1 truncate">{u.email}</span>
                                                <span className="font-mono text-[var(--text-muted)]">{u.password}</span>
                                                <button onClick={() => navigator.clipboard.writeText(`${u.email}:${u.password}`)} className="text-[var(--text-muted)] hover:text-indigo-400 transition-colors">
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                                </button>
                                            </div>
                                        ))}
                                        {r.failed.map(u => (
                                            <div key={u.email} className="flex items-center gap-4 px-4 py-2.5 text-xs bg-rose-500/5">
                                                <span className="text-rose-400 font-mono flex-1 truncate">{u.email}</span>
                                                <span className="text-rose-400/70 truncate max-w-xs">{u.error}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default CreateUsers;
