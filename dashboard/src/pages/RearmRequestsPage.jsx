import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, KeyRound, RefreshCw, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { listRearmRequests, approveRearmRequest, denyRearmRequest } from '../api/rearm';

/**
 * Re-arm approvals (ADR-011, D-226).
 *
 * A device whose agent was wiped asks to be re-armed by POSTing its hardware UUID. That UUID is printed
 * in firmware setup and readable from Windows, so it identifies a machine without authenticating one —
 * the request waits here instead of getting a key. Approving is single-use and expires after 15 minutes,
 * which is why the notice says so: the technician at the machine has to retry inside that window.
 */
export default function RearmRequestsPage() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(null); // { deviceId, action }
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await listRearmRequests();
      setRequests(Array.isArray(data?.requests) ? data.requests : []);
    } catch (err) {
      toast.error(
        err.response?.data?.error ||
          'Failed to load re-arm requests. Check your network connection and try again. If the issue persists, verify you have super-admin permissions.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(deviceId, action) {
    setBusy(deviceId);
    try {
      if (action === 'approve') await approveRearmRequest(deviceId);
      else await denyRearmRequest(deviceId);

      toast.success(
        action === 'approve'
          ? 'Approved. The device has 15 minutes to retry its recovery.'
          : 'Denied. The device will keep its current credentials.',
      );
      setConfirming(null);
      // Reload rather than splice: the decision may have been taken by another admin, and the queue is
      // the authority on what is still pending.
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || `Failed to ${action} the request.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100 flex items-center gap-2">
            <KeyRound size={22} className="text-amber-400" />
            Re-arm Requests
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            A device whose agent was wiped asks to be re-armed. It cannot prove who it is — the hardware
            UUID is printed in firmware setup — so it waits for you.
          </p>
        </div>
        <button className="btn-secondary flex items-center gap-2" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="card border-amber-500/20 bg-amber-950/20 flex gap-3">
        <AlertCircle className="text-amber-400 shrink-0 mt-0.5" size={18} />
        <div className="text-sm text-amber-200/80">
          <p className="font-medium text-amber-300 mb-1">An approval expires after 15 minutes</p>
          <p>
            It is also single-use: the device spends it on its next attempt and a second device cannot
            reuse it. Approve only when someone is at the machine and has just asked for recovery.
          </p>
        </div>
      </div>

      {loading && requests.length === 0 ? (
        <div className="card text-sm text-slate-400">Loading…</div>
      ) : requests.length === 0 ? (
        <div className="card text-sm text-slate-400">
          No pending requests. A device appears here after a failed re-arm attempt of its own.
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Hardware UUID</th>
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">From</th>
                <th className="px-4 py-3 text-right">Decision</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const deviceId = r.device_id || r.deviceId;
                const isConfirming = confirming?.deviceId === deviceId;
                return (
                  <tr key={deviceId} className="border-t border-slate-800">
                    <td className="px-4 py-3 text-slate-200">
                      {r.hostname || r.device_hostname || deviceId}
                    </td>
                    <td className="px-4 py-3">
                      <span className="badge-stolen">{r.device_status || r.status || 'pending'}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{r.hardware_uuid}</td>
                    <td className="px-4 py-3 text-slate-400">
                      {r.requested_at ? new Date(r.requested_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{r.source_ip || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {isConfirming ? (
                          <>
                            <button
                              className="btn-primary flex items-center gap-1"
                              disabled={busy === deviceId}
                              onClick={() => decide(deviceId, confirming.action)}
                            >
                              <Check size={14} />
                              Confirm {confirming.action}
                            </button>
                            <button
                              className="btn-secondary"
                              onClick={() => setConfirming(null)}
                              disabled={busy === deviceId}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn-primary flex items-center gap-1"
                              onClick={() => setConfirming({ deviceId, action: 'approve' })}
                            >
                              <Check size={14} />
                              Approve
                            </button>
                            <button
                              className="btn-secondary flex items-center gap-1"
                              onClick={() => setConfirming({ deviceId, action: 'deny' })}
                            >
                              <X size={14} />
                              Deny
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
