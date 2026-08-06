import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Account, AccountStatus } from '../types';

interface LogEntry {
  ts: string;
  level: 'INFO' | 'ERROR' | 'WARN';
  msg: string;
}

interface LiveOperationsProps {
  accounts: Account[];
  onVerify: (id: string) => void;
}

const LiveOperations: React.FC<LiveOperationsProps> = ({ accounts, onVerify }) => {
  const [showFailedOnly, setShowFailedOnly] = useState(false);
  const [otps, setOtps] = useState<Record<string, string>>({});
  const [logsPanel, setLogsPanel] = useState<{ email: string; accountId: string } | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const toast = (msg: string, type: 'ok'|'err'|'info' = 'info') => {
    const c = document.getElementById('toast-container'); if (!c) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
    el.innerHTML = `<span style="font-weight:700">${type==='ok'?'✓':type==='err'?'✕':'ℹ'}</span><span>${msg}</span>`;
    c.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; el.style.transition='all 0.3s'; setTimeout(()=>el.remove(),300); }, 3500);
  };

  const fetchLogs = async (email: string) => {
    setLogsLoading(true);
    try {
      const res = await fetch(`/api/logs?email=${encodeURIComponent(email)}`);
      const data = await res.json();
      setLogs(Array.isArray(data) ? data : []);
    } catch { /* silent */ } finally {
      setLogsLoading(false);
    }
  };

  const openLogs = (acc: Account) => {
    setLogsPanel({ email: acc.email, accountId: acc.id });
    setLogs([]);
    fetchLogs(acc.email);
  };

  const closeLogs = () => {
    setLogsPanel(null);
    setLogs([]);
    if (logsPollRef.current) clearInterval(logsPollRef.current);
  };

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Poll logs every 2s while panel is open and account is active
  useEffect(() => {
    if (!logsPanel) { if (logsPollRef.current) clearInterval(logsPollRef.current); return; }
    if (logsPollRef.current) clearInterval(logsPollRef.current);
    const acc = accounts.find(a => a.id === logsPanel.accountId);
    if (acc?.status === AccountStatus.VERIFYING) {
      logsPollRef.current = setInterval(() => fetchLogs(logsPanel.email), 2000);
    }
    return () => { if (logsPollRef.current) clearInterval(logsPollRef.current); };
  }, [logsPanel, accounts]);

  const filteredAccounts = useMemo(() => {
    const list = accounts.filter(a => a.status !== AccountStatus.PENDING);
    return showFailedOnly ? list.filter(a => a.status === AccountStatus.FAILED) : list;
  }, [accounts, showFailedOnly]);

  const stats = useMemo(() => ({
    total:     accounts.length,
    completed: accounts.filter(a => a.status === AccountStatus.COMPLETED).length,
    failed:    accounts.filter(a => a.status === AccountStatus.FAILED).length,
    noActive:  accounts.filter(a => a.status === AccountStatus.NO_ACTIVE).length,
    running:   accounts.filter(a => a.status === AccountStatus.VERIFYING).length,
  }), [accounts]);

  const handleRerunFailed = () => {
    const failed = accounts.filter(a => a.status === AccountStatus.FAILED);
    failed.forEach(acc => onVerify(acc.id));
    toast(`Retrying ${failed.length} failed accounts`, 'info');
  };

  const getOTP = async (id: string) => {
    const account = accounts.find(a => a.id === id); if (!account) return;
    setOtps(prev => ({ ...prev, [id]: '...' }));
    try {
      const res = await fetch('/api/otp', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: account.email }) });
      const data = await res.json();
      if (data.success && data.otp) {
        setOtps(prev => ({ ...prev, [id]: data.otp }));
        setTimeout(() => setOtps(prev => { const n={...prev}; delete n[id]; return n; }), 30000);
      } else {
        setOtps(prev => ({ ...prev, [id]: 'ERR' }));
        setTimeout(() => setOtps(prev => { const n={...prev}; delete n[id]; return n; }), 3000);
      }
    } catch {
      setOtps(prev => ({ ...prev, [id]: 'ERR' }));
      setTimeout(() => setOtps(prev => { const n={...prev}; delete n[id]; return n; }), 3000);
    }
  };

  const statusColor = (s: AccountStatus) => {
    if (s === AccountStatus.COMPLETED) return 'var(--green)';
    if (s === AccountStatus.FAILED)    return 'var(--red)';
    if (s === AccountStatus.NO_ACTIVE) return 'var(--orange)';
    if (s === AccountStatus.VERIFYING) return 'var(--blue)';
    return 'var(--text2)';
  };
  const statusLabel = (s: AccountStatus) => {
    if (s === AccountStatus.VERIFYING) return 'In Progress';
    if (s === AccountStatus.NO_ACTIVE) return 'No Active';
    return s.charAt(0) + s.slice(1).toLowerCase();
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20, flexWrap:'wrap', gap:12 }}>
        <div>
          <div style={{ fontSize:20, fontWeight:700 }}>Live Monitor</div>
          <div style={{ fontSize:13, color:'var(--text2)', marginTop:4 }}>Real-time account processing status</div>
        </div>
        <div style={{ display:'flex', gap:10, alignItems:'center' }}>
          {/* Failure filter toggle */}
          <div className="glass" style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 14px', borderRadius:8 }}>
            <span style={{ fontSize:12, color:'var(--text2)', fontWeight:500 }}>Failed only</span>
            <div className={`toggle ${showFailedOnly ? 'on' : ''}`} onClick={() => setShowFailedOnly(!showFailedOnly)} style={{ cursor:'pointer' }} />
          </div>
          <button
            className="btn btn-primary"
            onClick={handleRerunFailed}
            disabled={stats.failed === 0}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
            Retry All Failed
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:10, marginBottom:20 }}>
        {[
          { label:'Completed', val:stats.completed, color:'var(--green)' },
          { label:'Failed',    val:stats.failed,    color:'var(--red)' },
          { label:'No Active', val:stats.noActive,  color:'var(--orange)' },
          { label:'Running',   val:stats.running,   color:'var(--blue)' },
          { label:'Total',     val:stats.total,     color:'var(--text3)' },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <div className="stat-label">{s.label}</div>
            <div className="stat-val" style={{ color:s.color, fontSize:22 }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="glass" style={{ overflow:'hidden' }}>
        <div style={{ overflowX:'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th style={{ textAlign:'center' }}>Status</th>
                <th>Verified By</th>
                <th>OTP</th>
                <th style={{ textAlign:'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredAccounts.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign:'center', padding:'40px 0', color:'var(--text2)' }}>
                    No active operations
                  </td>
                </tr>
              ) : filteredAccounts.map(acc => (
                <tr key={acc.id}>
                  <td>
                    <div style={{ fontWeight:600, fontSize:13 }}>{acc.email}</div>
                    <div style={{ fontSize:10, color:'var(--text2)', fontFamily:'JetBrains Mono,monospace', marginTop:2 }}>
                      {acc.id.toUpperCase()}
                    </div>
                  </td>
                  <td style={{ textAlign:'center' }}>
                    <span className="badge" style={{
                      background: `${statusColor(acc.status)}18`,
                      color: statusColor(acc.status),
                      animation: acc.status === AccountStatus.VERIFYING ? 'pulse 1.5s infinite' : undefined
                    }}>
                      {statusLabel(acc.status)}
                    </span>
                  </td>
                  <td>
                    {acc.verifiedBy
                      ? <span className="badge badge-purple">{acc.verifiedBy}</span>
                      : <span style={{ color:'var(--text2)', fontSize:12 }}>—</span>
                    }
                  </td>
                  <td>
                    {otps[acc.id] ? (
                      <span
                        className="badge badge-blue mono"
                        style={{ cursor:'pointer', letterSpacing:'0.1em' }}
                        onClick={() => { navigator.clipboard.writeText(otps[acc.id]); toast('OTP copied', 'ok'); }}
                        title="Click to copy"
                      >
                        {otps[acc.id]}
                      </span>
                    ) : (
                      <span style={{ fontSize:11, color:'var(--text2)' }}>—</span>
                    )}
                  </td>
                  <td style={{ textAlign:'right' }}>
                    <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
                      <button className="btn btn-xs" onClick={() => getOTP(acc.id)}>
                        OTP
                      </button>
                      <button
                        className="btn btn-xs"
                        onClick={() => openLogs(acc)}
                        style={{ color: 'var(--cyan)', borderColor: 'rgba(6,182,212,0.3)' }}
                        title="View logs"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                        Logs
                      </button>
                      {acc.status === AccountStatus.FAILED && (
                        <button className="btn btn-xs btn-primary" onClick={() => onVerify(acc.id)}>
                          Retry
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {/* Logs Panel */}
      {logsPanel && (
        <div style={{
          position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', backdropFilter:'blur(4px)',
          zIndex:200, display:'flex', alignItems:'flex-end', justifyContent:'center'
        }} onClick={e => { if (e.target === e.currentTarget) closeLogs(); }}>
          <div style={{
            background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:'14px 14px 0 0',
            width:'100%', maxWidth:760, maxHeight:'75vh', display:'flex', flexDirection:'column',
            padding:0, overflow:'hidden'
          }}>
            {/* Header */}
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 18px', borderBottom:'1px solid var(--border)', background:'var(--bg3)' }}>
              <div>
                <div style={{ fontWeight:700, fontSize:14, color:'var(--cyan)' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{marginRight:6,verticalAlign:'middle'}}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  Process Logs
                </div>
                <div style={{ fontSize:11, color:'var(--text2)', marginTop:2, fontFamily:'JetBrains Mono,monospace' }}>{logsPanel.email}</div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                {(() => {
                  const acc = accounts.find(a => a.id === logsPanel.accountId);
                  return acc?.status === AccountStatus.VERIFYING ? (
                    <span style={{ fontSize:10, color:'var(--blue)', fontWeight:700, display:'flex', alignItems:'center', gap:5 }}>
                      <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--blue)', display:'inline-block', animation:'pulse 1.5s infinite' }} />
                      LIVE
                    </span>
                  ) : null;
                })()}
                <button className="btn btn-xs" onClick={() => fetchLogs(logsPanel.email)} title="Refresh">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                </button>
                <button className="btn btn-xs" onClick={closeLogs}>✕</button>
              </div>
            </div>

            {/* Log body */}
            <div style={{ flex:1, overflowY:'auto', padding:'12px 16px', fontFamily:'JetBrains Mono,monospace', fontSize:11, lineHeight:1.7, background:'var(--bg)' }}>
              {logsLoading && logs.length === 0 ? (
                <div style={{ textAlign:'center', color:'var(--text2)', padding:'40px 0' }}>
                  <svg className="animate-spin" style={{display:'inline-block'}} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  <div style={{ marginTop:8 }}>Loading logs...</div>
                </div>
              ) : logs.length === 0 ? (
                <div style={{ textAlign:'center', color:'var(--text2)', padding:'40px 0' }}>
                  <div style={{ fontSize:24, marginBottom:8 }}>📋</div>
                  No logs yet for this account.<br/>
                  <span style={{ fontSize:10, opacity:0.6 }}>Logs appear as the job processes.</span>
                </div>
              ) : (
                logs.map((log, i) => {
                  const color = log.level === 'ERROR' ? 'var(--red)' : log.level === 'WARN' ? 'var(--orange)' : 'var(--text3)';
                  const prefix = log.level === 'ERROR' ? '✕' : log.level === 'WARN' ? '⚠' : '›';
                  const time = log.ts ? new Date(log.ts).toLocaleTimeString('en-US', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '';
                  return (
                    <div key={i} style={{ display:'flex', gap:10, padding:'2px 0', borderBottom:'1px solid var(--border)', color }}>
                      <span style={{ color:'var(--text2)', flexShrink:0, minWidth:62 }}>{time}</span>
                      <span style={{ flexShrink:0 }}>{prefix}</span>
                      <span style={{ color, wordBreak:'break-word', flex:1 }}>{log.msg}</span>
                    </div>
                  );
                })
              )}
              <div ref={logsEndRef} />
            </div>

            {/* Footer */}
            <div style={{ padding:'8px 16px', borderTop:'1px solid var(--border)', background:'var(--bg3)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <span style={{ fontSize:10, color:'var(--text2)' }}>{logs.length} log entries</span>
              <span style={{ fontSize:10, color:'var(--text2)' }}>Auto-refreshes every 2s while active</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LiveOperations;
