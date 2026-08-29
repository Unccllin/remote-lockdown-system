import React, { useEffect, useState, useMemo } from 'react';
import { format } from 'date-fns';
import { RefreshCw, ClipboardList, Search, Calendar, User } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';
import { safeFormat } from '../utils/time';

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
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [adminFilter, setAdminFilter] = useState('all');

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/audit?limit=100');
      setLogs(data);
    } catch (err) {
      console.error('AuditPage load failed:', err);
      toast.error('Failed to load audit log. Check your network connection and try again. If the issue persists, verify the server is running.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Derive distinct admin usernames from the logs for the filter dropdown
  const adminOptions = useMemo(() => {
    const set = new Set();
    logs.forEach((l) => { if (l.admin_username) set.add(l.admin_username); });
    return [...set].sort();
  }, [logs]);

  const filtered = useMemo(() => {
    let result = logs;
    // Text search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) =>
        l.action?.toLowerCase().includes(q) ||
        l.hostname?.toLowerCase().includes(q) ||
        l.admin_username?.toLowerCase().includes(q)
      );
    }
    // Admin filter
    if (adminFilter !== 'all') {
      result = result.filter((l) => l.admin_username === adminFilter);
    }
    // Date range filter
    if (dateFrom) {
      const fromTime = new Date(dateFrom).getTime();
      result = result.filter((l) => new Date(l.timestamp).getTime() >= fromTime);
    }
    if (dateTo) {
      // Include the entire end day (add 24h)
      const toTime = new Date(dateTo).getTime() + 24 * 60 * 60 * 1000;
      result = result.filter((l) => new Date(l.timestamp).getTime() <= toTime);
    }
    return result;
  }, [logs, search, adminFilter, dateFrom, dateTo]);

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

      {/* Filter bar — search + date range + admin filter */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className="input pl-10"
            placeholder="Search by action, device, or admin…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search audit logs"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Calendar size={14} className="text-slate-500" />
          <input
            type="date"
            className="input h-9 w-auto text-xs"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            title="From date"
          />
          <span className="text-slate-500 text-xs">to</span>
          <input
            type="date"
            className="input h-9 w-auto text-xs"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            title="To date"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <User size={14} className="text-slate-500" />
          <select
            className="input h-9 w-auto text-xs pr-8"
            value={adminFilter}
            onChange={(e) => setAdminFilter(e.target.value)}
          >
            <option value="all">All admins</option>
            {adminOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        {(dateFrom || dateTo || adminFilter !== 'all') && (
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); setAdminFilter('all'); }}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {loading && logs.length === 0 ? (
        <div className="card p-0 overflow-hidden" role="status" aria-live="polite">
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
        <div className="card text-center text-slate-500 py-16" role="status" aria-live="polite">
          <ClipboardList size={32} className="mx-auto mb-3 opacity-30" />
          {logs.length === 0 ? 'No audit events yet.' : 'No events match your search.'}
        </div>
      ) : (
        <div className="card p-0 overflow-hidden" aria-live="polite">
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
                    {safeFormat(l.timestamp, 'MMM d, yyyy HH:mm:ss')}
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
