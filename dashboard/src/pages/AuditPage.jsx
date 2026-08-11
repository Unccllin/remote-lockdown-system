import React, { useEffect, useState, useMemo } from 'react';
import { format } from 'date-fns';
import { RefreshCw, ClipboardList, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';

const ACTION_COLOR = {
  flag_stolen: 'text-red-400',
  recover_device: 'text-emerald-400',
  device_enrolled: 'text-blue-400',
  agent_lockdown_confirmed: 'text-orange-400',
  agent_unlock_confirmed: 'text-emerald-400',
  agent_deadman_lockdown_confirmed: 'text-red-500',
  track: 'text-cyan-400',
  stop_track: 'text-slate-400',
  locate_requested: 'text-blue-400',
};

export default function AuditPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/audit?limit=100');
      setLogs(data);
    } catch (err) {
      console.error('AuditPage load failed:', err);
      toast.error('Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!search) return logs;
    const q = search.toLowerCase();
    return logs.filter((l) =>
      l.action?.toLowerCase().includes(q) ||
      l.hostname?.toLowerCase().includes(q) ||
      l.admin_username?.toLowerCase().includes(q)
    );
  }, [logs, search]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Audit Log</h1>
          <p className="text-slate-400 text-sm mt-1">Immutable record of all admin and agent actions</p>
        </div>
        <button className="btn-ghost" onClick={load}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4 max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          className="input pl-10"
          placeholder="Search by action, device, or admin…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading && logs.length === 0 ? (
        <div className="card p-0 overflow-hidden">
          <div className="space-y-3 p-5">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex gap-4">
                <div className="skeleton h-5 w-36" />
                <div className="skeleton h-5 w-40" />
                <div className="skeleton h-5 w-28" />
                <div className="skeleton h-5 flex-1" />
              </div>
            ))}
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center text-slate-500 py-16">
          <ClipboardList size={32} className="mx-auto mb-3 opacity-30" />
          {logs.length === 0 ? 'No audit events yet.' : 'No events match your search.'}
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800/60 text-slate-400 text-xs uppercase">
                <th className="text-left px-5 py-3 font-medium">Timestamp</th>
                <th className="text-left px-5 py-3 font-medium">Action</th>
                <th className="text-left px-5 py-3 font-medium">Device</th>
                <th className="text-left px-5 py-3 font-medium">Admin</th>
                <th className="text-left px-5 py-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id} className="border-b border-slate-800/40 hover:bg-slate-800/20 transition-colors">
                  <td className="px-5 py-3 text-slate-500 whitespace-nowrap text-xs">
                    {format(new Date(l.timestamp), 'MMM d, yyyy HH:mm:ss')}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`font-mono text-xs ${ACTION_COLOR[l.action] || 'text-slate-300'}`}>
                      {l.action}
                    </span>
                  </td>
                  <td className="px-5 py-3 font-mono text-slate-400 text-xs">{l.hostname || '—'}</td>
                  <td className="px-5 py-3 text-slate-400 text-xs">{l.admin_username || '—'}</td>
                  <td className="px-5 py-3 text-slate-500 text-xs font-mono max-w-xs truncate">
                    {l.detail ? JSON.stringify(l.detail) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-5 py-3 text-xs text-slate-500 border-t border-slate-800/40">
            Showing {filtered.length} of {logs.length} events
          </div>
        </div>
      )}
    </div>
  );
}
