import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldAlert,
  Monitor,
  Crosshair,
  Wifi,
  WifiOff,
  Loader,
  Activity,
  MapPin,
  TrendingUp,
  AlertTriangle,
  ShieldCheck,
  Clock,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import api from '../api/client';
import { safeFromNow } from '../utils/time';

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
  stolen: <ShieldAlert size={11} />,
  locked: <ShieldAlert size={11} />,
  recovering: <Loader size={11} className="animate-spin" />,
  tracking: <Crosshair size={11} />,
  inactive: <WifiOff size={11} />,
};

const AUDIT_ACTION_COLOR = {
  flag_stolen: 'text-red-400',
  agent_lockdown_confirmed: 'text-red-400',
  recover_device: 'text-emerald-400',
  agent_unlock_confirmed: 'text-emerald-400',
  track: 'text-cyan-400',
  agent_track_confirmed: 'text-cyan-400',
  stop_track: 'text-slate-400',
  agent_stop_track_confirmed: 'text-slate-400',
  locate_requested: 'text-blue-400',
};

const AUDIT_DOT_COLOR = {
  flag_stolen: 'bg-red-400',
  agent_lockdown_confirmed: 'bg-red-400',
  recover_device: 'bg-emerald-400',
  agent_unlock_confirmed: 'bg-emerald-400',
  track: 'bg-cyan-400',
  agent_track_confirmed: 'bg-cyan-400',
  stop_track: 'bg-slate-400',
  agent_stop_track_confirmed: 'bg-slate-400',
  locate_requested: 'bg-blue-400',
};

function auditColor(action) {
  return AUDIT_ACTION_COLOR[action] || 'text-slate-400';
}

function auditDot(action) {
  return AUDIT_DOT_COLOR[action] || 'bg-slate-400';
}

