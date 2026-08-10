import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ShieldAlert, ShieldCheck, Unlock, RefreshCw, ClipboardList, Loader, Crosshair, MapPin, Square, Locate, UserX, AlertTriangle, FileWarning, Lock } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import toast from 'react-hot-toast';
import api from '../api/client';
import ConfirmModal from '../components/ConfirmModal';
import { useCurrentUser } from '../hooks/useCurrentUser';

const STATUS_BADGE = {
  active: 'badge-active',
  stolen: 'badge-stolen',
  locked: 'badge-locked',
  recovering: 'badge-recovering',
  tracking: 'badge-tracking',
  inactive: 'badge-inactive',
};

/**
 * Parse an audit log detail field.
 * Postgres returns JSONB as a parsed object; SQLite returns TEXT as a string.
 * Returns null if the field is absent or unparseable.
 */
function parseAuditDetail(detail) {
  if (!detail) return null;
  if (typeof detail === 'object') return detail;
  if (typeof detail === 'string') {
    try { return JSON.parse(detail); } catch { return null; }
  }
  return null;
}

/**
 * Find the most recent lockdown-confirmed audit entry and return its parsed
 * detail. Used to surface lockdown-effectiveness status to the operator.
 */
function getLatestLockdownDetail(audit) {
  if (!Array.isArray(audit)) return null;
  for (const entry of audit) {
    if (entry.action === 'agent_lockdown_confirmed') {
      return parseAuditDetail(entry.detail);
    }
  }
  return null;
}

