
import React, { useState, useMemo, useEffect } from 'react';
import { Account, AccountStatus } from '../types';
import { Icons } from '../constants';

const API_URL = '/api';

interface ValidAccountsProps {
  accounts: Account[];
  onRemove: (id: string) => void;
  onBatchRemove: (ids: string[]) => void;
  onUpdateCollection: (ids: string[], name: string) => void;
  onEditAccount: (id: string, email: string, pass: string) => void;
  onMoveToQueue: (ids: string[]) => void;
  onNavigate?: (view: string) => void;
  currentUser?: { username: string; role: string } | null;
}

const ValidAccounts: React.FC<ValidAccountsProps> = ({
  accounts,
  onRemove,
  onBatchRemove,
  onUpdateCollection,
  onEditAccount,
  onMoveToQueue,
  onNavigate,
  currentUser
}) => {
  /* Self-fetched data from result_accounts.txt ONLY */
  const [resultAccounts, setResultAccounts] = useState<Account[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  useEffect(() => {
    const session = localStorage.getItem('nexus_session');
    const me = session ? JSON.parse(session) : null;

    const fetchResults = async () => {
      try {
        const res = await fetch(`${API_URL}/result-accounts`);
        if (!res.ok) return;
        const data = await res.json();
        let mapped: Account[] = data.map((item: any) => ({
          id: item.id,
          email: item.data?.userEmail || '',
          password: item.data?.userPassword || '',
          status: AccountStatus.COMPLETED,
          collection: item.collection || undefined,
          createdAt: item.createdAt || undefined,
          verifiedBy: item.verifiedBy || undefined
        }));

        // Filter removed: all users can see all result accounts

        setResultAccounts(mapped);
      } catch (e) {
        console.error('[ValidAccounts] fetch error:', e);
      } finally {
        setLoadingData(false);
      }
    };
    fetchResults();
    const interval = setInterval(fetchResults, 5000);
    return () => clearInterval(interval);
  }, []);

  /* Pagination State */
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(12);

  /* Filter & Selection State */
  const [filterCollection, setFilterCollection] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newCollectionName, setNewCollectionName] = useState('');
  const [newBulkDate, setNewBulkDate] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterUser, setFilterUser] = useState('all');
  const [assignUser, setAssignUser] = useState('');
  const [appUsers, setAppUsers] = useState<any[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState({ email: '', pass: '', collection: '', date: '' });
  const [otps, setOtps] = useState<Record<string, string>>({});
  const [revealedPassIds, setRevealedPassIds] = useState<Set<string>>(new Set());
  const [phoneVerifyingIds, setPhoneVerifyingIds] = useState<Set<string>>(new Set());
  const [phoneVerifyResults, setPhoneVerifyResults] = useState<Record<string, 'queued' | 'error'>>();
  const [statusCheckingIds, setStatusCheckingIds] = useState<Set<string>>(new Set());
  const [statusResults, setStatusResults] = useState<Record<string, string>>({});
  const [uploadingFile, setUploadingFile] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addAccountData, setAddAccountData] = useState({ email: '', password: '', collection: '' });

  /* Reset pagination when filter/data changes */
  React.useEffect(() => {
    setCurrentPage(1);
  }, [filterCollection, resultAccounts.length]);

  const validAccounts = resultAccounts; // already filtered to result_accounts.txt


  const isExpired = (createdAt?: string) => {
    if (!createdAt) return false;
    const diffDays = Math.floor((Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24));
    return diffDays >= 14;
  };

  const collections = useMemo(() => {
    const set = new Set(validAccounts.map(a => a.collection).filter(Boolean));
    return Array.from(set) as string[];
  }, [validAccounts]);

  const uniqueUsers = useMemo(() => {
    const set = new Set(validAccounts.map(a => a.verifiedBy).filter(Boolean));
    return Array.from(set) as string[];
  }, [validAccounts]);

  const filteredAccounts = useMemo(() => {
    let result = validAccounts;
    if (filterCollection === 'unassigned') result = result.filter(a => !a.collection);
    else if (filterCollection !== 'all') result = result.filter(a => a.collection === filterCollection);
    
    if (filterStatus === 'expired') result = result.filter(a => isExpired(a.createdAt));
    else if (filterStatus === 'active') result = result.filter(a => !isExpired(a.createdAt));

    if (filterUser !== 'all') {
      result = result.filter(a => a.verifiedBy === filterUser);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(a => a.email.toLowerCase().includes(q));
    }
    return result;
  }, [validAccounts, filterCollection, filterStatus, filterUser, searchQuery]);

  /* Pagination Logic */
  const totalPages = Math.ceil(filteredAccounts.length / itemsPerPage);
  const paginatedAccounts = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredAccounts.slice(start, start + itemsPerPage);
  }, [filteredAccounts, currentPage, itemsPerPage]);

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const toggleSelectAll = () => {
    const visibleIds = paginatedAccounts.map(a => a.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));

    const next = new Set(selectedIds);
    if (allVisibleSelected) {
      visibleIds.forEach(id => next.delete(id));
    } else {
      visibleIds.forEach(id => next.add(id));
    }
    setSelectedIds(next);
  };

  const handleGroupSelected = async () => {
    if ((!newCollectionName.trim() && !newBulkDate.trim()) || selectedIds.size === 0) return;

    const ids = Array.from(selectedIds);
    const accs = validAccounts.filter(a => ids.includes(a.id));
    const emails = accs.map(a => a.email);
    const collectionName = newCollectionName.trim();
    const newDateStr = newBulkDate ? new Date(newBulkDate).toISOString() : undefined;

    // Optimistic: update local state immediately
    setResultAccounts(prev => prev.map(a => {
      if (ids.includes(a.id)) {
        return {
          ...a,
          ...(collectionName ? { collection: collectionName } : {}),
          ...(newDateStr ? { createdAt: newDateStr } : {})
        };
      }
      return a;
    }));

    setNewCollectionName('');
    setNewBulkDate('');
    setSelectedIds(new Set());

    try {
      await fetch(`${API_URL}/accounts/bulk_update`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails, collection: collectionName, newDate: newDateStr })
      });
    } catch (e) {
      console.error('Bulk update error:', e);
    }
  };

  const handleAssignToUser = async () => {
    if (!assignUser.trim() || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const emails = validAccounts.filter(a => ids.includes(a.id)).map(a => a.email);

    try {
      await fetch(`${API_URL}/accounts/bulk_assign`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails, username: assignUser, force: true })
      });
      // Update local state
      setResultAccounts(prev => prev.map(a => ids.includes(a.id) ? { ...a, verifiedBy: assignUser } : a));
      setAssignUser('');
      setSelectedIds(new Set());
    } catch (e) {
      console.error('Assign error:', e);
    }
  };

  const toast = (msg: string, type: 'ok'|'err'|'info' = 'info') => {
    const c = document.getElementById('toast-container'); if (!c) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
    el.innerHTML = `<span style="font-weight:700">${type==='ok'?'✓':type==='err'?'✕':'ℹ'}</span><span>${msg}</span>`;
    c.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; el.style.transition='all 0.3s'; setTimeout(()=>el.remove(),300); }, 3500);
  };

  // Fetch users for assignment
  useEffect(() => {
    const session = localStorage.getItem('nexus_session');
    const me = session ? JSON.parse(session) : null;
    if (me) {
      fetch(`${API_URL}/app-users`).then(r => r.json()).then(setAppUsers).catch(() => {});
    }
  }, []);

  const startEdit = (acc: Account) => {
    setEditingId(acc.id);
    let dateStr = '';
    if (acc.createdAt) {
      dateStr = new Date(acc.createdAt).toISOString().split('T')[0];
    }
    setEditData({ email: acc.email, pass: acc.password, collection: acc.collection || '', date: dateStr });
  };

  const saveEdit = async () => {
    if (editingId) {
      const acc = validAccounts.find(a => a.id === editingId);
      if (!acc) return;

      const newDato = editData.date ? new Date(editData.date).toISOString() : undefined;

      try {
        await fetch(`${API_URL}/accounts/edit_full`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            oldEmail: acc.email,
            newEmail: editData.email,
            newPassword: editData.pass,
            newCollection: editData.collection,
            newDate: newDato
          })
        });

        // Optimistic update
        setResultAccounts(prev => prev.map(a =>
          a.id === editingId
            ? { ...a, email: editData.email, password: editData.pass, collection: editData.collection, createdAt: newDato }
            : a
        ));
      } catch (e) {
        console.error('Save edit error:', e);
      }

      setEditingId(null);
    }
  };

  const generateOTP = async (id: string) => {
    const account = validAccounts.find(a => a.id === id);
    if (!account) return;

    setOtps(prev => ({ ...prev, [id]: '...' }));

    try {
      const res = await fetch('/api/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: account.email })
      });
      const data = await res.json();

      if (data.success && data.otp) {
        setOtps(prev => ({ ...prev, [id]: data.otp }));
        // Auto-clear after 30s like standard TOTP window
        setTimeout(() => {
          setOtps(prev => {
            const n = { ...prev };
            delete n[id];
            return n;
          });
        }, 30000);
      } else {
        console.error('OTP Error:', data.error);
        setOtps(prev => ({ ...prev, [id]: 'ERR' }));
        setTimeout(() => setOtps(prev => { const n = { ...prev }; delete n[id]; return n; }), 3000);
      }
    } catch (e) {
      console.error('OTP Network Error:', e);
      setOtps(prev => ({ ...prev, [id]: 'ERR' }));
      setTimeout(() => setOtps(prev => { const n = { ...prev }; delete n[id]; return n; }), 3000);
    }
  };

  const toggleRevealPass = (id: string) => {
    const next = new Set(revealedPassIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setRevealedPassIds(next);
  };

  const verifyPhone = async (acc: Account) => {
    setPhoneVerifyingIds(prev => new Set(prev).add(acc.id));
    try {
      const session = localStorage.getItem('nexus_session');
      const me = session ? JSON.parse(session) : null;
      
      const res = await fetch('/api/accounts/verify-phone/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          accounts: [{ email: acc.email, password: acc.password }],
          verifiedBy: me?.username || 'admin'
        })
      });
      const data = await res.json();
      if (data.success) {
        setPhoneVerifyResults(prev => ({ ...prev, [acc.id]: 'queued' }));
        
        // Auto-add to verify list for the next UI
        const existing = JSON.parse(localStorage.getItem('nexus_auto_verify_emails') || '[]');
        if (!existing.includes(acc.email)) existing.push(acc.email);
        localStorage.setItem('nexus_auto_verify_emails', JSON.stringify(existing));
        
        toast('Added to Phone Verify Queue! Opening Verify Phone tab...', 'ok');
        
        setTimeout(() => {
          if (onNavigate) {
            onNavigate('PHONE_VERIFY');
          }
        }, 800);
      } else {
        setPhoneVerifyResults(prev => ({ ...prev, [acc.id]: 'error' }));
        setTimeout(() => setPhoneVerifyResults(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 3000);
      }
    } catch (e) {
      setPhoneVerifyResults(prev => ({ ...prev, [acc.id]: 'error' }));
      setTimeout(() => setPhoneVerifyResults(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 3000);
    } finally {
      setPhoneVerifyingIds(prev => { const n = new Set(prev); n.delete(acc.id); return n; });
    }
  };

  // ── gcloud + DWD + SDK (gcloud-only mode) ───────────────────────────────
  const [archivingIds, setArchivingIds] = useState<Set<string>>(new Set());

  const handleArchive = async (acc: Account) => {
    setArchivingIds(prev => new Set(prev).add(acc.id));
    try {
      const res = await fetch(`${API_URL}/accounts/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: acc.email, password: acc.password, collection: acc.collection, createdAt: acc.createdAt, verifiedBy: acc.verifiedBy, archivedBy: currentUser?.username || 'unknown' })
      });
      const data = await res.json();
      if (data.success) {
        setResultAccounts(prev => prev.filter(a => a.id !== acc.id));
        toast(`Archived ${acc.email}`, 'ok');
        onNavigate?.('ARCHIVE_ACCOUNTS');
      } else {
        toast(data.error || 'Archive failed', 'err');
      }
    } catch {
      toast('Connection error — restart the server', 'err');
    } finally {
      setArchivingIds(prev => { const n = new Set(prev); n.delete(acc.id); return n; });
    }
  };


  const [bulkArchiving, setBulkArchiving] = useState(false);

  const handleBulkArchive = async () => {
    if (selectedIds.size === 0 || bulkArchiving) return;
    const accs = validAccounts.filter(a => selectedIds.has(a.id));
    if (!accs.length) return;
    setBulkArchiving(true);
    try {
      const results = await Promise.all(accs.map(acc =>
        fetch(`${API_URL}/accounts/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: acc.email, password: acc.password, collection: acc.collection, createdAt: acc.createdAt, verifiedBy: acc.verifiedBy, archivedBy: currentUser?.username || 'unknown' })
        }).then(r => r.json()).catch(() => ({ success: false }))
      ));
      const succeeded = results.filter(r => r.success);
      const failed = results.length - succeeded.length;
      if (succeeded.length > 0) {
        const succeededEmails = accs.filter((_, i) => results[i]?.success).map(a => a.id);
        setResultAccounts(prev => prev.filter(a => !succeededEmails.includes(a.id)));
        setSelectedIds(new Set());
        toast(`Archived ${succeeded.length} account(s)${failed > 0 ? `, ${failed} failed` : ''}`, succeeded.length > 0 ? 'ok' : 'err');
        onNavigate?.('ARCHIVE_ACCOUNTS');
      } else {
        toast('Archive failed — restart the server and try again', 'err');
      }
    } catch {
      toast('Archive failed', 'err');
    } finally {
      setBulkArchiving(false);
    }
  };

  const [gcloudRunningIds, setGcloudRunningIds] = useState<Set<string>>(new Set());
  const [gcloudResults, setGcloudResults] = useState<Record<string, 'queued' | 'error'>>({});

  const [age18LoadingIds, setAge18LoadingIds] = useState<Set<string>>(new Set());
  const [age18Results, setAge18Results] = useState<Record<string, 'done' | 'error'>>({});

  const runGCloud = async (acc: Account) => {
    setGcloudRunningIds(prev => new Set(prev).add(acc.id));
    try {
      const res = await fetch('/api/jobs/gcloud', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEmail: acc.email, userPassword: acc.password, headless: false })
      });
      const data = await res.json();
      if (data.success) {
        setGcloudResults(prev => ({ ...prev, [acc.id]: 'queued' }));
        setTimeout(() => setGcloudResults(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 6000);
      } else {
        setGcloudResults(prev => ({ ...prev, [acc.id]: 'error' }));
        setTimeout(() => setGcloudResults(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 3000);
      }
    } catch (e) {
      setGcloudResults(prev => ({ ...prev, [acc.id]: 'error' }));
      setTimeout(() => setGcloudResults(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 3000);
    } finally {
      setGcloudRunningIds(prev => { const n = new Set(prev); n.delete(acc.id); return n; });
    }
  };

  const [recreateRunningIds, setRecreateRunningIds] = useState<Set<string>>(new Set());
  const [recreateResults, setRecreateResults] = useState<Record<string, 'queued' | 'error'>>({});

  const runRecreate = async (acc: Account, skipConfirm = false) => {
    if (!skipConfirm && !window.confirm(`Delete this account's existing GCP project(s) and re-run full setup for ${acc.email}?\n\nThis removes the current project and creates a brand-new one with all scopes/apis/setup.`)) return;
    setRecreateRunningIds(prev => new Set(prev).add(acc.id));
    try {
      const res = await fetch('/api/jobs/recreate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEmail: acc.email, userPassword: acc.password, headless: false })
      });
      const data = await res.json();
      if (data.success) {
        setRecreateResults(prev => ({ ...prev, [acc.id]: 'queued' }));
        setTimeout(() => setRecreateResults(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 6000);
      } else {
        setRecreateResults(prev => ({ ...prev, [acc.id]: 'error' }));
        setTimeout(() => setRecreateResults(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 3000);
      }
    } catch (e) {
      setRecreateResults(prev => ({ ...prev, [acc.id]: 'error' }));
      setTimeout(() => setRecreateResults(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 3000);
    } finally {
      setRecreateRunningIds(prev => { const n = new Set(prev); n.delete(acc.id); return n; });
    }
  };

  const checkAccountStatus = async (acc: Account) => {
    setStatusCheckingIds(prev => new Set(prev).add(acc.id));
    setStatusResults(prev => { const n = { ...prev } as Record<string, string>; delete n[acc.id]; return n; });
    try {
      const res = await fetch('/api/accounts/check-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: acc.email, password: acc.password })
      });
      const data = await res.json();
      if (data.success) {
        setStatusResults(prev => ({ ...prev, [acc.id]: data.status }));
        if (data.status === 'ACTIVE') toast('Account is active!', 'ok');
        else if (data.status === 'REQUIRES_PHONE_VERIFY') toast('Requires phone verify', 'info');
        else if (data.status === 'ACCOUNT_NOT_FOUND') toast('Account not found', 'err');
        else if (data.status === 'WRONG_PASSWORD') toast('Wrong password', 'err');
        else toast(`Status: ${data.status}`, 'info');
      } else {
        setStatusResults(prev => ({ ...prev, [acc.id]: 'ERROR' }));
        toast('Failed to check status', 'err');
      }
    } catch (e) {
      setStatusResults(prev => ({ ...prev, [acc.id]: 'ERROR' }));
      toast('Connection error', 'err');
    } finally {
      setStatusCheckingIds(prev => { const n = new Set(prev); n.delete(acc.id); return n; });
    }
  };

  const handleArchiveSingle = async (acc: Account) => {
    setAge18LoadingIds(prev => new Set(prev).add(acc.id));
    try {
      const res = await fetch('/api/manage/set-age-18plus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail: acc.email, adminPassword: acc.password })
      });
      const data = await res.json();
      if (data.success) {
        setAge18Results(prev => ({ ...prev, [acc.id]: 'done' }));
        setTimeout(() => setAge18Results(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 6000);
      } else {
        setAge18Results(prev => ({ ...prev, [acc.id]: 'error' }));
        setTimeout(() => setAge18Results(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 4000);
      }
    } catch {
      setAge18Results(prev => ({ ...prev, [acc.id]: 'error' }));
      setTimeout(() => setAge18Results(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 4000);
    } finally {
      setAge18LoadingIds(prev => { const n = new Set(prev); n.delete(acc.id); return n; });
    }
  };

  const runBulkGCloud = async () => {
    if (selectedIds.size === 0) return;
    toast(`Starting GCloud setup for ${selectedIds.size} account(s)`, 'info');
    for (const id of Array.from(selectedIds)) {
      const acc = validAccounts.find(a => a.id === id);
      if (acc) {
        runGCloud(acc);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  };

  const runBulkRecreate = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Delete existing GCP project(s) and re-run full setup for ${selectedIds.size} selected account(s)?`)) return;
    toast(`Recreating project for ${selectedIds.size} account(s)`, 'info');
    for (const id of Array.from(selectedIds)) {
      const acc = validAccounts.find(a => a.id === id);
      if (acc) {
        runRecreate(acc, true);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  };

  // ────────────────────────────────────────────────────────────────────────

  const handleMoveToQueueLocal = async (ids: string[]) => {
    const accs = validAccounts.filter(a => ids.includes(a.id));
    const emails = accs.map(a => a.email);
    if (emails.length === 0) return;

    // Optimistic: remove from local state immediately
    setResultAccounts(prev => prev.filter(a => !ids.includes(a.id)));
    setSelectedIds(new Set());

    try {
      const res = await fetch(`${API_URL}/accounts/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails })
      });
      const data = await res.json();
      if (data.success) {
        console.log(`✅ Moved ${data.moved} account(s) to queue`);
      } else {
        console.error('Move failed:', data.error);
      }
    } catch (e) {
      console.error('Move error:', e);
    }
  };

  const handleDownload = () => {
    if (selectedIds.size === 0) return;
    const selected = filteredAccounts.filter(a => selectedIds.has(a.id));
    const content = selected.map(a => `${a.email}:${a.password}`).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `verified_accounts_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    const emailsList = validAccounts.filter(a => selectedIds.has(a.id)).map(a => a.email);
    setResultAccounts(prev => prev.filter(a => !selectedIds.has(a.id)));
    setSelectedIds(new Set());
    toast(`Deleted ${emailsList.length} records`, 'ok');
    try {
      await fetch(`${API_URL}/accounts`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: emailsList })
      });
    } catch (e) { console.error('Delete error:', e); }
  };

  const handleDeleteLocal = async (id: string, email: string) => {
    setResultAccounts(prev => prev.filter(a => a.id !== id));
    toast(`Removed ${email}`, 'ok');
    try {
      await fetch(`${API_URL}/accounts`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: [email] })
      });
    } catch (e) { console.error('Delete error:', e); }
  };

  const handleDeduplicate = async () => {
    try {
      const res = await fetch(`${API_URL}/manage/deduplicate`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const m1 = data.results['result_accounts.txt']?.removed || 0;
        const m2 = data.results['accounts.txt']?.removed || 0;
        toast(`Removed ${m1} from results, ${m2} from queue`, 'ok');
        setTimeout(() => window.location.reload(), 1200);
      } else {
        toast(data.error || 'Deduplicate failed', 'err');
      }
    } catch (e: any) {
      toast('Error: ' + e.message, 'err');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFile(true);
    try {
      const text = await file.text();
      const lines = text.split('\n').map((l: string) => l.trim()).filter((l: string) => l.includes(':'));
      const parsed = lines.map((line: string) => {
        const idx = line.indexOf(':');
        return { email: line.substring(0, idx), password: line.substring(idx + 1) };
      }).filter((a: any) => a.email.includes('@'));

      if (parsed.length === 0) {
        toast('No valid accounts found. Format: email:password', 'err');
        return;
      }

      const res = await fetch('/api/accounts/upload-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: parsed })
      });
      const data = await res.json();
      if (data.success) {
        toast(`Uploaded ${data.count} accounts to Result Accounts`, 'ok');
      } else {
        toast('Upload failed: ' + data.error, 'err');
      }
    } catch (err: any) {
      toast('Error: ' + err.message, 'err');
    } finally {
      setUploadingFile(false);
      e.target.value = '';
    }
  };

  const handleAddManualAccount = async () => {
    if (!addAccountData.email.includes('@') || !addAccountData.password) {
      toast('Valid email and password are required', 'err');
      return;
    }
    
    try {
      const res = await fetch('/api/accounts/upload-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: [{ email: addAccountData.email, password: addAccountData.password }] })
      });
      const data = await res.json();
      if (data.success) {
        toast(`Account ${addAccountData.email} added manually`, 'ok');
        
        if (addAccountData.collection) {
          await fetch(`${API_URL}/accounts/bulk_update`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emails: [addAccountData.email], collection: addAccountData.collection })
          });
        }
        
        setShowAddModal(false);
        setAddAccountData({ email: '', password: '', collection: '' });
      } else {
        toast('Upload failed: ' + data.error, 'err');
      }
    } catch (err: any) {
      toast('Error: ' + err.message, 'err');
    }
  };

  return (
    <div className="space-y-8 md:space-y-12 animate-in fade-in duration-700 relative pb-24">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div className="shrink-0">
          <h2 className="text-2xl sm:text-3xl font-black tracking-tightest uppercase flex items-center gap-3">
            <span className="text-emerald-500"><Icons.Database /></span>
            Result Accounts
          </h2>
          <p className="text-[var(--text-muted)] mt-2 text-sm font-medium">Managing {validAccounts.length} verified administrative records.</p>
        </div>

        <div className="flex flex-row items-center gap-3 overflow-x-auto pb-2 no-scrollbar max-w-full">
          {/* Add Manual Account */}
          <button
            onClick={() => setShowAddModal(true)}
            className="glass-card px-4 py-2.5 flex items-center gap-2 hover:bg-blue-500/10 transition-colors text-blue-400 shrink-0"
            title="Add Account Manually"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            <span className="text-xs font-black uppercase tracking-widest hidden sm:inline">Add Manual</span>
          </button>

          {/* Upload TXT to Results */}
          <label className={`glass-card px-4 py-2.5 flex items-center gap-2 hover:bg-emerald-500/10 transition-colors cursor-pointer ${uploadingFile ? 'opacity-50 pointer-events-none' : 'text-emerald-400'}`} title="Upload verified accounts (email:password)">
            <input type="file" accept=".txt" className="hidden" onChange={handleFileUpload} />
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" x2="12" y1="3" y2="15" /></svg>
            <span className="text-xs font-black uppercase tracking-widest hidden sm:inline">{uploadingFile ? 'Uploading...' : 'Upload TXT'}</span>
          </label>

          {/* Deduplicate Action */}
          <button
            onClick={handleDeduplicate}
            className="glass-card px-4 py-2.5 flex items-center gap-2 hover:bg-white/5 transition-colors text-amber-500"
            title="Remove duplicates from all account files"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 62A2 2 0 0119 22H5a2 2 0 01-2-2V8a2 2 0 012-2h14a2 2 0 012 2z" /><path d="M10 11V17" /><path d="M14 11V17" /><path d="M5 6l1-3h12l1 3" /></svg>
            <span className="text-xs font-black uppercase tracking-widest hidden sm:inline">Deduplicate</span>
          </button>

          {/* Search Box */}
          <div className="glass-card px-4 py-2.5 flex items-center gap-2 min-w-[220px]">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-[var(--text-muted)] shrink-0"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              type="text"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              placeholder="Search email..."
              className="bg-transparent text-sm text-[var(--text-main)] outline-none w-full placeholder:text-[var(--text-muted)] placeholder:opacity-50 font-medium"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            )}
          </div>

          {/* Pagination Limit Selector */}
          <div className="glass-card px-4 py-2.5 flex items-center gap-3">
            <span className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Rows</span>
            <select
              value={itemsPerPage}
              onChange={(e) => setItemsPerPage(Number(e.target.value))}
              className="bg-transparent text-sm text-[var(--text-main)] outline-none cursor-pointer font-bold appearance-none"
            >
              <option className="bg-[#0f172a] text-[#f8fafc]" value={12}>12</option>
              <option className="bg-[#0f172a] text-[#f8fafc]" value={25}>25</option>
              <option className="bg-[#0f172a] text-[#f8fafc]" value={50}>50</option>
              <option className="bg-[#0f172a] text-[#f8fafc]" value={100}>100</option>
              <option className="bg-[#0f172a] text-[#f8fafc]" value={999999}>All</option>
            </select>
          </div>

          <div className="glass-card px-4 py-2.5 flex items-center gap-3">
            <span className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Filter by Collection</span>
            <select
              value={filterCollection}
              onChange={(e) => setFilterCollection(e.target.value)}
              className="bg-transparent text-sm text-[var(--text-main)] outline-none cursor-pointer font-bold appearance-none max-w-[150px]"
            >
              <option className="bg-[#0f172a] text-[#f8fafc]" value="all">All Records</option>
              <option className="bg-[#0f172a] text-[#f8fafc]" value="unassigned">Unassigned Only</option>
              {collections.map(c => (
                <option className="bg-[#0f172a] text-[#f8fafc]" key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="glass-card px-4 py-2.5 flex items-center gap-3">
            <span className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Filter by Status</span>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="bg-transparent text-sm text-[var(--text-main)] outline-none cursor-pointer font-bold appearance-none max-w-[150px]"
            >
              <option className="bg-[#0f172a] text-[#f8fafc]" value="all">All Statuses</option>
              <option className="bg-[#0f172a] text-[#f8fafc]" value="active">Active</option>
              <option className="bg-[#0f172a] text-[#f8fafc]" value="expired">Expired (14+ Days)</option>
            </select>
          </div>

          <div className="glass-card px-4 py-2.5 flex items-center gap-3">
            <span className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Filter by User</span>
            <select
              value={filterUser}
              onChange={(e) => setFilterUser(e.target.value)}
              className="bg-transparent text-sm text-[var(--text-main)] outline-none cursor-pointer font-bold appearance-none max-w-[150px]"
            >
              <option className="bg-[#0f172a] text-[#f8fafc]" value="all">All Users</option>
              {uniqueUsers.map(u => (
                <option className="bg-[#0f172a] text-[#f8fafc]" key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Floating Action Bar for Selections */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-8 left-1/2 lg:left-[calc(50%+160px)] -translate-x-1/2 z-50 animate-in slide-in-from-bottom-10 w-max max-w-[95vw] lg:max-w-[calc(100vw-350px)]">
          <div className="bg-[#0f172a] rounded-2xl px-6 py-4 shadow-[0_8px_32px_rgba(0,0,0,0.5)] flex flex-wrap items-center justify-center gap-4 border border-white/10 backdrop-blur-xl">
            <span className="text-sm font-black text-white whitespace-nowrap">{selectedIds.size} SELECTED</span>
            <div className="h-6 w-[1px] bg-white/20" />
            <input
              type="text"
              placeholder="Assign to new list..."
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              className="flex-1 min-w-[140px] bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none"
            />
            <input
              type="date"
              value={newBulkDate}
              onChange={(e) => setNewBulkDate(e.target.value)}
              className="w-[130px] bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
            />
            <button
              onClick={handleGroupSelected}
              className="bg-white text-indigo-600 font-bold px-5 py-2 rounded-lg text-sm hover:bg-slate-50 transition-all shadow-lg active:scale-95"
            >
              Update
            </button>

            {/* Run Bulk GCloud (Placement moved here for better visibility) */}
            <button
              onClick={runBulkGCloud}
              title="Run Bulk GCloud + DWD + SDK Setup"
              className="bg-orange-500 text-white font-bold px-5 py-2 rounded-lg text-sm hover:bg-orange-400 transition-all shadow-lg active:scale-95 flex items-center gap-2 whitespace-nowrap"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              Run GCloud
            </button>
            {/* Bulk Recreate Project: delete existing GCP project(s) + full setup */}
            <button
              onClick={runBulkRecreate}
              title="Delete existing GCP project(s) and re-run full setup for selected accounts"
              className="bg-cyan-500 text-white font-bold px-5 py-2 rounded-lg text-sm hover:bg-cyan-400 transition-all shadow-lg active:scale-95 flex items-center gap-2 whitespace-nowrap"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              Recreate Project
            </button>
            {/* Assign to User */}
            <div className="flex items-center gap-3">
              <div className="h-6 w-[1px] bg-white/20" />
              <select 
                value={assignUser}
                onChange={(e) => setAssignUser(e.target.value)}
                className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-sm text-white focus:outline-none outline-none appearance-none min-w-[120px]"
              >
                <option value="" className="bg-[#0f172a]">Assign to...</option>
                <option value="ALL" className="bg-indigo-600 font-bold">All Users (Shared)</option>
                {appUsers.map(u => (
                  <option key={u.id} value={u.username} className="bg-[#0f172a]">{u.username}</option>
                ))}
              </select>
              <button
                onClick={handleAssignToUser}
                disabled={!assignUser}
                className="bg-emerald-500 text-white font-bold px-4 py-2 rounded-lg text-xs hover:bg-emerald-400 transition-all disabled:opacity-50"
              >
                Set User
              </button>
            </div>
            {true && (
              <>
                <div className="h-6 w-[1px] bg-white/20" />
                <button
                  onClick={() => {
                    handleMoveToQueueLocal(Array.from(selectedIds));
                  }}
                  title="Return to Queue"
                  className="flex items-center gap-2 px-4 py-2 text-amber-400 bg-amber-400/10 hover:bg-amber-400/20 rounded-lg transition-colors font-bold text-xs uppercase tracking-widest"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></svg>
                  Move to Queue
                </button>
              </>
            )}

            {/* Bulk Archive */}
            <button
              onClick={handleBulkArchive}
              disabled={bulkArchiving}
              title="Move selected to Archive"
              className="flex items-center gap-2 px-4 py-2 text-slate-400 bg-slate-500/10 hover:bg-slate-500/20 rounded-lg transition-colors font-bold text-xs uppercase tracking-widest disabled:opacity-50"
            >
              {bulkArchiving ? (
                <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
              )}
              Archive
            </button>

            <button
              onClick={handleDownload}
              title="Download Selected"
              className="p-2 text-white hover:bg-white/10 rounded-lg transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></svg>
            </button>
            <button
              onClick={handleDeleteSelected}
              title="Delete Selected"
              className="p-2 text-rose-300 hover:bg-rose-500/20 rounded-lg transition-colors"
            >
              <Icons.Trash />
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="p-2 text-white/60 hover:text-white transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
            </button>
          </div>
        </div>
      )}

      {/* Dense Table View */}
      <div className="glass-card overflow-hidden shadow-2xl flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse table-auto min-w-[1400px]">
            <thead>
              <tr className="bg-theme-surface border-b border-theme-glass">
                <th className="px-4 py-6 w-12 text-center">
                  <input
                    type="checkbox"
                    checked={paginatedAccounts.length > 0 && paginatedAccounts.every(a => selectedIds.has(a.id))}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-theme-glass bg-theme-surface text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Email Identity</th>
                <th className="px-4 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Password</th>
                <th className="px-4 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Collection</th>
                <th className="px-4 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Created</th>
                <th className="px-4 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Verified By</th>
                <th className="px-4 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Trial Status</th>
                <th className="px-4 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Security</th>
                <th className="px-4 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest text-right">Operational Tools</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-glass">
              {paginatedAccounts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-24 text-center text-[var(--text-muted)] italic font-medium opacity-50">
                    <div className="flex flex-col items-center gap-3">
                      <span className="text-4xl">📂</span>
                      <span>No synchronized records found in this partition.</span>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedAccounts.map((acc) => (
                  <tr
                    key={acc.id}
                    className={`hover:bg-indigo-600/5 transition-all group ${selectedIds.has(acc.id) ? 'bg-indigo-600/10' : ''}`}
                  >
                    <td className="px-5 py-6 text-center">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(acc.id)}
                        onChange={() => toggleSelect(acc.id)}
                        className="w-5 h-5 rounded border-theme-glass bg-theme-surface text-indigo-600 cursor-pointer"
                      />
                    </td>
                    <td className="px-5 py-6">
                      {editingId === acc.id ? (
                        <input
                          type="text"
                          value={editData.email}
                          onChange={(e) => setEditData({ ...editData, email: e.target.value })}
                          className="w-full glass-input py-2 px-3 text-sm"
                        />
                      ) : (
                        <div className="flex items-center gap-3">
                          <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
                          <span className="font-bold text-[var(--text-main)] text-base">{acc.email}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-6">
                      {editingId === acc.id ? (
                        <input
                          type="text"
                          value={editData.pass}
                          onChange={(e) => setEditData({ ...editData, pass: e.target.value })}
                          className="w-full glass-input py-2 px-3 text-sm"
                        />
                      ) : (
                        <div
                          className="font-mono text-sm text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-main)] transition-colors flex items-center gap-2"
                          onClick={() => {
                            navigator.clipboard.writeText(acc.password);
                            toggleRevealPass(acc.id);
                          }}
                          title="Click to copy & reveal"
                        >
                          <span className="opacity-50 tracking-tighter uppercase text-xs">Key:</span>
                          <span className={revealedPassIds.has(acc.id) ? 'text-indigo-500 font-bold' : ''}>
                            {revealedPassIds.has(acc.id) ? acc.password : '••••••••••••'}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-6">
                      {editingId === acc.id ? (
                        <input
                          type="text"
                          value={editData.collection}
                          onChange={(e) => setEditData({ ...editData, collection: e.target.value })}
                          className="w-full glass-input py-2 px-3 text-sm"
                          placeholder="List Name"
                        />
                      ) : acc.collection ? (
                        <span className="inline-flex items-center px-3 py-1.5 rounded-md bg-indigo-500/10 text-indigo-500 border border-indigo-500/20 text-xs font-bold uppercase tracking-wide whitespace-nowrap">
                          {acc.collection}
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--text-muted)] italic opacity-50">Unsorted</span>
                      )}
                    </td>
                    <td className="px-5 py-6">
                      {acc.createdAt ? (
                        <span className="text-sm text-[var(--text-muted)] font-medium">
                          {new Date(acc.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--text-muted)] italic opacity-30">Unknown</span>
                      )}
                    </td>
                    {/* Verified By */}
                    <td className="px-5 py-6">
                      {acc.verifiedBy ? (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-500/10 text-violet-400 border border-violet-500/20 text-xs font-bold uppercase tracking-wide whitespace-nowrap">
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                          {acc.verifiedBy}
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--text-muted)] italic opacity-30">—</span>
                      )}
                    </td>
                    <td className="px-5 py-6">
                      <TrialCountdown createdAt={acc.createdAt} />
                    </td>
                    <td className="px-5 py-6 min-w-[140px]">
                      <div className="flex items-center gap-3">
                        <span className="badge bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 text-xs px-2 py-1">
                          NXS V3
                        </span>
                        {otps[acc.id] && (
                          <div
                            className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 rounded-md animate-in zoom-in duration-300 shadow-lg shadow-indigo-600/20 cursor-pointer hover:bg-indigo-500 transition-colors"
                            onClick={() => navigator.clipboard.writeText(otps[acc.id])}
                            title="Click to copy OTP"
                          >
                            <span className="text-xs font-black text-white font-mono tracking-widest">{otps[acc.id]}</span>
                            <div className="w-10 bg-white/20 h-1.5 rounded-full overflow-hidden">
                              <div className="bg-white h-full animate-[progress_15s_linear_forwards] w-full" />
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-6 text-right">
                      <div className="flex items-center justify-end gap-2 md:opacity-50 group-hover:opacity-100 transition-opacity">
                        {editingId === acc.id ? (
                          <>
                            <button onClick={saveEdit} className="p-2.5 text-emerald-500 hover:bg-emerald-500/10 rounded-xl transition-colors">
                              <Icons.Verify />
                            </button>
                            <button onClick={() => setEditingId(null)} className="p-2.5 text-[var(--text-muted)] hover:bg-slate-500/10 rounded-xl transition-colors">
                              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => checkAccountStatus(acc)}
                              disabled={statusCheckingIds.has(acc.id)}
                              title="Check Login Status"
                              className={`p-2.5 rounded-xl transition-all shrink-0 ${statusResults?.[acc.id] === 'ACTIVE'
                                ? 'text-emerald-400 bg-emerald-500/10'
                                : statusResults?.[acc.id] === 'REQUIRES_PHONE_VERIFY'
                                  ? 'text-orange-400 bg-orange-500/10'
                                  : statusResults?.[acc.id] === 'ACCOUNT_NOT_FOUND' || statusResults?.[acc.id] === 'SUSPENDED' || statusResults?.[acc.id] === 'WRONG_PASSWORD'
                                    ? 'text-rose-400 bg-rose-500/10'
                                    : 'text-blue-400 hover:bg-blue-500/10'
                                } disabled:opacity-40`}
                            >
                              {statusCheckingIds.has(acc.id) ? (
                                <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                              )}
                            </button>
                            <button
                              onClick={() => generateOTP(acc.id)}
                              title="Generate OTP"
                              className="p-2.5 text-indigo-500 hover:bg-indigo-500/10 rounded-xl transition-colors shrink-0"
                            >
                              <Icons.Shield />
                            </button>
                            {/* Phone-Only Verify Button */}
                            <button
                              onClick={() => verifyPhone(acc)}
                              disabled={phoneVerifyingIds.has(acc.id)}
                              title="Verify Phone Number"
                              className={`p-2.5 rounded-xl transition-all shrink-0 ${phoneVerifyResults?.[acc.id] === 'queued'
                                ? 'text-emerald-400 bg-emerald-500/10'
                                : phoneVerifyResults?.[acc.id] === 'error'
                                  ? 'text-rose-400 bg-rose-500/10'
                                  : 'text-teal-400 hover:bg-teal-500/10'
                                } disabled:opacity-40`}
                            >
                              {phoneVerifyingIds.has(acc.id) ? (
                                <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                              ) : phoneVerifyResults?.[acc.id] === 'queued' ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.1 6.1l.94-.94a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
                              )}
                            </button>
                            {/* GCloud + DWD + SDK Button */}
                            <button
                              onClick={() => runGCloud(acc)}
                              disabled={gcloudRunningIds.has(acc.id)}
                              title="Run GCloud + DWD + SDK Setup"
                              className={`p-2.5 rounded-xl transition-all shrink-0 ${gcloudResults?.[acc.id] === 'queued'
                                ? 'text-emerald-400 bg-emerald-500/10'
                                : gcloudResults?.[acc.id] === 'error'
                                  ? 'text-rose-400 bg-rose-500/10'
                                  : 'text-orange-400 hover:bg-orange-500/10'
                                } disabled:opacity-40`}
                            >
                              {gcloudRunningIds.has(acc.id) ? (
                                <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                              ) : gcloudResults?.[acc.id] === 'queued' ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" /></svg>
                              )}
                            </button>
                            {/* Recreate Project Button: delete existing GCP project(s) + full setup */}
                            <button
                              onClick={() => runRecreate(acc)}
                              disabled={recreateRunningIds.has(acc.id)}
                              title="Delete existing GCP project(s) and re-run full setup (new project + scopes)"
                              className={`p-2.5 rounded-xl transition-all shrink-0 font-black text-xs ${
                                recreateResults[acc.id] === 'queued'
                                  ? 'text-emerald-400 bg-emerald-500/10'
                                  : recreateResults[acc.id] === 'error'
                                    ? 'text-rose-400 bg-rose-500/10'
                                    : 'text-cyan-400 hover:bg-cyan-500/10'
                              } disabled:opacity-40`}
                            >
                              {recreateRunningIds.has(acc.id) ? (
                                <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                              ) : recreateResults[acc.id] === 'queued' ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                              ) : recreateResults[acc.id] === 'error' ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                              )}
                            </button>
                            {/* Age 18+ Button */}
                            <button
                              onClick={() => handleAge18Plus(acc)}
                              disabled={age18LoadingIds.has(acc.id)}
                              title="Set Age 18+ in Google Admin"
                              className={`p-2.5 rounded-xl transition-all shrink-0 font-black text-xs ${
                                age18Results[acc.id] === 'done'
                                  ? 'text-emerald-400 bg-emerald-500/10'
                                  : age18Results[acc.id] === 'error'
                                    ? 'text-rose-400 bg-rose-500/10'
                                    : 'text-violet-400 hover:bg-violet-500/10'
                              } disabled:opacity-40`}
                            >
                              {age18LoadingIds.has(acc.id) ? (
                                <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                              ) : age18Results[acc.id] === 'done' ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                              ) : age18Results[acc.id] === 'error' ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                              ) : (
                                <span style={{fontSize: 11, letterSpacing: 0}}>18+</span>
                              )}
                            </button>
                            <button
                              onClick={() => startEdit(acc)}
                              title="Edit Record"
                              className="p-2.5 text-[var(--text-muted)] hover:bg-indigo-500/10 rounded-xl transition-colors shrink-0"
                            >
                              <Icons.Edit />
                            </button>
                            <button
                              onClick={() => handleDeleteLocal(acc.id, acc.email)}
                              title="Destroy Record"
                              className="p-2.5 text-rose-500 hover:bg-rose-500/10 rounded-xl transition-colors shrink-0"
                            >
                              <Icons.Trash />
                            </button>
                            {isExpired(acc.createdAt) && (
                              <button
                                onClick={() => handleArchive(acc)}
                                disabled={archivingIds.has(acc.id)}
                                title="Move to Archive (Trial Expired)"
                                className="p-2.5 text-slate-400 hover:bg-slate-500/10 rounded-xl transition-colors shrink-0 disabled:opacity-40"
                              >
                                {archivingIds.has(acc.id) ? (
                                  <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                ) : (
                                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                                )}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        {totalPages > 1 && (
          <div className="border-t border-theme-glass px-4 py-3 flex items-center justify-between">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="px-3 py-1 rounded text-xs font-bold uppercase tracking-wider disabled:opacity-30 hover:bg-white/5 transition-colors"
            >
              Previous
            </button>
            <div className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">
              Page {currentPage} of {totalPages}
            </div>
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="px-3 py-1 rounded text-xs font-bold uppercase tracking-wider disabled:opacity-30 hover:bg-white/5 transition-colors"
            >
              Next
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes progress {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>

      {/* Add Manual Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-[#0f172a] rounded-2xl p-6 w-full max-w-md border border-white/10 shadow-2xl relative">
            <h3 className="text-xl font-black text-white mb-6 uppercase tracking-wider">Add Manual Account</h3>
            
            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-1.5 block">Email Address</label>
                <input
                  type="email"
                  value={addAccountData.email}
                  onChange={e => setAddAccountData({ ...addAccountData, email: e.target.value })}
                  placeholder="admin@domain.com"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
              <div>
                <label className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-1.5 block">Password</label>
                <input
                  type="text"
                  value={addAccountData.password}
                  onChange={e => setAddAccountData({ ...addAccountData, password: e.target.value })}
                  placeholder="Account password"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
              <div>
                <label className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-1.5 block">Collection (Optional)</label>
                <input
                  type="text"
                  value={addAccountData.collection}
                  onChange={e => setAddAccountData({ ...addAccountData, collection: e.target.value })}
                  placeholder="e.g. Batch_1"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-8">
              <button
                onClick={() => setShowAddModal(false)}
                className="flex-1 px-4 py-3 rounded-xl font-bold text-sm text-white/70 hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddManualAccount}
                className="flex-1 px-4 py-3 rounded-xl font-bold text-sm bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
              >
                Add Account
              </button>
            </div>
          </div>
        </div>
      )}
    </div >
  );
};

const TrialCountdown: React.FC<{ createdAt?: string }> = ({ createdAt }) => {
  if (!createdAt) {
    return <span className="text-[10px] text-[var(--text-muted)] italic opacity-30">N/A</span>;
  }

  const created = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const daysRemaining = 14 - diffDays;

  let badgeClass = '';
  let statusText = '';

  if (daysRemaining > 7) {
    badgeClass = 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
    statusText = `${daysRemaining} days left`;
  } else if (daysRemaining >= 3) {
    badgeClass = 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20';
    statusText = `${daysRemaining} days left`;
  } else if (daysRemaining > 0) {
    badgeClass = 'bg-rose-500/10 text-rose-500 border-rose-500/20';
    statusText = `${daysRemaining} days left`;
  } else {
    badgeClass = 'bg-slate-500/10 text-slate-500 border-slate-500/20';
    statusText = 'Expired';
  }

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-md border text-[10px] font-bold uppercase tracking-wide whitespace-nowrap ${badgeClass}`}>
      {statusText}
    </span>
  );
};

export default ValidAccounts;

