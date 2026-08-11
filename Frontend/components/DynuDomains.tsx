import React, { useState, useEffect, useCallback, useRef } from 'react';

const API_URL = '/api';
const PAGE_SIZE_DEFAULT = 25;

interface JobAccount {
    email: string;
    collection?: string;
    status?: string;
}

interface DynuLog {
    ts: string;
    level: 'INFO' | 'WARN' | 'ERROR';
    msg: string;
}

interface DynuProvisioned {
    baseDomain: string;
    subdomain: string;
    adminEmail: string;
    provider: string | null;
    verified: boolean;
    dynuHost?: { created: boolean; already?: boolean; zoneId?: number | null } | null;
    createdAt: string;
}

interface DynuStore {
    baseDomains: string[];
    provisioned: DynuProvisioned[];
}

interface BulkResult {
    email: string;
    baseDomain?: string;
    success?: boolean;
    subdomain?: string;
    verified?: boolean;
    provider?: string | null;
    error?: string;
    status?: string;
}

interface BulkUserAccountStatus {
    email: string;
    password?: string;
    targetDomain?: string;
    status: string;
    usersCreated: number;
    error?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
}

interface BulkUserJobStatus {
    running: boolean;
    stopRequested: boolean;
    startedAt?: string | null;
    finishedAt?: string | null;
    total: number;
    done: number;
    ok: number;
    failed: number;
    concurrency: number;
    usersPerAccount: number;
    accounts: BulkUserAccountStatus[];
}

interface DynuZone {
    id: number;
    name: string;
    [k: string]: any;
}

