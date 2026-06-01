import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ViewType, Account, AccountStatus, AppSettings } from './types';
import Dashboard from './components/Dashboard';
import AccountQueue from './components/AccountQueue';
import LiveOperations from './components/LiveOperations';
import Settings from './components/Settings';
import ValidAccounts from './components/ValidAccounts';
import PhoneVerifyAccounts from './components/PhoneVerifyAccounts';
import ManageAccounts from './components/ManageAccounts';
import UploadJSON from './components/UploadJSON';
import Login from './components/Login';
import AppPasswords from './components/AppPasswords';
import AppUsers from './components/AppUsers';
import OnlineUsers from './components/OnlineUsers';
import ArchiveAccounts from './components/ArchiveAccounts';
import CreateUsers from './components/CreateUsers';
import Domains from './components/Domains';
import ManualOTP from './components/ManualOTP';

const API_URL = '/api';

// ── Toast system ──────────────────────────────────────────────────────────────
function showToast(msg: string, type: 'ok' | 'err' | 'info' = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
  const icon = type === 'ok' ? '✓' : type === 'err' ? '✕' : 'ℹ';
  el.innerHTML = `<span style="font-weight:700;font-size:14px">${icon}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; el.style.transition = 'all 0.3s'; setTimeout(() => el.remove(), 300); }, 3500);
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────
const Ico = {
  shield:   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  grid:     <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>,
  list:     <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
  activity: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  check:    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
  phone:    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.15 11.6 19.79 19.79 0 0 1 1.07 3c-.06-.56.39-1 .95-1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L6.91 9.91a16 16 0 0 0 6.08 6.08l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 17z"/></svg>,
  users:    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  key:      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
  upload:   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>,
  database: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
  settings: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  logout:   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>,
  bell:     <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  chevronL: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>,
  chevronR: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>,
  online:   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/></svg>,
  manage:   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 9h6M9 12h6M9 15h4"/></svg>,
  archive:  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>,
  sun:      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>,
  moon:     <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
};

// ── NavItem ───────────────────────────────────────────────────────────────────
const NavItem: React.FC<{
  active: boolean; onClick: () => void; icon: React.ReactNode;
  label: string; badge?: number; mini?: boolean;
}> = ({ active, onClick, icon, label, badge, mini }) => (
  <button
    onClick={onClick}
    title={mini ? label : ''}
    className={`nav-item ${active ? 'active' : ''}`}
    style={{ justifyContent: mini ? 'center' : undefined }}
  >
    <span style={{ flexShrink: 0, opacity: active ? 1 : 0.7 }}>{icon}</span>
    {!mini && <><span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
      {badge !== undefined && badge > 0 && <span className="nav-badge">{badge}</span>}
    </>}
    {mini && badge !== undefined && badge > 0 && (
      <span style={{ position: 'absolute', top: 6, right: 6, width: 6, height: 6, background: 'var(--blue)', borderRadius: '50%' }} />
    )}
  </button>
);

const VIEW_PATHS: Record<string, string> = {
  DASHBOARD: '/', QUEUE: '/list-accounts', OPERATIONS: '/live-monitor',
  VALID_ACCOUNTS: '/result-accounts', PHONE_VERIFY: '/verifyphone',
  MANAGE_ACCOUNTS: '/account-manager', APP_PASSWORDS: '/app-passwords',
  UPLOAD_JSON: '/upload-json', SETTINGS: '/settings',
  APP_USERS: '/app-users', ONLINE_USERS: '/online-sessions',
  ARCHIVE_ACCOUNTS: '/archive-accounts',
  CREATE_USERS: '/create-users',
  DOMAINS: '/domains',
  MANUAL_OTP: '/manual-otp'
};

// ── App ───────────────────────────────────────────────────────────────────────
const App: React.FC = () => {
  const [activeView, setActiveView] = useState<ViewType>(() => {
    const path = window.location.pathname;
    const view = Object.keys(VIEW_PATHS).find(k => VIEW_PATHS[k] === path);
    return (view as ViewType) || 'DASHBOARD';
  });

  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname;
      const view = Object.keys(VIEW_PATHS).find(k => VIEW_PATHS[k] === path);
      if (view) setActiveView(view as ViewType);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const [accounts, setAccounts]               = useState<Account[]>([]);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentUser, setCurrentUser]         = useState<any>(null);
  const [mini, setMini]                       = useState(false);
  const [settings, setSettings]               = useState<AppSettings>({
    proxiesEnabled: true, headlessMode: true,
    cloudflareEmail: '', cloudflareKey: '', cloudflareZoneId: '',
    telegramToken: '', telegramChatId: '',
    proxiesList: '', heroSmsKey: '', heroSmsUrl: ''
  });
  const [dashboardStats, setDashboardStats] = useState({ active: 0, completed: 0, failed: 0, waiting: 0, workers: 0 });
  const [notifications, setNotifications]   = useState<any[]>([]);
  const [showNotif, setShowNotif]           = useState(false);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Poll stats + jobs every 5s ──────────────────────────────────────────────
  useEffect(() => {
    const poll = async () => {
      try {
        const session = localStorage.getItem('nexus_session');
        const me = session ? JSON.parse(session) : null;
        const [sRes, wRes, jRes] = await Promise.all([
          fetch(`${API_URL}/stats?user=global`),
          fetch(`${API_URL}/worker/status`),
          fetch(`${API_URL}/jobs`),
        ]);
        if (sRes.ok && wRes.ok) {
          const s = await sRes.json(); const w = await wRes.json();
          setDashboardStats({ active: s.processing||0, completed: s.completed||0, failed: s.failed||0, waiting: s.waiting||0, workers: w.count||0, workspace: s.workspace||undefined } as any);
        }
        if (jRes.ok) {
          const jobs = await jRes.json();
          let mapped: Account[] = jobs.map((j: any) => {
            let status = AccountStatus.PENDING;
            if (j.status === 'active' || j.status === 'waiting') status = AccountStatus.VERIFYING;
            if (j.status === 'completed') status = AccountStatus.COMPLETED;
            if (j.status === 'failed') status = AccountStatus.FAILED;
            if (j.status === 'ACCOUNT_NOT_FOUND') status = AccountStatus.ACCOUNT_NOT_FOUND;
            if (j.status === 'NO_ACTIVE') status = AccountStatus.NO_ACTIVE;
            return { id: j.id, email: j.data.userEmail, password: j.data.userPassword||'••••••••', status, collection: j.collection, createdAt: j.createdAt, verifiedBy: j.verifiedBy };
          });
          setAccounts(mapped);
        }
      } catch {}
    };
    const iv = setInterval(poll, 5000);
    poll();
    return () => clearInterval(iv);
  }, []);

  // ── Session ping ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!currentUser) { if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; } return; }
    const ping = () => fetch('/api/sessions/ping', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser.username, role: currentUser.role }) }).catch(()=>{});
    ping();
    pingRef.current = setInterval(ping, 30000);
    return () => { if (pingRef.current) clearInterval(pingRef.current); };
  }, [currentUser]);

  // ── Notifications (admin) ───────────────────────────────────────────────────
  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin') return;
    const fn = async () => { try { const r = await fetch('/api/notifications'); if (r.ok) setNotifications(await r.json()); } catch {} };
    fn(); const t = setInterval(fn, 10000); return () => clearInterval(t);
  }, [currentUser]);

  // ── Init ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    // Load settings
    fetch(`${API_URL}/settings`).then(r => r.ok ? r.json() : null).then(d => { if (d) setSettings(p => ({ ...p, ...d })); }).catch(() => {
      const s = localStorage.getItem('nexus_settings'); if (s) setSettings(JSON.parse(s));
    });
    // Load sidebar pref
    if (localStorage.getItem('nexus_mini') === 'true') setMini(true);
    // Restore session and immediately refresh permissions from server
    const s = localStorage.getItem('nexus_session');
    if (s) {
      try {
        const u = JSON.parse(s);
        setIsAuthenticated(true);
        setCurrentUser(u);
        fetch(`${API_URL}/auth/me?username=${encodeURIComponent(u.username)}`)
          .then(r => r.ok ? r.json() : null)
          .then(fresh => {
            if (fresh) {
              const updated = { ...u, permissions: fresh.permissions, role: fresh.role };
              setCurrentUser(updated);
              localStorage.setItem('nexus_session', JSON.stringify(updated));
            }
          })
          .catch(() => {});
      } catch { localStorage.removeItem('nexus_session'); }
    }
  }, []);

  useEffect(() => { localStorage.setItem('nexus_settings', JSON.stringify(settings)); }, [settings]);
  useEffect(() => { localStorage.setItem('nexus_mini', String(mini)); }, [mini]);

  const handleLogin = (user: any) => {
    setIsAuthenticated(true); setCurrentUser(user);
    localStorage.setItem('nexus_session', JSON.stringify(user));
    showToast(`Welcome back, ${user.username}`, 'ok');
  };

  const handleLogout = () => {
    if (currentUser) fetch('/api/sessions/logout', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser.username, role: currentUser.role }) }).catch(()=>{});
    setIsAuthenticated(false); setCurrentUser(null);
    localStorage.removeItem('nexus_session');
  };

  const hasPermission = (p: string) => {
    if (!currentUser) return false;
    if (currentUser.role === 'admin') return true;
    return currentUser.permissions?.includes(p);
  };

  const updateSettings = async (update: Partial<AppSettings> | ((p: AppSettings) => AppSettings)) => {
    setSettings(prev => {
      const next = typeof update === 'function' ? update(prev) : { ...prev, ...update };
      localStorage.setItem('nexus_settings', JSON.stringify(next));
      fetch(`${API_URL}/settings`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(typeof update === 'function' ? update(prev) : update) }).catch(()=>{});
      return next;
    });
  };

  const addAccountsFromDomains = async (rawList: string, concurrency?: number) => {
    const lines = rawList.split('\n').filter(l => l.trim());
    const isDomain = lines.length > 0 && !lines[0].includes(':') && !lines[0].includes('@');
    if (isDomain) {
      try {
        const r = await fetch(`${API_URL}/create-workspace`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ domains: lines, options: settings, concurrency: concurrency||1, username: currentUser?.username }) });
        const d = await r.json();
        if (d.success) { showToast(`Started ${lines.length} domain jobs`, 'ok'); setAccounts(p => [...p, ...lines.map(dom => ({ id: Math.random().toString(36).substr(2,9), email: `admin@${dom.trim()}`, password: '...', status: AccountStatus.PENDING, collection: 'Workspace Job' }))]); }
        else showToast(d.error || 'Failed to start', 'err');
      } catch { showToast('Connection error', 'err'); }
      return;
    }
    const newAcc: Account[] = lines.map(l => { const p = l.split(':'); return { id: Math.random().toString(36).substr(2,9), email: p[0]?.includes('@') ? p[0].trim() : `admin@${p[0].trim()}`, password: p[1]?.trim()||'pending', status: AccountStatus.PENDING }; });
    setAccounts(p => [...p, ...newAcc]);
    try {
      const r = await fetch(`${API_URL}/prepare-file`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ accounts: lines, options: settings, verifiedBy: currentUser?.username||'admin' }) });
      const d = await r.json();
      if (d.success) showToast(`Queued ${d.queued} jobs`, 'ok');
      else showToast(d.error || 'Failed', 'err');
    } catch { showToast('Connection error', 'err'); }
  };

  const updateAccountStatus = (id: string, s: AccountStatus) => setAccounts(p => p.map(a => a.id===id ? {...a, status:s} : a));

  const handleVerify = async (id: string) => {
    const acc = accounts.find(a => a.id===id); if (!acc) return;
    updateAccountStatus(id, AccountStatus.VERIFYING);
    try {
      const cleanPrefix = acc.email.split('@')[0].replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 10);
      const uniqueProjectId = `ret-${cleanPrefix}-${Date.now().toString().slice(-6)}-${Math.random().toString(36).substring(2, 5)}`.substring(0, 30).replace(/-+$/, '');
      const r = await fetch(`${API_URL}/jobs`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ projectId: uniqueProjectId, userEmail:acc.email, userPassword:acc.password, saName:'automation-sa', headless:settings.headlessMode, verifiedBy:currentUser?.username||'admin' }) });
      const d = await r.json();
      if (!d.success) { updateAccountStatus(id, AccountStatus.FAILED); showToast('Retry failed: '+d.error, 'err'); }
    } catch { updateAccountStatus(id, AccountStatus.FAILED); showToast('Connection error', 'err'); }
  };

  const handleBulkVerify = async (ids: string[]) => {
    const c = Math.max(1, Math.min(10, parseInt((settings as any).concurrency||'1')));
    for (let i=0; i<ids.length; i+=c) await Promise.all(ids.slice(i,i+c).map(id => handleVerify(id)));
  };

  const handlePhoneVerify = async (acc: Account) => {
    try {
      const r = await fetch(`${API_URL}/accounts/verify-phone`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email:acc.email, password:acc.password }) });
      const d = await r.json();
      if (d.success) { navigate('PHONE_VERIFY'); showToast('Added to phone verify queue', 'ok'); }
      else showToast(d.error||'Failed', 'err');
    } catch { showToast('Connection error', 'err'); }
  };

  const handleCheckLogin = async (id: string) => {
    const acc = accounts.find(a => a.id===id); if (!acc) return;
    updateAccountStatus(id, AccountStatus.VERIFYING);
    try {
      const r = await fetch(`${API_URL}/accounts/check-login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email:acc.email }) });
      const d = await r.json();
      if (d.exists) { updateAccountStatus(id, AccountStatus.COMPLETED); showToast(`✓ ${acc.email} exists`, 'ok'); }
      else { updateAccountStatus(id, AccountStatus.FAILED); showToast(`✕ ${acc.email} not found`, 'err'); }
    } catch { updateAccountStatus(id, AccountStatus.FAILED); showToast('Connection error', 'err'); }
  };

  const handleStopCreation = async () => {
    try {
      const r = await fetch(`${API_URL}/stop-creation`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser?.username }) });
      const d = await r.json();
      if (d.success) showToast('Stop command sent', 'ok');
      else showToast(d.message||'No active process', 'err');
    } catch { showToast('Connection error', 'err'); }
  };

  const removeAccount = async (id: string) => {
    const acc = accounts.find(a => a.id===id); if (!acc) return;
    setAccounts(p => p.filter(a => a.id!==id));
    try { await fetch(`${API_URL}/accounts`, { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ emails:[acc.email] }) }); } catch {}
  };

  const handleBatchRemove = async (ids: string[]) => {
    const emails = accounts.filter(a => ids.includes(a.id)).map(a => a.email);
    if (!emails.length) return;
    setAccounts(p => p.filter(a => !ids.includes(a.id)));
    try { await fetch(`${API_URL}/accounts`, { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ emails }) }); } catch {}
  };

  const updateAccountCollection = async (ids: string[], collection: string) => {
    const emails = accounts.filter(a => ids.includes(a.id)).map(a => a.email);
    if (!emails.length) return;
    setAccounts(p => p.map(a => ids.includes(a.id) ? {...a, collection} : a));
    try { await fetch(`${API_URL}/accounts/collection`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ emails, collection }) }); } catch {}
  };

  const editAccount = (id: string, email: string, pass: string) => setAccounts(p => p.map(a => a.id===id ? {...a, email, password:pass} : a));

  const handleMoveToQueue = async (ids: string[]) => {
    const emails = accounts.filter(a => ids.includes(a.id)).map(a => a.email);
    if (!emails.length) return;
    setAccounts(p => p.map(a => ids.includes(a.id) ? {...a, status:AccountStatus.PENDING, collection:undefined} : a));
    try {
      const r = await fetch(`${API_URL}/accounts/move`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ emails }) });
      const d = await r.json();
      if (d.success) showToast(`Moved ${d.moved} accounts to queue`, 'ok');
    } catch { showToast('Connection error', 'err'); }
  };

  const navigate = (view: ViewType) => {
    setActiveView(view);
    window.history.pushState(null, '', VIEW_PATHS[view] || '/');
  };

  if (!isAuthenticated) return <Login onLogin={handleLogin} />;

  const pendingCount   = accounts.filter(a => a.status === AccountStatus.PENDING).length;
  const completedCount = accounts.filter(a => a.status === AccountStatus.COMPLETED).length;
  const unreadNotif    = notifications.filter(n => !n.read).length;

  const viewLabels: Record<string, string> = {
    DASHBOARD: 'Dashboard', QUEUE: 'Account Queue', OPERATIONS: 'Live Monitor',
    VALID_ACCOUNTS: 'Result Accounts', PHONE_VERIFY: 'Phone Verify',
    MANAGE_ACCOUNTS: 'Account Manager', APP_PASSWORDS: 'App Passwords',
    UPLOAD_JSON: 'Upload JSON', SETTINGS: 'Settings',
    APP_USERS: 'App Users', ONLINE_USERS: 'Online Sessions',
    ARCHIVE_ACCOUNTS: 'Archive Accounts', CREATE_USERS: 'Create Users',
    DOMAINS: 'Domains', MANUAL_OTP: 'Manual OTP Keys',
  };

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>

      {/* ── Sidebar ──────────────────────────────────────────────────────────── */}
      <aside className={`sidebar ${mini ? 'mini' : ''}`}>
        {/* Logo */}
        <div style={{ padding: mini ? '20px 0' : '20px 16px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: mini ? 'center' : undefined, borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
          <div style={{ width: 34, height: 34, background: 'var(--blue)', borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0, boxShadow: '0 4px 12px rgba(59,130,246,0.3)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          {!mini && <div>
            <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: '-0.3px' }}>Nexus</div>
            <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 1 }}>Workspace Manager</div>
          </div>}
        </div>

        {/* Toggle mini button */}
        <button
          onClick={() => setMini(!mini)}
          style={{ position: 'absolute', right: -12, top: 28, width: 24, height: 24, background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text2)', zIndex: 10 }}
        >
          {mini ? Ico.chevronR : Ico.chevronL}
        </button>

        {/* Nav */}
        <nav style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '0 8px' }}>
          {!mini && <div className="nav-section">Control Panel</div>}
          {hasPermission('DASHBOARD')  && <NavItem active={activeView==='DASHBOARD'}  onClick={()=>navigate('DASHBOARD')}  icon={Ico.grid}     label="Dashboard"        mini={mini} />}
          {hasPermission('QUEUE')      && <NavItem active={activeView==='QUEUE'}      onClick={()=>navigate('QUEUE')}      icon={Ico.list}     label="List Accounts"    mini={mini} badge={pendingCount} />}
          {hasPermission('OPERATIONS') && <NavItem active={activeView==='OPERATIONS'} onClick={()=>navigate('OPERATIONS')} icon={Ico.activity} label="Live Monitor"     mini={mini} />}

          {!mini && <div className="nav-section" style={{ marginTop: 8 }}>Intelligence</div>}
          {mini && <div style={{ height: 8 }} />}
          {hasPermission('VALID_ACCOUNTS')  && <NavItem active={activeView==='VALID_ACCOUNTS'}  onClick={()=>navigate('VALID_ACCOUNTS')}  icon={Ico.check}    label="Result Accounts"  mini={mini} badge={completedCount} />}
          {hasPermission('VALID_ACCOUNTS')  && <NavItem active={activeView==='ARCHIVE_ACCOUNTS'} onClick={()=>navigate('ARCHIVE_ACCOUNTS')} icon={Ico.archive}  label="Archive Accounts" mini={mini} />}
          {hasPermission('PHONE_VERIFY')    && <NavItem active={activeView==='PHONE_VERIFY'}    onClick={()=>navigate('PHONE_VERIFY')}    icon={Ico.phone}    label="Verify Phone"     mini={mini} />}
          {hasPermission('MANAGE_ACCOUNTS') && <NavItem active={activeView==='MANAGE_ACCOUNTS'} onClick={()=>navigate('MANAGE_ACCOUNTS')} icon={Ico.manage}   label="Account Manager"  mini={mini} />}
          {hasPermission('APP_PASSWORDS')   && <NavItem active={activeView==='APP_PASSWORDS'}   onClick={()=>navigate('APP_PASSWORDS')}   icon={Ico.key}      label="App Passwords"    mini={mini} />}
          {hasPermission('UPLOAD_JSON')     && <NavItem active={activeView==='UPLOAD_JSON'}     onClick={()=>navigate('UPLOAD_JSON')}     icon={Ico.upload}   label="Upload JSON"      mini={mini} />}
          {hasPermission('CREATE_USERS')     && <NavItem active={activeView==='CREATE_USERS'}    onClick={()=>navigate('CREATE_USERS')}    icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>} label="Create Users" mini={mini} />}
          {hasPermission('DOMAINS')          && <NavItem active={activeView==='DOMAINS'}          onClick={()=>navigate('DOMAINS')}          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>} label="Domains" mini={mini} />}

          {(hasPermission('APP_USERS') || hasPermission('MANUAL_OTP')) && <>
            {!mini && <div className="nav-section" style={{ marginTop: 8 }}>Administration</div>}
            {mini && <div style={{ height: 8 }} />}
            {hasPermission('APP_USERS') && <NavItem active={activeView==='APP_USERS'}    onClick={()=>navigate('APP_USERS')}    icon={Ico.users}  label="App Users"        mini={mini} />}
            {hasPermission('APP_USERS') && <NavItem active={activeView==='ONLINE_USERS'} onClick={()=>navigate('ONLINE_USERS')} icon={Ico.online} label="Online Sessions"  mini={mini} badge={unreadNotif||undefined} />}
            {hasPermission('MANUAL_OTP') && <NavItem active={activeView==='MANUAL_OTP'}   onClick={()=>navigate('MANUAL_OTP')}   icon={Ico.key}    label="Manual OTP Keys"  mini={mini} />}
          </>}
        </nav>

        {/* Footer */}
        <div style={{ padding: '8px', borderTop: '1px solid var(--border)' }}>
          {/* User info */}
          {!mini && currentUser && (
            <div style={{ padding: '10px 12px', background: 'var(--bg3)', borderRadius: 8, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, color: '#fff', flexShrink: 0 }}>
                {currentUser.username.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentUser.username}</div>
                <div style={{ fontSize: 11, color: 'var(--text2)', textTransform: 'capitalize' }}>{currentUser.role}</div>
              </div>
              {currentUser.role === 'admin' && (
                <button
                  onClick={() => { setShowNotif(!showNotif); fetch('/api/notifications/read',{method:'POST'}); setNotifications(p=>p.map(n=>({...n,read:true}))); }}
                  style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', padding: 4, display: 'flex', alignItems: 'center' }}
                >
                  {Ico.bell}
                  {unreadNotif > 0 && <span style={{ position:'absolute', top:2, right:2, width:7, height:7, background:'var(--blue)', borderRadius:'50%' }} />}
                </button>
              )}
            </div>
          )}

          {/* Notification panel */}
          {showNotif && !mini && currentUser?.role === 'admin' && (
            <div className="glass" style={{ padding: 10, marginBottom: 6, maxHeight: 180, overflowY: 'auto' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)' }}>NOTIFICATIONS</span>
                <button onClick={()=>{ fetch('/api/notifications',{method:'DELETE'}); setNotifications([]); }} style={{ fontSize:11, color:'var(--red)', background:'none', border:'none', cursor:'pointer' }}>Clear</button>
              </div>
              {notifications.length === 0
                ? <div style={{ fontSize:12, color:'var(--text2)', textAlign:'center', padding:'8px 0' }}>No notifications</div>
                : notifications.slice(0,20).map(n=>(
                  <div key={n.id} style={{ fontSize:12, padding:'6px 8px', borderRadius:6, marginBottom:3, background: n.read?'transparent':'rgba(59,130,246,0.08)', color: n.read?'var(--text2)':'var(--text)' }}>
                    <div>{n.message}</div>
                    <div style={{ fontSize:10, color:'var(--text2)', marginTop:2 }}>{new Date(n.time).toLocaleTimeString()}</div>
                  </div>
                ))
              }
            </div>
          )}

          {hasPermission('SETTINGS') && <NavItem active={activeView==='SETTINGS'} onClick={()=>navigate('SETTINGS')} icon={Ico.settings} label="Settings" mini={mini} />}
          <NavItem active={false} onClick={handleLogout} icon={Ico.logout} label="Sign Out" mini={mini} />
        </div>
      </aside>

      {/* ── Main ─────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Topbar */}
        <header style={{ height: 54, background: 'var(--bg2)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', padding: '0 24px', gap: 12, flexShrink: 0 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{viewLabels[activeView]}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} className="pulse" />
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>
              {currentUser?.username} · {currentUser?.role}
            </span>
          </div>
        </header>

        {/* Content */}
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
          {activeView==='DASHBOARD'       && hasPermission('DASHBOARD')       && <Dashboard onAdd={addAccountsFromDomains} onStop={handleStopCreation} settings={settings} setSettings={updateSettings as any} stats={dashboardStats} username={currentUser?.username} />}
          {activeView==='QUEUE'           && hasPermission('QUEUE')           && <AccountQueue accounts={accounts} onVerify={handleVerify} onCheckLogin={handleCheckLogin} onBulkVerify={handleBulkVerify} onPhoneVerify={handlePhoneVerify} onRemove={removeAccount} settings={settings} setSettings={setSettings} />}
          {activeView==='OPERATIONS'      && hasPermission('OPERATIONS')      && <LiveOperations accounts={accounts} onVerify={handleVerify} />}
          {activeView==='VALID_ACCOUNTS'  && hasPermission('VALID_ACCOUNTS')  && <ValidAccounts accounts={accounts} onRemove={removeAccount} onBatchRemove={handleBatchRemove} onUpdateCollection={updateAccountCollection} onEditAccount={editAccount} onMoveToQueue={handleMoveToQueue} onNavigate={navigate} />}
          {activeView==='PHONE_VERIFY'    && hasPermission('PHONE_VERIFY')    && <PhoneVerifyAccounts />}
          {activeView==='MANAGE_ACCOUNTS' && hasPermission('MANAGE_ACCOUNTS') && <ManageAccounts />}
          {activeView==='APP_PASSWORDS'   && hasPermission('APP_PASSWORDS')   && <AppPasswords />}
          {activeView==='UPLOAD_JSON'     && hasPermission('UPLOAD_JSON')     && <UploadJSON />}
          {activeView==='SETTINGS'        && hasPermission('SETTINGS')        && <Settings settings={settings} setSettings={updateSettings as any} />}
          {activeView==='APP_USERS'       && hasPermission('APP_USERS')       && <AppUsers />}
          {activeView==='ONLINE_USERS'    && hasPermission('APP_USERS')       && <OnlineUsers />}
          {activeView==='ARCHIVE_ACCOUNTS' && hasPermission('VALID_ACCOUNTS')  && <ArchiveAccounts />}
          {activeView==='CREATE_USERS'    && hasPermission('CREATE_USERS')    && <CreateUsers />}
          {activeView==='DOMAINS'         && hasPermission('DOMAINS')         && <Domains />}
          {activeView==='MANUAL_OTP'      && hasPermission('MANUAL_OTP')      && <ManualOTP />}
        </main>
      </div>
    </div>
  );
};

export default App;
