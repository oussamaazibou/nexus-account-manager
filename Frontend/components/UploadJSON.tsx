import React, { useState } from 'react';

const API_URL = '/api';

type BulkResult = { email: string; exists: boolean };

const UploadJSON: React.FC = () => {
    const [email, setEmail] = useState('');
    const [jsonContent, setJsonContent] = useState('');
    const [fetchedJson, setFetchedJson] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [fetchingJson, setFetchingJson] = useState(false);
    const [copied, setCopied] = useState(false);
    const [searchStatus, setSearchStatus] = useState<{ type: 'idle' | 'found' | 'not_found' | 'error', message?: string }>({ type: 'idle' });
    const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

    // Bulk state
    const [bulkEmails, setBulkEmails] = useState('');
    const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null);
    const [bulkLoading, setBulkLoading] = useState(false);
    const [downloading, setDownloading] = useState(false);

    const handleSearch = async () => {
        if (!email.trim()) return;
        setLoading(true);
        setSearchStatus({ type: 'idle' });
        setActionMessage(null);
        setFetchedJson(null);
        try {
            const res = await fetch(`${API_URL}/s3/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim() })
            });
            const data = await res.json();
            if (data.exists) {
                setSearchStatus({ type: 'found', message: `✅ JSON found for ${email}` });
                fetchJsonContent(email.trim());
            } else {
                setSearchStatus({ type: 'not_found', message: `❌ JSON not found for ${email}` });
            }
        } catch (e: any) {
            setSearchStatus({ type: 'error', message: `Error checking S3: ${e.message}` });
        } finally {
            setLoading(false);
        }
    };

    const fetchJsonContent = async (emailToFetch: string) => {
        setFetchingJson(true);
        setFetchedJson(null);
        try {
            const res = await fetch(`${API_URL}/s3/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: emailToFetch })
            });
            const data = await res.json();
            if (data.success && data.content) {
                setFetchedJson(JSON.stringify(data.content, null, 2));
            } else {
                setFetchedJson(null);
            }
        } catch {
            setFetchedJson(null);
        } finally {
            setFetchingJson(false);
        }
    };

    const handleCopy = () => {
        if (!fetchedJson) return;
        navigator.clipboard.writeText(fetchedJson).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const handleDelete = async () => {
        if (!email.trim()) return;
        setLoading(true);
        setActionMessage(null);
        try {
            const res = await fetch(`${API_URL}/s3/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim() })
            });
            const data = await res.json();
            if (data.success) {
                setActionMessage({ type: 'success', text: `🗑️ Successfully deleted JSON for ${email}` });
                setSearchStatus({ type: 'not_found' });
                setFetchedJson(null);
            } else {
                setActionMessage({ type: 'error', text: `❌ Delete Error: ${data.error}` });
            }
        } catch (e: any) {
            setActionMessage({ type: 'error', text: `❌ Error: ${e.message}` });
        } finally {
            setLoading(false);
        }
    };

    const handleUpload = async () => {
        if (!email.trim() || !jsonContent.trim()) {
            setActionMessage({ type: 'error', text: `❌ Please enter an email and valid JSON content` });
            return;
        }

        try {
            JSON.parse(jsonContent);
        } catch (e) {
            setActionMessage({ type: 'error', text: `❌ Invalid JSON format` });
            return;
        }

        setLoading(true);
        setActionMessage(null);
        try {
            const res = await fetch(`${API_URL}/s3/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim(), jsonContent: jsonContent.trim() })
            });
            const data = await res.json();
            if (data.success) {
                setActionMessage({ type: 'success', text: `📤 Successfully uploaded JSON for ${email}!` });
                setSearchStatus({ type: 'found', message: `✅ JSON found for ${email} (Just Uploaded)` });
                setFetchedJson(JSON.stringify(JSON.parse(jsonContent), null, 2));
                setJsonContent('');
            } else {
                setActionMessage({ type: 'error', text: `❌ Upload Error: ${data.error}` });
            }
        } catch (e: any) {
            setActionMessage({ type: 'error', text: `❌ Error: ${e.message}` });
        } finally {
            setLoading(false);
        }
    };

    const handleBulkSearch = async () => {
        const emails = bulkEmails
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean);
        if (emails.length === 0) return;
        setBulkLoading(true);
        setBulkResults(null);
        try {
            const res = await fetch(`${API_URL}/s3/bulk-search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emails })
            });
            const data = await res.json();
            setBulkResults(data.results || []);
        } catch (e: any) {
            setBulkResults([]);
        } finally {
            setBulkLoading(false);
        }
    };

    const handleBulkDownload = async () => {
        if (!bulkResults) return;
        const found = bulkResults.filter(r => r.exists).map(r => r.email);
        if (found.length === 0) return;
        setDownloading(true);
        try {
            const res = await fetch(`${API_URL}/s3/bulk-download-zip`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emails: found })
            });
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'workspace-keys.zip';
            a.click();
            URL.revokeObjectURL(url);
        } catch (e: any) {
            console.error('Download failed', e);
        } finally {
            setDownloading(false);
        }
    };

    const foundCount = bulkResults ? bulkResults.filter(r => r.exists).length : 0;
    const notFoundCount = bulkResults ? bulkResults.filter(r => !r.exists).length : 0;

    return (
        <div className="space-y-6 max-w-4xl mx-auto">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-black tracking-tightest uppercase mb-1">S3 JSON Manager</h2>
                    <p className="text-[var(--text-muted)] text-sm">Search, view, delete, and upload Google Service Account JSONs to your S3 Bucket.</p>
                </div>
                <div className="w-12 h-12 rounded-2xl bg-indigo-600/20 text-indigo-400 flex items-center justify-center">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" x2="12" y1="3" y2="15" /></svg>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                {/* Search & View Panel */}
                <div className="glass-card p-6 space-y-6">
                    <h3 className="font-black border-b border-white/10 pb-4">1. Check Workspace Key in S3</h3>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Admin Account Email</label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={email}
                                    onChange={e => {
                                        let val = e.target.value;
                                        if (val.includes('\n') || val.includes(':')) {
                                            const firstLine = val.split('\n')[0].split('\r')[0];
                                            val = firstLine.split(':')[0].trim();
                                        }
                                        setEmail(val);
                                        setFetchedJson(null);
                                        setSearchStatus({ type: 'idle' });
                                    }}
                                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                                    placeholder="admin@example.com"
                                    className="flex-1 px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm focus:outline-none focus:border-indigo-500 text-[var(--text-main)]"
                                />
                                <button
                                    onClick={handleSearch}
                                    disabled={loading || !email.trim()}
                                    className="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black text-sm transition-all disabled:opacity-50 shrink-0"
                                >
                                    {loading ? '⏳' : '🔍 Search'}
                                </button>
                            </div>
                        </div>

                        {searchStatus.type !== 'idle' && (
                            <div className={`p-4 rounded-xl border flex items-center justify-between ${searchStatus.type === 'found' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
                                searchStatus.type === 'not_found' ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' :
                                    'bg-red-500/10 border-red-500/20 text-red-500'
                                }`}>
                                <div className="font-bold text-sm">{searchStatus.message}</div>
                                {searchStatus.type === 'found' && (
                                    <button
                                        onClick={handleDelete}
                                        disabled={loading}
                                        className="px-4 py-1.5 bg-red-500/20 hover:bg-red-500 text-red-400 hover:text-white rounded-lg text-xs font-black transition-all disabled:opacity-50"
                                    >
                                        Delete Key
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Upload Panel */}
                <div className="glass-card p-6 space-y-6">
                    <h3 className="font-black border-b border-white/10 pb-4">2. Upload Manual JSON</h3>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Paste Raw JSON Content</label>
                                <div>
                                    <input
                                        type="file"
                                        accept=".json"
                                        id="jsonUpload"
                                        className="hidden"
                                        onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (file) {
                                                const reader = new FileReader();
                                                reader.onload = (event) => setJsonContent(event.target?.result as string);
                                                reader.readAsText(file);
                                            }
                                        }}
                                    />
                                    <button
                                        onClick={() => document.getElementById('jsonUpload')?.click()}
                                        className="text-xs bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/40 px-3 py-1.5 rounded-lg font-bold transition-all flex items-center gap-2"
                                    >
                                        📂 Load from PC
                                    </button>
                                </div>
                            </div>
                            <textarea
                                value={jsonContent}
                                onChange={e => setJsonContent(e.target.value)}
                                placeholder='{\n  "type": "service_account",\n  "project_id": "...",\n  "private_key": "...",\n  "client_email": "..."\n}'
                                className="w-full h-48 px-4 py-4 rounded-xl bg-black/30 border border-white/10 text-sm font-mono focus:outline-none focus:border-emerald-500 text-[var(--text-main)] placeholder-[var(--text-muted)] resize-none"
                            ></textarea>
                        </div>
                        <button
                            onClick={handleUpload}
                            disabled={loading || !jsonContent.trim() || !email.trim()}
                            className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm transition-all shadow-[0_0_20px_rgba(16,185,129,0.3)] disabled:opacity-50 disabled:shadow-none"
                        >
                            {loading ? '⏳ Uploading...' : '📤 Upload New JSON'}
                        </button>
                    </div>

                    {actionMessage && (
                        <div className={`p-4 rounded-xl text-sm font-bold border ${actionMessage.type === 'success' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                            {actionMessage.text}
                        </div>
                    )}
                </div>

            </div>

            {/* JSON Viewer */}
            {(fetchingJson || fetchedJson) && (
                <div className="glass-card p-6 space-y-4">
                    <div className="flex items-center justify-between border-b border-white/10 pb-4">
                        <div>
                            <h3 className="font-black">3. JSON Content from S3</h3>
                            <p className="text-xs text-[var(--text-muted)] mt-1">{email}</p>
                        </div>
                        {fetchedJson && (
                            <button
                                onClick={handleCopy}
                                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-black text-sm transition-all ${copied
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : 'bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/40 border border-indigo-500/20'
                                }`}
                            >
                                {copied ? (
                                    <>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                                        Copied!
                                    </>
                                ) : (
                                    <>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                        Copy JSON
                                    </>
                                )}
                            </button>
                        )}
                    </div>

                    {fetchingJson ? (
                        <div className="flex items-center gap-3 text-[var(--text-muted)] text-sm py-6 justify-center">
                            <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                            Loading JSON from S3...
                        </div>
                    ) : fetchedJson ? (
                        <pre className="w-full overflow-auto rounded-xl bg-black/40 border border-white/5 p-5 text-xs font-mono text-emerald-300 leading-relaxed" style={{ maxHeight: 420 }}>
                            {fetchedJson}
                        </pre>
                    ) : null}
                </div>
            )}

            {/* Bulk Search Panel */}
            <div className="glass-card p-6 space-y-5">
                <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <div>
                        <h3 className="font-black">4. Bulk Search &amp; Download</h3>
                        <p className="text-xs text-[var(--text-muted)] mt-1">Paste multiple emails (one per line) to check S3 and download all found keys as a ZIP.</p>
                    </div>
                    <div className="w-10 h-10 rounded-xl bg-violet-600/20 text-violet-400 flex items-center justify-center shrink-0">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    {/* Textarea input */}
                    <div className="space-y-3">
                        <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">Emails (one per line)</label>
                        <textarea
                            value={bulkEmails}
                            onChange={e => setBulkEmails(e.target.value)}
                            placeholder={"admin1@domain.com\nadmin2@domain.com\nadmin3@domain.com"}
                            rows={8}
                            className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-sm font-mono focus:outline-none focus:border-violet-500 text-[var(--text-main)] placeholder-[var(--text-muted)] resize-none"
                        />
                        <button
                            onClick={handleBulkSearch}
                            disabled={bulkLoading || !bulkEmails.trim()}
                            className="w-full py-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-black text-sm transition-all disabled:opacity-50"
                        >
                            {bulkLoading ? (
                                <span className="flex items-center justify-center gap-2">
                                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                    Searching...
                                </span>
                            ) : '🔍 Search All'}
                        </button>
                    </div>

                    {/* Results */}
                    <div className="space-y-3">
                        {bulkResults ? (
                            <>
                                <div className="flex items-center justify-between">
                                    <label className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)] block">
                                        Results — <span className="text-emerald-400">{foundCount} found</span> · <span className="text-amber-400">{notFoundCount} missing</span>
                                    </label>
                                    {foundCount > 0 && (
                                        <button
                                            onClick={handleBulkDownload}
                                            disabled={downloading}
                                            className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-black text-xs transition-all disabled:opacity-50 shrink-0"
                                        >
                                            {downloading ? (
                                                <>
                                                    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                                    Packing...
                                                </>
                                            ) : (
                                                <>
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                                                    Download ZIP ({foundCount})
                                                </>
                                            )}
                                        </button>
                                    )}
                                </div>
                                <div className="rounded-xl bg-black/30 border border-white/10 overflow-hidden" style={{ maxHeight: 260, overflowY: 'auto' }}>
                                    {bulkResults.length === 0 ? (
                                        <div className="p-4 text-[var(--text-muted)] text-sm text-center">No results</div>
                                    ) : (
                                        <div className="divide-y divide-white/5">
                                            {bulkResults.map(r => (
                                                <div key={r.email} className="flex items-center justify-between px-4 py-2.5 text-sm">
                                                    <span className="font-mono text-[var(--text-main)] truncate mr-3">{r.email}</span>
                                                    {r.exists ? (
                                                        <span className="text-xs font-black text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md shrink-0">FOUND</span>
                                                    ) : (
                                                        <span className="text-xs font-black text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md shrink-0">MISSING</span>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-[var(--text-muted)] text-sm gap-3 rounded-xl bg-black/20 border border-white/5">
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                <span>Results will appear here</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default UploadJSON;
