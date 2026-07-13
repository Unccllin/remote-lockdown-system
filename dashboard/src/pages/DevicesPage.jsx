import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Monitor, RefreshCw, Plus, WifiOff, Wifi, ShieldOff, Loader,
  Crosshair, Search, ArrowUpDown, ArrowUp, ArrowDown, Users,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import api from '../api/client';

const STATUS_BADGE = {
  active: 'badge-active',
  stolen: 'badge-stolen',
  locked: 'badge-locked',
  recovering: 'badge-recovering',
  tracking: 'badge-tracking',
  inactive: 'badge-inactive',
};

const STATUS_ICON = {
  active: <Wifi size={11} />,
  stolen: <ShieldOff size={11} />,
  locked: <ShieldOff size={11} />,
  recovering: <Loader size={11} className="animate-spin" />,
  tracking: <Crosshair size={11} />,
  inactive: <WifiOff size={11} />,
};

const STATUS_FILTERS = ['all', 'active', 'stolen', 'locked', 'tracking', 'recovering'];

export default function DevicesPage() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortField, setSortField] = useState('enrolled_at');
  const [sortDir, setSortDir] = useState('desc');
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/devices');
      setDevices(Array.isArray(data) ? data : []);
    } catch {
      toast.error('Failed to load devices');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const stats = useMemo(() => ({
    total: devices.length,
    active: devices.filter((d) => d.status === 'active').length,
    stolen: devices.filter((d) => d.status === 'stolen').length,
    locked: devices.filter((d) => d.status === 'locked').length,
    recovering: devices.filter((d) => d.status === 'recovering').length,
    tracking: devices.filter((d) => d.status === 'tracking').length,
  }), [devices]);

  const filtered = useMemo(() => {
    let result = devices;
    if (statusFilter !== 'all') {
      result = result.filter((d) => d.status === statusFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((d) =>
        d.hostname?.toLowerCase().includes(q) ||
        d.owner_name?.toLowerCase().includes(q)
      );
    }
    result = [...result].sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];
      if (sortField === 'last_checkin') {
        aVal = aVal ? new Date(aVal).getTime() : 0;
        bVal = bVal ? new Date(bVal).getTime() : 0;
      } else {
        aVal = String(aVal || '').toLowerCase();
        bVal = String(bVal || '').toLowerCase();
      }
      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return result;
  }, [devices, search, statusFilter, sortField, sortDir]);

  function toggleSort(field) {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  function SortIcon({ field }) {
    if (sortField !== field) return <ArrowUpDown size={12} className="text-slate-600" />;
    return sortDir === 'asc' ? <ArrowUp size={12} className="text-blue-400" /> : <ArrowDown size={12} className="text-blue-400" />;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
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

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <div className="card glow-emerald">
          <p className="text-xs text-slate-400 mb-1">Active</p>
          <p className="text-3xl font-bold text-emerald-400">{stats.active}</p>
        </div>
        <div className="card glow-red">
          <p className="text-xs text-slate-400 mb-1">Stolen / Locked</p>
          <p className="text-3xl font-bold text-red-400">{stats.stolen + stats.locked}</p>
        </div>
        <div className="card glow-cyan">
          <p className="text-xs text-slate-400 mb-1">Tracking</p>
          <p className="text-3xl font-bold text-cyan-400">{stats.tracking}</p>
        </div>
        <div className="card glow-amber">
          <p className="text-xs text-slate-400 mb-1">Recovering</p>
          <p className="text-3xl font-bold text-amber-400">{stats.recovering}</p>
        </div>
        <div className="card glow-blue">
          <p className="text-xs text-slate-400 mb-1">Total</p>
          <p className="text-3xl font-bold text-slate-100">{stats.total}</p>
        </div>
      </div>

      {/* Search + Filter bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className="input pl-10"
            placeholder="Search by hostname or owner…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all capitalize ${
                statusFilter === s
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                  : 'bg-slate-800/50 text-slate-400 border border-slate-700/30 hover:bg-slate-700/50'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Device table */}
      {loading && devices.length === 0 ? (
        <div className="card p-0 overflow-hidden">
          <div className="space-y-3 p-5">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex gap-4">
                <div className="skeleton h-5 flex-1" />
                <div className="skeleton h-5 w-32" />
                <div className="skeleton h-5 w-24" />
                <div className="skeleton h-5 w-28" />
              </div>
            ))}
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center text-slate-500 py-16">
          <Monitor size={32} className="mx-auto mb-3 opacity-30" />
          {devices.length === 0 ? 'No devices enrolled yet.' : 'No devices match your filters.'}
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800/60 text-slate-400 text-xs uppercase">
                <th className="text-left px-5 py-3 font-medium cursor-pointer select-none hover:text-slate-200" onClick={() => toggleSort('hostname')}>
                  <span className="inline-flex items-center gap-1.5">Hostname <SortIcon field="hostname" /></span>
                </th>
                <th className="text-left px-5 py-3 font-medium cursor-pointer select-none hover:text-slate-200" onClick={() => toggleSort('owner_name')}>
                  <span className="inline-flex items-center gap-1.5">Owner <SortIcon field="owner_name" /></span>
                </th>
                <th className="text-left px-5 py-3 font-medium">Status</th>
                <th className="text-left px-5 py-3 font-medium cursor-pointer select-none hover:text-slate-200" onClick={() => toggleSort('last_checkin')}>
                  <span className="inline-flex items-center gap-1.5">Last Check-in <SortIcon field="last_checkin" /></span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr
                  key={d.id}
                  className="border-b border-slate-800/40 hover:bg-slate-800/30 cursor-pointer transition-colors"
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
          <div className="px-5 py-3 text-xs text-slate-500 border-t border-slate-800/40">
            Showing {filtered.length} of {stats.total} devices
          </div>
        </div>
      )}
    </div>
  );
}