interface DynuDnsRecord {
    id: number;
    recordType: string;
    nodeName?: string;
    hostname?: string;
    content?: string;
    textData?: string;
    ipv4Address?: string;
    ipv6Address?: string;
    host?: string;
    priority?: number;
    port?: number;
    weight?: number;
    ttl?: number;
    state?: boolean;
    [k: string]: any;
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

const recordValue = (r: DynuDnsRecord): string => {
    const v = r.ipv4Address || r.ipv6Address || r.host || r.textData || r.content || '';
    const extra = [];
    if (r.priority != null && (r.recordType === 'MX' || r.recordType === 'SRV')) extra.push(`prio ${r.priority}`);
    if (r.port != null && r.recordType === 'SRV') extra.push(`port ${r.port}`);
    if (r.weight != null && r.recordType === 'SRV') extra.push(`weight ${r.weight}`);
    return extra.length ? `${v}  (${extra.join(', ')})` : v;
};

const DynuDomains: React.FC = () => {
    const [accounts, setAccounts] = useState<JobAccount[]>([]);
    const [selectedEmail, setSelectedEmail] = useState('');
    const [searchText, setSearchText] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const [store, setStore] = useState<DynuStore>({ baseDomains: [], provisioned: [] });
    const [baseDomainsText, setBaseDomainsText] = useState('');
    const [savingBases, setSavingBases] = useState(false);
    const [removingBase, setRemovingBase] = useState<string | null>(null);
    const [provisioning, setProvisioning] = useState<string | null>(null);
    const [verifying, setVerifying] = useState<string | null>(null);
    const [clearingProvisioned, setClearingProvisioned] = useState(false);
    const [clearingLogs, setClearingLogs] = useState(false);

    // Bulk provision
    const [bulkText, setBulkText] = useState('');
    const [bulkMode, setBulkMode] = useState<'single' | 'rotate'>('single');
    const [bulkBaseDomain, setBulkBaseDomain] = useState('');
    const [bulkDomainsText, setBulkDomainsText] = useState('');
    const [bulking, setBulking] = useState(false);
    const [bulkResults, setBulkResults] = useState<BulkResult[]>([]);

    // Bulk user creation
    const [selectedBulkAccounts, setSelectedBulkAccounts] = useState<Set<string>>(new Set());
    const [usersPerAccount, setUsersPerAccount] = useState(9);
    const [bulkUsersConcurrency, setBulkUsersConcurrency] = useState(2);
    const [bulkUsersDomain, setBulkUsersDomain] = useState('');
    const [bulkUsersRunning, setBulkUsersRunning] = useState(false);
    const [bulkUsersJob, setBulkUsersJob] = useState<BulkUserJobStatus | null>(null);

    // Activity log
    const [logs, setLogs] = useState<DynuLog[]>([]);
    const [logsOpen, setLogsOpen] = useState(true);
    const logScrollRef = useRef<HTMLDivElement>(null);

    // Domain manager
    const [managerDomains, setManagerDomains] = useState<DynuZone[]>([]);
    const [managerLoading, setManagerLoading] = useState(false);
    const [managerError, setManagerError] = useState('');
    const [managerPage, setManagerPage] = useState(1);
    const [managerPageSize, setManagerPageSize] = useState<number | 'all'>(PAGE_SIZE_DEFAULT);
    const [selectedZones, setSelectedZones] = useState<Set<number>>(new Set());
    const [deletingZones, setDeletingZones] = useState(false);
    const [openZones, setOpenZones] = useState<Set<number>>(new Set());
    const [zoneRecords, setZoneRecords] = useState<Record<number, DynuDnsRecord[]>>({});
    const [recordsLoading, setRecordsLoading] = useState<Record<number, boolean>>({});
    const [deletingRecord, setDeletingRecord] = useState<string | null>(null);
    const [addForm, setAddForm] = useState<{ zoneId: number | null; type: string; nodeName: string; value: string; priority: string; port: string; weight: string }>({
        zoneId: null, type: 'A', nodeName: '', value: '', priority: '1', port: '0', weight: '0'
    });
    const [addingRecord, setAddingRecord] = useState(false);

    const loadLogs = useCallback(async () => {
        try {
            const res = await fetch(`${API_URL}/dynu/logs`);
            const data = await res.json();
            if (Array.isArray(data)) setLogs(data);
        } catch { /* silent */ }
    }, []);

    useEffect(() => {
        loadLogs();
        const iv = setInterval(loadLogs, 2000);
        return () => clearInterval(iv);
    }, [loadLogs]);

    // Auto-scroll the log panel ONLY when already near its bottom — never the page.
    useEffect(() => {
        const el = logScrollRef.current;
        if (!el) return;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        if (nearBottom) el.scrollTop = el.scrollHeight;
    }, [logs, logsOpen]);

    const loadStore = useCallback(async () => {
        try {
            const res = await fetch(`${API_URL}/dynu/domains`);
            if (res.ok) setStore(await res.json());
        } catch (e) { /* ignore */ }
    }, []);

    useEffect(() => {
        // Result accounts (result_accounts.txt) — verified accounts ready for use
        fetch(`${API_URL}/result-accounts`)
            .then(r => r.ok ? r.json() : [])
            .then((list: any[]) => {
                const seen = new Set<string>();
                const accs: JobAccount[] = (Array.isArray(list) ? list : [])
                    .map(j => ({
                        email: j?.data?.userEmail || '',
                        collection: j?.collection || 'Verified',
                        status: j?.status || 'completed'
                    }))
                    .filter(a => a.email.includes('@') && !seen.has(a.email) && (seen.add(a.email), true));
                setAccounts(accs);
                if (accs.length && !selectedEmail) {
                    setSelectedEmail(accs[0].email);
                    setSearchText(accs[0].email);
                }
            })
            .catch(() => {});
        loadStore();
    }, [loadStore]);

    useEffect(() => {
        setSearchText(selectedEmail);
    }, [selectedEmail]);

    useEffect(() => {
        if (!bulkBaseDomain && store.baseDomains.length) setBulkBaseDomain(store.baseDomains[0]);
    }, [store.baseDomains, bulkBaseDomain]);

    useEffect(() => {
        if (bulkMode === 'rotate' && !bulkDomainsText.trim() && store.baseDomains.length) {
            setBulkDomainsText(store.baseDomains.join('\n'));
        }
    }, [bulkMode, bulkDomainsText, store.baseDomains]);

    useEffect(() => {
        const n = managerPageSize === 'all' ? managerDomains.length : managerPageSize;
        const tp = Math.max(1, Math.ceil(managerDomains.length / n));
        if (managerPage > tp) setManagerPage(tp);
    }, [managerDomains.length, managerPage, managerPageSize]);

    const filteredAccounts = accounts.filter(a =>
        a.email.toLowerCase().includes(searchText.trim().toLowerCase())
    );

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
                if (bulkBaseDomain === baseDomain) setBulkBaseDomain(store.baseDomains[0] || '');
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

    const runBulkProvision = async () => {
        const emails = bulkText.split('\n').map(l => l.trim().toLowerCase()).filter(e => e.includes('@'));
        if (!emails.length) return toast('Paste at least one account email (one per line)', 'err');

        let payload: any;
        if (bulkMode === 'rotate') {
            const domains = bulkDomainsText.split('\n').map(l => l.trim().toLowerCase()).filter(d => d.includes('.'));
            if (!domains.length) return toast('Paste at least one domain (one per line) for rotation', 'err');
            payload = { adminEmails: emails, baseDomains: domains, mode: 'rotate' };
        } else {
            if (!bulkBaseDomain) return toast('Select a base domain first', 'err');
            payload = { adminEmails: emails, baseDomain: bulkBaseDomain, mode: 'single' };
        }

        setBulking(true);
        setBulkResults(emails.map(e => ({ email: e, success: false, status: 'queued' })));
        try {
            const res = await fetch(`${API_URL}/dynu/provision/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.success) {
                setBulkResults(data.results.map((r: any) => ({ ...r, status: r.success ? 'done' : 'failed' })));
                const ok = data.results.filter((r: any) => r.success).length;
                toast(`Bulk done: ${ok}/${data.results.length} ok`, ok === data.results.length ? 'ok' : 'info');
                await loadStore();
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setBulking(false);
        }
    };

    // ── Bulk User Creation (per-account Puppeteer job) ──────────────────────
    const loadBulkUserStatus = useCallback(async () => {
        try {
            const res = await fetch(`${API_URL}/dynu/users/bulk/status`);
            if (res.ok) {
                const data = await res.json();
                setBulkUsersJob(data);
                setBulkUsersRunning(!!data.running);
            }
        } catch { /* silent */ }
    }, []);

    useEffect(() => {
        loadBulkUserStatus();
        const iv = setInterval(loadBulkUserStatus, 2000);
        return () => clearInterval(iv);
    }, [loadBulkUserStatus]);

    const toggleBulkAccount = (email: string) => {
        setSelectedBulkAccounts(prev => {
            const next = new Set(prev);
            if (next.has(email)) next.delete(email);
            else next.add(email);
            return next;
        });
    };

    const toggleAllBulkAccounts = () => {
        setSelectedBulkAccounts(prev => (prev.size === accounts.length ? new Set() : new Set(accounts.map(a => a.email))));
    };

    const startBulkUsers = async () => {
        if (!selectedBulkAccounts.size) return toast('Select at least one account', 'err');
        if (bulkUsersRunning) return;
        const accountsList = [...selectedBulkAccounts].map(email => ({ email, targetDomain: bulkUsersDomain.trim() || undefined }));
        setBulkUsersRunning(true);
        try {
            const res = await fetch(`${API_URL}/dynu/users/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accounts: accountsList, concurrency: bulkUsersConcurrency, usersPerAccount })
            });
            const data = await res.json();
            if (res.ok) {
                toast(`Bulk user creation started: ${data.total} account(s)`, 'ok');
                await loadBulkUserStatus();
            } else {
                setBulkUsersRunning(false);
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            setBulkUsersRunning(false);
            toast(`Error: ${e.message}`, 'err');
        }
    };

    const stopBulkUsers = async () => {
        try {
            const res = await fetch(`${API_URL}/dynu/users/bulk/stop`, { method: 'POST' });
            const data = await res.json();
            toast(data.success ? 'Stop requested — finishing current accounts' : `Error: ${data.error}`, data.success ? 'info' : 'err');
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
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

    // ── Manual Clear buttons ─────────────────────────────────────────────
    const clearProvisioned = async () => {
        if (!store.provisioned.length) return;
        if (!window.confirm(`Clear all ${store.provisioned.length} provisioned subdomain(s) from the list?\nBase domains are kept.`)) return;
        setClearingProvisioned(true);
        try {
            const res = await fetch(`${API_URL}/dynu/domains/provisioned`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                setStore(prev => ({ ...prev, provisioned: [] }));
                toast('Provisioned subdomains cleared', 'ok');
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setClearingProvisioned(false);
        }
    };

    const clearLogs = async () => {
        setClearingLogs(true);
        try {
            const res = await fetch(`${API_URL}/dynu/logs`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                setLogs([]);
                toast('Activity log cleared', 'ok');
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setClearingLogs(false);
        }
    };

    // ── Dynu Domain Manager ───────────────────────────────────────────────
    const loadManagerDomains = async () => {
        setManagerLoading(true);
        setManagerError('');
        try {
            const res = await fetch(`${API_URL}/dynu/manage/domains`);
            const data = await res.json();
            if (data.success) {
                setManagerDomains(data.domains || []);
                setManagerPage(1);
                setOpenZones(new Set());
                setZoneRecords({});
                toast(`Loaded ${(data.domains || []).length} Dynu domain(s)`, 'ok');
            } else {
                setManagerError(data.error || 'Failed to load domains');
            }
        } catch (e: any) {
            setManagerError(e.message);
        } finally {
            setManagerLoading(false);
        }
    };

    const toggleSelectAllPage = () => {
        const pageIds = pageDomains.map(z => z.id);
        const allSelected = pageIds.length > 0 && pageIds.every(id => selectedZones.has(id));
        setSelectedZones(prev => {
            const next = new Set(prev);
            if (allSelected) pageIds.forEach(id => next.delete(id));
            else pageIds.forEach(id => next.add(id));
            return next;
        });
    };

    const toggleZoneSelected = (zoneId: number) => {
        setSelectedZones(prev => {
            const next = new Set(prev);
            if (next.has(zoneId)) next.delete(zoneId);
            else next.add(zoneId);
            return next;
        });
    };

    const deleteZones = async (ids: number[]) => {
        if (!ids.length) return;
        if (!window.confirm(`Delete ${ids.length} domain(s) from Dynu DNS service?\nThis removes the domains and ALL their records — cannot be undone.`)) return;
        setDeletingZones(true);
        try {
            const res = await fetch(`${API_URL}/dynu/manage/domains`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ zoneIds: ids })
            });
            const data = await res.json();
            if (data.success) {
                const deleted = new Set<number>((data.results || []).filter((r: any) => r.success).map((r: any) => Number(r.zoneId)));
                setManagerDomains(prev => prev.filter(z => !deleted.has(z.id)));
                setZoneRecords(prev => {
                    const n = { ...prev };
                    deleted.forEach(id => delete n[id]);
                    return n;
                });
                setOpenZones(prev => {
                    const n = new Set(prev);
                    deleted.forEach(id => n.delete(id));
                    return n;
                });
                setSelectedZones(new Set());
                toast(`Deleted ${deleted.size}/${ids.length} domain(s)`, 'ok');
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setDeletingZones(false);
        }
    };

    const toggleZone = async (zoneId: number) => {
        const next = new Set(openZones);
        if (next.has(zoneId)) {
            next.delete(zoneId);
        } else {
            next.add(zoneId);
            if (!zoneRecords[zoneId]) {
                setRecordsLoading(prev => ({ ...prev, [zoneId]: true }));
                try {
                    const res = await fetch(`${API_URL}/dynu/manage/records?zoneId=${zoneId}`);
                    const data = await res.json();
                    if (data.success) setZoneRecords(prev => ({ ...prev, [zoneId]: data.records || [] }));
                    else toast(`Error: ${data.error}`, 'err');
                } catch (e: any) {
                    toast(`Error: ${e.message}`, 'err');
                } finally {
                    setRecordsLoading(prev => { const n = { ...prev }; delete n[zoneId]; return n; });
                }
            }
        }
        setOpenZones(next);
    };

    const refreshZoneRecords = async (zoneId: number) => {
        setRecordsLoading(prev => ({ ...prev, [zoneId]: true }));
        try {
            const res = await fetch(`${API_URL}/dynu/manage/records?zoneId=${zoneId}`);
            const data = await res.json();
            if (data.success) setZoneRecords(prev => ({ ...prev, [zoneId]: data.records || [] }));
            else toast(`Error: ${data.error}`, 'err');
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setRecordsLoading(prev => { const n = { ...prev }; delete n[zoneId]; return n; });
        }
    };

    const deleteRecord = async (zoneId: number, recId: number) => {
        setDeletingRecord(`${zoneId}:${recId}`);
        try {
            const res = await fetch(`${API_URL}/dynu/manage/records`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ zoneId, recordId: recId })
            });
            const data = await res.json();
            if (data.success) {
                setZoneRecords(prev => ({ ...prev, [zoneId]: (prev[zoneId] || []).filter(r => r.id !== recId) }));
                toast('Record deleted', 'ok');
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setDeletingRecord(null);
        }
    };

    const buildRecordPayload = () => {
        const body: Record<string, any> = {};
        switch (addForm.type) {
            case 'A': body.ipv4Address = addForm.value.trim(); break;
            case 'AAAA': body.ipv6Address = addForm.value.trim(); break;
            case 'CNAME': case 'NS': body.host = addForm.value.trim(); break;
            case 'TXT': body.textData = addForm.value; break;
            case 'MX': body.host = addForm.value.trim(); body.priority = Number(addForm.priority); break;
            case 'SRV': body.host = addForm.value.trim(); body.priority = Number(addForm.priority); body.weight = Number(addForm.weight); body.port = Number(addForm.port); break;
        }
        return { nodeName: addForm.nodeName.trim(), recordType: addForm.type, ttl: 300, state: true, group: '', body };
    };

    const submitAddRecord = async (zoneId: number) => {
        if (!addForm.value.trim()) return toast('Enter a value for the record', 'err');
        setAddingRecord(true);
        try {
            const res = await fetch(`${API_URL}/dynu/manage/records`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ zoneId, record: buildRecordPayload() })
            });
            const data = await res.json();
            if (data.success) {
                toast(`Added ${addForm.type} record`, 'ok');
                setAddForm(f => ({ ...f, nodeName: '', value: '' }));
                await refreshZoneRecords(zoneId);
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setAddingRecord(false);
        }
    };

    const pageSizeNum = managerPageSize === 'all' ? Number.POSITIVE_INFINITY : managerPageSize;
    const totalPages = Math.max(1, Math.ceil(managerDomains.length / pageSizeNum));
    const pageDomains = managerDomains.slice((managerPage - 1) * pageSizeNum, managerPage * pageSizeNum);

    const baseCount = store.baseDomains.length;
    const provisionedCount = store.provisioned.length;
    const verifiedCount = store.provisioned.filter(p => p.verified).length;
    const bulkOk = bulkResults.filter(r => r.success).length;

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

                {/* LEFT: Account + base domains + bulk */}
                <div className="lg:col-span-1 space-y-4">
                    <div className="glass-card p-5 space-y-4">
                        <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">Target Workspace</h3>
                        <div className="relative">
                            <input
                                value={searchText}
                                onChange={e => { setSearchText(e.target.value); setSearchOpen(true); }}
                                onFocus={() => setSearchOpen(true)}
                                onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
                                placeholder="Type to search account…"
                                className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                            />
                            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-white/50">
                                ▼
                            </div>
                            {searchOpen && (
                                <div className="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto rounded-xl bg-[#0f172a] border border-white/10 shadow-2xl">
                                    {filteredAccounts.length === 0 && (
                                        <div className="px-4 py-3 text-xs text-[var(--text-muted)]">No accounts match "{searchText}"</div>
                                    )}
                                    {filteredAccounts.map(a => (
                                        <button
                                            key={a.email}
                                            onMouseDown={e => { e.preventDefault(); setSelectedEmail(a.email); setSearchText(a.email); setSearchOpen(false); }}
                                            className={`w-full text-left px-4 py-2.5 text-sm font-mono hover:bg-indigo-500/15 transition-colors ${a.email === selectedEmail ? 'bg-indigo-500/10 text-indigo-300' : 'text-[var(--text-main)]'}`}
                                        >
                                            <span className="truncate">{a.email}</span>
                                            {a.collection && a.collection !== 'Queue' && (
                                                <span className="ml-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)]">· {a.collection}</span>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <p className="text-[11px] text-[var(--text-muted)]">
                            {accounts.length === 0
                                ? 'No verified accounts found — run List Accounts to populate result_accounts.txt.'
                                : `${accounts.length} verified account(s) from Result Accounts. Selected: ${selectedEmail || '—'}`}
                        </p>
                    </div>

                    <div className="glass-card p-5 space-y-4">
                        <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">Bulk Provision</h3>

                        {/* Mode toggle: one domain vs rotate through many */}
                        <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-black/30 border border-white/10">
                            <button
                                onClick={() => setBulkMode('single')}
                                className={`py-2 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all ${bulkMode === 'single' ? 'bg-indigo-600 text-white shadow' : 'text-[var(--text-muted)] hover:text-white'}`}
                            >
                                One Domain
                            </button>
                            <button
                                onClick={() => setBulkMode('rotate')}
                                className={`py-2 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all ${bulkMode === 'rotate' ? 'bg-indigo-600 text-white shadow' : 'text-[var(--text-muted)] hover:text-white'}`}
                            >
                                Rotate Domains
                            </button>
                        </div>

                        <textarea
                            rows={5}
                            placeholder={'admin@workspace1.com\nadmin@workspace2.com\nadmin@workspace3.com\none-per-line'}
                            value={bulkText}
                            onChange={e => setBulkText(e.target.value)}
                            style={{ resize: 'vertical' }}
                            className="w-full px-4 py-2 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                        />

                        {bulkMode === 'single' ? (
                            <select
                                value={bulkBaseDomain}
                                onChange={e => setBulkBaseDomain(e.target.value)}
                                className="w-full px-3 py-2 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] font-mono"
                            >
                                {store.baseDomains.length === 0 && <option value="">No base domains — add one below</option>}
                                {store.baseDomains.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                        ) : (
                            <textarea
                                rows={4}
                                placeholder={'example.com\nanother.org\none-per-line'}
                                value={bulkDomainsText}
                                onChange={e => setBulkDomainsText(e.target.value)}
                                style={{ resize: 'vertical' }}
                                className="w-full px-4 py-2 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                            />
                        )}

                        <button
                            onClick={runBulkProvision}
                            disabled={bulking || !bulkText.trim() || (bulkMode === 'single' ? !bulkBaseDomain : !bulkDomainsText.trim())}
                            className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black text-sm transition-all disabled:opacity-50"
                        >
                            {bulking ? <span className="inline-flex items-center gap-2"><Spinner size={13} /> Processing…</span> : `⚡ Run Bulk Provision (${bulkText.split('\n').filter(l => l.includes('@')).length})`}
                        </button>
                        <p className="text-[10px] text-[var(--text-muted)]">
                            {bulkMode === 'single'
                                ? 'Each pasted account gets its own unique subdomain under the selected base domain.'
                                : 'Accounts rotate through the domains: account 1 → domain 1, account 2 → domain 2, … wrapping around.'}
                            {' '}Live progress shows in the Activity Log below.
                        </p>

                        {bulkResults.length > 0 && (
                            <div className="space-y-1.5 rounded-xl bg-black/30 border border-white/5 p-3 max-h-56 overflow-y-auto">
                                <div className="flex items-center justify-between text-[10px] uppercase tracking-widest font-black text-[var(--text-muted)]">
                                    <span>Bulk Results</span>
                                    <span className={bulkOk === bulkResults.length ? 'text-emerald-400' : 'text-amber-400'}>{bulkOk}/{bulkResults.length} ok</span>
                                </div>
                                {bulkResults.map(r => (
                                    <div key={r.email} className="flex items-center gap-2 text-[11px] font-mono">
                                        <span className={`shrink-0 ${r.success ? 'text-emerald-400' : 'text-rose-400'}`}>{r.success ? '✓' : '✕'}</span>
                                        <span className="flex-1 truncate text-[var(--text-muted)]">{r.email}</span>
                                        {r.subdomain && <span className="truncate text-cyan-400">{r.subdomain}</span>}
                                        {r.baseDomain && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-[var(--text-muted)]">{r.baseDomain}</span>}
                                        {r.error && <span className="truncate text-rose-400">{r.error}</span>}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="glass-card p-5 space-y-4">
                        <div className="flex items-center justify-between">
                            <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">Bulk User Creation</h3>
                            {bulkUsersRunning && (
                                <span className="text-[10px] px-2 py-0.5 rounded font-black uppercase bg-amber-500/15 text-amber-400 animate-pulse">Running</span>
                            )}
                        </div>

                        {/* account multi-select */}
                        <div className="rounded-xl bg-black/30 border border-white/10 overflow-hidden">
                            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                                <span className="text-[10px] uppercase tracking-widest font-black text-[var(--text-muted)]">Accounts ({selectedBulkAccounts.size}/{accounts.length})</span>
                                <button onClick={toggleAllBulkAccounts} disabled={!accounts.length} className="text-[10px] font-black uppercase text-indigo-300 hover:text-indigo-200 disabled:opacity-40">
                                    {selectedBulkAccounts.size === accounts.length && accounts.length > 0 ? 'Clear all' : 'Select all'}
                                </button>
                            </div>
                            <div className="max-h-44 overflow-y-auto">
                                {accounts.length === 0 && (
                                    <div className="px-3 py-4 text-[11px] text-[var(--text-muted)]">No verified accounts found — run List Accounts first.</div>
                                )}
                                {accounts.map(a => {
                                    const st = (bulkUsersJob?.accounts || []).find((j: BulkUserAccountStatus) => j.email === a.email);
                                    return (
                                        <label key={a.email} className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 cursor-pointer">
                                            <input type="checkbox" checked={selectedBulkAccounts.has(a.email)} onChange={() => toggleBulkAccount(a.email)} className="accent-indigo-500" />
                                            <span className="flex-1 truncate text-[11px] font-mono text-[var(--text-main)]">{a.email}</span>
                                            {st && (
                                                <span className={`shrink-0 text-[9px] font-black uppercase ${st.status === 'done' ? 'text-emerald-400' : st.status === 'failed' ? 'text-rose-400' : st.status === 'running' ? 'text-amber-400 animate-pulse' : 'text-white/40'}`}>
                                                    {st.status === 'done' ? `✓ ${st.usersCreated}` : st.status === 'failed' ? '✕' : st.status === 'running' ? '…' : st.status}
                                                </span>
                                            )}
                                        </label>
                                    );
                                })}
                            </div>
                        </div>

                        {/* settings */}
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[10px] uppercase tracking-widest font-black text-[var(--text-muted)]">Users / account</label>
                                <input type="number" min={1} max={500} value={usersPerAccount} onChange={e => setUsersPerAccount(Math.min(500, Math.max(1, parseInt(e.target.value) || 9)))} className="mt-1 w-full px-3 py-2 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)]" />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase tracking-widest font-black text-[var(--text-muted)]">Concurrency</label>
                                <input type="number" min={1} max={10} value={bulkUsersConcurrency} onChange={e => setBulkUsersConcurrency(Math.min(10, Math.max(1, parseInt(e.target.value) || 2)))} className="mt-1 w-full px-3 py-2 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)]" />
                            </div>
                        </div>

                        <div>
                            <label className="text-[10px] uppercase tracking-widest font-black text-[var(--text-muted)]">Target domain (optional)</label>
                            <input value={bulkUsersDomain} onChange={e => setBulkUsersDomain(e.target.value)} placeholder="alias-domain.com — empty = auto pick" className="mt-1 w-full px-3 py-2 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono" />
                        </div>

                        {(bulkUsersJob?.total ?? 0) > 0 && (
                            <div className="rounded-xl bg-black/30 border border-white/5 p-3 space-y-2">
                                <div className="flex items-center justify-between text-[10px] uppercase tracking-widest font-black text-[var(--text-muted)]">
                                    <span>Job progress</span>
                                    <span className="text-[var(--text-main)]">{bulkUsersJob!.done}/{bulkUsersJob!.total} · {bulkUsersJob!.ok} ok · {bulkUsersJob!.failed} failed</span>
                                </div>
                                <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                                    <div className="h-full bg-indigo-500 transition-all" style={{ width: `${bulkUsersJob!.total ? (bulkUsersJob!.done / bulkUsersJob!.total) * 100 : 0}%` }} />
                                </div>
                                {bulkUsersJob!.accounts.filter(a => a.status !== 'queued').map(a => (
                                    <div key={a.email} className="flex items-center gap-2 text-[10px] font-mono">
                                        <span className={`shrink-0 ${a.status === 'done' ? 'text-emerald-400' : a.status === 'failed' ? 'text-rose-400' : 'text-amber-400'}`}>
                                            {a.status === 'done' ? '✓' : a.status === 'failed' ? '✕' : '…'}
                                        </span>
                                        <span className="flex-1 truncate text-[var(--text-muted)]">{a.email}</span>
                                        {a.status === 'done' && <span className="shrink-0 text-emerald-400">{a.usersCreated} users</span>}
                                        {a.status === 'failed' && a.error && <span className="shrink-0 truncate text-rose-400">{a.error}</span>}
                                    </div>
                                ))}
                            </div>
                        )}

                        {bulkUsersRunning ? (
                            <button onClick={stopBulkUsers} disabled={bulkUsersJob?.stopRequested} className="w-full py-2.5 rounded-xl bg-red-600/20 hover:bg-red-600/40 text-red-400 font-black text-sm transition-all disabled:opacity-50">
                                {bulkUsersJob?.stopRequested ? '⏹ Stopping…' : '⏹ Stop Job'}
                            </button>
                        ) : (
                            <button onClick={startBulkUsers} disabled={!selectedBulkAccounts.size} className="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-black text-sm transition-all disabled:opacity-50">
                                {selectedBulkAccounts.size ? `▶ Create Users (${selectedBulkAccounts.size} account${selectedBulkAccounts.size > 1 ? 's' : ''})` : '▶ Select accounts to start'}
                            </button>
                        )}
                        <p className="text-[10px] text-[var(--text-muted)]">
                            Opens each account's Google Admin, navigates to "Bulk add users" and creates the given number of users. Passwords come from result_accounts.txt; OTP + 2Captcha are auto-handled. Live progress shows in the Activity Log below.
                        </p>
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
                        <div className="flex items-center justify-between">
                            <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">Provisioned Subdomains</h3>
                            {store.provisioned.length > 0 && (
                                <button
                                    onClick={clearProvisioned}
                                    disabled={clearingProvisioned}
                                    className="px-3 py-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-400 font-black text-[11px] transition-all disabled:opacity-50"
                                >
                                    {clearingProvisioned ? <Spinner size={11} /> : `🧹 Clear (${store.provisioned.length})`}
                                </button>
                            )}
                        </div>
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
                                        {rec.provider === 'dynu' && (
                                            <span title={rec.dynuHost ? `Dynu host ${rec.dynuHost.zoneId ? `#${rec.dynuHost.zoneId}${rec.dynuHost.already ? ' (pre-existing)' : ''}` : ''}` : 'Host was not auto-created in Dynu'} className={`text-[10px] px-2 py-1 rounded font-black uppercase ${rec.dynuHost?.created ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>
                                                {rec.dynuHost?.created ? 'Host ✓' : 'Host ✕'}
                                            </span>
                                        )}
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

            {/* ── Dynu activity log ── */}
            <div className="glass-card p-5 space-y-3">
                <div className="flex items-center justify-between">
                    <button className="flex items-center gap-2 text-left" onClick={() => setLogsOpen(o => !o)}>
                        <svg className={`transition-transform ${logsOpen ? 'rotate-90' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6" /></svg>
                        <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">Dynu Activity Log</h3>
                        {logs.some(l => l.level === 'ERROR') && (
                            <span className="text-[10px] px-2 py-0.5 rounded font-black uppercase bg-rose-500/15 text-rose-400">
                                {logs.filter(l => l.level === 'ERROR').length} error{logs.filter(l => l.level === 'ERROR').length > 1 ? 's' : ''}
                            </span>
                        )}
                        {logs.some(l => l.level === 'WARN') && !logs.some(l => l.level === 'ERROR') && (
                            <span className="text-[10px] px-2 py-0.5 rounded font-black uppercase bg-amber-500/15 text-amber-400">
                                {logs.filter(l => l.level === 'WARN').length} warn
                            </span>
                        )}
                    </button>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={loadLogs}
                            className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-[var(--text-muted)] font-black text-[10px] uppercase transition-all"
                        >
                            Refresh
                        </button>
                        <button
                            onClick={clearLogs}
                            disabled={clearingLogs || logs.length === 0}
                            className="px-2 py-1 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-400 font-black text-[10px] uppercase transition-all disabled:opacity-40"
                        >
                            {clearingLogs ? <Spinner size={10} /> : 'Clear'}
                        </button>
                    </div>
                </div>
                {logsOpen && (
                    <div ref={logScrollRef} className="h-56 overflow-y-auto rounded-xl bg-black/40 border border-white/5 p-3 font-mono text-[11px] leading-relaxed space-y-1">
                        {logs.length === 0 && (
                            <div className="text-center py-8 text-[var(--text-muted)] text-sm font-sans">
                                No Dynu activity yet. Provision a subdomain to see the live process.
                            </div>
                        )}
                        {logs.map((log, i) => {
                            const color = log.level === 'ERROR' ? 'var(--red, #f87171)' : log.level === 'WARN' ? 'var(--amber, #fbbf24)' : 'var(--text-muted, #94a3b8)';
                            const prefix = log.level === 'ERROR' ? '✕' : log.level === 'WARN' ? '⚠' : '›';
                            return (
                                <div key={i} className="flex gap-2" style={{ color }}>
                                    <span className="shrink-0 text-white/30">{new Date(log.ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                    <span className="shrink-0">{prefix}</span>
                                    <span className="break-words">{log.msg}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── Dynu Domain Manager ── */}
            <div className="glass-card p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">Dynu Domain Manager</h3>
                        <span className="text-[10px] text-[var(--text-muted)]">Live DNS zones · add/delete records via API</span>
                    </div>
                    <button
                        onClick={loadManagerDomains}
                        disabled={managerLoading}
                        className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50"
                    >
                        {managerLoading ? <span className="inline-flex items-center gap-2"><Spinner size={12} /> Loading…</span> : `⟳ Load Domains${managerDomains.length ? ` (${managerDomains.length})` : ''}`}
                    </button>
                </div>

                {managerError && (
                    <div className="px-4 py-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs font-bold">
                        {managerError}
                    </div>
                )}

                {managerDomains.length > 0 && (
                    <>
                        {/* Selection + Pagination */}
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <span className="text-[11px] text-[var(--text-muted)]">
                                {managerPageSize === 'all'
                                    ? `Showing all ${managerDomains.length} domain${managerDomains.length === 1 ? '' : 's'}`
                                    : `Showing ${(managerPage - 1) * managerPageSize + 1}–${Math.min(managerPage * managerPageSize, managerDomains.length)} of ${managerDomains.length} domains`}
                            </span>
                            <div className="flex flex-wrap items-center gap-2">
                                <select
                                    value={String(managerPageSize)}
                                    onChange={e => setManagerPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                                    className="px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[var(--text-muted)] font-black text-[11px] focus:outline-none"
                                    title="Rows per page"
                                >
                                    <option value="25">25 / page</option>
                                    <option value="50">50 / page</option>
                                    <option value="100">100 / page</option>
                                    <option value="all">All</option>
                                </select>
                                <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[var(--text-muted)] font-black text-[11px] cursor-pointer select-none">
                                    <input type="checkbox" checked={pageDomains.length > 0 && pageDomains.every(z => selectedZones.has(z.id))} onChange={toggleSelectAllPage} className="accent-indigo-500" />
                                    Select page
                                </label>
                                {selectedZones.size > 0 && (
                                    <>
                                        <button
                                            onClick={() => setSelectedZones(new Set())}
                                            className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[var(--text-muted)] font-black text-[11px] transition-all"
                                        >
                                            Clear ({selectedZones.size})
                                        </button>
                                        <button
                                            onClick={() => deleteZones(Array.from(selectedZones))}
                                            disabled={deletingZones}
                                            className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-black text-[11px] transition-all disabled:opacity-50"
                                        >
                                            {deletingZones ? <span className="inline-flex items-center gap-2"><Spinner size={11} /> Deleting…</span> : `🗑 Delete Selected (${selectedZones.size})`}
                                        </button>
                                    </>
                                )}
                                <button
                                    onClick={() => setManagerPage(p => Math.max(1, p - 1))}
                                    disabled={managerPage <= 1}
                                    className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[var(--text-muted)] font-black text-[11px] transition-all disabled:opacity-40"
                                >
                                    ‹ Prev
                                </button>
                                <span className="text-[11px] font-mono text-[var(--text-main)]">Page {managerPage} / {totalPages}</span>
                                <button
                                    onClick={() => setManagerPage(p => Math.min(totalPages, p + 1))}
                                    disabled={managerPage >= totalPages}
                                    className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[var(--text-muted)] font-black text-[11px] transition-all disabled:opacity-40"
                                >
                                    Next ›
                                </button>
                            </div>
                        </div>

                        <div className="space-y-2">
                            {pageDomains.map(zone => {
                                const open = openZones.has(zone.id);
                                const records = zoneRecords[zone.id] || [];
                                const loading = !!recordsLoading[zone.id];
                                return (
                                    <div key={zone.id} className={`rounded-xl bg-white/3 border overflow-hidden ${selectedZones.has(zone.id) ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-white/5'}`}>
                                        <div className="flex items-center gap-3 px-4 py-3">
                                            <input
                                                type="checkbox"
                                                checked={selectedZones.has(zone.id)}
                                                onChange={() => toggleZoneSelected(zone.id)}
                                                className="accent-indigo-500 shrink-0"
                                                title="Select for deletion"
                                            />
                                            <button
                                                onClick={() => toggleZone(zone.id)}
                                                className="flex items-center gap-2 text-left flex-1 min-w-0"
                                            >
                                                <svg className={`transition-transform shrink-0 ${open ? 'rotate-90' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6" /></svg>
                                                <span className="text-sm font-mono font-bold text-[var(--text-main)] truncate">{zone.name}</span>
                                                <span className="text-[10px] px-2 py-0.5 rounded font-black uppercase bg-cyan-500/10 text-cyan-400 shrink-0">#{zone.id}</span>
                                                <span className="text-[10px] font-mono text-[var(--text-muted)] shrink-0">{loading ? '…' : open ? `${records.length} record${records.length !== 1 ? 's' : ''}` : 'records'}</span>
                                            </button>
                                            {open && (
                                                <button
                                                    onClick={() => refreshZoneRecords(zone.id)}
                                                    disabled={loading}
                                                    className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-[var(--text-muted)] font-black text-[10px] uppercase transition-all disabled:opacity-50"
                                                >
                                                    ⟳
                                                </button>
                                            )}
                                            <button
                                                onClick={() => deleteZones([zone.id])}
                                                disabled={deletingZones}
                                                className="px-2 py-1 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-400 font-black text-[10px] transition-all disabled:opacity-50 shrink-0"
                                                title="Delete this domain"
                                            >
                                                {deletingZones ? <Spinner size={10} /> : '✕'}
                                            </button>
                                        </div>

                                        {open && (
                                            <div className="border-t border-white/5 p-4 space-y-4">
                                                {/* Add record form */}
                                                <div className="rounded-xl bg-black/30 border border-white/5 p-3 space-y-3">
                                                    <div className="text-[10px] uppercase tracking-widest font-black text-[var(--text-muted)]">＋ Add Record</div>
                                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                                        <select
                                                            value={addForm.zoneId === zone.id ? addForm.type : 'A'}
                                                            onChange={e => setAddForm(f => ({ ...f, zoneId: zone.id, type: e.target.value, value: '' }))}
                                                            className="px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-[var(--text-main)] font-mono"
                                                        >
                                                            {['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SRV'].map(t => <option key={t} value={t}>{t}</option>)}
                                                        </select>
                                                        <input
                                                            placeholder="node (blank = @/root)"
                                                            value={addForm.zoneId === zone.id ? addForm.nodeName : ''}
                                                            onChange={e => setAddForm(f => ({ ...f, zoneId: zone.id, nodeName: e.target.value }))}
                                                            className="px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                                                        />
                                                        <input
                                                            placeholder={(addForm.zoneId === zone.id ? addForm.type : 'A') === 'MX' || (addForm.zoneId === zone.id ? addForm.type : 'A') === 'SRV' ? 'host / target' : 'value'}
                                                            value={addForm.zoneId === zone.id ? addForm.value : ''}
                                                            onChange={e => setAddForm(f => ({ ...f, zoneId: zone.id, value: e.target.value }))}
                                                            className="px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                                                        />
                                                        {(addForm.zoneId === zone.id ? addForm.type : 'A') === 'MX' && (
                                                            <input
                                                                placeholder="priority"
                                                                value={addForm.zoneId === zone.id ? addForm.priority : '1'}
                                                                onChange={e => setAddForm(f => ({ ...f, zoneId: zone.id, priority: e.target.value }))}
                                                                className="px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                                                            />
                                                        )}
                                                        {(addForm.zoneId === zone.id ? addForm.type : 'A') === 'SRV' && (
                                                            <>
                                                                <input
                                                                    placeholder="priority"
                                                                    value={addForm.zoneId === zone.id ? addForm.priority : '1'}
                                                                    onChange={e => setAddForm(f => ({ ...f, zoneId: zone.id, priority: e.target.value }))}
                                                                    className="px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                                                                />
                                                                <input
                                                                    placeholder="weight"
                                                                    value={addForm.zoneId === zone.id ? addForm.weight : '0'}
                                                                    onChange={e => setAddForm(f => ({ ...f, zoneId: zone.id, weight: e.target.value }))}
                                                                    className="px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                                                                />
                                                                <input
                                                                    placeholder="port"
                                                                    value={addForm.zoneId === zone.id ? addForm.port : '0'}
                                                                    onChange={e => setAddForm(f => ({ ...f, zoneId: zone.id, port: e.target.value }))}
                                                                    className="px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                                                                />
                                                            </>
                                                        )}
                                                    </div>
                                                    <button
                                                        onClick={() => submitAddRecord(zone.id)}
                                                        disabled={addingRecord}
                                                        className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-black text-xs transition-all disabled:opacity-50"
                                                    >
                                                        {addingRecord ? <span className="inline-flex items-center gap-2"><Spinner size={12} /> Adding…</span> : '＋ Add Record'}
                                                    </button>
                                                </div>

                                                {/* Records table */}
                                                {loading ? (
                                                    <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                                                        <Spinner size={12} /> Loading records…
                                                    </div>
                                                ) : records.length === 0 ? (
                                                    <div className="text-[11px] text-[var(--text-muted)]">No records found in this zone.</div>
                                                ) : (
                                                    <div className="space-y-1">
                                                        {records.map(r => (
                                                            <div key={r.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/3 border border-white/5">
                                                                <span className="text-[10px] px-2 py-0.5 rounded font-black uppercase bg-white/10 text-[var(--text-main)] shrink-0">{r.recordType}</span>
                                                                <span className="text-[11px] font-mono text-[var(--text-muted)] truncate">{r.hostname || r.nodeName || '@'}</span>
                                                                <span className="flex-1 text-[11px] font-mono text-[var(--text-main)] truncate" title={recordValue(r)}>{recordValue(r)}</span>
                                                                <span className="text-[10px] font-mono text-[var(--text-muted)] shrink-0">{r.ttl != null ? `${r.ttl}s` : ''}</span>
                                                                <button
                                                                    onClick={() => deleteRecord(zone.id, r.id)}
                                                                    disabled={deletingRecord === `${zone.id}:${r.id}`}
                                                                    className="px-2 py-1 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-400 font-black text-[10px] transition-all disabled:opacity-50 shrink-0"
                                                                >
                                                                    {deletingRecord === `${zone.id}:${r.id}` ? <Spinner size={10} /> : '✕ Delete'}
                                                                </button>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default DynuDomains;
