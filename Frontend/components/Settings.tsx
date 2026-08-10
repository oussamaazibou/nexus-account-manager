
import React, { useState, useEffect } from 'react';
import { Icons } from '../constants';
import { AppSettings } from '../types';

interface SettingsProps {
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
}

const Settings: React.FC<SettingsProps> = ({ settings: globalSettings, setSettings: syncGlobalSettings }) => {
  const [localSettings, setLocalSettings] = useState<AppSettings>(globalSettings);
  const [isSaving, setIsSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ service: string, message: string } | null>(null);

  const API_URL = '/api';

  useEffect(() => {
    setLocalSettings(globalSettings);
  }, [globalSettings]);

  const testService = async (service: string, endpoint: string, payload: any) => {
    setTestResult({ service, message: 'Testing...' });
    try {
      const res = await fetch(`${API_URL}/test/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        setTestResult({ service, message: data.balance ? `Balance: ${data.balance}` : (data.message || 'Success') });
      } else {
        setTestResult({ service, message: `Error: ${data.error}` });
      }
    } catch (e: any) { setTestResult({ service, message: `Failed: ${e.message}` }); }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const response = await fetch(`${API_URL}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localSettings)
      });

      if (response.ok) {
        setIsSaving(false);
        setShowSaved(true);
        syncGlobalSettings(localSettings);
        setTimeout(() => setShowSaved(false), 3000);
      } else {
        throw new Error('Save failed');
      }
    } catch (error) {
      console.error('Save error:', error);
      setIsSaving(false);
    }
  };

  const updateField = (field: keyof AppSettings, value: string) => {
    setLocalSettings(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="space-y-12 animate-in fade-in duration-700 pb-24">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-8">
        <div className="space-y-2">
          <h2 className="text-4xl font-black tracking-tightest uppercase">System Config</h2>
          <p className="text-[var(--text-muted)] text-sm font-medium">Manage API keys and global infrastructure parameters.</p>
        </div>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className={`btn-glow min-w-[200px] py-5 px-10 rounded-2xl font-black text-xs transition-all uppercase tracking-widest shadow-xl flex items-center justify-center gap-4 ${showSaved
            ? 'bg-emerald-600 text-white'
            : 'bg-indigo-600 text-white hover:bg-indigo-500'
            } disabled:opacity-50`}
        >
          {isSaving ? (
            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
          ) : showSaved ? (
            <>
              <Icons.Verify />
              <span>Synced</span>
            </>
          ) : (
            'Commit Changes'
          )}
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-10">
        <SettingsCard
          icon={<div className="text-orange-500"><Icons.Cloud /></div>}
          title="Cloudflare"
          subtitle="DNS Security"
        >
          <div className="space-y-6 mt-10">
            <ModernInput label="Auth Email" placeholder="user@cloudflare.net" value={localSettings.cloudflareEmail || ''} onChange={(v) => updateField('cloudflareEmail', v)} />
            <ModernInput label="Global Token" placeholder="••••••••••••••••" type="password" value={localSettings.cloudflareKey || ''} onChange={(v) => updateField('cloudflareKey', v)} />
            <div className="flex justify-between items-center pt-2">
              <button onClick={() => testService('cloudflare', 'cloudflare', { email: localSettings.cloudflareEmail, key: localSettings.cloudflareKey })} className="text-[10px] uppercase font-bold text-orange-400 hover:text-orange-300 transition-colors bg-orange-500/10 px-3 py-1 rounded">Test Auth</button>
              {testResult?.service === 'cloudflare' && <span className="text-[10px] text-white/70 animate-pulse">{testResult.message}</span>}
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-cyan-400"><Icons.Cloud /></div>}
          title="Dynu"
          subtitle="DNS Service"
        >
          <div className="space-y-6 mt-10">
            <ModernInput label="API Key" placeholder="••••••••••••••••" type="password" value={localSettings.dynuApiKey || ''} onChange={(v) => updateField('dynuApiKey', v)} />
            <div className="flex justify-between items-center pt-2">
              <button onClick={() => testService('dynu', 'dynu', { key: localSettings.dynuApiKey })} className="text-[10px] uppercase font-bold text-cyan-400 hover:text-cyan-300 transition-colors bg-cyan-500/10 px-3 py-1 rounded">Test Auth</button>
              {testResult?.service === 'dynu' && <span className="text-[10px] text-white/70 animate-pulse">{testResult.message}</span>}
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-emerald-500"><Icons.Shield /></div>}
          title="Hero-SMS"
          subtitle="Identity Verification"
        >
          <div className="space-y-6 mt-10">
            <ModernInput label="API Access Key" placeholder="HS-XXXX-XXXX" type="password" value={localSettings.heroSmsKey || ''} onChange={(v) => updateField('heroSmsKey', v)} />
            <ModernInput label="API Endpoint URL" placeholder="https://api.herosms.io/v1" value={localSettings.heroSmsUrl || ''} onChange={(v) => updateField('heroSmsUrl', v)} />
            <div className="flex justify-between items-center pt-2">
              <button onClick={() => testService('hero-sms', 'hero-sms', { key: localSettings.heroSmsKey, url: localSettings.heroSmsUrl })} className="text-[10px] uppercase font-bold text-emerald-400 hover:text-emerald-300 transition-colors bg-emerald-500/10 px-3 py-1 rounded">Check Balance</button>
              {testResult?.service === 'hero-sms' && <span className="text-[10px] text-white/70 animate-pulse">{testResult.message}</span>}
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-yellow-500"><Icons.Shield /></div>}
          title="2Captcha"
          subtitle="Bot Protection"
        >
          <div className="space-y-6 mt-10">
            <ModernInput label="API Key" placeholder="2captcha_api_key" type="password" value={localSettings.captchaKey || ''} onChange={(v) => updateField('captchaKey', v)} />
            <div className="flex justify-between items-center pt-2">
              <button onClick={() => testService('2captcha', '2captcha', { key: localSettings.captchaKey })} className="text-[10px] uppercase font-bold text-yellow-400 hover:text-yellow-300 transition-colors bg-yellow-500/10 px-3 py-1 rounded">Check Balance</button>
              {testResult?.service === '2captcha' && <span className="text-[10px] text-white/70 animate-pulse">{testResult.message}</span>}
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-sky-500"><Icons.Telegram /></div>}
          title="Notifications"
          subtitle="Telegram Bridge"
        >
          <div className="space-y-6 mt-10">
            <ModernInput label="Bot Key" placeholder="748293758:AA..." type="password" value={localSettings.telegramToken || ''} onChange={(v) => updateField('telegramToken', v)} />
            <ModernInput label="Secure Chat ID" placeholder="-10015928..." value={localSettings.telegramChatId || ''} onChange={(v) => updateField('telegramChatId', v)} />
            <button
              onClick={() => testService('telegram', 'telegram', { token: localSettings.telegramToken, chatId: localSettings.telegramChatId })}
              className="w-full py-4 text-[10px] font-black text-sky-400 hover:text-white transition-all uppercase tracking-[0.2em] bg-sky-500/5 rounded-2xl border border-sky-500/10 hover:bg-sky-500/20 active:scale-95 mt-4"
            >
              Send Connection Test
            </button>
            {testResult?.service === 'telegram' && <div className="text-center mt-2 text-[10px] text-white/70 animate-pulse">{testResult.message}</div>}
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-purple-500"><Icons.Cloud /></div>}
          title="Performance"
          subtitle="Resource Allocation"
        >
          <div className="space-y-6 mt-10">
            <ModernInput label="Threads (Batch Size)" placeholder="10" value={localSettings.concurrency || '10'} onChange={(v) => updateField('concurrency', v)} />
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-amber-500"><Icons.Database /></div>}
          title="AWS S3"
          subtitle="Object Storage"
        >
          <div className="space-y-6 mt-10">
            <div className="grid grid-cols-2 gap-4">
              <ModernInput label="Region" placeholder="eu-west-1" value={localSettings.awsRegion || ''} onChange={(v) => updateField('awsRegion', v)} />
              <ModernInput label="Bucket" placeholder="json-files-gw" value={localSettings.awsBucket || ''} onChange={(v) => updateField('awsBucket', v)} />
            </div>
            <ModernInput label="Access Key ID" placeholder="AKIA..." value={localSettings.awsAccessKey || ''} onChange={(v) => updateField('awsAccessKey', v)} />
            <ModernInput label="Secret Access Key" placeholder="••••••••••••" type="password" value={localSettings.awsSecretKey || ''} onChange={(v) => updateField('awsSecretKey', v)} />
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-red-500"><Icons.Shield /></div>}
          title="Google Admin"
          subtitle="Domain-Wide Delegation"
        >
          <div className="space-y-6 mt-10">
            <ModernInput label="Admin Email" placeholder="contact@getsmart.levoria.fun" value={localSettings.adminEmail || ''} onChange={(v) => updateField('adminEmail', v)} />
            <ModernInput label="Admin Password" placeholder="••••••••" type="password" value={localSettings.adminPassword || ''} onChange={(v) => updateField('adminPassword', v)} />
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-pink-500"><Icons.Database /></div>}
          title="SFTP Server"
          subtitle="OTP Source"
        >
          <div className="space-y-6 mt-10">
            <div className="grid grid-cols-2 gap-4">
              <ModernInput label="Host" placeholder="sftp.example.com" value={localSettings.sftpHost || ''} onChange={(v) => updateField('sftpHost', v)} />
              <ModernInput label="Port" placeholder="22" value={localSettings.sftpPort || '22'} onChange={(v) => updateField('sftpPort', v)} />
            </div>
            <ModernInput label="Username" placeholder="root" value={localSettings.sftpUser || ''} onChange={(v) => updateField('sftpUser', v)} />
            <ModernInput label="Password" placeholder="••••••••" type="password" value={localSettings.sftpPassword || ''} onChange={(v) => updateField('sftpPassword', v)} />
            <ModernInput label="Path" placeholder="/root/secrets" value={localSettings.sftpPath || ''} onChange={(v) => updateField('sftpPath', v)} />
            <div className="flex justify-between items-center pt-2 col-span-2">
              <button onClick={() => testService('sftp', 'sftp', { host: localSettings.sftpHost, port: localSettings.sftpPort, user: localSettings.sftpUser, password: localSettings.sftpPassword })} className="text-[10px] uppercase font-bold text-pink-400 hover:text-pink-300 transition-colors bg-pink-500/10 px-3 py-1 rounded">Test Connection</button>
              {testResult?.service === 'sftp' && <span className="text-[10px] text-white/70 animate-pulse">{testResult.message}</span>}
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-indigo-500"><Icons.Shield /></div>}
          title="Proxy Cluster"
          subtitle="Network Rotation"
          fullWidth
        >
          <div className="mt-8">
            <textarea
              value={localSettings.proxiesList || ''}
              onChange={(e) => updateField('proxiesList', e.target.value)}
              className="w-full h-64 glass-input mono text-sm resize-none bg-black/10"
              placeholder="127.0.0.1:8080:root:pass"
            />
            <div className="mt-4 text-[9px] font-mono text-slate-600 uppercase tracking-widest text-right">Format: host:port:user:pass</div>
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-cyan-400">🌐</div>}
          title="Namecheap"
          subtitle="Domain Registrar"
        >
          <div className="space-y-6 mt-10">
            <ModernInput label="API Key" placeholder="c3c4ffea41644db3a4e7..." type="password" value={localSettings.namecheapKey || ''} onChange={(v) => updateField('namecheapKey', v)} />
            <ModernInput label="API Username" placeholder="M2diafox" value={localSettings.namecheapUser || ''} onChange={(v) => updateField('namecheapUser', v)} />
            <ModernInput label="Whitelisted IP" placeholder="105.155.16.113" value={localSettings.namecheapIp || ''} onChange={(v) => updateField('namecheapIp', v)} />
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-violet-400">🚀</div>}
          title="Spaceship"
          subtitle="Domain Registrar"
        >
          <div className="space-y-6 mt-10">
            <ModernInput label="API Key" placeholder="psQNwshvy0XZ..." type="password" value={localSettings.spaceshipKey || ''} onChange={(v) => updateField('spaceshipKey', v)} />
            <ModernInput label="API Secret" placeholder="FqfoDiNw73Dv..." type="password" value={localSettings.spaceshipSecret || ''} onChange={(v) => updateField('spaceshipSecret', v)} />
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<div className="text-emerald-400">🏷️</div>}
          title="Nicnames"
          subtitle="Domain Registrar"
        >
          <div className="space-y-6 mt-10">
            <ModernInput label="API Key" placeholder="Bearer token..." type="password" value={localSettings.nicnamesKey || ''} onChange={(v) => updateField('nicnamesKey', v)} />
          </div>
        </SettingsCard>

      </div >
    </div >
  );
};

const SettingsCard: React.FC<{ icon: React.ReactNode, title: string, subtitle: string, children: React.ReactNode, fullWidth?: boolean }> = ({ icon, title, subtitle, children, fullWidth }) => (
  <section className={`glass-card p-10 ${fullWidth ? 'xl:col-span-2' : ''}`}>
    <div className="flex items-center gap-5">
      <div className="w-14 h-14 bg-white/5 rounded-2xl flex items-center justify-center border border-[var(--border-glass)]">
        {icon}
      </div>
      <div>
        <h3 className="text-lg font-black uppercase tracking-tight leading-none">{title}</h3>
        <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-widest font-black mt-2">{subtitle}</p>
      </div>
    </div>
    {children}
  </section>
);

const ModernInput: React.FC<{ label: string, placeholder: string, type?: string, value: string, onChange: (v: string) => void }> = ({ label, placeholder, type = 'text', value, onChange }) => (
  <div className="space-y-3">
    <label className="text-[10px] font-black text-indigo-500 uppercase tracking-widest ml-4">{label}</label>
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full glass-input"
      placeholder={placeholder}
    />
  </div>
);

export default Settings;
