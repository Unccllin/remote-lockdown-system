import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Bell, RefreshCw, X, Monitor, MapPin, ShieldAlert,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import {
  getAlerts, getSeverity, dismissAlert, getDismissedAlertIds, _clearDismissed,
} from '../api/alerts';
import { safeFromNow } from '../utils/time';

const SEVERITY_STYLE = {
  red: {
    stripe: 'border-l-red-500',
    icon: 'text-red-400',
    bg: 'bg-red-500/5',
    label: 'text-red-400',
  },
  amber: {
    stripe: 'border-l-amber-500',
    icon: 'text-amber-400',
    bg: 'bg-amber-500/5',
    label: 'text-amber-400',
  },
  slate: {
    stripe: 'border-l-slate-500',
    icon: 'text-slate-400',
    bg: 'bg-slate-500/5',
    label: 'text-slate-400',
  },
};

const ALERT_ICON = {
  missed_checkin: <Monitor size={18} />,
  location_jump: <MapPin size={18} />,
  failed_unlock: <ShieldAlert size={18} />,
};

const SEVERITY_FILTERS = ['all', 'red', 'amber'];

export default function AlertsPage() {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dismissedIds, setDismissedIds] = useState([]);
  const [severityFilter, setSeverityFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAlerts();
      setAlerts(data);
      setDismissedIds(getDismissedAlertIds());
    } catch {
      toast.error('Failed to load alerts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    let result = alerts.filter((a) => !dismissedIds.includes(a.id));
    if (severityFilter !== 'all') {
      result = result.filter((a) => getSeverity(a.type).level === severityFilter);
    }
    return result;
  }, [alerts, dismissedIds, severityFilter]);

  function handleDismiss(id) {
    dismissAlert(id);
    setDismissedIds([...dismissedIds, id]);
  }

  const counts = useMemo(() => {
    const undismissed = alerts.filter((a) => !dismissedIds.includes(a.id));
    return {
      total: undismissed.length,
      red: undismissed.filter((a) => getSeverity(a.type).level === 'red').length,
      amber: undismissed.filter((a) => getSeverity(a.type).level === 'amber').length,
    };
  }, [alerts, dismissedIds]);

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Bell size={22} className="text-amber-400" />
            Alerts
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Auto-generated fleet alerts — missed check-ins, location anomalies, failed unlocks
          </p>
        </div>
        <button className="btn-ghost" onClick={load}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Summary + filter bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex gap-1.5">
          {SEVERITY_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setSeverityFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all capitalize ${
                severityFilter === s
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                  : 'bg-slate-800/50 text-slate-400 border border-slate-700/30 hover:bg-slate-700/50'
              }`}
            >
              {s === 'all' ? `All (${counts.total})` :
                s === 'red' ? `Critical (${counts.red})` :
                `Warning (${counts.amber})`}
            </button>
          ))}
        </div>
      </div>

      {/* Alert list */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card border-l-4 border-l-slate-700">
              <div className="flex gap-4">
                <div className="skeleton h-10 w-10 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 w-48" />
                  <div className="skeleton h-3 w-32" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="card text-center text-slate-500 py-20">
          <AlertTriangle size={36} className="mx-auto mb-3 opacity-30" />
          <p className="text-slate-400 text-sm">
            {alerts.length === 0 ? 'No alerts detected.' : 'All alerts have been dismissed.'}
          </p>
          <p className="text-slate-500 text-xs mt-1">
            Fleet is operating normally.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((alert) => {
            const sev = getSeverity(alert.type);
            const style = SEVERITY_STYLE[sev.level] || SEVERITY_STYLE.slate;
            return (
              <div
                key={alert.id}
                className={`card border-l-4 ${style.stripe} ${style.bg} transition-all`}
              >
                <div className="flex items-start gap-4">
                  {/* Severity icon */}
                  <div className={`shrink-0 ${style.icon}`}>
                    {ALERT_ICON[alert.type] || <AlertTriangle size={18} />}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs font-semibold ${style.label}`}>
                        {sev.label}
                      </span>
                      <span
                        className="font-mono text-sm text-slate-200 cursor-pointer hover:text-blue-400 transition-colors"
                        onClick={() => navigate(`/devices/${alert.device_id}`)}
                      >
                        {alert.hostname}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">{alert.message}</p>
                    <p className="text-[10px] text-slate-500 mt-1 font-mono">
                      {alert.timestamp
                        ? safeFromNow(alert.timestamp)
                        : '—'}
                    </p>
                  </div>

                  {/* Dismiss button */}
                  <button
                    onClick={() => handleDismiss(alert.id)}
                    className="shrink-0 p-1.5 text-slate-500 hover:text-slate-300 hover:bg-slate-800/60 rounded-lg transition-colors"
                    title="Dismiss alert"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
