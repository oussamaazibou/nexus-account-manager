import React, { useState } from 'react';

const ManualOTP: React.FC = () => {
  const [email, setEmail] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !secretKey.trim()) return;
    
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/manual-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), secretKey: secretKey.trim().replace(/\s/g, '') })
      });
      const data = await res.json();
      if (data.success) {
        setResult({ success: true, message: 'OTP Secret successfully saved to VPS!' });
        setEmail('');
        setSecretKey('');
      } else {
        setResult({ success: false, message: data.error || 'Failed to save OTP' });
      }
    } catch (err: any) {
      setResult({ success: false, message: 'Network error connecting to backend' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass" style={{ padding: '24px', maxWidth: '600px', margin: '0 auto', borderRadius: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <div style={{ width: 40, height: 40, background: 'rgba(59,130,246,0.1)', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--blue)' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
          </svg>
        </div>
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0, color: 'var(--text)' }}>Manual OTP Keys</h2>
          <div style={{ fontSize: '13px', color: 'var(--text2)', marginTop: '4px' }}>
            Save OTP secrets for accounts created manually to the remote OTP server.
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: 'var(--text2)', marginBottom: '8px' }}>
            Account Email
          </label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="admin@example.com"
            required
            className="input"
            style={{ width: '100%' }}
            disabled={loading}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: 'var(--text2)', marginBottom: '8px' }}>
            Authenticator Secret Key
          </label>
          <input
            type="text"
            value={secretKey}
            onChange={e => setSecretKey(e.target.value)}
            placeholder="JBSWY3DPEHPK3PXP"
            required
            className="input"
            style={{ width: '100%', fontFamily: 'monospace' }}
            disabled={loading}
          />
          <div style={{ fontSize: '11px', color: 'var(--text2)', marginTop: '6px' }}>
            Spaces will be automatically removed.
          </div>
        </div>

        {result && (
          <div style={{
            padding: '12px',
            borderRadius: '8px',
            fontSize: '13px',
            background: result.success ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            color: result.success ? 'var(--green)' : 'var(--red)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            {result.success ? '✓' : '✕'} {result.message}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !email.trim() || !secretKey.trim()}
          className="btn-primary"
          style={{ width: '100%', justifyContent: 'center', marginTop: '8px', opacity: (loading || !email.trim() || !secretKey.trim()) ? 0.7 : 1 }}
        >
          {loading ? 'Saving to Server...' : 'Save Secret Key'}
        </button>
      </form>
    </div>
  );
};

export default ManualOTP;
