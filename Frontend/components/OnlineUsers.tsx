
import React, { useState, useEffect } from 'react';

interface UserSession {
  id: string;
  username: string;
  role: string;
  online: boolean;
  lastSeen: number | null;
  loginTime: number | null;
}

const API_URL = '/api';

const formatTime = (ts: number | null) => {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const formatDuration = (ts: number | null) => {
  if (!ts) return '—';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
};

const OnlineUsers: React.FC = () => {
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${API_URL}/sessions`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (e) {
      console.error('Sessions fetch error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 10000);
    return () => clearInterval(interval);
  }, []);

  const onlineCount = sessions.filter(s => s.online).length;
  const offlineCount = sessions.filter(s => !s.online).length;

  return (
    <div className="space-y-10 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
        <div>
          <h2 className="text-3xl font-black tracking-tightest uppercase flex items-center gap-3">
            <span className="text-violet-400">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </span>
            User Sessions
          </h2>
          <p className="text-[var(--text-muted)] mt-2 text-sm font-medium">Real-time activity monitoring for all platform users.</p>
        </div>
        <button
          onClick={fetchSessions}
          className="glass-card px-5 py-3 flex items-center gap-2 text-indigo-400 hover:bg-indigo-500/10 transition-colors text-xs font-black uppercase tracking-widest"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
          Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="glass-card p-6 text-center">
          <div className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-2">Online Now</div>
          <div className="text-4xl font-black text-emerald-400">{onlineCount}</div>
          <div className="mt-2 flex justify-center"><span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block"/></div>
        </div>
        <div className="glass-card p-6 text-center">
          <div className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-2">Offline</div>
          <div className="text-4xl font-black text-slate-500">{offlineCount}</div>
        </div>
        <div className="glass-card p-6 text-center">
          <div className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-2">Total Users</div>
          <div className="text-4xl font-black text-violet-400">{sessions.length}</div>
        </div>
      </div>

      {/* Users Table */}
      <div className="glass-card overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-theme-surface border-b border-theme-glass">
                <th className="px-6 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">User</th>
                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Role</th>
                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest text-center">Status</th>
                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Login Time</th>
                <th className="px-4 py-5 text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">Last Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-glass">
              {loading ? (
                <tr><td colSpan={5} className="px-6 py-20 text-center text-[var(--text-muted)] opacity-50">Loading sessions...</td></tr>
              ) : sessions.length === 0 ? (
                <tr><td colSpan={5} className="px-6 py-20 text-center text-[var(--text-muted)] opacity-50">No users found.</td></tr>
              ) : (
                sessions.map(s => (
                  <tr key={s.id} className={`hover:bg-white/3 transition-all ${s.online ? 'bg-emerald-500/3' : ''}`}>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-sm font-black uppercase ${
                          s.online ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'bg-slate-500/10 text-slate-500 border border-slate-500/20'
                        }`}>
                          {s.username.charAt(0)}
                        </div>
                        <div>
                          <div className="font-bold text-[var(--text-main)] text-sm">{s.username}</div>
                          <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-widest opacity-50">ID: {s.id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide border ${
                        s.role === 'admin'
                          ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                          : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                      }`}>
                        {s.role === 'admin' ? '👑 Admin' : '👤 ' + s.role}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-center">
                      <div className="flex flex-col items-center gap-1">
                        <div className={`w-2.5 h-2.5 rounded-full ${s.online ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)] animate-pulse' : 'bg-slate-600'}`}/>
                        <span className={`text-[10px] font-black uppercase tracking-widest ${s.online ? 'text-emerald-400' : 'text-slate-500'}`}>
                          {s.online ? 'Online' : 'Offline'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className="text-xs text-[var(--text-muted)] font-medium">
                        {s.loginTime ? formatTime(s.loginTime) : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <span className={`text-xs font-medium ${s.online ? 'text-emerald-400' : 'text-[var(--text-muted)]'}`}>
                        {s.online ? 'Active now' : formatDuration(s.lastSeen)}
                      </span>
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

export default OnlineUsers;
