import React, { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { RefreshCw, ClipboardList } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';

export default function AuditPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/audit?limit=100');
      setLogs(data);
    } catch {
      toast.error('Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const ACTION_COLOR = {
    flag_stolen: 'text-red-400',
    recover_device: 'text-emerald-400',
    device_enrolled: 'text-blue-400',
    agent_lockdown_confirmed: 'text-orange-400',
    agent_unlock_confirmed: 'text-emerald-400',
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Audit Log</h1>
          <p className="text-slate-400 text-sm mt-1">Immutable record of all admin and agent actions</p>
        </div>
        <button className="btn-ghost" onClick={load}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {loading && logs.length === 0 ? (
        <div className="card text-center text-slate-500 py-16">Loading...</div>
      ) : logs.length === 0 ? (
        <div className="card text-center text-slate-500 py-16">
          <ClipboardList size={32} className="mx-auto mb-2 opacity-30" />
          No audit events yet.
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase">
                <th className="text-left px-5 py-3 font-medium">Timestamp</th>
                <th className="text-left px-5 py-3 font-medium">Action</th>
                <th className="text-left px-5 py-3 font-medium">Device</th>
                <th className="text-left px-5 py-3 font-medium">Admin</th>
                <th className="text-left px-5 py-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-b border-slate-800/50">
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
                  <td className="px-5 py-3 text-slate-500 text-xs font-mono">
                    {l.detail ? JSON.stringify(l.detail) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
