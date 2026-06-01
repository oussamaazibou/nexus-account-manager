import React, { useState, useEffect } from 'react';
import { Icons } from '../constants';

const API_URL = '/api';

const AVAILABLE_PERMISSIONS = [
    'DASHBOARD',
    'QUEUE',
    'OPERATIONS',
    'SETTINGS',
    'VALID_ACCOUNTS',
    'PHONE_VERIFY',
    'MANAGE_ACCOUNTS',
    'UPLOAD_JSON',
    'APP_PASSWORDS',
    'APP_USERS',
    'LIVE_OPERATIONS',
    'ONLINE_USERS',
    'ARCHIVE_ACCOUNTS',
    'CREATE_USERS',
    'DOMAINS'
];

interface AppUser {
    id: string;
    username: string;
    role: string;
    permissions: string[];
}

const AppUsers: React.FC = () => {
    const [users, setUsers] = useState<AppUser[]>([]);
    const [loading, setLoading] = useState(true);

    // Create / Edit modal state
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [formData, setFormData] = useState({ username: '', password: '', role: 'mailer', permissions: [] as string[] });

    useEffect(() => {
        fetchUsers();
    }, []);

    const fetchUsers = async () => {
        try {
            const res = await fetch(`${API_URL}/app-users`);
            const data = await res.json();
            setUsers(data);
        } catch (e) {
            console.error('Error fetching users', e);
        } finally {
            setLoading(false);
        }
    };

    const openCreateModal = () => {
        setEditingId(null);
        setFormData({ username: '', password: '', role: 'mailer', permissions: [] });
        setIsModalOpen(true);
    };

    const openEditModal = (user: AppUser) => {
        setEditingId(user.id);
        setFormData({ username: user.username, password: '', role: user.role || 'mailer', permissions: user.permissions });
        setIsModalOpen(true);
    };

    const togglePermission = (perm: string) => {
        setFormData(prev => ({
            ...prev,
            permissions: prev.permissions.includes(perm)
                ? prev.permissions.filter(p => p !== perm)
                : [...prev.permissions, perm]
        }));
    };

    const toast = (msg: string, type: 'ok'|'err'|'info' = 'info') => {
        const c = document.getElementById('toast-container'); if (!c) return;
        const el = document.createElement('div');
        el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
        el.innerHTML = `<span style="font-weight:700">${type==='ok'?'✓':type==='err'?'✕':'ℹ'}</span><span>${msg}</span>`;
        c.appendChild(el);
        setTimeout(()=>{ el.style.opacity='0'; el.style.transition='all 0.3s'; setTimeout(()=>el.remove(),300); }, 3500);
    };

    const handleSave = async () => {
        if (!formData.username) return;

        try {
            const isEdit = !!editingId;
            const endpoint = isEdit ? `${API_URL}/app-users/${editingId}` : `${API_URL}/app-users`;
            const method = isEdit ? 'PUT' : 'POST';

            const res = await fetch(endpoint, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            const data = await res.json();
            if (data.success) {
                setIsModalOpen(false);
                fetchUsers();
                toast(isEdit ? 'User updated' : 'User created', 'ok');
            } else {
                toast(data.error || 'Failed to save user', 'err');
            }
        } catch (e) {
            toast('Error saving user', 'err');
        }
    };

    const handleDelete = async (id: string) => {
        try {
            const res = await fetch(`${API_URL}/app-users/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                fetchUsers();
                toast('User deleted', 'ok');
            } else {
                toast(data.error || 'Delete failed', 'err');
            }
        } catch (e) {
            toast('Error deleting user', 'err');
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in duration-700">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-6">
                <div>
                    <h2 className="text-3xl font-black tracking-tightest uppercase">Application Users</h2>
                    <p className="text-[var(--text-muted)] text-sm font-medium mt-1">Manage Mailer Accounts & Workspace Access</p>
                </div>
                <button
                    onClick={openCreateModal}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-3 rounded-xl font-bold transition-colors uppercase tracking-widest text-xs shadow-xl shadow-indigo-500/20"
                >
                    + Add New User
                </button>
            </div>

            <div className="glass-card overflow-hidden">
                {loading ? (
                    <div className="p-12 text-center text-[var(--text-muted)]">Loading users...</div>
                ) : (
                    <table className="w-full text-left">
                        <thead>
                            <tr className="bg-black/20 border-b border-white/5">
                                <th className="px-6 py-4 text-xs font-black uppercase text-[var(--text-muted)]">Username</th>
                                <th className="px-6 py-4 text-xs font-black uppercase text-[var(--text-muted)]">Role</th>
                                <th className="px-6 py-4 text-xs font-black uppercase text-[var(--text-muted)]">Permissions</th>
                                <th className="px-6 py-4 text-xs font-black uppercase text-[var(--text-muted)] text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {users.map(u => (
                                <tr key={u.id} className="hover:bg-white/5 transition-colors">
                                    <td className="px-6 py-4 font-bold">{u.username}</td>
                                    <td className="px-6 py-4">
                                        <span className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-full ${u.role === 'admin' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
                                            {u.role}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex flex-wrap gap-2">
                                            {u.permissions.map(p => (
                                                <span key={p} className="text-[9px] bg-white/5 border border-white/10 text-[var(--text-muted)] px-2 py-0.5 rounded uppercase tracking-wider">
                                                    {p.replace('_', ' ')}
                                                </span>
                                            ))}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <button onClick={() => openEditModal(u)} className="p-2 text-indigo-400 hover:bg-indigo-500/20 rounded-lg transition-colors mr-2">
                                            ✏️
                                        </button>
                                        {u.role !== 'admin' && (
                                            <button onClick={() => handleDelete(u.id)} className="p-2 text-rose-400 hover:bg-rose-500/20 rounded-lg transition-colors">
                                                🗑
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {isModalOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-[#0f172a] border border-white/10 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl">
                        <div className="p-6 border-b border-white/5 flex justify-between items-center">
                            <h3 className="text-xl font-black uppercase tracking-widest">{editingId ? 'Edit User' : 'Create User'}</h3>
                            <button onClick={() => setIsModalOpen(false)} className="text-[var(--text-muted)] hover:text-white"><Icons.X /></button>
                        </div>
                        <div className="p-6 space-y-6">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-2">Username</label>
                                    <input
                                        type="text"
                                        value={formData.username}
                                        onChange={e => setFormData({ ...formData, username: e.target.value })}
                                        className="w-full bg-black/30 border border-white/10 rounded-lg px-4 py-2.5 outline-none focus:border-indigo-500 transition-colors pointer-events-auto"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-2">Password {editingId && '(Blk to keep)'}</label>
                                    <input
                                        type="password"
                                        value={formData.password}
                                        onChange={e => setFormData({ ...formData, password: e.target.value })}
                                        className="w-full bg-black/30 border border-white/10 rounded-lg px-4 py-2.5 outline-none focus:border-indigo-500 transition-colors pointer-events-auto"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-2">Role</label>
                                    <select
                                        value={formData.role}
                                        onChange={e => {
                                            const role = e.target.value;
                                            setFormData(prev => ({
                                                ...prev,
                                                role,
                                                permissions: role === 'admin' ? [] : prev.permissions
                                            }));
                                        }}
                                        disabled={editingId === 'admin'} // Protect base admin
                                        className="w-full bg-black/30 border border-white/10 rounded-lg px-4 py-3 text-sm font-bold outline-none focus:border-indigo-500 transition-colors pointer-events-auto"
                                    >
                                        <option value="admin">Admin</option>
                                        <option value="mailer">Mailer</option>
                                        <option value="support">Support</option>
                                    </select>
                                </div>
                            </div>

                            {formData.role !== 'admin' && (
                                <div>
                                    <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-4">Permissions</label>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                        {AVAILABLE_PERMISSIONS.map(perm => (
                                            <label key={perm} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${formData.permissions.includes(perm) ? 'bg-indigo-500/10 border-indigo-500/50 text-indigo-300' : 'bg-black/20 border-white/5 text-[var(--text-muted)] opacity-60 hover:opacity-100'}`}>
                                                <input
                                                    type="checkbox"
                                                    className="hidden"
                                                    checked={formData.permissions.includes(perm)}
                                                    onChange={() => togglePermission(perm)}
                                                />
                                                <div className={`w-4 h-4 rounded-sm border flex items-center justify-center ${formData.permissions.includes(perm) ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-white/20'}`}>
                                                    {formData.permissions.includes(perm) && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><polyline points="20 6 9 17 4 12"></polyline></svg>}
                                                </div>
                                                <span className="text-[10px] font-black uppercase tracking-wider">{perm.replace('_', ' ')}</span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="p-6 border-t border-white/5 flex gap-3 justify-end bg-black/20">
                            <button
                                onClick={() => setIsModalOpen(false)}
                                className="px-6 py-2.5 rounded-lg text-sm font-bold text-[var(--text-muted)] hover:bg-white/5 transition-colors"
                            >
                                CANCEL
                            </button>
                            <button
                                onClick={handleSave}
                                className="px-6 py-2.5 rounded-lg text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                            >
                                SAVE USER
                            </button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
};

export default AppUsers;
