import React, { useState, useEffect, useMemo } from 'react';

const API_URL = '/api';

interface ArchivedAccount {
  id: string;
  email: string;
  password: string;
  collection?: string;
  createdAt?: string;
  verifiedBy?: string;
  archivedAt: string;
  archivedBy?: string;
}

const toast = (msg: string, type: 'ok' | 'err' | 'info' = 'info') => {
  const c = document.getElementById('toast-container'); if (!c) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
  el.innerHTML = `<span style="font-weight:700">${type === 'ok' ? '✓' : type === 'err' ? '✕' : 'ℹ'}</span><span>${msg}</span>`;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'all 0.3s'; setTimeout(() => el.remove(), 300); }, 3500);
};

const ArchiveAccounts: React.FC = () => {
  const [accounts, setAccounts] = useState<ArchivedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);
  const [revealedPassIds, setRevealedPassIds] = useState<Set<string>>(new Set());

  const fetchArchived = async () => {
    try {
      const res = await fetch(`${API_URL}/accounts/archived`);
      if (!res.ok) return;
      const data = await res.json();
      setAccounts(data);
    } catch (e) {
      console.error('[ArchiveAccounts] fetch error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchArchived();
    const iv = setInterval(fetchArchived, 10000);
    return () => clearInterval(iv);
  }, []);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return accounts;
    const q = searchQuery.toLowerCase();
    return accounts.filter(a => a.email.toLowerCase().includes(q) || (a.collection || '').toLowerCase().includes(q));
  }, [accounts, searchQuery]);

  const totalPages = Math.ceil(filtered.length / itemsPerPage);
  const paginated = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filtered.slice(start, start + itemsPerPage);
  }, [filtered, currentPage, itemsPerPage]);

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  };

  const toggleSelectAll = () => {
    const ids = paginated.map(a => a.id);
    const allSelected = ids.length > 0 && ids.every(id => selectedIds.has(id));
    const next = new Set(selectedIds);
    if (allSelected) ids.forEach(id => next.delete(id));
    else ids.forEach(id => next.add(id));
    setSelectedIds(next);
  };

  const toggleReveal = (id: string) => {
    const next = new Set(revealedPassIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setRevealedPassIds(next);
  };

  const handleRestoreSelected = async () => {
    if (selectedIds.size === 0) return;
    const emails = accounts.filter(a => selectedIds.has(a.id)).map(a => a.email);
    try {
      const res = await fetch(`${API_URL}/accounts/archive/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails })
      });
      const data = await res.json();
      if (data.success) {
        setAccounts(prev => prev.filter(a => !selectedIds.has(a.id)));
        setSelectedIds(new Set());
        toast(`Restored ${data.restored} account(s) to Result Accounts`, 'ok');
      } else {
        toast(data.error || 'Restore failed', 'err');
      }
    } catch {
      toast('Connection error', 'err');
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    const emails = accounts.filter(a => selectedIds.has(a.id)).map(a => a.email);
    try {
      const res = await fetch(`${API_URL}/accounts/archive`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails })
      });
      const data = await res.json();
      if (data.success) {
        setAccounts(prev => prev.filter(a => !selectedIds.has(a.id)));
        setSelectedIds(new Set());
        toast(`Deleted ${emails.length} archived account(s)`, 'ok');
      } else {
        toast(data.error || 'Delete failed', 'err');
      }
    } catch {
      toast('Connection error', 'err');
    }
  };

  const handleDownload = () => {
    const selected = filtered.filter(a => selectedIds.has(a.id));
    if (!selected.length) return;
    const content = selected.map(a => `${a.email}:${a.password}`).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `archived_accounts_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDeleteOne = async (id: string, email: string) => {
    try {
      const res = await fetch(`${API_URL}/accounts/archive`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: [email] })
      });
      const data = await res.json();
      if (data.success) {
        setAccounts(prev => prev.filter(a => a.id !== id));
        toast(`Removed ${email}`, 'ok');
      }
    } catch {
      toast('Connection error', 'err');
    }
  };

  return (
    <div className="workspace-page space-y-8 animate-in fade-in duration-700 relative pb-24">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div className="shrink-0">
          <h2 className="text-2xl sm:text-3xl font-black tracking-tightest uppercase flex items-center gap-3">
            <span style={{ color: '#64748b' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>
              </svg>
            </span>
            Archive Accounts
          </h2>
          <p className="text-[var(--text-muted)] mt-2 text-sm font-medium">
            {accounts.length} expired account{accounts.length !== 1 ? 's' : ''} archived.
          </p>
        </div>

        <div className="flex flex-row items-center gap-3">
          {/* Search */}
          <div className="glass-card px-4 py-2.5 flex items-center gap-2 min-w-[220px]">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-[var(--text-muted)] shrink-0"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input
              type="text"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              placeholder="Search email..."
              className="bg-transparent text-sm text-[var(--text-main)] outline-none w-full placeholder:text-[var(--text-muted)] placeholder:opacity-50 font-medium"
            />
          </div>

          {/* Rows per page */}
          <div className="glass-card px-4 py-2.5 flex items-center gap-3">
            <span className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Rows</span>
            <select
              value={itemsPerPage}
              onChange={e => setItemsPerPage(Number(e.target.value))}
              className="bg-transparent text-sm text-[var(--text-main)] outline-none cursor-pointer font-bold appearance-none"
            >
              <option className="bg-[#0f172a] text-[#f8fafc]" value={25}>25</option>
              <option className="bg-[#0f172a] text-[#f8fafc]" value={50}>50</option>
              <option className="bg-[#0f172a] text-[#f8fafc]" value={100}>100</option>
              <option className="bg-[#0f172a] text-[#f8fafc]" value={999999}>All</option>
            </select>
          </div>
        </div>
      </div>

      {/* Floating action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-8 left-1/2 lg:left-[calc(50%+160px)] -translate-x-1/2 z-50 animate-in slide-in-from-bottom-10 w-max max-w-[95vw]">
          <div className="bg-[#0f172a] rounded-2xl px-6 py-4 shadow-[0_8px_32px_rgba(0,0,0,0.5)] flex flex-wrap items-center justify-center gap-4 border border-white/10 backdrop-blur-xl">
            <span className="text-sm font-black text-white whitespace-nowrap">{selectedIds.size} SELECTED</span>
            <div className="h-6 w-[1px] bg-white/20" />
            <button
              onClick={handleRestoreSelected}
              className="bg-emerald-500 text-white font-bold px-5 py-2 rounded-lg text-sm hover:bg-emerald-400 transition-all shadow-lg active:scale-95 flex items-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>
              Restore to Results
            </button>
            <button
              onClick={handleDownload}
              className="p-2 text-white hover:bg-white/10 rounded-lg transition-colors"
              title="Download Selected"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
            </button>
            <button
              onClick={handleDeleteSelected}
              className="p-2 text-rose-300 hover:bg-rose-500/20 rounded-lg transition-colors"
              title="Delete Selected"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
            <button onClick={() => setSelectedIds(new Set())} className="p-2 text-white/60 hover:text-white transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="glass-card overflow-hidden shadow-2xl flex flex-col">
        {loading ? (
          <div className="px-6 py-24 text-center text-[var(--text-muted)] italic font-medium opacity-50">
            <div className="flex flex-col items-center gap-3">
              <span className="text-4xl">📦</span>
              <span>Loading archived accounts...</span>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse table-auto min-w-[900px]">
              <thead>
                <tr className="bg-theme-surface border-b border-theme-glass">
                  <th className="px-4 py-5 w-12 text-center">
                    <input
                      type="checkbox"
                      checked={paginated.length > 0 && paginated.every(a => selectedIds.has(a.id))}
                      onChange={toggleSelectAll}
                      className="w-4 h-4 rounded border-theme-glass bg-theme-surface text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    />
                  </th>
                  <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Email</th>
                  <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Password</th>
                  <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Collection</th>
                  <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Created</th>
                  <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Archived</th>
                  <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Archived By</th>
                  <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-theme-glass">
                {paginated.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-24 text-center text-[var(--text-muted)] italic font-medium opacity-50">
                      <div className="flex flex-col items-center gap-3">
                        <span className="text-4xl">📦</span>
                        <span>No archived accounts found.</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  paginated.map(acc => (
                    <tr key={acc.id} className={`hover:bg-slate-500/5 transition-all group ${selectedIds.has(acc.id) ? 'bg-slate-500/10' : ''}`}>
                      <td className="px-5 py-4 text-center">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(acc.id)}
                          onChange={() => toggleSelect(acc.id)}
                          className="w-4 h-4 rounded border-theme-glass bg-theme-surface text-indigo-600 cursor-pointer"
                        />
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-2 h-2 rounded-full bg-slate-500"></div>
                          <span className="font-bold text-[var(--text-main)]">{acc.email}</span>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div
                          className="font-mono text-sm text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-main)] transition-colors flex items-center gap-2"
                          onClick={() => { navigator.clipboard.writeText(acc.password); toggleReveal(acc.id); }}
                          title="Click to copy & reveal"
                        >
                          <span className="opacity-50 tracking-tighter uppercase text-xs">Key:</span>
                          <span className={revealedPassIds.has(acc.id) ? 'text-indigo-500 font-bold' : ''}>
                            {revealedPassIds.has(acc.id) ? acc.password : '••••••••••••'}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        {acc.collection ? (
                          <span className="inline-flex items-center px-3 py-1.5 rounded-md bg-slate-500/10 text-slate-400 border border-slate-500/20 text-xs font-bold uppercase tracking-wide whitespace-nowrap">
                            {acc.collection}
                          </span>
                        ) : (
                          <span className="text-xs text-[var(--text-muted)] italic opacity-30">Unsorted</span>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        {acc.createdAt ? (
                          <span className="text-sm text-[var(--text-muted)] font-medium">
                            {new Date(acc.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        ) : (
                          <span className="text-xs text-[var(--text-muted)] italic opacity-30">Unknown</span>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-sm text-slate-500 font-medium">
                          {new Date(acc.archivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        {acc.archivedBy && acc.archivedBy !== 'unknown' ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-500/15 text-indigo-400 border border-indigo-500/30 text-xs font-bold">
                            <span>👤</span>
                            {acc.archivedBy}
                          </span>
                        ) : (
                          <span className="text-xs text-[var(--text-muted)] italic opacity-40">—</span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-right">
                        <div className="flex items-center justify-end gap-2 md:opacity-50 group-hover:opacity-100 transition-opacity">
                          {/* Restore */}
                          <button
                            onClick={async () => {
                              try {
                                const res = await fetch(`${API_URL}/accounts/archive/restore`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ emails: [acc.email] })
                                });
                                const data = await res.json();
                                if (data.success) {
                                  setAccounts(prev => prev.filter(a => a.id !== acc.id));
                                  toast(`Restored ${acc.email}`, 'ok');
                                }
                              } catch { toast('Error restoring', 'err'); }
                            }}
                            title="Restore to Result Accounts"
                            className="p-2.5 text-emerald-500 hover:bg-emerald-500/10 rounded-xl transition-colors shrink-0"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>
                          </button>
                          {/* Delete */}
                          <button
                            onClick={() => handleDeleteOne(acc.id, acc.email)}
                            title="Delete permanently"
                            className="p-2.5 text-rose-500 hover:bg-rose-500/10 rounded-xl transition-colors shrink-0"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
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
    </div>
  );
};

export default ArchiveAccounts;
