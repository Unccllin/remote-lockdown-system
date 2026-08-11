import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  Activity, RefreshCw, Server, HardDrive, Database, ListChecks,
  AlertTriangle, ShieldCheck, Clock, Cpu, Wifi, WifiOff,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import { getDetailedHealth } from '../api/health';

const REFRESH_INTERVAL_MS = 30000;

// Fleet status display config (active / stale / missing / dead / never).
const FLEET_STAT = [
  { key: 'active', label: 'Active', color: 'text-emerald-400', dot: 'bg-emerald-400', icon: Wifi },
  { key: 'stale', label: 'Stale', color: 'text-amber-400', dot: 'bg-amber-400', icon: Clock },
  { key: 'missing', label: 'Missing', color: 'text-orange-400', dot: 'bg-orange-400', icon: AlertTriangle },
  { key: 'dead', label: 'Dead', color: 'text-red-400', dot: 'bg-red-400', icon: WifiOff },
  { key: 'never', label: 'Never', color: 'text-slate-400', dot: 'bg-slate-500', icon: WifiOff },
];

function serverColor(status) {
  if (status === 'ok') return { ring: 'border-emerald-500/40', text: 'text-emerald-400', bg: 'bg-emerald-500/10', label: 'Healthy' };
  if (status === 'degraded') return { ring: 'border-amber-500/40', text: 'text-amber-400', bg: 'bg-amber-500/10', label: 'Degraded' };
  return { ring: 'border-red-500/40', text: 'text-red-400', bg: 'bg-red-500/10', label: 'Down' };
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h) parts.push(`${s}s`);
  return parts.join(' ');
}

export default function HealthPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL_MS / 1000);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await getDetailedHealth();
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load health data');
      toast.error('Failed to load health data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh with countdown timer.
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          load();
          return REFRESH_INTERVAL_MS / 1000;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [load]);

  const status = data?.status || 'degraded';
  const sc = serverColor(status);

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Activity size={22} className="text-blue-400" />
            System Health
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Server, database, and fleet monitoring
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500 flex items-center gap-1">
            <Clock size={12} />
            Refreshing in {countdown}s
          </span>
          <button
            className="btn-ghost"
            onClick={() => {
              setCountdown(REFRESH_INTERVAL_MS / 1000);
              load();
            }}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {error && !data && (
        <div className="card border-red-500/30 mb-6">
          <div className="flex items-center gap-2 text-red-400">
            <AlertTriangle size={18} />
            <span className="font-medium">{error}</span>
          </div>
        </div>
      )}

      {/* Server status card */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className={`card border ${sc.ring}`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Server size={16} className="text-slate-400" />
              <h2 className="text-sm font-semibold text-slate-200">Server Status</h2>
            </div>
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${sc.bg} ${sc.text}`}>
              {sc.label}
            </span>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400 flex items-center gap-1.5">
                <Clock size={12} /> Uptime
              </span>
              <span className="text-sm text-slate-200 font-mono">
                {data ? formatUptime(data.server.uptimeSeconds) : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400 flex items-center gap-1.5">
                <Database size={12} /> DB Latency
              </span>
              <span className={`text-sm font-mono ${data?.db?.connected ? 'text-emerald-400' : 'text-red-400'}`}>
                {data ? (data.db.connected ? `${data.db.latencyMs}ms` : 'disconnected') : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400 flex items-center gap-1.5">
                <Cpu size={12} /> Heap Used
              </span>
              <span className="text-sm text-slate-200 font-mono">
                {data ? `${data.server.memory.heapUsedMb} / ${data.server.memory.heapTotalMb} MB` : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400 flex items-center gap-1.5">
                <HardDrive size={12} /> RSS
              </span>
              <span className="text-sm text-slate-200 font-mono">
                {data ? `${data.server.memory.rssMb} MB` : '—'}
              </span>
            </div>
          </div>
        </div>

        {/* Fleet status card */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <ShieldCheck size={16} className="text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-200">Fleet Status</h2>
            <span className="text-xs text-slate-500 ml-auto">
              {data ? data.fleet.total : 0} devices
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {FLEET_STAT.map((s) => {
              const Icon = s.icon;
              const count = data ? data.fleet[s.key] : 0;
              return (
                <div key={s.key} className="flex items-center gap-2 rounded-lg bg-slate-800/40 px-3 py-2">
                  <Icon size={14} className={s.color} />
                  <div className="min-w-0">
                    <div className={`text-lg font-bold ${s.color}`}>{count}</div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wide">{s.label}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Command queue card */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <ListChecks size={16} className="text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-200">Command Queue</h2>
          </div>
          <div className="flex flex-col items-center justify-center py-4">
            <p className={`text-5xl font-bold ${data && data.queueDepth > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
              {data ? data.queueDepth : '—'}
            </p>
            <p className="text-xs text-slate-500 mt-2">Pending commands</p>
          </div>
          <div className="mt-2 text-center">
            {data && data.queueDepth > 0 ? (
              <span className="text-xs text-amber-400 flex items-center justify-center gap-1">
                <AlertTriangle size={11} /> Backlog detected
              </span>
            ) : (
              <span className="text-xs text-emerald-400 flex items-center justify-center gap-1">
                <ShieldCheck size={11} /> Queue clear
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Recent alerts list */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle size={16} className="text-amber-400" />
          <h2 className="text-sm font-semibold text-slate-200">Recent Alerts</h2>
        </div>

        {loading && !data ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="skeleton h-12 w-full" />
            ))}
          </div>
        ) : data && Array.isArray(data.recentAlerts) && data.recentAlerts.length > 0 ? (
          <div className="space-y-0">
            {data.recentAlerts.map((alert, idx) => (
              <div key={alert.id || idx} className="relative pl-6 pb-4 last:pb-0">
                {idx < data.recentAlerts.length - 1 && (
                  <span className="absolute left-[5px] top-3 bottom-0 w-px bg-slate-700" />
                )}
                <span className="absolute left-0 top-1.5 inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5">
                  <span className="font-mono text-xs text-amber-400">{alert.action}</span>
                  <span className="text-slate-500 text-xs flex items-center gap-1">
                    <Clock size={10} />
                    {alert.timestamp
                      ? formatDistanceToNow(new Date(alert.timestamp), { addSuffix: true })
                      : '—'}
                  </span>
                </div>
                {alert.detail && (
                  <p className="text-slate-500 text-xs mt-0.5">
                    {typeof alert.detail === 'string' ? alert.detail : JSON.stringify(alert.detail)}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center text-slate-500 py-10">
            <ShieldCheck size={28} className="mx-auto mb-2 text-emerald-400 opacity-60" />
            <p className="text-slate-400">No recent alerts.</p>
            <p className="text-slate-500 text-sm mt-1">System is operating normally.</p>
          </div>
        )}
      </div>
    </div>
  );
}
