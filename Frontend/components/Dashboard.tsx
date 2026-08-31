import React, { useState } from 'react';
import { AppSettings } from '../types';

interface WorkspaceStats {
  batchCurrent: number; batchTotal: number;
  successful: number; failed: number;
  antiSpamBlocked: number; failureRate: number; antiSpamRate: number; activeThreads: number;
}
interface DashboardStats {
  active: number; completed: number; failed: number; waiting: number; workers: number; workspace?: WorkspaceStats;
}
interface DashboardProps {
  onAdd: (list: string, concurrency: number) => void;
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  stats?: DashboardStats;
  onStop?: () => void;
  username?: string;
}

const Dashboard: React.FC<DashboardProps> = ({ onAdd, onStop, settings, setSettings, stats, username }) => {
  const [inputText, setInputText] = useState('');
  const [concurrency, setConcurrency] = useState(5);

  const total = (stats?.active||0) + (stats?.failed||0) + (stats?.completed||0) + (stats?.waiting||0);
  const threads = stats?.workspace?.activeThreads || stats?.workers || 0;
  const isRunning = threads > 0 || (stats?.active||0) > 0;

  const statCards = [
    { label: 'Active',    val: stats?.active||0,    color: '#3b82f6' },
    { label: 'Completed', val: stats?.completed||0, color: '#10b981' },
    { label: 'Failed',    val: stats?.failed||0,    color: '#ef4444' },
    { label: 'Waiting',   val: stats?.waiting||0,   color: '#f59e0b' },
  ];

  return (
    <div className="dashboard-view">
      <div className="page-intro">
        <div>
          <div className="page-kicker">Operations center</div>
          <div className="page-title">Workspace Creation</div>
          <div className="page-description">Add domains or accounts, configure the run, and track every job from one place.</div>
        </div>
        <div className={`system-chip ${isRunning ? 'is-running' : ''}`}>
          <span className="system-chip-dot" />
          {isRunning ? `${threads} threads running` : 'System ready'}
        </div>
      </div>

      {/* Stats row */}
      <div className="stats-grid">
        {statCards.map(s => (
          <div key={s.label} className="stat-card" style={{ '--stat-color': s.color } as React.CSSProperties}>
            <div className="stat-label">{s.label}</div>
            <div className="stat-val" style={{ color: s.color }}>{s.val.toLocaleString()}</div>
            <div className="stat-sub">Jobs</div>
          </div>
        ))}
      </div>

      <div className="workspace-grid">

        {/* Input card */}
        <div className="glass workspace-composer">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Input Stream
            </div>
            <div style={{ fontSize: 11, color: 'var(--text2)' }}>
              Format: <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--text3)' }}>email:pass</span> or <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--text3)' }}>domain.com</span>
            </div>
          </div>

          <textarea
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            className="inp"
            rows={12}
            style={{ resize: 'vertical', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, lineHeight: 1.6, borderRadius: 8 }}
            placeholder={"user@example.com:password123\ndomain.com\nuniversity.edu"}
          />

          <div className="composer-actions">
            <button
              className="btn btn-primary"
              onClick={() => { onAdd(inputText, concurrency); setInputText(''); }}
              disabled={!inputText.trim()}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Start Processing
            </button>

            <button
              className="btn btn-danger"
              onClick={onStop}
              disabled={!isRunning}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
              Stop
            </button>

            <label className="btn" style={{ cursor: 'pointer' }}>
              <input type="file" className="hidden" accept=".txt,.csv" style={{ display: 'none' }}
                onChange={async e => {
                  const file = e.target.files?.[0]; if (!file) return;
                  try {
                    const text = await file.text();
                    const r = await fetch('/api/upload-registry', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ registryData: text, username }) });
                    const d = await r.json();
                    const t = (msg: string, type='info') => { const c=document.getElementById('toast-container');if(!c)return;const el=document.createElement('div');el.className=`toast toast-${type==='ok'?'ok':type==='err'?'err':'info'}`;el.innerHTML=`<span>${msg}</span>`;c.appendChild(el);setTimeout(()=>{el.style.opacity='0';el.style.transition='all 0.3s';setTimeout(()=>el.remove(),300);},3500); };
                    if (d.success) { setInputText(d.content); t('File imported', 'ok'); }
                    else t('Upload failed: ' + d.error, 'err');
                  } catch { const c=document.getElementById('toast-container');if(c){const el=document.createElement('div');el.className='toast toast-err';el.innerHTML='<span>Upload error</span>';c.appendChild(el);setTimeout(()=>{el.style.opacity='0';el.style.transition='all 0.3s';setTimeout(()=>el.remove(),300);},3500);} }
                  e.target.value = '';
                }}
              />
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Import File
            </label>

            <div className="thread-control">
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>Threads:</span>
              <input
                type="number" min={1} max={50} value={concurrency}
                onChange={e => setConcurrency(parseInt(e.target.value)||1)}
                className="inp"
                style={{ width: 60, padding: '6px 10px', fontSize: 13, fontWeight: 600, textAlign: 'center' }}
              />
            </div>
          </div>
        </div>

        {/* Config panel */}
        <div className="config-stack">

          {/* Toggles */}
          <div className="glass" style={{ padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Configuration</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Toggle label="Proxy Cluster" sub="Route through proxies" active={settings.proxiesEnabled} onClick={() => setSettings((s: AppSettings) => ({ ...s, proxiesEnabled: !s.proxiesEnabled }))} />
              <Toggle label="Headless Mode" sub="Browser runs silently" active={settings.headlessMode}  onClick={() => setSettings((s: AppSettings) => ({ ...s, headlessMode: !s.headlessMode }))} />
            </div>
          </div>

          {/* Telemetry */}
          <div className="glass" style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Threads</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: threads > 0 ? 'var(--blue)' : 'var(--text2)', fontFamily: 'JetBrains Mono, monospace' }}>{threads}</div>
            </div>

            {stats?.workspace ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text2)', paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                  <span>Batch {stats.workspace.batchCurrent}/{stats.workspace.batchTotal}</span>
                  <span style={{ color: stats.workspace.failureRate > 50 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
                    {stats.workspace.failureRate}% fail
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <MiniStat label="Success" val={stats.workspace.successful} color="var(--green)" />
                  <MiniStat label="Failed"  val={stats.workspace.failed}     color="var(--red)" />
                </div>
                <MiniStat label="Anti-Spam Blocked" val={stats.workspace.antiSpamBlocked} color="var(--orange)" full />
              </div>
            ) : (
              <>
                <div style={{ background: 'var(--bg3)', borderRadius: 6, height: 6, overflow: 'hidden', marginBottom: 10 }}>
                  <div style={{ height: '100%', width: total > 0 ? `${Math.round(((stats?.active||0)/total)*100)}%` : '0%', background: 'var(--blue)', borderRadius: 6, transition: 'width 0.8s ease' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text2)' }}>
                  <span>Total: {total}</span>
                  <span>{total > 0 ? Math.round(((stats?.active||0)/total)*100) : 0}% active</span>
                </div>
              </>
            )}
          </div>

          {/* High failure rate warning */}
          {stats?.workspace && stats.workspace.failureRate > 50 && (
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 10, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)', marginBottom: 2 }}>High Failure Rate</div>
                <div style={{ fontSize: 11, color: 'var(--text2)' }}>Reduce threads or rotate proxies</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const Toggle: React.FC<{ label: string; sub: string; active: boolean; onClick: () => void }> = ({ label, sub, active, onClick }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }} onClick={onClick}>
    <div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 1 }}>{sub}</div>
    </div>
    <div className={`toggle ${active ? 'on' : ''}`} />
  </div>
);

const MiniStat: React.FC<{ label: string; val: number; color: string; full?: boolean }> = ({ label, val, color, full }) => (
  <div style={{ background: 'var(--bg3)', borderRadius: 6, padding: '8px 10px', gridColumn: full ? 'span 2' : undefined }}>
    <div style={{ fontSize: 10, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    <div style={{ fontSize: 18, fontWeight: 700, color, marginTop: 2, fontFamily: 'JetBrains Mono, monospace' }}>{val}</div>
  </div>
);

export default Dashboard;
