
import React, { useState, useMemo } from 'react';
import { Account, AccountStatus, AppSettings } from '../types';
import { Icons } from '../constants';

interface AccountQueueProps {
  accounts: Account[];
  onVerify: (id: string) => void;
  onCheckLogin: (id: string) => void;
  onBulkVerify: (ids: string[]) => void;
  onPhoneVerify: (acc: Account) => void;
  onRemove: (id: string) => void;
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
}

const AccountQueue: React.FC<AccountQueueProps> = ({
  accounts, onVerify, onCheckLogin, onBulkVerify, onPhoneVerify, onRemove, settings, setSettings
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [failureFilter, setFailureFilter] = useState<boolean>(false);
  const [phoneVerifyingIds, setPhoneVerifyingIds] = useState<Set<string>>(new Set());
  const [otps, setOtps] = useState<Record<string, string>>({});
  const [uploadingFile, setUploadingFile] = useState(false);
  const [assignUser, setAssignUser] = useState('');
  const [appUsers, setAppUsers] = useState<any[]>([]);
  const [sessionLimit, setSessionLimit] = useState<number>(6);
  const [revealedPassIds, setRevealedPassIds] = useState<Set<string>>(new Set());
  const [smsGeo, setSmsGeo] = useState<'ID' | 'CO' | 'ROTATE'>('ID');

  // Load SMS geo setting from server
  React.useEffect(() => {
    fetch('/api/settings/sms-geo').then(r => r.json()).then(d => {
      if (d && d.smsGeo) setSmsGeo(d.smsGeo);
    }).catch(() => {});
  }, []);

  const updateSmsGeo = async (v: string) => {
    setSmsGeo(v as 'ID' | 'CO' | 'ROTATE');
    localStorage.setItem('nexus_sms_geo', v);
    try { await fetch('/api/settings/sms-geo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ smsGeo: v }) }); } catch {}
    toast(`SMS geo set to ${v === 'ROTATE' ? 'auto-rotation (Colombia ↔ Indonesia)' : v === 'CO' ? 'Colombia' : 'Indonesia'}`, 'ok');
  };

  // Fetch users for assignment
  React.useEffect(() => {
    const session = localStorage.getItem('nexus_session');
    const me = session ? JSON.parse(session) : null;
    if (me) {
      fetch('/api/app-users').then(r => r.json()).then(setAppUsers).catch(() => {});
    }
  }, []);

  const generateOTP = async (acc: Account) => {
    setOtps(prev => ({ ...prev, [acc.id]: '...' }));
    try {
      const res = await fetch('/api/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: acc.email })
      });
      const data = await res.json();
      if (data.success && data.otp) {
        setOtps(prev => ({ ...prev, [acc.id]: data.otp }));
        setTimeout(() => setOtps(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 30000);
      } else {
        setOtps(prev => ({ ...prev, [acc.id]: 'ERR' }));
        setTimeout(() => setOtps(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 3000);
      }
    } catch (e) {
      setOtps(prev => ({ ...prev, [acc.id]: 'ERR' }));
      setTimeout(() => setOtps(prev => { const n = { ...prev }; delete n[acc.id]; return n; }), 3000);
    }
  };

  const handlePhoneVerifyClick = async (acc: Account) => {
    setPhoneVerifyingIds(prev => new Set(prev).add(acc.id));
    await onPhoneVerify(acc);
    setTimeout(() => setPhoneVerifyingIds(prev => { const n = new Set(prev); n.delete(acc.id); return n; }), 1500);
  };

  const bulkVerifyPhone = async (ids: string[]) => {
    const accs = filteredAccounts.filter(a => ids.includes(a.id));
    for (const acc of accs) await handlePhoneVerifyClick(acc);
  };

  // Filter accounts based on failure filter and user role
  const filteredAccounts = useMemo(() => {
    let result = accounts.filter(acc => acc.status !== AccountStatus.COMPLETED);

    const session = localStorage.getItem('nexus_session');
    const me = session ? JSON.parse(session) : null;
    if (me && me.role !== 'admin') {
      result = result.filter(acc => acc.verifiedBy === me.username || acc.verifiedBy === 'ALL' || !acc.verifiedBy);
    }

    if (failureFilter) {
      result = result.filter(acc =>
        acc.status === AccountStatus.FAILED ||
        acc.status === AccountStatus.ACCOUNT_NOT_FOUND ||
        acc.status === AccountStatus.NO_ACTIVE
      );
    }
    return result;
  }, [accounts, failureFilter]);

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredAccounts.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(filteredAccounts.map(a => a.id)));
  };

  const toast = (msg: string, type: 'ok'|'err'|'info' = 'info') => {
    const c = document.getElementById('toast-container'); if (!c) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
    el.innerHTML = `<span style="font-weight:700">${type==='ok'?'✓':type==='err'?'✕':'ℹ'}</span><span>${msg}</span>`;
    c.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; el.style.transition='all 0.3s'; setTimeout(()=>el.remove(),300); }, 3500);
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    Array.from(selectedIds).forEach(id => onRemove(id));
    toast(`Deleted ${selectedIds.size} account(s)`, 'ok');
    setSelectedIds(new Set());
  };

  const handleDeduplicate = async () => {
    try {
      const res = await fetch('/api/manage/deduplicate', { method: 'POST' });
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

  const handleAssignToUser = async () => {
    if (!assignUser.trim() || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const emails = filteredAccounts.filter(a => ids.includes(a.id)).map(a => a.email);

    try {
      const res = await fetch('/api/accounts/bulk_assign', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails, username: assignUser, force: true })
      });
      const data = await res.json();
      if (data.success) {
        toast(`Assigned ${ids.length} accounts to ${assignUser}`, 'ok');
        setAssignUser('');
        setSelectedIds(new Set());
        setTimeout(() => window.location.reload(), 1000);
      }
    } catch (e) {
      console.error('Assign error:', e);
    }
  };

  const handleResetToPending = async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const emails = filteredAccounts.filter(a => ids.includes(a.id)).map(a => a.email);
    try {
      const res = await fetch('/api/jobs/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails })
      });
      const data = await res.json();
      if (data.success) { toast(`Reset ${emails.length} accounts to pending`, 'ok'); setSelectedIds(new Set()); }
      else toast(data.error || 'Reset failed', 'err');
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

      const session = localStorage.getItem('nexus_session');
      const me = session ? JSON.parse(session) : null;

      const res = await fetch('/api/accounts/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          accounts: parsed,
          verifiedBy: me?.username || 'admin'
        })
      });
      const data = await res.json();
      if (data.success) {
        toast(`Uploaded ${data.count} accounts`, 'ok');
        setTimeout(() => window.location.reload(), 1200);
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

  return (
    <div className="workspace-page space-y-8 md:space-y-12 animate-in fade-in duration-700 relative pb-24">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
        <div className="space-y-2 shrink-0">
          <h2 className="text-3xl md:text-4xl font-black tracking-tightest uppercase">List Accounts</h2>
          <p className="text-[var(--text-muted)] text-sm font-medium">Monitoring {filteredAccounts.length} identity threads.</p>
        </div>

        <div className="flex flex-row items-center gap-3 overflow-x-auto pb-2 no-scrollbar max-w-full">
          {/* Upload TXT File */}
          <label className={`glass-card px-4 py-2.5 flex items-center gap-2 hover:bg-emerald-500/10 transition-colors cursor-pointer ${uploadingFile ? 'opacity-50 pointer-events-none' : 'text-emerald-400'}`} title="Upload accounts.txt file">
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

          {/* Headless Mode Toggle */}
          <div className="glass-card px-4 py-2.5 flex items-center gap-3">
            <span className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Headless Mode</span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings.headlessMode}
                onChange={(e) => setSettings({ ...settings, headlessMode: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
            </label>
          </div>

          {/* Sessions Counter */}
          <div className="glass-card px-4 py-2.5 flex items-center gap-3">
            <span className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Sessions</span>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  const current = parseInt(settings.concurrency || '1');
                  if (current > 1) {
                    const next = String(current - 1);
                    setSettings({ ...settings, concurrency: next });
                    await fetch('/api/settings/concurrency', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ concurrency: next })
                    }).catch(() => { });
                  }
                }}
                className="w-6 h-6 rounded-lg bg-slate-500 hover:bg-slate-400 text-white font-black text-sm flex items-center justify-center transition-colors active:scale-90"
              >−</button>
              <span className="text-sm font-black text-[var(--text-main)] w-5 text-center tabular-nums">
                {settings.concurrency || '1'}
              </span>
              <button
                onClick={async () => {
                  const current = parseInt(settings.concurrency || '1');
                  if (current < 10) {
                    const next = String(current + 1);
                    setSettings({ ...settings, concurrency: next });
                    await fetch('/api/settings/concurrency', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ concurrency: next })
                    }).catch(() => { });
                  }
                }}
                className="w-6 h-6 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white font-black text-sm flex items-center justify-center transition-colors active:scale-90"
              >+</button>
            </div>
          </div>

          {/* Failure Filter Toggle */}
          <div className="glass-card px-4 py-2.5 flex items-center gap-3">
            <span className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Failure Filter</span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={failureFilter}
                onChange={(e) => setFailureFilter(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
            </label>
          </div>
        </div>
      </div>

      <div className="glass-card overflow-hidden shadow-2xl border-[var(--border-glass)]">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[1100px]">
            <thead>
              <tr className="bg-white/5 border-b border-[var(--border-glass)]">
                <th className="px-6 py-6 w-12 text-center">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === filteredAccounts.length && filteredAccounts.length > 0}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-[var(--border-glass)] bg-black/20 text-indigo-600 focus:ring-0 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-[0.2em]">Target Identity</th>
                <th className="px-4 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-[0.2em]">Password</th>
                <th className="px-4 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-[0.2em] text-center">Protocol Status</th>
                <th className="px-6 py-6 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-[0.2em] text-right">Utility</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-glass)]">
              {filteredAccounts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-10 py-24 text-center text-[var(--text-muted)] font-black uppercase tracking-[0.4em] text-[10px] opacity-30">Registry Empty</td>
                </tr>
              ) : (
                filteredAccounts.map((acc) => (
                  <tr key={acc.id} className="hover:bg-white/[0.02] transition-colors group">
                    <td className="px-6 py-4 text-center">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(acc.id)}
                        onChange={() => toggleSelect(acc.id)}
                        className="w-4 h-4 rounded border-[var(--border-glass)] bg-black/20 text-indigo-600 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-bold text-xs md:text-sm tracking-tight truncate max-w-[200px] md:max-w-xs">{acc.email}</div>
                      <div className="text-[9px] mono text-[var(--text-muted)] uppercase tracking-widest mt-0.5 opacity-40">Ref: {acc.id.toUpperCase()}</div>
                    </td>
                    <td className="px-4 py-4">
                      <div 
                        className="font-mono text-[10px] md:text-xs text-[var(--text-muted)] bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-white/10 hover:text-[var(--text-main)] transition-all flex items-center justify-between gap-2 max-w-[150px]"
                        onClick={() => {
                          const id = acc.id;
                          navigator.clipboard.writeText(acc.password);
                          setRevealedPassIds(prev => new Set(prev).add(id));
                          // Auto-hide after 15 seconds
                          setTimeout(() => {
                            setRevealedPassIds(prev => {
                              const next = new Set(prev);
                              next.delete(id);
                              return next;
                            });
                          }, 15000);
                        }}
                        title="Click to reveal & copy password"
                      >
                        <span className="truncate">
                          {revealedPassIds.has(acc.id) ? acc.password : '••••••••'}
                        </span>
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="opacity-40"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-center">
                      <StatusBadge status={acc.status} />
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2 md:opacity-40 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => onCheckLogin(acc.id)}
                          disabled={acc.status === AccountStatus.VERIFYING}
                          className="btn-glow bg-indigo-600/10 border border-indigo-500/20 hover:bg-indigo-600/20 px-3 md:px-5 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest whitespace-nowrap text-indigo-500"
                        >
                          Check Login
                        </button>
                        {/* Phone Verify Button → navigates to Phone Verify page */}
                        <button
                          onClick={() => handlePhoneVerifyClick(acc)}
                          disabled={phoneVerifyingIds.has(acc.id) || acc.status === AccountStatus.VERIFYING}
                          title="Verify Phone → opens Phone Verify page"
                          className="flex items-center gap-1.5 px-3 md:px-4 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest border transition-all disabled:opacity-40 bg-teal-500/10 border-teal-500/20 text-teal-400 hover:bg-teal-500/20"
                        >
                          {phoneVerifyingIds.has(acc.id) ? (
                            <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                          ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.1 6.1l.94-.94a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
                          )}
                          {phoneVerifyingIds.has(acc.id) ? 'Going...' : 'Phone'}
                        </button>
                        <button
                          onClick={() => generateOTP(acc)}
                          title="Get OTP from SSH"
                          className="flex items-center gap-1.5 px-3 md:px-4 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest border transition-all disabled:opacity-40 bg-indigo-500/10 border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20"
                        >
                          {otps[acc.id] || 'Get OTP'}
                        </button>
                        <button
                          onClick={() => onVerify(acc.id)}
                          disabled={acc.status === AccountStatus.VERIFYING}
                          className="btn-glow bg-white/5 border border-[var(--border-glass)] hover:border-indigo-500/50 px-3 md:px-5 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest whitespace-nowrap"
                        >
                          Verify
                        </button>
                        <button
                          onClick={() => onRemove(acc.id)}
                          className="p-2 text-rose-500 hover:bg-rose-500/10 rounded-xl transition-all"
                        >
                          <Icons.Trash />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Floating Action Bar for Selections */}
      {
        selectedIds.size > 0 && (
          <div className="fixed bottom-8 left-1/2 lg:left-[calc(50%+160px)] -translate-x-1/2 z-50 animate-in slide-in-from-bottom-10 w-max max-w-[95vw] lg:max-w-[calc(100vw-350px)]">
            <div className="bg-indigo-600 rounded-2xl px-6 py-4 shadow-[0_20px_50px_rgba(79,70,229,0.3)] flex flex-wrap items-center justify-center gap-4 border border-white/20 backdrop-blur-xl">
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-black text-white/60 uppercase tracking-widest">Selected</span>
                <span className="text-sm font-black text-white">{selectedIds.size} Units</span>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  onClick={() => {
                    Array.from(selectedIds).forEach(id => onCheckLogin(id));
                    setSelectedIds(new Set());
                  }}
                  className="bg-white text-indigo-600 px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-50 transition-all active:scale-95 whitespace-nowrap"
                >
                  Check Login
                </button>
                {/* Bulk Phone Verify */}
                <button
                  onClick={() => { bulkVerifyPhone(Array.from(selectedIds)); setSelectedIds(new Set()); }}
                  className="bg-teal-600 text-white border border-teal-500/30 px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-teal-500 transition-all active:scale-95 whitespace-nowrap flex items-center gap-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.1 6.1l.94-.94a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
                  Phone Verify
                </button>
                {/* SMS phone-number geo selector */}
                <div className="flex items-center gap-2 bg-indigo-900/40 border border-indigo-400/30 rounded-xl px-2.5 py-1.5" title="Phone number GEO used for SMS verification (Colombia / Indonesia / rotation)">
                  <span className="text-[9px] font-black text-white/60 uppercase tracking-widest">SMS Geo</span>
                  <select
                    value={smsGeo}
                    onChange={(e) => updateSmsGeo(e.target.value)}
                    className="bg-transparent text-xs font-black text-white outline-none cursor-pointer appearance-none"
                  >
                    <option value="ID" className="bg-indigo-800">🇮🇩 Indonesia</option>
                    <option value="CO" className="bg-indigo-800">🇨🇴 Colombia</option>
                    <option value="ROTATE" className="bg-indigo-800">🔄 Rotate CO ↔ ID</option>
                  </select>
                </div>
                <div className="flex items-center gap-1 mx-1">
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={sessionLimit}
                    onChange={(e) => setSessionLimit(Number(e.target.value))}
                    className="w-12 h-8 bg-black/20 border border-white/10 rounded-lg px-1 text-xs text-center text-white focus:outline-none placeholder:text-white/40 font-bold appearance-none"
                    title="Concurrent Sessions"
                  />
                  <button
                    onClick={async () => {
                      setSettings(prev => ({ ...prev, concurrency: String(sessionLimit) }));
                      await fetch('/api/settings/concurrency', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ concurrency: String(sessionLimit) })
                      }).catch(() => {});
                      onBulkVerify(Array.from(selectedIds));
                      toast(`Running ${selectedIds.size} accounts · ${sessionLimit} sessions`, 'ok');
                      setSelectedIds(new Set());
                    }}
                    className="bg-emerald-500 text-white border border-emerald-400/30 px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-400 transition-all active:scale-95 whitespace-nowrap flex items-center gap-1"
                  >
                    Run Setup
                  </button>
                </div>
                <button
                  onClick={() => {
                    const selected = filteredAccounts.filter(a => selectedIds.has(a.id));
                    const lines = selected.map(a => `${a.email}:${a.password}`).join('\n');
                    const blob = new Blob([lines], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const el = document.createElement('a');
                    el.href = url; el.download = 'accounts.txt'; el.click();
                    URL.revokeObjectURL(url);
                    toast(`Downloaded ${selected.length} accounts`, 'ok');
                  }}
                  className="bg-emerald-700 text-white border border-emerald-600/50 px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-600 transition-all active:scale-95 whitespace-nowrap flex items-center gap-1.5"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                  Download
                </button>
                <button
                  onClick={handleDeleteSelected}
                  className="bg-rose-600 text-white border border-rose-700/50 px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-rose-500 transition-all active:scale-95 whitespace-nowrap"
                >
                  Delete
                </button>

                {/* Assign to User */}
                <div className="flex items-center gap-2">
                   <div className="h-6 w-[1px] bg-white/20 mx-1" />
                    <select 
                      value={assignUser}
                      onChange={(e) => setAssignUser(e.target.value)}
                      className="bg-white/10 border border-white/20 rounded-xl px-3 py-2 text-[10px] text-white focus:outline-none outline-none appearance-none min-w-[100px] font-black uppercase tracking-widest"
                    >
                      <option value="" className="bg-indigo-700">Assign to...</option>
                      <option value="ALL" className="bg-slate-600">All Users (Shared)</option>
                      {appUsers.map(u => (
                        <option key={u.id} value={u.username} className="bg-indigo-700">{u.username}</option>
                      ))}
                    </select>
                    <button
                      onClick={handleAssignToUser}
                      disabled={!assignUser}
                      className="bg-emerald-500 text-white font-black px-4 py-2 rounded-xl text-[10px] uppercase tracking-widest hover:bg-emerald-400 transition-all disabled:opacity-50"
                    >
                      Assign Unit
                    </button>
                    <button
                      onClick={handleResetToPending}
                      className="bg-amber-500 text-white font-black px-4 py-2 rounded-xl text-[10px] uppercase tracking-widest hover:bg-amber-400 transition-all"
                    >
                      Reset Pending
                    </button>
                </div>

                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="p-2 text-white/60 hover:text-white transition-colors ml-2"
                >
                  <Icons.X size={18} />
                </button>
              </div>
            </div>
          </div>
        )
      }
    </div>
  );
};

const StatusBadge: React.FC<{ status: AccountStatus }> = ({ status }) => {
  const styles = {
    [AccountStatus.PENDING]: 'text-slate-500 bg-slate-500/10 border-slate-500/20',
    [AccountStatus.VERIFYING]: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/20 animate-pulse',
    [AccountStatus.COMPLETED]: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
    [AccountStatus.FAILED]: 'text-rose-500 bg-rose-500/10 border-rose-500/20',
    [AccountStatus.NO_ACTIVE]: 'text-orange-400 bg-orange-400/10 border-orange-400/20',
    [AccountStatus.ACCOUNT_NOT_FOUND]: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
  };

  const getLabel = (status: AccountStatus) => {
    switch (status) {
      case AccountStatus.VERIFYING: return 'IN PROGRESS';
      case AccountStatus.COMPLETED: return 'COMPLETED';
      case AccountStatus.NO_ACTIVE: return 'NO ACTIVE';
      case AccountStatus.ACCOUNT_NOT_FOUND: return 'ACCOUNT NOT FOUND';
      default: return status;
    }
  };

  return (
    <span className={`badge border text-[8px] md:text-[9px] ${styles[status]}`}>
      {getLabel(status)}
    </span>
  );
};

export default AccountQueue;
