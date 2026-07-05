import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Monitor, RefreshCw, Plus, WifiOff, Wifi, ShieldOff } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import api from '../api/client';

const STATUS_BADGE = {
  active: 'badge-active',
  stolen: 'badge-stolen',
  locked: 'badge-locked',
  inactive: 'badge-inactive',
};

const STATUS_ICON = {
  active: <Wifi size={11} />,
  stolen: <ShieldOff size={11} />,
  locked: <ShieldOff size={11} />,
  inactive: <WifiOff size={11} />,
};

export default function DevicesPage() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/devices');
      setDevices(data);
    } catch {
      toast.error('Failed to load devices');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const stats = {
    total: devices.length,
    active: devices.filter((d) => d.status === 'active').length,
    stolen: devices.filter((d) => d.status === 'stolen').length,
    locked: devices.filter((d) => d.status === 'locked').length,
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Devices</h1>
          <p className="text-slate-400 text-sm mt-1">{stats.total} registered devices</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={load}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button className="btn-primary" onClick={() => navigate('/devices/enroll')}>
            <Plus size={14} />
            Enroll Device
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card">
          <p className="text-xs text-slate-400 mb-1">Active</p>
          <p className="text-3xl font-bold text-emerald-400">{stats.active}</p>
        </div>
        <div className="card">
          <p className="text-xs text-slate-400 mb-1">Stolen / Locked</p>
          <p className="text-3xl font-bold text-red-400">{stats.stolen + stats.locked}</p>
        </div>
        <div className="card">
          <p className="text-xs text-slate-400 mb-1">Total</p>
          <p className="text-3xl font-bold text-slate-100">{stats.total}</p>
        </div>
      </div>

      {loading && devices.length === 0 ? (
        <div className="card text-center text-slate-500 py-16">Loading...</div>
      ) : devices.length === 0 ? (
        <div className="card text-center text-slate-500 py-16">
          <Monitor size={32} className="mx-auto mb-2 opacity-30" />
          No devices enrolled yet.
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase">
                <th className="text-left px-5 py-3 font-medium">Hostname</th>
                <th className="text-left px-5 py-3 font-medium">Owner</th>
                <th className="text-left px-5 py-3 font-medium">Status</th>
                <th className="text-left px-5 py-3 font-medium">Last Check-in</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr
                  key={d.id}
                  className="border-b border-slate-800/50 hover:bg-slate-800/40 cursor-pointer transition-colors"
                  onClick={() => navigate(`/devices/${d.id}`)}
                >
                  <td className="px-5 py-3 font-mono text-slate-200">{d.hostname}</td>
                  <td className="px-5 py-3 text-slate-300">{d.owner_name}</td>
                  <td className="px-5 py-3">
                    <span className={STATUS_BADGE[d.status] || 'badge-inactive'}>
                      {STATUS_ICON[d.status]}
                      {d.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-slate-400">
                    {d.last_checkin
                      ? formatDistanceToNow(new Date(d.last_checkin), { addSuffix: true })
                      : 'Never'}
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
