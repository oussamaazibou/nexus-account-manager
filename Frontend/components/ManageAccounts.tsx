
import React, { useState, useEffect, useCallback } from 'react';

const API_URL = '/api';

interface WorkspaceAccount {
    email: string;
    domain: string;
    cached?: boolean;
    collection?: string;
    password?: string;
}

interface WsUser {
    email: string;
    name?: string;
    status: 'active' | 'suspended';
    isAdmin?: boolean;
    creationTime?: string;
}

interface WsDomain {
    domainName: string;
    isPrimary?: boolean;
    verified?: boolean;
}

type Tab = 'bulk-info' | 'users' | 'create-users' | 'add-domain' | 'domains' | 'bulk-ops';

const toast = (msg: string, type: 'ok'|'err'|'info' = 'info') => {
    const c = document.getElementById('toast-container'); if (!c) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
    el.innerHTML = `<span style="font-weight:700">${type==='ok'?'✓':type==='err'?'✕':'ℹ'}</span><span>${msg}</span>`;
    c.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; el.style.transition='all 0.3s'; setTimeout(()=>el.remove(),300); }, 3500);
};

const ManageAccounts: React.FC = () => {
    const [accounts, setAccounts] = useState<WorkspaceAccount[]>([]);
    const [loadingAccounts, setLoadingAccounts] = useState(true);
    const [selectedAccount, setSelectedAccount] = useState<WorkspaceAccount | null>(null);
    const [adminEmail, setAdminEmail] = useState('');
    const [activeTab, setActiveTab] = useState<Tab>('users');
    const [wsInfo, setWsInfo] = useState<{ users: WsUser[]; domains: WsDomain[] } | null>(null);
    const [loadingInfo, setLoadingInfo] = useState(false);
    const [infoError, setInfoError] = useState('');
    const [searchFilter, setSearchFilter] = useState('');
    const [accountSearch, setAccountSearch] = useState('');

    // Create users state
    const [bulkUsersText, setBulkUsersText] = useState('');
    const [createLoading, setCreateLoading] = useState(false);
    const [createResults, setCreateResults] = useState<{ email: string; status: string; error?: string }[]>([]);
    const [targetDomain, setTargetDomain] = useState('');
    const [proxyString, setProxyString] = useState('');

    // Add domain state
    const [newDomain, setNewDomain] = useState('');
    const [addingDomain, setAddingDomain] = useState(false);
    const [domainMsg, setDomainMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    // Bulk domains state
    const [bulkDomainsText, setBulkDomainsText] = useState('');
    const [bulkDomainResults, setBulkDomainResults] = useState<{ domain: string; status: string; error?: string }[]>([]);
    const [bulkDomainLoading, setBulkDomainLoading] = useState(false);

    // Domain verification state
    const [verifyingDomains, setVerifyingDomains] = useState<Record<string, 'loading' | 'ok' | 'err'>>({});
    const [verifyErrors, setVerifyErrors] = useState<Record<string, string>>({});

    // Migrate & delete domain state
    const [deletingAliases, setDeletingAliases] = useState<Record<string, boolean>>({});
    const [aliasResults, setAliasResults] = useState<Record<string, { deletedCount: number; error?: string }>>({});

    // Bulk Info State
    const [selectedCollection, setSelectedCollection] = useState<string>('All');
    const [bulkInfoResults, setBulkInfoResults] = useState<{ [email: string]: any } | null>(null);
    const [bulkInfoLoading, setBulkInfoLoading] = useState(false);

    // Domain Verification (bulk, via Workspace UI session) state
    const [domainVerifyJobId, setDomainVerifyJobId] = useState<string | null>(null);
    const [domainVerifyState, setDomainVerifyState] = useState<any>(null);
    const [domainVerifyConcurrency, setDomainVerifyConcurrency] = useState<number>(2);
    const [domainVerifyLoading, setDomainVerifyLoading] = useState(false);
    const [domainVerifyEmails, setDomainVerifyEmails] = useState<string[]>([]);

    // Bulk Ops tab
    const [bulkAddDomainText, setBulkAddDomainText] = useState('');
    const [bulkAddDomainResults, setBulkAddDomainResults] = useState<{adminEmail:string; domainName:string; status:string; error?:string}[]>([]);
    const [bulkAddDomainLoading, setBulkAddDomainLoading] = useState(false);

    const [bulkMigrateText, setBulkMigrateText] = useState('');
    const [bulkMigrateResults, setBulkMigrateResults] = useState<{adminEmail:string; primaryDomain?:string; error?:string; note?:string; domains?:{domain:string; movedCount:number; total:number; domainDeleted:boolean; domainError?:string}[]}[]>([]);
    const [bulkMigrateLoading, setBulkMigrateLoading] = useState(false);

    // Migrate users only (no domain deletion)
    const [bulkMigrateUsersText, setBulkMigrateUsersText] = useState('');
    const [bulkMigrateUsersResults, setBulkMigrateUsersResults] = useState<{adminEmail:string; targetDomain?:string; error?:string; note?:string; domains?:{domain:string; movedCount:number; total:number}[]}[]>([]);
    const [bulkMigrateUsersLoading, setBulkMigrateUsersLoading] = useState(false);

    const [bulkChangeDomainText, setBulkChangeDomainText] = useState('');
    const [bulkChangeDomainResults, setBulkChangeDomainResults] = useState<{adminEmail:string; targetDomain:string; movedCount?:number; total?:number; error?:string; errors?:any[]}[]>([]);
    const [bulkChangeDomainLoading, setBulkChangeDomainLoading] = useState(false);

    const [bulkChangeSpecificText, setBulkChangeSpecificText] = useState('');
    const [bulkChangeSpecificResults, setBulkChangeSpecificResults] = useState<{adminEmail:string; usersProcessed?:number; movedCount?:number; error?:string; errors?:any[]}[]>([]);
    const [bulkChangeSpecificLoading, setBulkChangeSpecificLoading] = useState(false);

    // Per-domain migration in Domains tab
    const [migratingUsersFor, setMigratingUsersFor] = useState<Record<string, boolean>>({});
    const [migrateUsersResults, setMigrateUsersResults] = useState<Record<string, {movedCount:number; total:number; error?:string}>>({});
    const [migratingAndDeleting, setMigratingAndDeleting] = useState<Record<string, boolean>>({});
    const [migrateAndDeleteResults, setMigrateAndDeleteResults] = useState<Record<string, {movedCount:number; total:number; domainDeleted:boolean; domainError?:string; error?:string}>>({});

    // Add Domain tab — migrate after add toggle
    const [addMigrateAfter, setAddMigrateAfter] = useState(false);

    // Verify domain full-screen overlay
    const [verifyModal, setVerifyModal] = useState<{ domain: string; step: number; done: boolean; error: string } | null>(null);

    // Edit User modal state
    const [editUserModal, setEditUserModal] = useState<{ oldEmail: string; newEmail: string; firstName: string; lastName: string } | null>(null);
    const [editingUser, setEditingUser] = useState(false);
    const [editUserError, setEditUserError] = useState('');

    useEffect(() => {
        fetch(`${API_URL}/manage/accounts`)
            .then(r => r.json())
            .then(data => { setAccounts(Array.isArray(data) ? data : []); setLoadingAccounts(false); })
            .catch(() => setLoadingAccounts(false));
    }, []);

    const loadWorkspaceInfo = useCallback(async (acc: WorkspaceAccount, email: string) => {
        if (!acc || !email) return;
        setLoadingInfo(true);
        setInfoError('');
        setWsInfo(null);
        try {
            const res = await fetch(`${API_URL}/manage/workspace-info`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminEmail: email })
            });
            const data = await res.json();
            if (data.error) {
                setInfoError(data.error);
            } else {
                setWsInfo(data);
                // Default target domain to the primary one, or just the first domain
                if (data.domains && data.domains.length > 0) {
                    const primary = data.domains.find((d: any) => d.isPrimary);
                    setTargetDomain(primary ? primary.domainName : data.domains[0].domainName);
                }
            }
        } catch (e: any) {
            setInfoError(e.message);
        } finally {
            setLoadingInfo(false);
        }
    }, []);

    const handleSelectAccount = (acc: WorkspaceAccount) => {
        setSelectedAccount(acc);
        setAdminEmail(acc.email);
        setWsInfo(null);
        setCreateResults([]);
        setTargetDomain(acc.domain); // Default to selected account's domain until info loads
        setDomainMsg(null);
        setBulkDomainResults([]);
    };

    const handleLoadInfo = () => {
        if (selectedAccount && adminEmail) loadWorkspaceInfo(selectedAccount, adminEmail);
    };

    // Parse bulk users text: one per line, formats: username / username:password / username:password:firstName:lastName
    const parseBulkUsers = (text: string) => {
        return text.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
            const parts = line.split(':');
            const originalUsername = parts[0].trim();
            const randomNumber = Math.floor(1000 + Math.random() * 9000);
            const cleanUsername = originalUsername.replace(/\./g, '').toLowerCase();
            const finalUsername = `${cleanUsername}${randomNumber}`;
            return {
                username: finalUsername,
                password: parts[1]?.trim() || Math.random().toString(36).slice(2, 10) + 'A1!',
                firstName: parts[2]?.trim() || originalUsername,
                lastName: parts[3]?.trim() || 'User'
            };
        });
    };

    const handleCreateUsers = async () => {
        if (!selectedAccount || !adminEmail || !bulkUsersText.trim()) return;
        setCreateLoading(true);
        setCreateResults([]);
        const users = parseBulkUsers(bulkUsersText);
        try {
            const res = await fetch(`${API_URL}/manage/create-users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminEmail, users, targetDomain, proxyString })
            });
            const data = await res.json();
            setCreateResults(data.results || []);
        } catch (e: any) {
            setCreateResults([{ email: 'Error', status: 'error', error: e.message }]);
        } finally {
            setCreateLoading(false);
        }
    };

    const [deletingUser, setDeletingUser] = useState<string | null>(null);

    const handleDeleteUser = async (userEmail: string, specificAdminEmail?: string) => {
        const targetAdminEmail = specificAdminEmail || adminEmail;
        if (!targetAdminEmail) return;
        setDeletingUser(userEmail);
        try {
            const res = await fetch(`${API_URL}/manage/user`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminEmail: targetAdminEmail, userEmail })
            });
            const data = await res.json();
            if (data.success) {
                setWsInfo(prev => prev ? { ...prev, users: prev.users.filter(u => u.email !== userEmail) } : prev);
                setBulkInfoResults(prev => {
                    if (!prev || !prev[targetAdminEmail] || !prev[targetAdminEmail].users) return prev;
                    return {
                        ...prev,
                        [targetAdminEmail]: {
                            ...prev[targetAdminEmail],
                            users: prev[targetAdminEmail].users.filter((u: any) => u.email !== userEmail)
                        }
                    };
                });
                toast(`Deleted ${userEmail}`, 'ok');
            } else {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setDeletingUser(null);
        }
    };

    const [deletingSuspended, setDeletingSuspended] = useState<boolean>(false);
    const handleDeleteSuspended = async (specificAdminEmail?: string) => {
        const emailToUse = specificAdminEmail || selectedAccount?.adminEmail;
        if (!emailToUse) return;
        setDeletingSuspended(true);
        try {
            const res = await fetch(`${API_URL}/manage/users/suspended`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminEmail: emailToUse })
            });
            const data = await res.json();
            if (data.success) {
                if (!specificAdminEmail) {
                    setWsInfo(prev => prev ? { ...prev, users: prev.users.filter(u => !(u.status === 'suspended' && !u.isAdmin)) } : prev);
                } else {
                    setBulkInfoResults(prev => {
                        if (!prev || !prev[specificAdminEmail] || !prev[specificAdminEmail].users) return prev;
                        return {
                            ...prev,
                            [specificAdminEmail]: {
                                ...prev[specificAdminEmail],
                                users: prev[specificAdminEmail].users.filter((u: any) => !(u.status === 'suspended' && !u.isAdmin))
                            }
                        };
                    });
                }
                toast(`Deleted ${data.deletedCount} suspended users`, 'ok');
            } else {
                toast(data.error || 'Failed to delete suspended users', 'err');
            }
        } catch (e: any) {
            toast('Error: ' + e.message, 'err');
        } finally {
            setDeletingSuspended(false);
        }
    };

    const submitEditUser = async () => {
        if (!adminEmail || !selectedAccount || !editUserModal) return;
        setEditingUser(true);
        setEditUserError('');
        try {
            const res = await fetch(`${API_URL}/manage/edit-user`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    adminEmail,
                    oldEmail: editUserModal.oldEmail,
                    newEmail: editUserModal.newEmail,
                    firstName: editUserModal.firstName,
                    lastName: editUserModal.lastName
                })
            });
            const data = await res.json();
            if (data.success) {
                toast(`User updated to ${data.newEmail}`, 'ok');
                setEditUserModal(null);
                loadWorkspaceInfo(selectedAccount, adminEmail);
            } else {
                setEditUserError(data.error || 'Failed to edit user');
            }
        } catch (e: any) {
            setEditUserError(e.message);
        } finally {
            setEditingUser(false);
        }
    };

    const handleVerifySMS = async (email: string) => {
        const password = selectedAccount?.password;
        if (!password) {
            toast('Admin password not found for this workspace.', 'err');
            return;
        }
        
        try {
            const session = localStorage.getItem('nexus_session');
            const me = session ? JSON.parse(session) : null;
            
            const res = await fetch('/api/accounts/verify-phone/bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    accounts: [{ email, password }],
                    verifiedBy: me?.username || 'admin'
                })
            });
            const data = await res.json();
            if (data.success) {
                const existing = JSON.parse(localStorage.getItem('nexus_auto_verify_emails') || '[]');
                if (!existing.includes(email)) existing.push(email);
                localStorage.setItem('nexus_auto_verify_emails', JSON.stringify(existing));
                toast('Added to Phone Verify Queue! Check the Verify Phone tab.', 'ok');
            } else {
                toast(data.error || 'Failed to queue SMS verification', 'err');
            }
        } catch (e: any) {
            toast('Error: ' + e.message, 'err');
        }
    };

    const [deletingBulkSuspended, setDeletingBulkSuspended] = useState<boolean>(false);
    const handleBulkDeleteSuspended = async () => {
        if (!bulkInfoResults) return;
        const emails = Object.keys(bulkInfoResults);
        if (emails.length === 0) return;

        setDeletingBulkSuspended(true);
        let deletedTotal = 0;
        for (const email of emails) {
            try {
                const res = await fetch(`${API_URL}/manage/users/suspended`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ adminEmail: email })
                });
                const data = await res.json();
                if (data.success) {
                    deletedTotal += data.deletedCount || 0;
                    setBulkInfoResults((prev: any) => {
                        if (!prev || !prev[email] || !prev[email].users) return prev;
                        return {
                            ...prev,
                            [email]: {
                                ...prev[email],
                                users: prev[email].users.filter((u: any) => !(u.status === 'suspended' && !u.isAdmin))
                            }
                        };
                    });
                }
            } catch (e) {
                console.error(`Failed to bulk delete suspended for ${email}:`, e);
            }
        }
        setDeletingBulkSuspended(false);
        toast(`Bulk deletion done. Total deleted: ${deletedTotal}`, 'ok');
    };

    const handleDownloadBulkUsers = () => {
        if (!bulkInfoResults) return;

        let fileContent = '';

        for (const adminEmail of Object.keys(bulkInfoResults)) {
            const adminData = bulkInfoResults[adminEmail];
            if (!adminData.users) continue;

            // Find the password for this admin account
            const adminAccount = accounts.find(acc => acc.email === adminEmail);
            const adminPassword = adminAccount?.password || 'NOT_FOUND';

            // Generate user:password format
            for (const user of adminData.users) {
                if (user.status !== 'suspended') {
                    fileContent += `${user.email}:${adminPassword}\n`;
                }
            }
        }

        if (!fileContent.trim()) {
            toast('No active users found to download', 'err');
            return;
        }

        const blob = new Blob([fileContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bulk_users_${selectedCollection.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // ── Domain Verification (bulk) ──────────────────────────────────────────────
    const handleStartDomainVerify = async () => {
        if (!bulkInfoResults) { toast('Load Bulk Info first', 'err'); return; }
        const emails = Object.keys(bulkInfoResults);
        if (emails.length === 0) { toast('No accounts loaded — click "Bulk Load Info" first', 'err'); return; }
        const entries = emails.map(email => {
            const acc = accounts.find(a => a.email === email);
            return { adminEmail: email, password: acc?.password || undefined };
        });
        setDomainVerifyEmails(emails);
        setDomainVerifyState(null);
        setDomainVerifyLoading(true);
        try {
            const res = await fetch(`${API_URL}/manage/domain-verify/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries, concurrency: domainVerifyConcurrency })
            });
            const data = await res.json();
            if (data.success) {
                setDomainVerifyJobId(data.jobId);
                toast(`Started domain verification for ${emails.length} account(s)`, 'ok');
            } else {
                toast(data.error || 'Failed to start', 'err');
                setDomainVerifyLoading(false);
            }
        } catch (e: any) {
            toast('Error: ' + e.message, 'err');
            setDomainVerifyLoading(false);
        }
    };

    const handleStopDomainVerify = async () => {
        if (!domainVerifyJobId) return;
        try {
            await fetch(`${API_URL}/manage/domain-verify/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: domainVerifyJobId })
            });
            toast('Stop requested…', 'info');
        } catch (e: any) {
            toast('Error: ' + e.message, 'err');
        }
    };

    // Poll job status while running, then refresh bulk info once finished
    useEffect(() => {
        if (!domainVerifyJobId) return;
        let finished = false;
        const iv = setInterval(async () => {
            try {
                const res = await fetch(`${API_URL}/manage/domain-verify/status?jobId=${encodeURIComponent(domainVerifyJobId)}`);
                const data = await res.json();
                if (data.status) setDomainVerifyState(data);
                if (data.status === 'completed' || data.status === 'stopped' || data.status === 'failed') {
                    if (finished) return;
                    finished = true;
                    clearInterval(iv);
                    setDomainVerifyLoading(false);
                    setDomainVerifyJobId(null);
                    const emails = domainVerifyEmails;
                    if (data.status === 'completed' && emails.length > 0) {
                        toast('Domain verification finished', 'ok');
                        try {
                            const r = await fetch(`${API_URL}/manage/workspace-info-bulk`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ emails })
                            });
                            const d = await r.json();
                            if (d.results) setBulkInfoResults(d.results);
                        } catch (e) { /* ignore */ }
                    } else {
                        toast('Domain verification stopped', 'info');
                    }
                }
            } catch (e) { /* ignore */ }
        }, 2000);
        return () => clearInterval(iv);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [domainVerifyJobId]);

    const handleAddDomain = async () => {
        if (!selectedAccount || !adminEmail || !newDomain.trim()) return;
        setAddingDomain(true);
        setDomainMsg(null);
        try {
            const res = await fetch(`${API_URL}/manage/add-domain`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminEmail, domainName: newDomain.trim() })
            });
            const data = await res.json();
            if (data.success) {
                setDomainMsg({ type: 'success', text: `✅ Domain "${newDomain}" added successfully!` });
                setNewDomain('');
                loadWorkspaceInfo(selectedAccount, adminEmail);
            } else {
                setDomainMsg({ type: 'error', text: `❌ ${data.error}` });
            }
        } catch (e: any) {
            setDomainMsg({ type: 'error', text: `❌ ${e.message}` });
        } finally {
            setAddingDomain(false);
        }
    };

    const handleBulkAddDomains = async () => {
        if (!selectedAccount || !adminEmail || !bulkDomainsText.trim()) return;
        setBulkDomainLoading(true);
        setBulkDomainResults([]);
        const domains = bulkDomainsText.split('\n').map(l => l.trim()).filter(Boolean);
        const results: { domain: string; status: string; error?: string }[] = [];
        for (const domain of domains) {
            try {
                const res = await fetch(`${API_URL}/manage/add-domain`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ adminEmail, domainName: domain })
                });
                const data = await res.json();
                results.push({ domain, status: data.success ? 'added' : 'error', error: data.error });
            } catch (e: any) {
                results.push({ domain, status: 'error', error: e.message });
            }
            setBulkDomainResults([...results]);
        }
        setBulkDomainLoading(false);
    };

    const handleVerifyDomain = async (domainName: string, accountEmail?: string) => {
        const emailToUse = accountEmail || adminEmail;
        if (!emailToUse) return;
        setVerifyingDomains(prev => ({ ...prev, [domainName]: 'loading' }));
        setVerifyErrors(prev => { const n = { ...prev }; delete n[domainName]; return n; });
        setVerifyModal({ domain: domainName, step: 0, done: false, error: '' });

        // Advance steps on a timer while API runs in background
        const stepDelay = [1200, 2500, 5000, 13000];
        stepDelay.forEach((ms, i) => {
            setTimeout(() => {
                setVerifyModal(prev => prev && !prev.done && !prev.error ? { ...prev, step: i + 1 } : prev);
            }, ms);
        });

        try {
            const res = await fetch(`${API_URL}/manage/verify-domain`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminEmail: emailToUse, domainName })
            });
            const data = await res.json();
            if (data.success) {
                setVerifyModal(prev => prev ? { ...prev, step: 4, done: true, error: '' } : prev);
                setVerifyingDomains(prev => ({ ...prev, [domainName]: 'ok' }));
                setWsInfo(prev => prev ? {
                    ...prev,
                    domains: prev.domains.map(d => d.domainName === domainName ? { ...d, verified: true } : d)
                } : prev);
            } else {
                setVerifyModal(prev => prev ? { ...prev, done: true, error: data.error || 'Verification failed' } : prev);
                setVerifyingDomains(prev => ({ ...prev, [domainName]: 'err' }));
                setVerifyErrors(prev => ({ ...prev, [domainName]: data.error || 'Verification failed' }));
            }
        } catch (e: any) {
            setVerifyModal(prev => prev ? { ...prev, done: true, error: e.message } : prev);
            setVerifyingDomains(prev => ({ ...prev, [domainName]: 'err' }));
            setVerifyErrors(prev => ({ ...prev, [domainName]: e.message }));
        }
    };

    const handleDeleteDomainAliases = async (domainName: string) => {
        if (!adminEmail) return;
        setDeletingAliases(prev => ({ ...prev, [domainName]: true }));
        setAliasResults(prev => { const n = { ...prev }; delete n[domainName]; return n; });
        try {
            const res = await fetch(`${API_URL}/manage/delete-domain-aliases`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminEmail, domainName })
            });
            const data = await res.json();
            if (data.success) {
                setAliasResults(prev => ({ ...prev, [domainName]: { deletedCount: data.deletedCount } }));
                toast(`Deleted ${data.deletedCount}/${data.total} users from @${domainName}`, data.deletedCount > 0 ? 'ok' : 'info');
                if (wsInfo) setWsInfo(prev => prev ? { ...prev, users: prev.users.filter(u => !u.email.endsWith('@' + domainName)) } : prev);
            } else {
                setAliasResults(prev => ({ ...prev, [domainName]: { deletedCount: 0, error: data.error } }));
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            setAliasResults(prev => ({ ...prev, [domainName]: { deletedCount: 0, error: e.message } }));
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setDeletingAliases(prev => ({ ...prev, [domainName]: false }));
        }
    };

    const filteredUsers = wsInfo?.users.filter(u =>
        u.email.toLowerCase().includes(searchFilter.toLowerCase()) ||
        (u.name || '').toLowerCase().includes(searchFilter.toLowerCase())
    ) || [];

    const isBulkPasteMode = accountSearch.includes('\n');
    const isSingleEmailMode = !isBulkPasteMode && accountSearch.trim().includes('@');
    const pastedEmailLines = isBulkPasteMode
        ? accountSearch.split('\n').map(l => l.trim()).filter(Boolean)
        : isSingleEmailMode ? [accountSearch.trim()] : [];

    const filteredAccounts = isBulkPasteMode
        ? accounts.filter(acc => selectedCollection === 'All' || acc.collection === selectedCollection)
        : accounts.filter(acc =>
            (selectedCollection === 'All' || acc.collection === selectedCollection) &&
            (acc.domain.toLowerCase().includes(accountSearch.toLowerCase()) ||
                acc.email.toLowerCase().includes(accountSearch.toLowerCase()))
        );

    const collections = ['All', ...Array.from(new Set(accounts.map(a => a.collection || 'Uncategorized')))];

    const handleBulkLoadInfo = async () => {
        const emails = isBulkPasteMode ? pastedEmailLines : filteredAccounts.map(a => a.email);
        if (emails.length === 0) return;
        setBulkInfoLoading(true);
        setBulkInfoResults(null);
        try {
            const res = await fetch(`${API_URL}/manage/workspace-info-bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emails })
            });
            const data = await res.json();
            setBulkInfoResults(data.results || {});
        } catch (e: any) {
            console.error(e);
        } finally {
            setBulkInfoLoading(false);
            setActiveTab('bulk-info');
            setSelectedAccount(null);
        }
    };

    const parsePair = (line: string): { adminEmail: string; rest: string } | null => {
        // Split by first comma; fallback to first colon (email has no comma/colon normally)
        const commaIdx = line.indexOf(',');
        if (commaIdx !== -1) return { adminEmail: line.slice(0, commaIdx).trim(), rest: line.slice(commaIdx + 1).trim() };
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) return { adminEmail: line.slice(0, colonIdx).trim(), rest: line.slice(colonIdx + 1).trim() };
        return null;
    };

    const handleBulkAddDomainsMulti = async () => {
        const pairs = bulkAddDomainText.split('\n').map((l: string) => l.trim()).filter(Boolean).map((line: string) => {
            const p = parsePair(line);
            return p ? { adminEmail: p.adminEmail, domainName: p.rest } : null;
        }).filter(Boolean) as { adminEmail: string; domainName: string }[];
        if (pairs.length === 0) return;
        setBulkAddDomainLoading(true);
        setBulkAddDomainResults([]);
        const results: {adminEmail:string; domainName:string; status:string; error?:string; migratedCount?:number}[] = [];
        for (const pair of pairs) {
            try {
                const res = await fetch(`${API_URL}/manage/add-domain`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ adminEmail: pair.adminEmail, domainName: pair.domainName })
                });
                const data = await res.json();
                results.push({ adminEmail: pair.adminEmail, domainName: pair.domainName, status: data.success ? 'added' : 'error', error: data.error });
            } catch (e: any) {
                results.push({ adminEmail: pair.adminEmail, domainName: pair.domainName, status: 'error', error: e.message });
            }
            setBulkAddDomainResults([...results]);
        }
        if (addMigrateAfter) {
            const successPairs = results.filter(r => r.status === 'added');
            for (const pair of successPairs) {
                try {
                    const mRes = await fetch(`${API_URL}/manage/migrate-users-only`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ adminEmail: pair.adminEmail, targetDomain: pair.domainName })
                    });
                    const mData = await mRes.json();
                    const totalMoved = (mData.domains || []).reduce((sum: number, d: any) => sum + (d.movedCount || 0), 0);
                    setBulkAddDomainResults(prev => prev.map(r =>
                        r.adminEmail === pair.adminEmail && r.domainName === pair.domainName
                            ? { ...r, migratedCount: totalMoved }
                            : r
                    ));
                } catch (_) {}
            }
        }
        setBulkAddDomainLoading(false);
    };

    const handleBulkMigrateUsersOnly = async () => {
        const entries = bulkMigrateUsersText.split('\n').map((l: string) => l.trim()).filter(Boolean).map((line: string) => {
            const p = parsePair(line);
            if (p) return { adminEmail: p.adminEmail, targetDomain: p.rest || undefined };
            return { adminEmail: line }; // auto mode, no targetDomain
        });
        if (entries.length === 0) return;
        setBulkMigrateUsersLoading(true);
        setBulkMigrateUsersResults([]);
        try {
            const res = await fetch(`${API_URL}/manage/bulk-migrate-users-only`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries })
            });
            const data = await res.json();
            setBulkMigrateUsersResults(data.results || []);
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setBulkMigrateUsersLoading(false);
        }
    };

    // "Domain (keep domains)": server auto-picks next available non-primary domain, falls back to primary
    const handleMigrateUsersForDomain = async (sourceDomain: string) => {
        if (!adminEmail) return;
        setMigratingUsersFor(prev => ({ ...prev, [sourceDomain]: true }));
        setMigrateUsersResults(prev => { const n = { ...prev }; delete n[sourceDomain]; return n; });
        try {
            const res = await fetch(`${API_URL}/manage/migrate-users-only`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminEmail, sourceDomain }) // no targetDomain — server finds next available
            });
            const data = await res.json();
            if (data.success) {
                const domainResult = data.domains?.[0];
                if (domainResult) {
                    setMigrateUsersResults(prev => ({ ...prev, [sourceDomain]: { movedCount: domainResult.movedCount, total: domainResult.total } }));
                    toast(`Migrated ${domainResult.movedCount}/${domainResult.total} users → @${targetDomain}`, 'ok');
                }
            } else {
                setMigrateUsersResults(prev => ({ ...prev, [sourceDomain]: { movedCount: 0, total: 0, error: data.error } }));
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            setMigrateUsersResults(prev => ({ ...prev, [sourceDomain]: { movedCount: 0, total: 0, error: e.message } }));
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setMigratingUsersFor(prev => ({ ...prev, [sourceDomain]: false }));
        }
    };

    // "→ Primary & Delete": migrate users to primary domain then delete source domain
    const handleMigrateAndDeleteDomain = async (sourceDomain: string) => {
        if (!adminEmail) return;
        setMigratingAndDeleting(prev => ({ ...prev, [sourceDomain]: true }));
        setMigrateAndDeleteResults(prev => { const n = { ...prev }; delete n[sourceDomain]; return n; });
        try {
            const res = await fetch(`${API_URL}/manage/migrate-and-delete-domain`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminEmail, sourceDomain })
            });
            const data = await res.json();
            if (data.success) {
                setMigrateAndDeleteResults(prev => ({ ...prev, [sourceDomain]: { movedCount: data.movedCount, total: data.total, domainDeleted: data.domainDeleted, domainError: data.domainError } }));
                toast(`Migrated ${data.movedCount}/${data.total} users → @${data.targetDomain}${data.domainDeleted ? ', domain deleted' : ''}`, 'ok');
            } else {
                setMigrateAndDeleteResults(prev => ({ ...prev, [sourceDomain]: { movedCount: 0, total: 0, domainDeleted: false, error: data.error } }));
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            setMigrateAndDeleteResults(prev => ({ ...prev, [sourceDomain]: { movedCount: 0, total: 0, domainDeleted: false, error: e.message } }));
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setMigratingAndDeleting(prev => ({ ...prev, [sourceDomain]: false }));
        }
    };

    const handleBulkChangeUsersDomain = async () => {
        if (!bulkChangeDomainText.trim()) return;
        setBulkChangeDomainLoading(true);
        setBulkChangeDomainResults([]);
        
        const entries = bulkChangeDomainText.split('\n').map((l: string) => l.trim()).filter(Boolean).map((line: string) => {
            let adminEmail = '', targetDomain = '';
            if (line.includes(',')) {
                [adminEmail, targetDomain] = line.split(',').map((s: string) => s.trim());
            } else if (line.includes(':')) {
                [adminEmail, targetDomain] = line.split(':').map((s: string) => s.trim());
            }
            return { adminEmail, targetDomain };
        });

        if (entries.length === 0) {
            setBulkChangeDomainLoading(false);
            return;
        }

        try {
            const res = await fetch(`${API_URL}/manage/bulk-change-users-domain`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries })
            });
            const data = await res.json();
            if (data.results) {
                setBulkChangeDomainResults(data.results);
                toast(`Changed domains for ${entries.length} requests`, 'info');
            } else if (data.error) {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Network Error: ${e.message}`, 'err');
        } finally {
            setBulkChangeDomainLoading(false);
        }
    };

    const handleBulkChangeSpecificUsers = async () => {
        if (!bulkChangeSpecificText.trim()) return;
        setBulkChangeSpecificLoading(true);
        setBulkChangeSpecificResults([]);
        
        const entries = bulkChangeSpecificText.split('\n').map((l: string) => l.trim()).filter(Boolean).map((line: string) => {
            let userEmail = '', targetDomain = '', adminEmail = '';
            const parts = line.split(/[,:]/).map((s: string) => s.trim());
            if (parts.length === 3) {
                [adminEmail, userEmail, targetDomain] = parts;
            } else if (parts.length === 2) {
                [userEmail, targetDomain] = parts;
            }
            return { adminEmail, userEmail, targetDomain };
        }).filter((e: any) => e.userEmail && e.targetDomain);

        if (entries.length === 0) {
            setBulkChangeSpecificLoading(false);
            return;
        }

        try {
            const res = await fetch(`${API_URL}/manage/bulk-change-specific-users-domain`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries })
            });
            const data = await res.json();
            if (data.results) {
                setBulkChangeSpecificResults(data.results);
                toast(`Processed specific domain changes for ${entries.length} users`, 'info');
            } else if (data.error) {
                toast(`Error: ${data.error}`, 'err');
            }
        } catch (e: any) {
            toast(`Network Error: ${e.message}`, 'err');
        } finally {
            setBulkChangeSpecificLoading(false);
        }
    };

    const handleBulkMigrateDomains = async () => {
        // Format: "email" (auto-detect) or "email,domain" / "email:domain" (specific)
        const entries = bulkMigrateText.split('\n').map((l: string) => l.trim()).filter(Boolean).map((line: string) => {
            const p = parsePair(line);
            if (p) return { adminEmail: p.adminEmail, sourceDomain: p.rest };
            return { adminEmail: line }; // auto-detect mode
        });
        if (entries.length === 0) return;
        setBulkMigrateLoading(true);
        setBulkMigrateResults([]);
        try {
            const res = await fetch(`${API_URL}/manage/bulk-auto-migrate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries })
            });
            const data = await res.json();
            setBulkMigrateResults(data.results || []);
        } catch (e: any) {
            toast(`Error: ${e.message}`, 'err');
        } finally {
            setBulkMigrateLoading(false);
        }
    };

    const tabs: { id: Tab; label: string; icon: string }[] = [
        { id: 'bulk-info', label: 'Bulk Info', icon: '📊' },
        { id: 'users', label: 'Users', icon: '👥' },
        { id: 'create-users', label: 'Create Users', icon: '➕' },
        { id: 'add-domain', label: 'Add Domain', icon: '🌐' },
        { id: 'domains', label: 'Domains', icon: '📋' },
        { id: 'bulk-ops', label: 'Bulk Ops', icon: '⚡' },
    ];

    const VERIFY_STEPS = [
        { label: 'Connecting to Google Workspace Admin API…' },
        { label: 'Fetching verification token for domain…' },
        { label: 'Upserting TXT record in Cloudflare DNS…' },
        { label: 'Submitting verification to Google…' },
        { label: 'Domain verified successfully!' },
    ];

    return (
        <div className="space-y-8 animate-in fade-in duration-700">

            {/* Verify domain full-screen overlay */}
            {verifyModal && (
                <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-[#0f172a] border border-white/10 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
                        {/* Top bar */}
                        <div className="bg-indigo-600/20 border-b border-indigo-500/20 px-6 py-4 flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center shrink-0">
                                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" style={{ display: verifyModal.done ? 'none' : undefined }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                {verifyModal.done && !verifyModal.error && <span style={{ fontSize: 16 }}>✅</span>}
                                {verifyModal.done && verifyModal.error && <span style={{ fontSize: 16 }}>❌</span>}
                            </div>
                            <div>
                                <div className="font-black text-sm">Verifying Domain</div>
                                <div className="text-xs text-indigo-300 font-mono">{verifyModal.domain}</div>
                            </div>
                        </div>

                        {/* Steps */}
                        <div className="px-6 py-5 space-y-3">
                            {VERIFY_STEPS.map((s, i) => {
                                const active = i === verifyModal.step && !verifyModal.done;
                                const done = i < verifyModal.step || (verifyModal.done && !verifyModal.error);
                                const isError = verifyModal.done && verifyModal.error && i === verifyModal.step;
                                return (
                                    <div key={i} className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${active ? 'bg-indigo-500/15 border border-indigo-500/30' : done ? 'bg-emerald-500/10 border border-emerald-500/20' : isError ? 'bg-red-500/10 border border-red-500/20' : 'bg-white/3 border border-white/5 opacity-40'}`}>
                                        <div className="shrink-0 w-6 h-6 flex items-center justify-center">
                                            {active && <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>}
                                            {done && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                                            {isError && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>}
                                            {!active && !done && !isError && <span className="text-xs text-white/30">{i + 1}</span>}
                                        </div>
                                        <span className={`text-xs font-bold ${active ? 'text-indigo-300' : done ? 'text-emerald-400' : isError ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
                                            {isError ? verifyModal.error : s.label}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Footer */}
                        {verifyModal.done && (
                            <div className="px-6 pb-5">
                                <button
                                    onClick={() => setVerifyModal(null)}
                                    className={`w-full py-2.5 rounded-xl font-black text-sm transition-all ${verifyModal.error ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-emerald-600 hover:bg-emerald-500 text-white'}`}
                                >
                                    {verifyModal.error ? '✕ Close' : '✓ Done'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Header */}
            <div className="space-y-2">
                <h2 className="text-3xl md:text-4xl font-black tracking-tightest uppercase">Account Manager</h2>
                <p className="text-[var(--text-muted)] text-sm font-medium">Manage Google Workspace via Admin SDK API</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* LEFT: Account Selector */}
                <div className="lg:col-span-1 space-y-4">
                    <div className="glass-card p-5 space-y-4">
                        <div className="space-y-3 pb-4 border-b border-white/10">
                            <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Filter by Collection</label>
                            <div className="relative">
                                <select
                                    value={selectedCollection}
                                    onChange={e => setSelectedCollection(e.target.value)}
                                    className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] appearance-none cursor-pointer"
                                >
                                    {collections.map(c => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 mt-6 text-white/50">
                                    ▼
                                </div>
                            </div>
                            {!isBulkPasteMode && (
                                <button
                                    onClick={() => { handleBulkLoadInfo(); setActiveTab('bulk-info'); }}
                                    disabled={bulkInfoLoading || filteredAccounts.length === 0}
                                    className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm transition-all disabled:opacity-50"
                                >
                                    {bulkInfoLoading ? '⏳ Fetching Data...' : `📊 Bulk Load Info (${filteredAccounts.length})`}
                                </button>
                            )}
                        </div>

                        <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)] pt-2">
                            {isBulkPasteMode ? `Bulk Mode · ${pastedEmailLines.length} emails` : `Select Workspace · ${filteredAccounts.length} / ${accounts.length} available`}
                        </h3>

                        <div className="space-y-2">
                            <textarea
                                rows={4}
                                placeholder={"Search · or type one email · or paste many (one per line)"}
                                value={accountSearch}
                                onChange={e => setAccountSearch(e.target.value)}
                                style={{ resize: 'vertical' }}
                                className="w-full px-4 py-2 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)] font-mono"
                            />
                            {isSingleEmailMode && (
                                <button
                                    onClick={() => { handleBulkLoadInfo(); setActiveTab('bulk-info'); }}
                                    disabled={bulkInfoLoading}
                                    className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black text-sm transition-all disabled:opacity-50"
                                >
                                    {bulkInfoLoading ? '⏳ Loading...' : `🔍 Load "${accountSearch.trim()}"`}
                                </button>
                            )}
                            {isBulkPasteMode && (
                                <>
                                    <div className="text-xs font-bold text-blue-400 bg-blue-500/10 rounded-lg px-2 py-1">
                                        ⚡ Bulk: {pastedEmailLines.length} emails detected
                                    </div>
                                    <button
                                        onClick={() => { handleBulkLoadInfo(); setActiveTab('bulk-info'); }}
                                        disabled={bulkInfoLoading || pastedEmailLines.length === 0}
                                        className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-black text-sm transition-all disabled:opacity-50"
                                    >
                                        {bulkInfoLoading ? '⏳ Loading...' : `📊 Load ${pastedEmailLines.length} Accounts`}
                                    </button>
                                    <button
                                        onClick={() => setAccountSearch('')}
                                        className="w-full py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-xs text-[var(--text-muted)] font-bold transition-all"
                                    >
                                        ✕ Clear — back to search
                                    </button>
                                </>
                            )}
                        </div>

                        {!isBulkPasteMode && (loadingAccounts ? (
                            <div className="text-center py-8 text-[var(--text-muted)]">Loading...</div>
                        ) : (
                            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                                {filteredAccounts.map(acc => (
                                    <button
                                        key={acc.email}
                                        onClick={() => handleSelectAccount(acc)}
                                        className={`w-full text-left px-4 py-3 rounded-xl transition-all duration-200 border ${selectedAccount?.email === acc.email
                                            ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-600/30'
                                            : 'border-white/5 hover:border-white/20 hover:bg-white/5'
                                            }`}
                                    >
                                        <div className="font-bold text-sm truncate">{acc.domain}</div>
                                        <div className={`text-xs truncate flex items-center justify-between mt-0.5 ${selectedAccount?.email === acc.email ? 'text-indigo-200' : 'text-[var(--text-muted)]'}`}>
                                            {acc.email}
                                            {acc.cached && <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/20 text-emerald-400 text-[9px] font-black uppercase">Cached</span>}
                                        </div>
                                    </button>
                                ))}
                                {accounts.length === 0 && (
                                    <div className="text-center py-8 text-[var(--text-muted)] text-sm">
                                        No verified accounts found in result_accounts.txt
                                    </div>
                                )}
                                {accounts.length > 0 && filteredAccounts.length === 0 && (
                                    <div className="text-center py-8 text-[var(--text-muted)] text-sm">
                                        No accounts match your search
                                    </div>
                                )}
                            </div>
                        ))}

                        {/* Admin Email + Load */}
                        {selectedAccount && (
                            <div className="space-y-3 border-t border-white/10 pt-4">
                                <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)]">Admin Email</label>
                                <input
                                    type="email"
                                    value={adminEmail}
                                    onChange={e => setAdminEmail(e.target.value)}
                                    placeholder="support@yourdomain.com"
                                    className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)]"
                                />
                                <button
                                    onClick={handleLoadInfo}
                                    disabled={loadingInfo}
                                    className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black text-sm transition-all disabled:opacity-50"
                                >
                                    {loadingInfo ? '⏳ Loading...' : '🔍 Load Workspace'}
                                </button>
                                {infoError && (
                                    <div className="text-xs text-red-400 bg-red-500/10 rounded-xl px-3 py-2">{infoError}</div>
                                )}
                                {wsInfo && (
                                    <div className="grid grid-cols-2 gap-2 text-center">
                                        <div className="bg-white/5 rounded-xl p-3">
                                            <div className="text-2xl font-black text-indigo-400">{wsInfo.users.length}</div>
                                            <div className="text-xs text-[var(--text-muted)] uppercase">Users</div>
                                        </div>
                                        <div className="bg-white/5 rounded-xl p-3">
                                            <div className="text-2xl font-black text-emerald-400">{wsInfo.domains.length}</div>
                                            <div className="text-xs text-[var(--text-muted)] uppercase">Domains</div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* RIGHT: Actions Panel */}
                <div className="lg:col-span-2 space-y-4">
                    <div className="glass-card p-0 overflow-hidden">
                        {/* Tabs — always visible */}
                        <div className="flex border-b border-white/10 overflow-x-auto">
                            {tabs.map(tab => (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={`flex-shrink-0 flex-1 py-4 text-xs font-black uppercase tracking-widest transition-all ${activeTab === tab.id
                                        ? 'text-indigo-400 border-b-2 border-indigo-500 bg-indigo-600/10'
                                        : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'
                                        }`}
                                >
                                    <span className="hidden sm:inline">{tab.icon} </span>{tab.label}
                                </button>
                            ))}
                        </div>

                        <div className="p-6">
                            {/* No account selected — placeholder for non-bulk tabs */}
                            {!selectedAccount && activeTab !== 'bulk-info' && activeTab !== 'bulk-ops' && (
                                <div className="py-12 text-center text-[var(--text-muted)]">
                                    <div className="text-5xl mb-4">🏢</div>
                                    <div className="font-black text-lg">Select a workspace account</div>
                                    <div className="text-sm mt-2">Choose from the left panel, or use <button onClick={() => setActiveTab('bulk-ops')} className="text-amber-400 font-black underline">⚡ Bulk Ops</button> — no account needed</div>
                                </div>
                            )}
                                {/* TAB: BULK INFO */}
                                {activeTab === 'bulk-info' && (
                                    <div className="space-y-6">
                                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                                            <div>
                                                <h3 className="font-black text-xl">Bulk Workspace Info</h3>
                                                <p className="text-sm text-[var(--text-muted)]">Overview for Collection: <span className="text-indigo-400 font-bold">{selectedCollection}</span></p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <button onClick={handleDownloadBulkUsers} disabled={!bulkInfoResults || Object.keys(bulkInfoResults).length === 0} className="px-4 py-2 rounded-xl bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500 hover:text-white text-sm font-bold transition-all shrink-0">
                                                    💾 Download Users
                                                </button>
                                                <div className="flex items-center gap-1.5 bg-black/30 border border-white/10 rounded-xl px-2 py-1.5 shrink-0">
                                                    <span className="text-[10px] text-[var(--text-muted)] font-bold uppercase tracking-wider leading-none">Accounts<br/>at once</span>
                                                    <div className="flex items-center gap-1">
                                                        <button onClick={() => setDomainVerifyConcurrency(c => Math.max(1, c - 1))} disabled={domainVerifyLoading} className="w-6 h-6 rounded-lg bg-white/10 hover:bg-white/20 text-sm font-black leading-none disabled:opacity-40">−</button>
                                                        <input
                                                            type="number"
                                                            min={1}
                                                            max={10}
                                                            value={domainVerifyConcurrency}
                                                            disabled={domainVerifyLoading}
                                                            onChange={e => setDomainVerifyConcurrency(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                                                            className="w-10 bg-black/40 border border-white/10 rounded-lg text-center text-sm font-black text-emerald-400 focus:outline-none focus:border-emerald-500"
                                                        />
                                                        <button onClick={() => setDomainVerifyConcurrency(c => Math.min(10, c + 1))} disabled={domainVerifyLoading} className="w-6 h-6 rounded-lg bg-white/10 hover:bg-white/20 text-sm font-black leading-none disabled:opacity-40">+</button>
                                                    </div>
                                                </div>
                                                <button onClick={handleStartDomainVerify} disabled={domainVerifyLoading || !bulkInfoResults || Object.keys(bulkInfoResults).length === 0} className="px-4 py-2 rounded-xl bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white text-sm font-bold transition-all shrink-0">
                                                    {domainVerifyLoading ? '⏳ Verifying...' : '✅ Verify Unverified Domains'}
                                                </button>
                                                <button onClick={handleBulkDeleteSuspended} disabled={deletingBulkSuspended || !bulkInfoResults || Object.keys(bulkInfoResults).length === 0} className="px-4 py-2 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white text-sm font-bold transition-all shrink-0">
                                                    {deletingBulkSuspended ? '⏳ Deleting...' : '🗑 Suspandeds'}
                                                </button>
                                                <button onClick={handleBulkLoadInfo} disabled={bulkInfoLoading || filteredAccounts.length === 0} className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-sm font-bold transition-all shrink-0">
                                                    {bulkInfoLoading ? '⏳ Loading...' : '🔄 Refresh Bulk'}
                                                </button>
                                            </div>
                                        </div>

                                        {!bulkInfoResults ? (
                                            <div className="text-center py-12 text-[var(--text-muted)] border border-dashed border-white/10 rounded-2xl bg-black/20">
                                                <div className="text-4xl mb-3">📊</div>
                                                <div>Select a Collection and click "Bulk Load Info" from the left panel to view all users</div>
                                            </div>
                                        ) : (
                                            <div className="space-y-4 max-h-[600px] overflow-y-auto pr-2">
                                                {Object.entries(bulkInfoResults).map(([email, d]: any) => (
                                                    <div key={email} className="bg-white/5 rounded-xl p-4 border border-white/10 hover:bg-white/10 transition-colors">
                                                        <div className="font-bold flex items-center justify-between gap-2 text-md mb-3 pb-3 border-b border-white/5">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-indigo-400">💼</span> {email}
                                                            </div>
                                                            <div className="text-xs px-2 py-0.5 rounded bg-black/30 text-[var(--text-muted)] font-mono">
                                                                {d.users ? d.users.length : 0} Users
                                                            </div>
                                                        </div>
                                                        {d.error ? (
                                                            <div className="text-sm text-red-400 bg-red-500/10 px-3 py-2 rounded-lg">{d.error}</div>
                                                        ) : (
                                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                                {d.users.map((u: any) => (
                                                                    <div key={u.email} className="flex items-center justify-between bg-black/40 px-3 py-2 rounded-lg text-sm border border-white/5">
                                                                        <div className="truncate pr-2">{u.email}</div>
                                                                        <div className="flex items-center gap-2 shrink-0">
                                                                            {u.isAdmin && <span className="text-[10px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider">Admin</span>}
                                                                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-black uppercase tracking-wider shrink-0 ${u.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-500 shadow-sm shadow-red-500/20'}`}>
                                                                                {u.status}
                                                                            </span>
                                                                            <button
                                                                                onClick={() => handleDeleteUser(u.email, email)}
                                                                                disabled={deletingUser === u.email || u.isAdmin}
                                                                                title={u.isAdmin ? "Cannot delete Admin from here" : "Delete User"}
                                                                                className={`px-2 py-1 ml-1 rounded text-xs font-black transition-all ${u.isAdmin ? 'opacity-30 cursor-not-allowed bg-red-900/20 text-red-500/50' : 'bg-red-500/10 hover:bg-red-500 hover:text-white text-red-500'}`}
                                                                            >
                                                                                {deletingUser === u.email ? '⏳' : '🗑'}
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                ))}
                                                                {d.users.length === 0 && <div className="text-xs text-[var(--text-muted)] italic">No users found for this workspace.</div>}
                                                            </div>
                                                        )}
                                                        {!d.error && d.domains && d.domains.length > 0 && (
                                                            <div className="mt-4 pt-4 border-t border-white/5 space-y-2">
                                                                <div className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider mb-2">Domains ({d.domains.length})</div>
                                                                <div className="grid grid-cols-1 gap-2">
                                                                    {d.domains.map((dom: any) => (
                                                                        <div key={dom.domainName} className="flex items-center justify-between bg-black/40 px-3 py-2 rounded-lg text-sm border border-white/5">
                                                                            <div className="flex items-center gap-2">
                                                                                <span className="font-bold">{dom.domainName}</span>
                                                                                {dom.isPrimary && <span className="text-[10px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider">Primary</span>}
                                                                            </div>
                                                                            <div className="flex items-center gap-2">
                                                                                {dom.verified ? (
                                                                                    <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-black uppercase tracking-wider">Verified</span>
                                                                                ) : (
                                                                                    <div className="flex items-center gap-2">
                                                                                        <span className="text-[10px] bg-amber-500/20 text-amber-500 px-2 py-0.5 rounded-full font-black uppercase tracking-wider">Pending</span>
                                                                                        <button
                                                                                            onClick={() => handleVerifyDomain(dom.domainName, email)}
                                                                                            disabled={verifyingDomains[dom.domainName] === 'loading'}
                                                                                            className="px-2 py-1 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-bold rounded transition-colors disabled:opacity-50"
                                                                                        >
                                                                                            {verifyingDomains[dom.domainName] === 'loading' ? 'Verifying...' : 'Verify Now'}
                                                                                        </button>
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                                {Object.keys(bulkInfoResults).length === 0 && (
                                                    <div className="text-center text-[var(--text-muted)] py-4">No results available.</div>
                                                )}
                                            </div>
                                        )}

                                        {/* Section: Verify Unverified Domains (Workspace UI session) */}
                                        {domainVerifyState && (
                                            <div className="space-y-3 border-t border-white/10 pt-5">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">
                                                            {domainVerifyState.status === 'running' ? '🔁 Verifying Unverified Domains…' : '✅ Domain Verification Finished'}
                                                        </h3>
                                                        {domainVerifyState.current && domainVerifyState.status === 'running' && (
                                                            <p className="text-xs text-[var(--text-muted)] mt-1">
                                                                Account {domainVerifyState.current.index}/{domainVerifyState.current.total} · <span className="font-mono">{domainVerifyState.current.adminEmail}</span>
                                                                {domainVerifyState.concurrency && <span className="ml-2 text-emerald-400">⚡ {domainVerifyState.concurrency} concurrent</span>}
                                                            </p>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        {domainVerifyState.status === 'running' && (
                                                            <button onClick={handleStopDomainVerify} className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white text-xs font-bold transition-all shrink-0">
                                                                ⏹ Stop
                                                            </button>
                                                        )}
                                                        <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-white/5 text-[var(--text-muted)]">
                                                            {(domainVerifyState.results || []).reduce((acc: number, r: any) => acc + (r.domains?.filter((d: any) => d.status === 'verified').length || 0), 0)} verified
                                                        </span>
                                                    </div>
                                                </div>

                                                {(domainVerifyState.results || []).length === 0 && domainVerifyState.status === 'running' && (
                                                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                                                        <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                                        Logging in and fetching unverified domains…
                                                    </div>
                                                )}

                                                <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                                                    {(domainVerifyState.results || []).map((acc: any) => (
                                                        <div key={acc.adminEmail} className="bg-white/5 rounded-xl p-3 border border-white/10">
                                                            <div className="font-bold text-sm flex items-center justify-between gap-2 mb-1">
                                                                <span className="truncate">{acc.adminEmail}</span>
                                                                {acc.error ? (
                                                                    <span className="text-xs text-red-400 shrink-0">❌ {acc.error}</span>
                                                                ) : (
                                                                    <span className="text-xs text-[var(--text-muted)] shrink-0">
                                                                        {acc.note || `${(acc.domains || []).filter((d: any) => d.status === 'verified').length}/${(acc.domains || []).length} verified`}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            {(acc.domains || []).map((d: any) => (
                                                                <div key={d.domain} className="flex items-center justify-between gap-2 text-xs py-1.5 border-t border-white/5">
                                                                    <span className="font-mono truncate">{d.domain}</span>
                                                                    {d.status === 'verified' ? (
                                                                        <span className="text-emerald-400 font-bold shrink-0">✓ Verified</span>
                                                                    ) : d.status === 'skipped' ? (
                                                                        <span className="text-[var(--text-muted)] font-bold shrink-0">⊘ {d.error || 'Skipped'}</span>
                                                                    ) : (
                                                                        <span className="text-red-400 font-bold shrink-0">✕ {d.error || d.status}</span>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    ))}
                                                </div>

                                                {domainVerifyState.logs && domainVerifyState.logs.length > 0 && (
                                                    <div className="bg-black/40 rounded-xl p-3 max-h-40 overflow-y-auto text-[11px] font-mono text-[var(--text-muted)] space-y-0.5">
                                                        {domainVerifyState.logs.slice(-40).map((l: string, i: number) => (
                                                            <div key={i} className="truncate">{l}</div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Section: Change Specific Users Domain */}
                                        <div className="space-y-4 border-t border-white/10 pt-6">
                                            <div>
                                                <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Change Specific Users Domain</label>
                                                <p className="text-xs text-[var(--text-muted)] mt-1">Changes domain for only the specified users. Format: <code className="bg-white/10 px-1 rounded">user@account.com:targetdomain.com</code></p>
                                            </div>
                                            <textarea
                                                value={bulkChangeSpecificText}
                                                onChange={e => setBulkChangeSpecificText(e.target.value)}
                                                rows={6}
                                                placeholder={`user1@olddomain.com:newdomain.com\nuser2@olddomain.com:otherdomain.com`}
                                                className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-indigo-500 resize-y"
                                            />
                                            <div className="text-xs text-[var(--text-muted)]">
                                                {bulkChangeSpecificText.split('\n').filter((l: string) => l.trim()).length} users ready
                                            </div>
                                            <button
                                                onClick={handleBulkChangeSpecificUsers}
                                                disabled={bulkChangeSpecificLoading || !bulkChangeSpecificText.trim()}
                                                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                            >
                                                {bulkChangeSpecificLoading ? (
                                                    <><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Changing Domains...</>
                                                ) : '⚡ Run Change Specific Users'}
                                            </button>
                                            {bulkChangeSpecificResults.length > 0 && (
                                                <div className="space-y-2 max-h-64 overflow-y-auto">
                                                    <div className="flex gap-4 text-xs font-bold">
                                                        <span className="text-emerald-400">✅ {bulkChangeSpecificResults.filter(r => !r.error).length} done</span>
                                                        <span className="text-red-400">❌ {bulkChangeSpecificResults.filter(r => r.error).length} failed</span>
                                                    </div>
                                                    {bulkChangeSpecificResults.map((r, i) => (
                                                        <div key={i} className={`px-3 py-2 rounded-lg text-xs ${r.error ? 'bg-red-500/10' : 'bg-white/5'} border border-white/5`}>
                                                            <div className="flex items-center gap-2 font-bold mb-1">
                                                                <span>{r.error ? '❌' : '✅'}</span>
                                                                <span>{r.adminEmail}</span>
                                                            </div>
                                                            {r.error ? (
                                                                <div className="text-red-400">{r.error}</div>
                                                            ) : (
                                                                <div className="text-[var(--text-muted)] pl-5">
                                                                    Processed {r.usersProcessed} users, Moved {r.movedCount} successfully
                                                                    {r.errors && r.errors.length > 0 && (
                                                                        <div className="text-red-400 mt-1">Failed to move: {r.errors.map((e: any) => e.user).join(', ')}</div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* TAB: USERS */}
                                {activeTab === 'users' && selectedAccount && (
                                    <div className="space-y-4">
                                        <div className="flex items-center gap-3">
                                            <input
                                                type="text"
                                                placeholder="Search users..."
                                                value={searchFilter}
                                                onChange={e => setSearchFilter(e.target.value)}
                                                className="flex-1 px-4 py-2 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)]"
                                            />
                                            {wsInfo && wsInfo.users.filter(u => u.status === 'suspended').length > 0 && (
                                                <button
                                                    onClick={() => handleDeleteSuspended()}
                                                    disabled={deletingSuspended}
                                                    className="px-4 py-2 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white text-sm font-bold transition-all"
                                                >
                                                    {deletingSuspended ? '⏳' : '🗑 Suspandeds'}
                                                </button>
                                            )}
                                            <button
                                                onClick={handleLoadInfo}
                                                disabled={loadingInfo}
                                                className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-sm font-bold transition-all"
                                            >
                                                {loadingInfo ? '⏳' : '🔄 Refresh'}
                                            </button>
                                        </div>
                                        {!wsInfo ? (
                                            <div className="text-center py-12 text-[var(--text-muted)]">
                                                <div className="text-4xl mb-3">👥</div>
                                                <div>Click "Load Workspace" to see users</div>
                                            </div>
                                        ) : (
                                            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                                                {filteredUsers.length === 0 ? (
                                                    <div className="text-center py-8 text-[var(--text-muted)]">No users found</div>
                                                ) : filteredUsers.map(user => (
                                                    <div key={user.email} className="flex items-center gap-4 px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 transition-all">
                                                        <div className="w-9 h-9 rounded-full bg-indigo-600/30 flex items-center justify-center text-indigo-400 font-black text-sm shrink-0">
                                                            {user.email[0]?.toUpperCase()}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="font-bold text-sm truncate">{user.email}</div>
                                                            <div className="text-xs text-[var(--text-muted)]">{user.name}</div>
                                                        </div>
                                                        <div className="flex items-center gap-2 shrink-0">
                                                            {user.isAdmin && <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full font-bold">Admin</span>}
                                                            <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${user.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                                                                {user.status}
                                                            </span>
                                                            {user.status === 'suspended' && (
                                                                <button
                                                                    onClick={() => handleVerifySMS(user.email)}
                                                                    title="Verify User via SMS"
                                                                    className="px-3 py-1.5 ml-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all bg-indigo-500/10 hover:bg-indigo-500 hover:text-white text-indigo-400 whitespace-nowrap"
                                                                >
                                                                    Verify b SMS
                                                                </button>
                                                            )}
                                                            <button
                                                                onClick={() => {
                                                                    const parts = user.name ? user.name.split(' ') : [];
                                                                    setEditUserModal({
                                                                        oldEmail: user.email,
                                                                        newEmail: user.email,
                                                                        firstName: parts[0] || '',
                                                                        lastName: parts.slice(1).join(' ') || ''
                                                                    });
                                                                }}
                                                                title="Edit User"
                                                                className="px-3 py-1.5 ml-2 rounded-lg text-sm font-black transition-all bg-blue-500/10 hover:bg-blue-500 hover:text-white text-blue-500"
                                                            >
                                                                ✏️
                                                            </button>
                                                            <button
                                                                onClick={() => handleDeleteUser(user.email)}
                                                                disabled={deletingUser === user.email || user.isAdmin}
                                                                title={user.isAdmin ? "Cannot delete Admin from here" : "Delete User"}
                                                                className={`px-3 py-1.5 ml-2 rounded-lg text-sm font-black transition-all ${user.isAdmin ? 'opacity-30 cursor-not-allowed bg-red-900/20 text-red-500/50' : 'bg-red-500/10 hover:bg-red-500 hover:text-white text-red-500'}`}
                                                            >
                                                                {deletingUser === user.email ? '⏳' : '🗑'}
                                                            </button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* TAB: CREATE USERS */}
                                {activeTab === 'create-users' && selectedAccount && (
                                    <div className="space-y-5">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                                            <div className="space-y-2">
                                                <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Target Domain</label>
                                                <select
                                                    value={targetDomain}
                                                    onChange={e => setTargetDomain(e.target.value)}
                                                    className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] appearance-none cursor-pointer"
                                                >
                                                    {wsInfo?.domains.map(d => (
                                                        <option key={d.domainName} value={d.domainName}>
                                                            {d.domainName} {d.isPrimary ? '(Primary)' : ''}
                                                        </option>
                                                    ))}
                                                    {!wsInfo && <option value={selectedAccount.domain}>{selectedAccount.domain}</option>}
                                                </select>
                                                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 mt-8 text-white/50">
                                                    ▼
                                                </div>
                                            </div>

                                            <div className="space-y-2">
                                                <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Proxy (Optional)</label>
                                                <input
                                                    type="text"
                                                    value={proxyString}
                                                    onChange={e => setProxyString(e.target.value)}
                                                    placeholder="ip:port:user:password"
                                                    className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)]"
                                                />
                                            </div>
                                        </div>

                                        <div>
                                            <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block mb-2">
                                                Users List · Format: username:password:firstname:lastname (one per line)
                                            </label>
                                            <textarea
                                                value={bulkUsersText}
                                                onChange={e => setBulkUsersText(e.target.value)}
                                                rows={8}
                                                placeholder={`john:Pass123!:John:Doe\njane:SecurePass1!:Jane:Smith\nbob (auto-password)\nbob:MyPass99!`}
                                                className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-indigo-500 resize-none"
                                            />
                                            <div className="text-xs text-[var(--text-muted)] mt-1">
                                                {bulkUsersText.split('\n').filter(l => l.trim()).length} users — will be created at @{targetDomain || selectedAccount.domain}
                                            </div>
                                        </div>
                                        <button
                                            onClick={handleCreateUsers}
                                            disabled={createLoading || !bulkUsersText.trim()}
                                            className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                        >
                                            {createLoading ? '⏳ Creating Users...' : `➕ Create ${bulkUsersText.split('\n').filter(l => l.trim()).length} Users`}
                                        </button>

                                        {createResults.length > 0 && (
                                            <div className="space-y-2 max-h-64 overflow-y-auto">
                                                <div className="flex gap-4 text-xs font-bold">
                                                    <span className="text-emerald-400">✅ Created: {createResults.filter(r => r.status === 'created').length}</span>
                                                    <span className="text-red-400">❌ Failed: {createResults.filter(r => r.status === 'error').length}</span>
                                                </div>
                                                {createResults.map((r, i) => (
                                                    <div key={i} className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm ${r.status === 'created' ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                                                        <span>{r.status === 'created' ? '✅' : '❌'}</span>
                                                        <span className="font-bold flex-shrink-0 w-32 truncate">{r.email}</span>
                                                        {r.error && <span className="text-xs text-red-400 break-words flex-1">{r.error}</span>}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* TAB: ADD DOMAIN (single + bulk) */}
                                {activeTab === 'add-domain' && (
                                    <div className="space-y-6">
                                        {/* Single */}
                                        <div className="space-y-3">
                                            <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Add Single Domain</label>
                                            <div className="flex gap-3">
                                                <input
                                                    type="text"
                                                    value={newDomain}
                                                    onChange={e => setNewDomain(e.target.value)}
                                                    placeholder="example.com"
                                                    className="flex-1 px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)] placeholder-[var(--text-muted)]"
                                                />
                                                <button
                                                    onClick={handleAddDomain}
                                                    disabled={addingDomain || !newDomain.trim()}
                                                    className="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black text-sm transition-all disabled:opacity-50"
                                                >
                                                    {addingDomain ? '⏳' : '🌐 Add'}
                                                </button>
                                            </div>
                                            {domainMsg && (
                                                <div className={`text-sm px-4 py-2.5 rounded-xl ${domainMsg.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                                    {domainMsg.text}
                                                </div>
                                            )}
                                        </div>

                                        {/* Bulk */}
                                        <div className="space-y-3 border-t border-white/10 pt-6">
                                            <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Bulk Add Domains (one per line)</label>
                                            <textarea
                                                value={bulkDomainsText}
                                                onChange={e => setBulkDomainsText(e.target.value)}
                                                rows={6}
                                                placeholder={`domain1.com\ndomain2.com\ndomain3.net`}
                                                className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-indigo-500 resize-none"
                                            />
                                            <label style={{display:'flex', alignItems:'center', gap:8, cursor:'pointer'}}>
                                                <input type="checkbox" checked={addMigrateAfter} onChange={e => setAddMigrateAfter(e.target.checked)} />
                                                <span style={{fontSize:12}}>After adding, migrate existing users to newly added domain</span>
                                            </label>
                                            <button
                                                onClick={handleBulkAddDomains}
                                                disabled={bulkDomainLoading || !bulkDomainsText.trim()}
                                                className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm transition-all disabled:opacity-50"
                                            >
                                                {bulkDomainLoading ? `⏳ Adding... ${bulkDomainResults.length}/${bulkDomainsText.split('\n').filter(l => l.trim()).length}` : `🌐 Bulk Add ${bulkDomainsText.split('\n').filter(l => l.trim()).length} Domains`}
                                            </button>

                                            {bulkDomainResults.length > 0 && (
                                                <div className="space-y-1.5 max-h-56 overflow-y-auto">
                                                    <div className="flex gap-4 text-xs font-bold">
                                                        <span className="text-emerald-400">✅ Added: {bulkDomainResults.filter(r => r.status === 'added').length}</span>
                                                        <span className="text-red-400">❌ Failed: {bulkDomainResults.filter(r => r.status === 'error').length}</span>
                                                    </div>
                                                    {bulkDomainResults.map((r, i) => (
                                                        <div key={i} className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${r.status === 'added' ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                                                            <span>{r.status === 'added' ? '✅' : '❌'}</span>
                                                            <span className="font-bold flex-shrink-0 w-32 truncate">{r.domain}</span>
                                                            {r.error && <span className="text-xs text-red-400 break-words flex-1">{r.error}</span>}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* TAB: BULK OPS */}
                                {activeTab === 'bulk-ops' && (
                                    <div className="space-y-8">
                                        {/* Section 1: Bulk Add Domains */}
                                        <div className="space-y-4">
                                            <div>
                                                <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Bulk Add Domains</label>
                                                <p className="text-xs text-[var(--text-muted)] mt-1">Format: <code className="bg-white/10 px-1 rounded">admin@account.com,newdomain.com</code> — one per line</p>
                                            </div>
                                            <textarea
                                                value={bulkAddDomainText}
                                                onChange={e => setBulkAddDomainText(e.target.value)}
                                                rows={10}
                                                placeholder={`admin@workspace1.com,domain1.com\nadmin@workspace2.com,domain2.com`}
                                                className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-indigo-500 resize-y"
                                            />
                                            <div className="text-xs text-[var(--text-muted)]">
                                                {bulkAddDomainText.split('\n').filter((l: string) => l.trim()).length} pairs ready
                                            </div>
                                            <label style={{display:'flex', alignItems:'center', gap:8, cursor:'pointer'}}>
                                                <input type="checkbox" checked={addMigrateAfter} onChange={e => setAddMigrateAfter(e.target.checked)} />
                                                <span style={{fontSize:12}}>After adding, migrate existing users to newly added domain</span>
                                            </label>
                                            <button
                                                onClick={handleBulkAddDomainsMulti}
                                                disabled={bulkAddDomainLoading || !bulkAddDomainText.trim()}
                                                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                            >
                                                {bulkAddDomainLoading ? (
                                                    <><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Adding... {bulkAddDomainResults.length}/{bulkAddDomainText.split('\n').filter((l:string) => l.trim()).length}</>
                                                ) : '⚡ Run Bulk Add'}
                                            </button>
                                            {bulkAddDomainResults.length > 0 && (
                                                <div className="space-y-1.5 max-h-56 overflow-y-auto">
                                                    <div className="flex gap-4 text-xs font-bold">
                                                        <span className="text-emerald-400">✅ Added: {bulkAddDomainResults.filter(r => r.status === 'added').length}</span>
                                                        <span className="text-red-400">❌ Failed: {bulkAddDomainResults.filter(r => r.status === 'error').length}</span>
                                                    </div>
                                                    {bulkAddDomainResults.map((r, i) => (
                                                        <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${r.status === 'added' ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                                                            <span>{r.status === 'added' ? '✅' : '❌'}</span>
                                                            <span className="font-bold text-[var(--text-muted)]">{r.adminEmail}</span>
                                                            <span className="text-white/30">→</span>
                                                            <span className="font-bold">{r.domainName}</span>
                                                            {r.error && <span className="text-red-400 ml-auto truncate max-w-[40%]">{r.error}</span>}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Section: Change Users Domain */}
                                        <div className="space-y-4 border-t border-white/10 pt-6">
                                            <div>
                                                <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Change Users Domain</label>
                                                <p className="text-xs text-[var(--text-muted)] mt-1">Changes domain for all users except the admin. Format: <code className="bg-white/10 px-1 rounded">admin@account.com,targetdomain.com</code></p>
                                            </div>
                                            <textarea
                                                value={bulkChangeDomainText}
                                                onChange={e => setBulkChangeDomainText(e.target.value)}
                                                rows={6}
                                                placeholder={`admin@workspace1.com,newdomain.com\nadmin@workspace2.com,target.domain`}
                                                className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-indigo-500 resize-y"
                                            />
                                            <div className="text-xs text-[var(--text-muted)]">
                                                {bulkChangeDomainText.split('\n').filter((l: string) => l.trim()).length} accounts ready
                                            </div>
                                            <button
                                                onClick={handleBulkChangeUsersDomain}
                                                disabled={bulkChangeDomainLoading || !bulkChangeDomainText.trim()}
                                                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                            >
                                                {bulkChangeDomainLoading ? (
                                                    <><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Changing Domains...</>
                                                ) : '⚡ Run Change Users Domain'}
                                            </button>
                                            {bulkChangeDomainResults.length > 0 && (
                                                <div className="space-y-2 max-h-64 overflow-y-auto">
                                                    <div className="flex gap-4 text-xs font-bold">
                                                        <span className="text-emerald-400">✅ {bulkChangeDomainResults.filter(r => !r.error).length} done</span>
                                                        <span className="text-red-400">❌ {bulkChangeDomainResults.filter(r => r.error).length} failed</span>
                                                    </div>
                                                    {bulkChangeDomainResults.map((r, i) => (
                                                        <div key={i} className={`px-3 py-2 rounded-lg text-xs ${r.error ? 'bg-red-500/10' : 'bg-white/5'} border border-white/5`}>
                                                            <div className="flex items-center gap-2 font-bold mb-1">
                                                                <span>{r.error ? '❌' : '✅'}</span>
                                                                <span>{r.adminEmail}</span>
                                                                <span className="text-[var(--text-muted)] font-normal">→ @{r.targetDomain}</span>
                                                            </div>
                                                            {r.error ? (
                                                                <div className="text-red-400">{r.error}</div>
                                                            ) : (
                                                                <div className="text-[var(--text-muted)] pl-5">
                                                                    Moved {r.movedCount}/{r.total} users
                                                                </div>
                                                            )}
                                                            {r.errors && r.errors.length > 0 && (
                                                                <div className="mt-1 pl-5 text-red-400">
                                                                    {r.errors.map((e: any, j: number) => (
                                                                        <div key={j}>⚠️ {e.user}: {e.error}</div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Section 2: Bulk Migrate & Delete */}

                                        <div className="space-y-4 border-t border-white/10 pt-6">
                                            <div>
                                                <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Bulk Migrate &amp; Delete Domain</label>
                                                <p className="text-xs text-[var(--text-muted)] mt-1">
                                                    One per line:<br/>
                                                    <code className="bg-white/10 px-1 rounded">admin@account.com</code> — auto-detect all non-primary domains<br/>
                                                    <code className="bg-white/10 px-1 rounded">admin@account.com,old-domain.com</code> — specific domain only
                                                </p>
                                            </div>
                                            <textarea
                                                value={bulkMigrateText}
                                                onChange={e => setBulkMigrateText(e.target.value)}
                                                rows={8}
                                                placeholder={"support@workspace1.com\nsupport@workspace2.com,old-domain.com\nadmin@ws3.com,specific.domain"}
                                                className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-amber-500 resize-y"
                                            />
                                            <div className="text-xs text-[var(--text-muted)]">
                                                {bulkMigrateText.split('\n').filter((l: string) => l.trim()).length} accounts ready
                                            </div>
                                            <button
                                                onClick={handleBulkMigrateDomains}
                                                disabled={bulkMigrateLoading || !bulkMigrateText.trim()}
                                                className="w-full py-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-black text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                            >
                                                {bulkMigrateLoading ? (
                                                    <><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Migrating...</>
                                                ) : '⚡ Run Bulk Migrate & Delete'}
                                            </button>
                                            {bulkMigrateResults.length > 0 && (
                                                <div className="space-y-2 max-h-64 overflow-y-auto">
                                                    <div className="flex gap-4 text-xs font-bold">
                                                        <span className="text-emerald-400">✅ {bulkMigrateResults.filter(r => !r.error && r.domains && r.domains.some(d => d.domainDeleted)).length} accounts done</span>
                                                        <span className="text-red-400">❌ {bulkMigrateResults.filter(r => r.error).length} failed</span>
                                                    </div>
                                                    {bulkMigrateResults.map((r, i) => (
                                                        <div key={i} className={`px-3 py-2 rounded-lg text-xs ${r.error ? 'bg-red-500/10' : 'bg-white/5'} border border-white/5`}>
                                                            <div className="flex items-center gap-2 font-bold mb-1">
                                                                <span>{r.error ? '❌' : '✅'}</span>
                                                                <span>{r.adminEmail}</span>
                                                                {r.primaryDomain && <span className="text-[var(--text-muted)] font-normal">→ @{r.primaryDomain}</span>}
                                                            </div>
                                                            {r.error && <div className="text-red-400">{r.error}</div>}
                                                            {r.note && <div className="text-amber-400">{r.note}</div>}
                                                            {r.domains && r.domains.map((d, j) => (
                                                                <div key={j} className={`mt-1 pl-3 border-l-2 ${d.domainDeleted ? 'border-emerald-500' : 'border-red-500'} text-[var(--text-muted)]`}>
                                                                    {d.domainDeleted ? '✅' : '⚠️'} {d.domain} — moved {d.movedCount}/{d.total} users{d.domainDeleted ? ' · deleted' : ` · ${d.domainError}`}
                                                                </div>
                                                            ))}
                                                            {r.error && <div className="mt-1 text-red-400">{r.error}</div>}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Section 3: Migrate Aliases to Domain (keep domains) */}
                                        <div className="border-t border-white/10 pt-6 space-y-4">
                                            <div>
                                                <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Migrate Aliases to Domain (keep domains)</label>
                                                <p className="text-xs text-[var(--text-muted)] mt-1">
                                                    One per line:<br/>
                                                    <code className="bg-white/10 px-1 rounded">admin@account.com</code> — auto: move users to next available domain (falls back to primary)<br/>
                                                    <code className="bg-white/10 px-1 rounded">admin@account.com,targetDomain</code> or <code className="bg-white/10 px-1 rounded">admin@account.com:targetDomain</code> — move to specified domain
                                                </p>
                                            </div>
                                            <textarea
                                                value={bulkMigrateUsersText}
                                                onChange={e => setBulkMigrateUsersText(e.target.value)}
                                                rows={8}
                                                placeholder={"support@workspace1.com\nsupport@workspace2.com,new-domain.com\nadmin@ws3.com:target.domain"}
                                                className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-amber-500 resize-y"
                                            />
                                            <div className="text-xs text-[var(--text-muted)]">
                                                {bulkMigrateUsersText.split('\n').filter((l: string) => l.trim()).length} accounts ready
                                            </div>
                                            <button
                                                onClick={handleBulkMigrateUsersOnly}
                                                disabled={bulkMigrateUsersLoading || !bulkMigrateUsersText.trim()}
                                                className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                            >
                                                {bulkMigrateUsersLoading ? (
                                                    <><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Migrating...</>
                                                ) : '⚡ Run Bulk Migrate Aliases'}
                                            </button>
                                            {bulkMigrateUsersResults.length > 0 && (
                                                <div className="space-y-2 max-h-64 overflow-y-auto">
                                                    <div className="flex gap-4 text-xs font-bold">
                                                        <span className="text-emerald-400">✅ {bulkMigrateUsersResults.filter(r => !r.error).length} accounts done</span>
                                                        <span className="text-red-400">❌ {bulkMigrateUsersResults.filter(r => r.error).length} failed</span>
                                                    </div>
                                                    {bulkMigrateUsersResults.map((r, i) => (
                                                        <div key={i} className={`px-3 py-2 rounded-lg text-xs ${r.error ? 'bg-red-500/10' : 'bg-white/5'} border border-white/5`}>
                                                            <div className="flex items-center gap-2 font-bold mb-1">
                                                                <span>{r.error ? '❌' : '✅'}</span>
                                                                <span>{r.adminEmail}</span>
                                                                {r.targetDomain && <span className="text-[var(--text-muted)] font-normal">→ @{r.targetDomain}</span>}
                                                            </div>
                                                            {r.error && <div className="text-red-400">{r.error}</div>}
                                                            {r.note && <div className="text-amber-400">{r.note}</div>}
                                                            {r.domains && r.domains.map((d, j) => (
                                                                <div key={j} className="mt-1 pl-3 border-l-2 border-emerald-500 text-[var(--text-muted)]">
                                                                    ✅ {d.domain} — moved {d.movedCount}/{d.total} users
                                                                </div>
                                                            ))}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* TAB: DOMAINS LIST */}
                                {activeTab === 'domains' && (
                                    <div className="space-y-4">
                                        <div className="flex justify-between items-center mb-2">
                                            <div>
                                                <h3 className="font-black text-xs uppercase tracking-widest text-[var(--text-muted)]">Workspace Domains</h3>
                                                {wsInfo && (
                                                    <p className="text-xs text-[var(--text-muted)] mt-1">
                                                        <span className="text-emerald-400 font-bold">{wsInfo.domains.filter(d => d.verified).length} verified</span>
                                                        {wsInfo.domains.filter(d => !d.verified).length > 0 && (
                                                            <span className="text-amber-400 font-bold ml-3">{wsInfo.domains.filter(d => !d.verified).length} pending</span>
                                                        )}
                                                    </p>
                                                )}
                                            </div>
                                            {wsInfo && (
                                                <button
                                                    onClick={handleLoadInfo}
                                                    disabled={loadingInfo}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 transition-all text-xs font-bold"
                                                >
                                                    {loadingInfo ? '⏳...' : '🔄 Refresh'}
                                                </button>
                                            )}
                                        </div>
                                        {!wsInfo ? (
                                            <div className="text-center py-12 text-[var(--text-muted)]">
                                                <div className="text-4xl mb-3">🌐</div>
                                                <div>Click "Load Workspace" to see domains</div>
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {wsInfo.domains.length === 0 ? (
                                                    <div className="text-center py-8 text-[var(--text-muted)]">No domains found</div>
                                                ) : wsInfo.domains.map(d => {
                                                    const vState = verifyingDomains[d.domainName];
                                                    const vErr = verifyErrors[d.domainName];
                                                    const isPending = !d.verified;
                                                    return (
                                                        <div key={d.domainName} className={`rounded-xl border transition-all ${isPending ? 'bg-amber-500/5 border-amber-500/20' : d.isPrimary ? 'bg-indigo-500/5 border-indigo-500/20' : 'bg-white/5 border-white/10'}`}>
                                                            <div className="flex items-center gap-3 px-4 py-3">
                                                                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-lg shrink-0 ${d.isPrimary ? 'bg-indigo-600/20 text-indigo-400' : d.verified ? 'bg-emerald-600/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
                                                                    {d.isPrimary ? '★' : d.verified ? '✓' : '⏳'}
                                                                </div>
                                                                <div className="flex-1 min-w-0">
                                                                    <div className="font-bold text-sm">{d.domainName}</div>
                                                                    {isPending && (
                                                                        <div className="text-[10px] text-amber-400/70 mt-0.5">
                                                                            Added to Workspace — DNS verification pending
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                <div className="flex items-center gap-2 shrink-0">
                                                                    {d.isPrimary && (
                                                                        <span className="text-xs bg-indigo-500/20 text-indigo-400 px-2 py-0.5 rounded-full font-bold">Primary</span>
                                                                    )}
                                                                    <span className={`text-xs px-2.5 py-1 rounded-full font-black uppercase tracking-wider ${d.verified ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
                                                                        {vState === 'ok' ? '✓ Verified' : d.verified ? '✓ Verified' : '⏳ Pending'}
                                                                    </span>
                                                                    {isPending && vState !== 'ok' && (
                                                                        <button
                                                                            onClick={() => handleVerifyDomain(d.domainName)}
                                                                            disabled={vState === 'loading'}
                                                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-black transition-all disabled:opacity-50"
                                                                        >
                                                                            {vState === 'loading' ? (
                                                                                <><svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Verifying...</>
                                                                            ) : (
                                                                                <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg> Verify Now</>
                                                                            )}
                                                                        </button>
                                                                    )}
                                                                    {!d.isPrimary && (
                                                                        <button
                                                                            onClick={() => handleDeleteDomainAliases(d.domainName)}
                                                                            disabled={deletingAliases[d.domainName]}
                                                                            title="Delete all users on this domain"
                                                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500 text-rose-400 hover:text-white text-xs font-black transition-all disabled:opacity-50"
                                                                        >
                                                                            {deletingAliases[d.domainName] ? (
                                                                                <><svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Deleting...</>
                                                                            ) : (
                                                                                <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg> Delete Users</>
                                                                            )}
                                                                        </button>
                                                                    )}
                                                                    {!d.isPrimary && (
                                                                        <button
                                                                            onClick={() => handleMigrateUsersForDomain(d.domainName)}
                                                                            disabled={migratingUsersFor[d.domainName]}
                                                                            title="Migrate users to next available non-primary domain (keep domains)"
                                                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-white text-xs font-black transition-all disabled:opacity-50"
                                                                        >
                                                                            {migratingUsersFor[d.domainName] ? (
                                                                                <><svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Migrating...</>
                                                                            ) : (
                                                                                <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg> Domain (keep domains)</>
                                                                            )}
                                                                        </button>
                                                                    )}
                                                                    {!d.isPrimary && (
                                                                        <button
                                                                            onClick={() => handleMigrateAndDeleteDomain(d.domainName)}
                                                                            disabled={migratingAndDeleting[d.domainName]}
                                                                            title="Migrate users to primary domain then delete this domain"
                                                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/10 hover:bg-violet-500 text-violet-400 hover:text-white text-xs font-black transition-all disabled:opacity-50"
                                                                        >
                                                                            {migratingAndDeleting[d.domainName] ? (
                                                                                <><svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Processing...</>
                                                                            ) : (
                                                                                <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg> → Primary &amp; Delete</>
                                                                            )}
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            {vErr && (
                                                                <div className="px-4 pb-3">
                                                                    <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">❌ {vErr}</div>
                                                                </div>
                                                            )}
                                                            {vState === 'ok' && (
                                                                <div className="px-4 pb-3">
                                                                    <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">✅ Domain verified successfully</div>
                                                                </div>
                                                            )}
                                                            {aliasResults[d.domainName] && (
                                                                <div className="px-4 pb-3">
                                                                    {aliasResults[d.domainName].error ? (
                                                                        <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">❌ {aliasResults[d.domainName].error}</div>
                                                                    ) : (
                                                                        <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">✅ {aliasResults[d.domainName].deletedCount} user(s) deleted from @{d.domainName}</div>
                                                                    )}
                                                                </div>
                                                            )}
                                                            {migrateUsersResults[d.domainName] && (
                                                                <div className="px-4 pb-3">
                                                                    <div className={`text-xs px-3 py-2 rounded-lg border ${migrateUsersResults[d.domainName].error ? 'text-rose-400 bg-rose-500/10 border-rose-500/20' : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'}`}>
                                                                        {migrateUsersResults[d.domainName].error
                                                                            ? `❌ ${migrateUsersResults[d.domainName].error}`
                                                                            : `✅ ${migrateUsersResults[d.domainName].movedCount}/${migrateUsersResults[d.domainName].total} users migrated`}
                                                                    </div>
                                                                </div>
                                                            )}
                                                            {migratingAndDeleting[d.domainName] && (
                                                                <div className="px-4 pb-3">
                                                                    <div className="flex items-center gap-2 text-xs text-violet-400 bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-2">
                                                                        <svg className="animate-spin shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                                                        <span>Migrating users &amp; removing aliases — domain deletion in progress, please wait…</span>
                                                                    </div>
                                                                </div>
                                                            )}
                                                            {migrateAndDeleteResults[d.domainName] && (
                                                                <div className="px-4 pb-3">
                                                                    <div className={`text-xs px-3 py-2 rounded-lg border ${migrateAndDeleteResults[d.domainName].error ? 'text-rose-400 bg-rose-500/10 border-rose-500/20' : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'}`}>
                                                                        {migrateAndDeleteResults[d.domainName].error
                                                                            ? `❌ ${migrateAndDeleteResults[d.domainName].error}`
                                                                            : `✅ ${migrateAndDeleteResults[d.domainName].movedCount}/${migrateAndDeleteResults[d.domainName].total} migrated → primary${migrateAndDeleteResults[d.domainName].domainDeleted ? ', domain deleted' : migrateAndDeleteResults[d.domainName].domainError ? ` — delete failed: ${migrateAndDeleteResults[d.domainName].domainError}` : ''}`}
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            {Object.values(migratingAndDeleting).some(Boolean) && (
                <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 rounded-2xl bg-violet-900/95 border border-violet-400/40 text-violet-100 text-sm font-bold shadow-2xl backdrop-blur-sm">
                    <svg className="animate-spin shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                    Migrating &amp; deleting domain — please wait…
                </div>
            )}

            {/* Edit User Modal */}
            {editUserModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
                    <div className="bg-[#1a1b26] border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-xl font-black text-white">Edit User</h2>
                            <button onClick={() => setEditUserModal(null)} className="text-[var(--text-muted)] hover:text-white transition-colors">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                            </button>
                        </div>
                        
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-black uppercase text-[var(--text-muted)] block mb-1">First Name</label>
                                <input
                                    type="text"
                                    value={editUserModal.firstName}
                                    onChange={e => setEditUserModal({ ...editUserModal, firstName: e.target.value })}
                                    className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-blue-500 text-white"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-black uppercase text-[var(--text-muted)] block mb-1">Last Name</label>
                                <input
                                    type="text"
                                    value={editUserModal.lastName}
                                    onChange={e => setEditUserModal({ ...editUserModal, lastName: e.target.value })}
                                    className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-blue-500 text-white"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-black uppercase text-[var(--text-muted)] block mb-1">Primary Email / Alias</label>
                                <input
                                    type="text"
                                    value={editUserModal.newEmail}
                                    onChange={e => setEditUserModal({ ...editUserModal, newEmail: e.target.value })}
                                    className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-blue-500 text-white"
                                />
                                <p className="text-[10px] text-[var(--text-muted)] mt-1">Changing this will make the old email an alias.</p>
                            </div>

                            {editUserError && (
                                <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                                    ❌ {editUserError}
                                </div>
                            )}

                            <button
                                onClick={submitEditUser}
                                disabled={editingUser || !editUserModal.newEmail}
                                className="w-full mt-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-black text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {editingUser ? (
                                    <><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Saving...</>
                                ) : '💾 Save Changes'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ManageAccounts;