export default function OverviewPage() {
  const [devices, setDevices] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    try {
      const [devRes, logRes] = await Promise.all([
        api.get('/devices'),
        api.get('/audit?limit=10'),
      ]);
      setDevices(Array.isArray(devRes.data) ? devRes.data : []);
      setLogs(Array.isArray(logRes.data) ? logRes.data : []);
    } catch {
      toast.error('Failed to load overview data. Check your network connection and try again. If the issue persists, verify the server is running.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const stats = {
    total: devices.length,
    active: devices.filter((d) => d.status === 'active').length,
    stolen: devices.filter((d) => d.status === 'stolen').length,
    locked: devices.filter((d) => d.status === 'locked').length,
    recovering: devices.filter((d) => d.status === 'recovering').length,
    tracking: devices.filter((d) => d.status === 'tracking').length,
    inactive: devices.filter((d) => d.status === 'inactive').length,
  };

  const atRisk = stats.stolen + stats.locked;

  const attentionDevices = devices.filter(
    (d) => d.status !== 'active' && d.status !== 'tracking'
  );

  const segments = [
    { key: 'active', label: 'Active', count: stats.active, color: 'bg-emerald-500' },
    { key: 'stolen', label: 'Stolen', count: stats.stolen, color: 'bg-red-500' },
    { key: 'locked', label: 'Locked', count: stats.locked, color: 'bg-orange-500' },
    { key: 'tracking', label: 'Tracking', count: stats.tracking, color: 'bg-cyan-500' },
    { key: 'recovering', label: 'Recovering', count: stats.recovering, color: 'bg-amber-500' },
  ].filter((s) => s.count > 0);

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <ShieldCheck size={22} className="text-emerald-400" />
            Fleet Overview
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Monitoring {stats.total} device{stats.total === 1 ? '' : 's'} across your organization
          </p>
        </div>
        <button className="btn-ghost" onClick={load} aria-label="Refresh overview data">
          <Loader size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6" aria-live="polite">
        <div className="card card-hover glow-blue">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-slate-400 mb-1">Total Devices</p>
              <p className="text-3xl font-bold text-slate-100">{stats.total}</p>
              <p className="text-xs text-slate-500 mt-1">Enrolled in fleet</p>
            </div>
            <div className="rounded-full bg-blue-500/15 p-2.5">
              <Monitor size={20} className="text-blue-400" />
            </div>
          </div>
        </div>

        <div className="card card-hover glow-emerald">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-slate-400 mb-1">Active</p>
              <p className="text-3xl font-bold text-emerald-400">{stats.active}</p>
              <p className="text-xs text-slate-500 mt-1">Healthy & reporting</p>
            </div>
            <div className="rounded-full bg-emerald-500/15 p-2.5">
              <ShieldCheck size={20} className="text-emerald-400" />
            </div>
          </div>
        </div>

        <div className="card card-hover glow-red">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-slate-400 mb-1">At Risk</p>
              <p className="text-3xl font-bold text-red-400">{atRisk}</p>
              <p className="text-xs text-slate-500 mt-1">Stolen or locked</p>
            </div>
            <div className="rounded-full bg-red-500/15 p-2.5">
              <AlertTriangle size={20} className="text-red-400" />
            </div>
          </div>
        </div>

        <div className="card card-hover glow-cyan">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-slate-400 mb-1">Tracking</p>
              <p className="text-3xl font-bold text-cyan-400">{stats.tracking}</p>
              <p className="text-xs text-slate-500 mt-1">Being located</p>
            </div>
            <div className="rounded-full bg-cyan-500/15 p-2.5">
              <Crosshair size={20} className="text-cyan-400" />
            </div>
          </div>
        </div>
      </div>

      {/* Loading state */}
      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <div className="card">
            <div className="skeleton h-6 w-40 mb-4" />
            <div className="skeleton h-8 w-full mb-3" />
            <div className="skeleton h-4 w-full" />
          </div>
          <div className="card">
            <div className="skeleton h-6 w-40 mb-4" />
            <div className="skeleton h-16 w-full mb-3" />
            <div className="skeleton h-16 w-full mb-3" />
            <div className="skeleton h-16 w-full" />
          </div>
        </div>
      ) : devices.length === 0 ? (
        <div className="card text-center text-slate-500 py-20">
          <Monitor size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-slate-400">No devices enrolled yet.</p>
          <p className="text-slate-500 text-sm mt-1">
            Enroll a device to start monitoring your fleet.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Fleet Status */}
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp size={16} className="text-slate-400" />
              <h2 className="text-sm font-semibold text-slate-200">Fleet Status</h2>
            </div>

            {stats.total > 0 ? (
              <>
                <div className="flex h-3 w-full rounded-full overflow-hidden bg-slate-800">
                  {segments.map((s) => (
                    <div
                      key={s.key}
                      className={s.color}
                      style={{ width: `${(s.count / stats.total) * 100}%` }}
                      title={`${s.label}: ${s.count}`}
                    />
                  ))}
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-2 mt-4">
                  {segments.map((s) => (
                    <div key={s.key} className="flex items-center gap-1.5">
                      <span className={`inline-block h-2.5 w-2.5 rounded-full ${s.color}`} />
                      <span className="text-xs text-slate-400">
                        {s.label} <span className="text-slate-300 font-medium">{s.count}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-slate-500 text-sm">No status data available.</p>
            )}
          </div>

          {/* Recent Activity */}
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <Activity size={16} className="text-slate-400" />
              <h2 className="text-sm font-semibold text-slate-200">Recent Activity</h2>
            </div>

            {logs.length === 0 ? (
              <p className="text-slate-500 text-sm py-6 text-center">No recent activity.</p>
            ) : (
              <div className="space-y-0">
                {logs.slice(0, 10).map((l, idx) => (
                  <div key={l.id || idx} className="relative pl-6 pb-4 last:pb-0">
                    {idx < logs.length - 1 && (
                      <span className="absolute left-[5px] top-3 bottom-0 w-px bg-slate-700" />
                    )}
                    <span
                      className={`absolute left-0 top-1.5 inline-block h-2.5 w-2.5 rounded-full ${auditDot(l.action)}`}
                    />
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5">
                      <div className="min-w-0">
                        <span className={`font-mono text-xs ${auditColor(l.action)}`}>
                          {l.action}
                        </span>
                        <span className="text-slate-400 text-xs ml-1.5">
                          {l.hostname || '—'}
                        </span>
                      </div>
                      <span className="text-slate-500 text-xs flex items-center gap-1 shrink-0">
                        <Clock size={10} />
                        {l.timestamp
                          ? safeFromNow(l.timestamp)
                          : '—'}
                      </span>
                    </div>
                    {l.admin_username && (
                      <p className="text-slate-500 text-xs mt-0.5">by {l.admin_username}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Devices Needing Attention */}
      {!loading && devices.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-4">
            <ShieldAlert size={16} className="text-amber-400" />
            <h2 className="text-sm font-semibold text-slate-200">Devices Needing Attention</h2>
            <span className="text-xs text-slate-500">({attentionDevices.length})</span>
          </div>

          {attentionDevices.length === 0 ? (
            <div className="card text-center text-slate-500 py-10">
              <ShieldCheck size={28} className="mx-auto mb-2 text-emerald-400 opacity-60" />
              <p className="text-slate-400">All devices are operating normally.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {attentionDevices.map((d) => (
                <div
                  key={d.id}
                  className="card card-hover cursor-pointer"
                  onClick={() => navigate(`/devices/${d.id}`)}
                  tabIndex={0}
                  role="button"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-sm text-slate-200 truncate">
                      {d.hostname}
                    </span>
                    <span className={STATUS_BADGE[d.status] || 'badge-inactive'}>
                      {STATUS_ICON[d.status]}
                      {d.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    <MapPin size={11} />
                    {d.last_checkin
                      ? safeFromNow(d.last_checkin)
                      : 'Never checked in'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