export default function DeviceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const [device, setDevice] = useState(null);
  const [audit, setAudit] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [acting, setActing] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [devRes, auditRes, locRes] = await Promise.all([
        api.get(`/devices/${id}`),
        api.get(`/audit?device_id=${id}&limit=20`),
        api.get(`/devices/${id}/locations?limit=20`).catch(() => ({ data: [] })),
      ]);
      setDevice(devRes.data);
      setAudit(auditRes.data);
      setLocations(locRes.data);
    } catch {
      toast.error('Failed to load device');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]);

  async function flagStolen() {
    setActing(true);
    try {
      await api.post(`/devices/${id}/flag-stolen`, { hostname_confirm: device.hostname });
      toast.success('Device flagged as stolen — lockdown command queued');
      setModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Action failed');
    } finally {
      setActing(false);
    }
  }

  async function recover() {
    setActing(true);
    try {
      await api.post(`/devices/${id}/recover`, { hostname_confirm: device.hostname });
      toast.success('Recovery command queued — unlock key released to agent');
      setModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Action failed');
    } finally {
      setActing(false);
    }
  }

  async function startTracking() {
    setActing(true);
    try {
      await api.post(`/devices/${id}/track`);
      toast.success('Tracking activated — agent will report location silently');
      setModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Action failed');
    } finally {
      setActing(false);
    }
  }

  async function stopTracking() {
    setActing(true);
    try {
      await api.post(`/devices/${id}/stop-track`);
      toast.success('Tracking stopped — device returned to active status');
      setModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Action failed');
    } finally {
      setActing(false);
    }
  }

  async function locateNow() {
    setActing(true);
    try {
      await api.post(`/devices/${id}/locate`);
      toast.success('Location request queued — agent will report on next check-in');
      setModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Action failed');
    } finally {
      setActing(false);
    }
  }

  async function releaseDevice() {
    setActing(true);
    try {
      await api.delete(`/devices/${id}/release`, { data: { hostname_confirm: device.hostname } });
      toast.success('Device released — all associated data has been deleted');
      setModal(null);
      navigate('/devices');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Release failed');
    } finally {
      setActing(false);
    }
  }

  if (loading) return <div className="text-slate-500 text-center py-32">Loading...</div>;
  if (!device) return <div className="text-slate-500 text-center py-32">Device not found.</div>;

  const isOperator = currentUser?.isOperator;
  const latestLocation = locations[0];

  // Phase 17: Lockdown-effectiveness analysis from the most recent lockdown
  // confirmation. This surfaces the dangerous case where the device shows
  // "locked" but boot lockdown silently no-op'd (critical_applied=0).
  const lockdownDetail = getLatestLockdownDetail(audit);
  const isLockedOrStolen = device.status === 'locked' || device.status === 'stolen';
  const lockdownEffective = lockdownDetail?.lockdown_effective;
  const bootLockDetail = lockdownDetail?.boot_lock_detail;
  const showLockdownPanel = isLockedOrStolen && lockdownDetail && lockdownEffective !== null && lockdownEffective !== undefined;

  // D-008/D-010/D-011: Extract new status fields from the lockdown detail
  const encryptionBlockedFiles = lockdownDetail?.encryption_blocked_files;
  const bitlockerStatus = bootLockDetail?.bcd?.bitlocker_status;
  const sureAdminStatus = bootLockDetail?.hp_uefi?.sure_admin_status;
  const lockSessionContext = lockdownDetail?.lock_session_context;
  const hasBlockedFiles = Array.isArray(encryptionBlockedFiles) && encryptionBlockedFiles.length > 0;
  const hasBitlocker = bitlockerStatus?.enabled === true;
  const hasSureAdmin = sureAdminStatus?.any_sure_feature === true;
  const isSessionZero = lockSessionContext?.is_session_zero === true;

  return (
    <div>
      {modal === 'flag' && (
        <ConfirmModal
          title="Flag Device as Stolen"
          description={`This will immediately queue a lockdown command for "${device.hostname}". The agent will encrypt the sensitive folder and replace the shell. Type the device hostname to confirm.`}
          confirmLabel={acting ? 'Processing…' : 'Flag as Stolen'}
          confirmValue={device.hostname}
          onConfirm={flagStolen}
          onCancel={() => setModal(null)}
          danger
        />
      )}
      {modal === 'recover' && (
        <ConfirmModal
          title="Recover Device"
          description={`This will queue an unlock command and release the decryption key for "${device.hostname}". Type the device hostname to confirm.`}
          confirmLabel={acting ? 'Processing…' : 'Recover Device'}
          confirmValue={device.hostname}
          onConfirm={recover}
          onCancel={() => setModal(null)}
          danger={false}
        />
      )}
      {modal === 'track' && (
        <ConfirmModal
          title="Start Covert Tracking"
          description={`This will activate covert tracking on "${device.hostname}". The device remains fully usable — the agent will silently report geolocation. The user will not be notified.`}
          confirmLabel={acting ? 'Processing…' : 'Start Tracking'}
          onConfirm={startTracking}
          onCancel={() => setModal(null)}
          danger={false}
        />
      )}
      {modal === 'stop_track' && (
        <ConfirmModal
          title="Stop Tracking"
          description={`Stop covert tracking on "${device.hostname}"? The device will return to normal active status.`}
          confirmLabel={acting ? 'Processing…' : 'Stop Tracking'}
          onConfirm={stopTracking}
          onCancel={() => setModal(null)}
          danger={false}
        />
      )}
      {modal === 'locate' && (
        <ConfirmModal
          title="Locate Device Now"
          description={`Send a one-time location request to "${device.hostname}"? The agent will report its current location on the next check-in. The device status will not change.`}
          confirmLabel={acting ? 'Processing…' : 'Locate Now'}
          onConfirm={locateNow}
          onCancel={() => setModal(null)}
          danger={false}
        />
      )}
      {modal === 'release' && (
        <ConfirmModal
          title="Release Device from Account"
          description={`This will PERMANENTLY DELETE all data associated with "${device.hostname}", including location history, encryption keys, and command history. The device will need to be re-enrolled if you want to manage it again. This action cannot be undone. Type the device hostname to confirm.`}
          confirmLabel={acting ? 'Processing…' : 'Release & Delete Data'}
          confirmValue={device.hostname}
          onConfirm={releaseDevice}
          onCancel={() => setModal(null)}
          danger
        />
      )}

      <button onClick={() => navigate('/devices')} className="flex items-center gap-2 text-slate-400 hover:text-slate-200 text-sm mb-6">
        <ArrowLeft size={14} /> Back to Devices
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold font-mono text-slate-100">{device.hostname}</h1>
          <p className="text-slate-400 text-sm mt-1">Owner: {device.owner_name}</p>
        </div>
        <span className={STATUS_BADGE[device.status] || 'badge-inactive'}>
          {device.status}
        </span>
      </div>

      {/* Phase 17: Lockdown-effectiveness panel.
          Surfaces the dangerous case where the device shows "locked" but
          boot lockdown silently no-op'd (critical_applied=0). Without this
          panel, the operator has no way to distinguish "fully locked +
          BIOS locked + BCD locked" from "encrypted-only, boots from USB". */}
      {showLockdownPanel && (
        <div className={`card mb-6 border-l-4 ${lockdownEffective ? 'border-l-green-500' : 'border-l-red-500'}`}>
          <div className="flex items-center gap-2 mb-3">
            {lockdownEffective ? (
              <ShieldCheck size={16} className="text-green-400" />
            ) : (
              <AlertTriangle size={16} className="text-red-400" />
            )}
            <h2 className="font-semibold text-slate-200 text-sm">
              Lockdown Effectiveness
            </h2>
            <span className={`text-xs font-medium ml-auto ${lockdownEffective ? 'text-green-400' : 'text-red-400'}`}>
              {lockdownEffective ? 'Boot lockdown applied' : 'BOOT LOCKDOWN INEFFECTIVE'}
            </span>
          </div>

          {!lockdownEffective && (
            <p className="text-xs text-red-300 mb-3 leading-relaxed">
              The device is encrypted, but <strong>zero critical boot-lockdown
              settings</strong> were applied. The machine can likely boot from
              USB/network and bypass the lock screen. The encryption key is the
              only remaining barrier. Manual BIOS lockdown may be required.
            </p>
          )}

          {bootLockDetail && (
            <div className="grid grid-cols-2 gap-4">
              {/* BCD layer */}
              <div>
                <p className="text-xs text-slate-400 mb-1">BCD Lockdown</p>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Critical applied</span>
                    <span className={`font-mono ${bootLockDetail.bcd?.critical_applied > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {bootLockDetail.bcd?.critical_applied ?? '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Best-effort applied</span>
                    <span className="font-mono text-slate-300">{bootLockDetail.bcd?.best_effort_applied ?? '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Best-effort failed</span>
                    <span className="font-mono text-slate-300">{bootLockDetail.bcd?.best_effort_failed ?? '—'}</span>
                  </div>
                  {bootLockDetail.bcd?.rolled_back && (
                    <div className="text-red-400 text-xs pt-1">Rolled back (critical failure)</div>
                  )}
                </div>
              </div>

              {/* HP UEFI layer */}
              <div>
                <p className="text-xs text-slate-400 mb-1">HP UEFI / BIOS</p>
                <div className="space-y-1 text-xs">
                  {bootLockDetail.hp_uefi?.not_hp ? (
                    <div className="text-slate-500 text-xs">Not an HP machine — skipped</div>
                  ) : (
                    <>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Critical applied</span>
                        <span className={`font-mono ${bootLockDetail.hp_uefi?.critical_applied > 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {bootLockDetail.hp_uefi?.critical_applied ?? '—'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Best-effort applied</span>
                        <span className="font-mono text-slate-300">{bootLockDetail.hp_uefi?.best_effort_applied ?? '—'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Best-effort failed</span>
                        <span className="font-mono text-slate-300">{bootLockDetail.hp_uefi?.best_effort_failed ?? '—'}</span>
                      </div>
                      {bootLockDetail.hp_uefi?.rolled_back && (
                        <div className="text-red-400 text-xs pt-1">Rolled back (critical failure)</div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="mt-3 pt-3 border-t border-slate-800/50 text-xs text-slate-500">
            Boot lock status: <span className="font-mono text-slate-400">{lockdownDetail.boot_lock_status || 'full'}</span>
            {' · '}
            Total critical: <span className={`font-mono ${lockdownEffective ? 'text-green-400' : 'text-red-400'}`}>{bootLockDetail?.critical_applied_total ?? 0}</span>
          </div>
        </div>
      )}

      {/* D-011: Encryption blocked files warning.
          Shows when some files couldn't be encrypted because they were
          locked/open by another process (e.g., Office docs, Outlook PSTs). */}
      {isLockedOrStolen && hasBlockedFiles && (
        <div className="card mb-6 border-l-4 border-l-yellow-500">
          <div className="flex items-center gap-2 mb-3">
            <FileWarning size={16} className="text-yellow-400" />
            <h2 className="font-semibold text-slate-200 text-sm">
              Encryption Blocked Files
            </h2>
            <span className="text-xs font-medium ml-auto text-yellow-400">
              {encryptionBlockedFiles.length} file(s) not encrypted
            </span>
          </div>
          <p className="text-xs text-yellow-300/80 mb-3 leading-relaxed">
            These files were locked/open by another process during lockdown
            and could not be encrypted. The lockdown proceeded, but these
            files remain in plaintext on the device.
          </p>
          <ul className="space-y-1">
            {encryptionBlockedFiles.map((file, i) => (
              <li key={i} className="text-xs font-mono text-yellow-200/70 bg-yellow-950/20 px-2 py-1 rounded">
                {file}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* D-010: HP Sure Admin / Sure Run / Sure Start warning.
          Shows when any Sure feature is detected, warning that BIOS changes
          may be reverted on next boot. */}
      {isLockedOrStolen && hasSureAdmin && (
        <div className="card mb-6 border-l-4 border-l-orange-500">
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert size={16} className="text-orange-400" />
            <h2 className="font-semibold text-slate-200 text-sm">
              HP Sure Admin Detected
            </h2>
          </div>
          <p className="text-xs text-orange-300/80 mb-3 leading-relaxed">
            {sureAdminStatus.warning}
          </p>
          <div className="flex gap-3 text-xs">
            {sureAdminStatus.sure_admin_detected && (
              <span className="text-orange-400">Sure Admin</span>
            )}
            {sureAdminStatus.sure_run_detected && (
              <span className="text-orange-400">Sure Run</span>
            )}
            {sureAdminStatus.sure_start_detected && (
              <span className="text-orange-400">Sure Start</span>
            )}
          </div>
        </div>
      )}

      {/* D-008: BitLocker status info.
          Shows when BitLocker is enabled, indicating that protectors were
          suspended during BCD lockdown and resumed after. */}
      {isLockedOrStolen && hasBitlocker && (
        <div className="card mb-6 border-l-4 border-l-blue-500">
          <div className="flex items-center gap-2 mb-3">
            <Lock size={16} className="text-blue-400" />
            <h2 className="font-semibold text-slate-200 text-sm">
              BitLocker Active
            </h2>
            <span className="text-xs font-medium ml-auto text-blue-400">
              {bitlockerStatus.percentage} encrypted
            </span>
          </div>
          <p className="text-xs text-blue-300/80 leading-relaxed">
            BitLocker was enabled on this device. Protectors were suspended
            during BCD lockdown to prevent recovery key prompts, then resumed.
            If BCD changes were rolled back, verify BitLocker protection is
            active.
          </p>
        </div>
      )}

      {/* D-007: Session 0 lock context warning.
          Shows when the agent is running as a Windows service (Session 0),
          indicating that tsdiscon was used instead of LockWorkStation. */}
      {isLockedOrStolen && isSessionZero && (
        <div className="card mb-6 border-l-4 border-l-purple-500">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={16} className="text-purple-400" />
            <h2 className="font-semibold text-slate-200 text-sm">
              Lock Applied from Service Session
            </h2>
            <span className="text-xs font-medium ml-auto text-purple-400">
              Session 0 (ID: {lockSessionContext.session_id})
            </span>
          </div>
          <p className="text-xs text-purple-300/80 leading-relaxed">
            The agent is running as a Windows service in Session 0. The lock
            screen was applied via <span className="font-mono">tsdiscon</span>
            instead of <span className="font-mono">LockWorkStation</span> to
            disconnect the active console session. If the lock does not take
            effect, the agent may need to run in an interactive session
            instead of as a service.
          </p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card">
          <p className="text-xs text-slate-400 mb-1">Last Check-in</p>
          <p className="text-sm font-medium text-slate-200">
            {device.last_checkin
              ? formatDistanceToNow(new Date(device.last_checkin), { addSuffix: true })
              : 'Never'}
          </p>
        </div>
        <div className="card">
          <p className="text-xs text-slate-400 mb-1">Enrolled</p>
          <p className="text-sm font-medium text-slate-200">
            {format(new Date(device.enrolled_at), 'MMM d, yyyy')}
          </p>
        </div>
        <div className="card">
          <p className="text-xs text-slate-400 mb-1">Device ID</p>
          <p className="text-xs font-mono text-slate-400 break-all">{device.id}</p>
        </div>
      </div>

      {/* Latest location card */}
      {latestLocation && (
        <div className="card mb-6">
          <div className="flex items-center gap-2 mb-3">
            <MapPin size={16} className="text-cyan-400" />
            <h2 className="font-semibold text-slate-200 text-sm">Latest Location</h2>
          </div>
          <div className="grid grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-slate-400">Latitude</p>
              <p className="text-sm font-mono text-slate-200">{latestLocation.latitude?.toFixed(4) ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Longitude</p>
              <p className="text-sm font-mono text-slate-200">{latestLocation.longitude?.toFixed(4) ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Source / Accuracy</p>
              <p className="text-sm text-slate-200">
                {latestLocation.source}
                {latestLocation.accuracy_meters ? ` (~${Math.round(latestLocation.accuracy_meters)}m)` : ''}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Reported</p>
              <p className="text-sm text-slate-200">
                {formatDistanceToNow(new Date(latestLocation.reported_at), { addSuffix: true })}
              </p>
            </div>
          </div>
          {latestLocation.city && (
            <p className="text-xs text-slate-400 mt-3">
              {latestLocation.city}, {latestLocation.region}, {latestLocation.country}
            </p>
          )}
        </div>
      )}

      {/* No location data placeholder */}
      {!latestLocation && device.status !== 'recovering' && (
        <div className="card mb-6 text-center">
          <MapPin size={24} className="mx-auto mb-2 text-slate-600" />
          <p className="text-slate-400 text-sm">No location data for this device yet.</p>
          <p className="text-slate-500 text-xs mt-1">
            Click <span className="text-blue-400">Locate Now</span> to request a one-time location ping,
            or <span className="text-cyan-400">Start Tracking</span> for continuous reporting.
          </p>
        </div>
      )}

      <div className="flex gap-3 mb-8">
        <button className="btn-ghost" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
        {isOperator && device.status !== 'stolen' && device.status !== 'locked' && device.status !== 'recovering' && (
          <button className="btn-danger" onClick={() => setModal('flag')}>
            <ShieldAlert size={14} /> Flag as Stolen
          </button>
        )}
        {isOperator && device.status !== 'tracking' && device.status !== 'stolen' && device.status !== 'locked' && device.status !== 'recovering' && (
          <button className="btn-ghost text-cyan-400 border-cyan-700/50 hover:bg-cyan-900/20" onClick={() => setModal('track')}>
            <Crosshair size={14} /> Start Tracking
          </button>
        )}
        {isOperator && device.status === 'tracking' && (
          <button className="btn-ghost text-cyan-400 border-cyan-700/50 hover:bg-cyan-900/20" onClick={() => setModal('stop_track')}>
            <Square size={14} /> Stop Tracking
          </button>
        )}
        {isOperator && device.status !== 'recovering' && (
          <button className="btn-ghost text-blue-400 border-blue-700/50 hover:bg-blue-900/20" onClick={() => setModal('locate')}>
            <Locate size={14} /> Locate Now
          </button>
        )}
        {isOperator && (device.status === 'stolen' || device.status === 'locked') && (
          <button className="btn-success" onClick={() => setModal('recover')}>
            <Unlock size={14} /> Recover Device
          </button>
        )}
        {device.status === 'recovering' && (
          <span className="badge-recovering">
            <Loader size={11} className="animate-spin" />
            Recovery in progress — waiting for agent to decrypt
          </span>
        )}
        {/* Phase 7: Release device (ownership transfer / GDPR erasure) */}
        {isOperator && device.status === 'active' && (
          <button
            className="btn-ghost text-red-400 border-red-800/50 hover:bg-red-900/20 ml-auto"
            onClick={() => setModal('release')}
          >
            <UserX size={14} /> Release Device
          </button>
        )}
      </div>

      {/* Location history */}
      {locations.length > 0 && (
        <div className="card mb-6">
          <div className="flex items-center gap-2 mb-4">
            <MapPin size={16} className="text-slate-400" />
            <h2 className="font-semibold text-slate-200 text-sm">Location History</h2>
          </div>
          <ul className="space-y-2">
            {locations.map((loc) => (
              <li key={loc.id} className="flex items-start gap-4 py-2 border-b border-slate-800/50 last:border-0">
                <span className="text-xs text-slate-500 w-36 shrink-0">
                  {format(new Date(loc.reported_at), 'MMM d, HH:mm:ss')}
                </span>
                <span className="text-xs font-mono text-cyan-400 shrink-0">
                  {loc.latitude?.toFixed(4)}, {loc.longitude?.toFixed(4)}
                </span>
                <span className="text-xs text-slate-500">
                  {loc.source}
                  {loc.city ? ` — ${loc.city}, ${loc.country}` : ''}
                  {loc.accuracy_meters ? ` (~${Math.round(loc.accuracy_meters)}m)` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <ClipboardList size={16} className="text-slate-400" />
          <h2 className="font-semibold text-slate-200 text-sm">Recent Activity</h2>
        </div>
        {audit.length === 0 ? (
          <p className="text-slate-500 text-sm text-center py-8">No audit events yet.</p>
        ) : (
          <ul className="space-y-2">
            {audit.map((a) => (
              <li key={a.id} className="flex items-start gap-4 py-2 border-b border-slate-800/50 last:border-0">
                <span className="text-xs text-slate-500 w-36 shrink-0">
                  {format(new Date(a.timestamp), 'MMM d, HH:mm:ss')}
                </span>
                <span className="text-xs font-mono text-blue-400 shrink-0">{a.action}</span>
                {a.admin_username && (
                  <span className="text-xs text-slate-500">by {a.admin_username}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
