import React, { useState } from 'react';

interface LoginProps {
  onLogin: (user: any) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [showPass, setShowPass] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (data.success) {
        setTimeout(() => onLogin(data.user), 400);
      } else {
        setError(data.error || 'Invalid credentials');
        setIsLoading(false);
      }
    } catch {
      setError('Cannot connect to server');
      setIsLoading(false);
    }
  };

  return (
    <div className="login-wrap login-redesign">
      {/* Subtle background glow */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 0,
        background: 'radial-gradient(ellipse 60% 50% at 50% 0%, rgba(59,130,246,0.08) 0%, transparent 70%)'
      }} />

      <div className="login-showcase">
        <div className="login-showcase-inner">
          <div className="showcase-badge"><span /> Secure operations workspace</div>
          <h1>Control every account workflow from one place.</h1>
          <p>Launch, monitor, and manage your workspace operations with a focused command center built for speed.</p>
          <div className="showcase-metrics">
            <div><strong>Live</strong><span>Job telemetry</span></div>
            <div><strong>24/7</strong><span>Queue monitoring</span></div>
            <div><strong>Secure</strong><span>Role access</span></div>
          </div>
        </div>
      </div>

      <div className="login-card">
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 48, height: 48,
            background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
            borderRadius: 12,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 16,
            boxShadow: '0 8px 24px rgba(59,130,246,0.3)'
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <div className="login-welcome">Welcome back</div>
          <div className="login-copy">Sign in to continue to Nexus</div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.25)',
            color: '#f87171',
            borderRadius: 8,
            padding: '10px 14px',
            fontSize: 13,
            marginBottom: 18,
            display: 'flex', alignItems: 'center', gap: 8
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="label">Username</div>
            <input
              className="inp"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Enter your username"
              autoFocus
              required
            />
          </div>

          <div>
            <div className="label">Password</div>
            <div style={{ position: 'relative' }}>
              <input
                className="inp"
                type={showPass ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter your password"
                style={{ paddingRight: 44 }}
                required
              />
              <button
                type="button"
                onClick={() => setShowPass(!showPass)}
                style={{
                  position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)',
                  padding: 2, display: 'flex', alignItems: 'center'
                }}
              >
                {showPass ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={isLoading}
            style={{ marginTop: 6, padding: '12px 16px', justifyContent: 'center', fontSize: 14 }}
          >
            {isLoading ? (
              <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <span style={{ width: 6, height: 6, background: '#fff', borderRadius: '50%', animation: 'pulse 1s infinite' }} />
                <span style={{ width: 6, height: 6, background: '#fff', borderRadius: '50%', animation: 'pulse 1s 0.2s infinite' }} />
                <span style={{ width: 6, height: 6, background: '#fff', borderRadius: '50%', animation: 'pulse 1s 0.4s infinite' }} />
              </span>
            ) : 'Sign In'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 24, fontSize: 11, color: 'var(--text2)' }}>
          Authorized access only · Nexus Platform
        </div>
      </div>
    </div>
  );
};

export default Login;
