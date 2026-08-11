import React, { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, ShieldCheck, UserCog } from 'lucide-react';
import toast from 'react-hot-toast';
import { listAdmins, createAdmin, deleteAdmin, updateAdminRole } from '../api/admins';
import { useCurrentUser } from '../hooks/useCurrentUser';

const ROLE_BADGE = {
  viewer: 'badge-inactive',
  operator: 'badge-active',
  'super-admin': 'badge-stolen',
};

const ROLE_LABEL = {
  viewer: 'Viewer',
  operator: 'Operator',
  'super-admin': 'Super Admin',
};

const ROLE_OPTIONS = ['viewer', 'operator', 'super-admin'];

export default function AdminsPage() {
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const currentUser = useCurrentUser();

  // Create-admin form state
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', role: 'viewer' });
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const { data } = await listAdmins();
      setAdmins(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load admins');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.username || !form.password || !form.role) {
      toast.error('All fields are required');
      return;
    }
    setSubmitting(true);
    try {
      await createAdmin(form);
      toast.success(`Admin "${form.username}" created`);
      setForm({ username: '', password: '', role: 'viewer' });
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create admin');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(admin) {
    if (!confirm(`Delete admin "${admin.username}"? This cannot be undone.`)) return;
    try {
      await deleteAdmin(admin.id);
      toast.success(`Admin "${admin.username}" deleted`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete admin');
    }
  }

  async function handleRoleChange(admin, newRole) {
    if (admin.role === newRole) return;
    try {
      await updateAdminRole(admin.id, newRole);
      toast.success(`${admin.username} role changed to ${ROLE_LABEL[newRole]}`);
      load();
    } catch (err) {
      console.error('AdminsPage role change failed:', err);
      toast.error(err.response?.data?.error || 'Failed to update role');
    }
  }

  const isSelf = (admin) => currentUser && admin.id === currentUser.id;

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <UserCog size={22} className="text-red-400" />
            Admin Management
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            {admins.length} administrator{admins.length === 1 ? '' : 's'} with role-based access
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={load}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>
            <Plus size={14} />
            Add Admin
          </button>
        </div>
      </div>

      {/* Create admin form */}
      {showForm && (
        <form onSubmit={handleCreate} className="card mb-6">
          <h2 className="text-sm font-semibold text-slate-200 mb-4">Create New Admin</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Username</label>
              <input
                className="input"
                placeholder="e.g. jdoe"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                minLength={3}
                maxLength={100}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Password</label>
              <input
                className="input"
                type="password"
                placeholder="min 8 characters"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                minLength={8}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Role</label>
              <select
                className="input"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Admin'}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Admins table */}
      {loading && admins.length === 0 ? (
        <div className="card p-0 overflow-hidden">
          <div className="space-y-3 p-5">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex gap-4">
                <div className="skeleton h-5 flex-1" />
                <div className="skeleton h-5 w-32" />
                <div className="skeleton h-5 w-24" />
              </div>
            ))}
          </div>
        </div>
      ) : admins.length === 0 ? (
        <div className="card text-center text-slate-500 py-16">
          <ShieldCheck size={32} className="mx-auto mb-3 opacity-30" />
          No admins found.
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800/60 text-slate-400 text-xs uppercase">
                <th className="text-left px-5 py-3 font-medium">Username</th>
                <th className="text-left px-5 py-3 font-medium">Role</th>
                <th className="text-left px-5 py-3 font-medium">Created</th>
                <th className="text-right px-5 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id} className="border-b border-slate-800/40 hover:bg-slate-800/30 transition-colors">
                  <td className="px-5 py-3 font-mono text-slate-200">
                    {a.username}
                    {isSelf(a) && (
                      <span className="ml-2 text-xs text-blue-400">(you)</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <span className={ROLE_BADGE[a.role] || 'badge-inactive'}>
                      {ROLE_LABEL[a.role] || a.role}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-slate-400">
                    {a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <select
                        className="input !py-1 !px-2 !text-xs w-32"
                        value={a.role}
                        disabled={isSelf(a)}
                        onChange={(e) => handleRoleChange(a, e.target.value)}
                        title={isSelf(a) ? 'Cannot change your own role' : 'Change role'}
                      >
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                        ))}
                      </select>
                      <button
                        className="btn-ghost !p-2 text-red-400 hover:text-red-300"
                        disabled={isSelf(a)}
                        onClick={() => handleDelete(a)}
                        title={isSelf(a) ? 'Cannot delete your own account' : 'Delete admin'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-5 py-3 text-xs text-slate-500 border-t border-slate-800/40">
            {admins.length} admin{admins.length === 1 ? '' : 's'} total
          </div>
        </div>
      )}
    </div>
  );
}
