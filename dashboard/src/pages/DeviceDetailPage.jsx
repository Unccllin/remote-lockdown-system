import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, Circle, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ArrowLeft, ShieldAlert, ShieldCheck, Unlock, RefreshCw, ClipboardList, Loader, Crosshair, MapPin, Square, Locate, UserX, AlertTriangle, FileWarning, Lock, Key, Eye, EyeOff, Copy } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';
import ConfirmModal from '../components/ConfirmModal';
import { useCurrentUser } from '../hooks/useCurrentUser';
import { safeFromNow, safeFormat } from '../utils/time';

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

/**
 * T10: CredentialField — a single PBA credential display row with
 * reveal/hide toggle and copy-to-clipboard button. Credentials are
 * masked by default (shown as "••••••••") to prevent shoulder-surfing.
 */
function CredentialField({ label, value, revealed, onToggle, onCopy }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <p className="text-xs text-slate-400 mb-0.5">{label}</p>
        <p className="text-sm font-mono text-slate-200 bg-slate-900/50 px-2 py-1 rounded">
          {revealed ? value : '----------'}
        </p>
      </div>
      <button
        onClick={onToggle}
        className="p-1.5 text-slate-400 hover:text-slate-200 transition-colors"
        title={revealed ? 'Hide' : 'Reveal'}
      >
        {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
      <button
        onClick={onCopy}
        className="p-1.5 text-slate-400 hover:text-slate-200 transition-colors"
        title="Copy to clipboard"
      >
        <Copy size={14} />
      </button>
    </div>
  );
}

/** Leaflet: auto-fit map bounds to all location points. */
function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView([points[0].latitude, points[0].longitude], 13);
    } else {
      const bounds = L.latLngBounds(
        points.map((p) => [p.latitude, p.longitude])
      );
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }, [points, map]);
  return null;
}

/** Create a colored Leaflet divIcon marker for the device detail map. */
function makeDetailIcon(color, isLatest = false) {
  const pulse = isLatest
    ? `<div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.4;animation:marker-pulse 2s ease-out infinite;"></div>`
    : '';
  const html = `
    <div style="position:relative;width:14px;height:14px;">
      ${pulse}
      <div style="position:absolute;inset:1px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,0.6);"></div>
    </div>
  `;
  return L.divIcon({
    html,
    className: 'custom-marker',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
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
  // T10: PBA Recovery panel state
  const [pbaCredentials, setPbaCredentials] = useState(null);
  const [showPbaCredentials, setShowPbaCredentials] = useState(false);
  const [pbaLoading, setPbaLoading] = useState(false);
  const [revealedCredentials, setRevealedCredentials] = useState({});

  const load = useCallback(async () => {
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
    } catch (err) {
      console.error('DeviceDetailPage load failed:', err);
      toast.error('Failed to load device. Check your network connection and try again. If the issue persists, verify the device ID is correct.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

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

  async function recover(duress = false) {
    setActing(true);
    try {
      await api.post(`/devices/${id}/recover`, {
        hostname_confirm: device.hostname,
        duress_code: duress,
      });
      toast.success(duress
        ? 'Recovery command queued — unlock key released to agent'
        : 'Recovery command queued — unlock key released to agent');
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

  // T10: Fetch PBA credentials for the Recovery panel.
  // Called on-demand when the operator clicks "Show PBA Credentials" —
  // credentials are not fetched on page load to minimize exposure.
  async function fetchPbaCredentials() {
    setPbaLoading(true);
    try {
      const res = await api.get(`/devices/${id}/pba-credentials`);
      setPbaCredentials(res.data);
      setShowPbaCredentials(true);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load PBA credentials. Check your network connection and try again. If the issue persists, verify the device has PBA credentials configured.');
    } finally {
      setPbaLoading(false);
    }
  }

  function copyToClipboard(text, label) {
    navigator.clipboard.writeText(text).then(() => {
      toast.success(`${label} copied to clipboard`);
    }).catch(() => {
      toast.error('Failed to copy');
    });
  }

  function toggleReveal(key) {
    setRevealedCredentials(prev => ({ ...prev, [key]: !prev[key] }));
  }

  if (loading) return <div className="text-slate-500 text-center py-32">Loading...</div>;
  if (!device) return <div className="text-slate-500 text-center py-32">Device not found.</div>;

  const isOperator = currentUser?.isOperator;
  const isSuperAdmin = currentUser?.isSuperAdmin;
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
  // T10: PBA Active detection — from boot_lock_detail (T7 pba_active flag)
  // or from bitlocker PBA (T9 — if bitlocker_pin or recovery password exists
  // in the credentials, PBA is active)
  const pbaActive = bootLockDetail?.hp_uefi?.pba_active === true;

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
          onConfirm={() => recover(false)}
          onCancel={() => setModal(null)}
          danger={false}
        />
      )}
      {modal === 'recover_duress' && (
        <ConfirmModal
          title="Release with Duress Code"
          description={`This will queue an unlock command for "${device.hostname}" that PRETENDS to unlock. The agent will show a normal desktop, then silently re-encrypt files and re-lock after a short delay. Use this if someone is forcing you to unlock the device. Type the device hostname to confirm.`}
          confirmLabel={acting ? 'Processing…' : 'Release with Duress Code'}
          confirmValue={device.hostname}
          onConfirm={() => recover(true)}
          onCancel={() => setModal(null)}
          danger
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
        <div className="flex items-center gap-2">
          {pbaActive && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-950/40 text-red-400 border border-red-800/50">
              <Key size={10} /> PBA Active
            </span>
          )}
          <span className={STATUS_BADGE[device.status] || 'badge-inactive'}>
            {device.status}
          </span>
        </div>
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
            {sureAdminStatus.warning ||
              'HP Sure features detected. BIOS changes may be reverted on next boot.'}
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
              {bitlockerStatus.percentage != null
                ? `${bitlockerStatus.percentage} encrypted`
                : 'Encryption active'}
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

      {/* T10: PBA Recovery panel.
          Shows when PBA is active (Tier 1 HP Power-On Password and/or
          Tier 2 BitLocker TPM+PIN). The super-admin needs these credentials
          to physically unlock a rebooted PBA device. Credentials are
          fetched on-demand to minimize exposure. Only super-admins can
          access the PBA credentials endpoint. Served by both Express and
          the Worker (S4-serverless P3). */}
      {isLockedOrStolen && pbaActive && isSuperAdmin && (
        <div className="card mb-6 border-l-4 border-l-red-500">
          <div className="flex items-center gap-2 mb-3">
            <Key size={16} className="text-red-400" />
            <h2 className="font-semibold text-slate-200 text-sm">
              PBA Recovery
            </h2>
            <span className="text-xs font-medium ml-auto text-red-400">
              Pre-Boot Authentication Active
            </span>
          </div>

          <div className="bg-red-950/30 border border-red-800/50 rounded p-3 mb-4">
            <p className="text-xs text-red-300 leading-relaxed">
              <strong>WARNING:</strong> Remote unlock will not work if the
              device has rebooted. Physical access required to enter these
              credentials at the pre-boot prompt. If no one can physically
              access the device, there is no remote recovery path.
            </p>
          </div>

          {!showPbaCredentials ? (
            <button
              onClick={fetchPbaCredentials}
              disabled={pbaLoading}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition-colors"
            >
              {pbaLoading ? (
                <><Loader size={12} className="animate-spin" /> Loading…</>
              ) : (
                <><Eye size={12} /> Show PBA Credentials</>
              )}
            </button>
          ) : pbaCredentials ? (
            <div className="space-y-3">
              {/* BitLocker PIN */}
              {pbaCredentials.bitlocker_pin && (
                <CredentialField
                  label="BitLocker PIN"
                  value={pbaCredentials.bitlocker_pin}
                  revealed={!!revealedCredentials.bitlocker_pin}
                  onToggle={() => toggleReveal('bitlocker_pin')}
                  onCopy={() => copyToClipboard(pbaCredentials.bitlocker_pin, 'BitLocker PIN')}
                />
              )}

              {/* BitLocker Recovery Password (48-digit) */}
              {pbaCredentials.bitlocker_recovery_password && (
                <CredentialField
                  label="BitLocker Recovery Password (48-digit)"
                  value={pbaCredentials.bitlocker_recovery_password}
                  revealed={!!revealedCredentials.bitlocker_recovery_password}
                  onToggle={() => toggleReveal('bitlocker_recovery_password')}
                  onCopy={() => copyToClipboard(pbaCredentials.bitlocker_recovery_password, 'Recovery Password')}
                />
              )}

              {/* HP Power-On Password */}
              {pbaCredentials.power_on_password && (
                <CredentialField
                  label="HP Power-On Password"
                  value={pbaCredentials.power_on_password}
                  revealed={!!revealedCredentials.power_on_password}
                  onToggle={() => toggleReveal('power_on_password')}
                  onCopy={() => copyToClipboard(pbaCredentials.power_on_password, 'Power-On Password')}
                />
              )}

              {/* HP Setup Password */}
              {pbaCredentials.setup_password && (
                <CredentialField
                  label="HP Setup Password"
                  value={pbaCredentials.setup_password}
                  revealed={!!revealedCredentials.setup_password}
                  onToggle={() => toggleReveal('setup_password')}
                  onCopy={() => copyToClipboard(pbaCredentials.setup_password, 'Setup Password')}
                />
              )}

              {/* If all credentials are null */}
              {!pbaCredentials.bitlocker_pin &&
                !pbaCredentials.bitlocker_recovery_password &&
                !pbaCredentials.power_on_password &&
                !pbaCredentials.setup_password && (
                <p className="text-xs text-slate-500">
                  No PBA credentials found for this device.
                </p>
              )}

              <div className="pt-2 border-t border-slate-800/50">
                <p className="text-xs text-slate-500">
                  See <span className="font-mono text-slate-400">docs/PBA_RECOVERY_RUNBOOK.md</span> for step-by-step recovery instructions.
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">No PBA credentials found.</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card">
          <p className="text-xs text-slate-400 mb-1">Last Check-in</p>
          <p className="text-sm font-medium text-slate-200">
            {device.last_checkin
              ? safeFromNow(device.last_checkin)
              : 'Never'}
          </p>
        </div>
        <div className="card">
          <p className="text-xs text-slate-400 mb-1">Enrolled</p>
          <p className="text-sm font-medium text-slate-200">
            {safeFormat(device.enrolled_at, 'MMM d, yyyy')}
          </p>
        </div>
        <div className="card">
          <p className="text-xs text-slate-400 mb-1">Device ID</p>
          <p className="text-xs font-mono text-slate-400 break-all">{device.id}</p>
        </div>
      </div>

      {/* Hardware Identity — physical-machine identifiers that persist even
          if the hostname changes (e.g. after theft). Lets the admin confirm
          they are looking at the right physical box. */}
      <div className="card mb-6">
        <h2 className="font-semibold text-slate-200 text-sm mb-3">Hardware Identity</h2>
        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-xs text-slate-500">Serial Number</span>
            <span className={`text-sm font-mono ${device.serial_number ? 'text-slate-200' : 'text-slate-400'}`}>
              {device.serial_number || 'N/A'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs text-slate-500">Hardware UUID</span>
            <span className={`text-sm font-mono ${device.hardware_uuid ? 'text-slate-200' : 'text-slate-400'}`}>
              {device.hardware_uuid || 'N/A'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs text-slate-500">MAC Address</span>
            <span className={`text-sm font-mono ${device.mac_address ? 'text-slate-200' : 'text-slate-400'}`}>
              {device.mac_address || 'N/A'}
            </span>
          </div>
        </div>
      </div>

      {/* Firmware Posture — agent-reported SPI/Secure-Boot recon. Tells the
          operator which PblPersistDxe delivery path is possible per unit:
          signed capsule / Setup-Mode key enrollment / external flash. */}
      {device.firmware_audit && typeof device.firmware_audit === 'object' && (
        <div className="card mb-6">
          <h2 className="font-semibold text-slate-200 text-sm mb-3">Firmware Posture</h2>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-xs text-slate-500">Secure Boot</span>
              <span className={`text-sm font-medium ${
                device.firmware_audit.secure_boot === true ? 'text-green-400'
                : device.firmware_audit.secure_boot === false ? 'text-red-400'
                : 'text-slate-400'
              }`}>
                {device.firmware_audit.secure_boot === true ? 'Enabled'
                  : device.firmware_audit.secure_boot === false ? 'Disabled'
                  : 'Unknown'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-slate-500">Setup Mode</span>
              <span className={`text-sm font-medium ${
                device.firmware_audit.setup_mode === true ? 'text-amber-400'
                : device.firmware_audit.setup_mode === false ? 'text-slate-200'
                : 'text-slate-400'
              }`}>
                {device.firmware_audit.setup_mode === true ? 'Yes (db writable)'
                  : device.firmware_audit.setup_mode === false ? 'No'
                  : 'Unknown'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-slate-500">TPM Enabled</span>
              <span className={`text-sm font-medium ${
                device.firmware_audit.tpm_enabled === true ? 'text-green-400'
                : device.firmware_audit.tpm_enabled === false ? 'text-red-400'
                : 'text-slate-400'
              }`}>
                {device.firmware_audit.tpm_enabled === true ? 'Yes'
                  : device.firmware_audit.tpm_enabled === false ? 'No'
                  : 'Unknown'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-slate-500">BIOS Vendor</span>
              <span className="text-sm font-mono text-slate-200">
                {device.firmware_audit.bios_vendor || 'N/A'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-slate-500">Manufacturer / Model</span>
              <span className="text-sm font-mono text-slate-200">
                {[device.firmware_audit.manufacturer, device.firmware_audit.model]
                  .filter(Boolean).join(' ') || 'N/A'}
              </span>
            </div>
            {device.firmware_audit.note && (
              <div className="pt-2 border-t border-slate-800/50">
                <p className="text-xs text-slate-500">
                  Note: <span className="text-slate-400">{device.firmware_audit.note}</span>
                </p>
              </div>
            )}
            <div className="pt-2 border-t border-slate-800/50">
              <p className="text-xs text-slate-500">
                Audited {safeFromNow(device.firmware_audit_at)}
                {device.firmware_audit.spi_registers === null && (
                  <span className="text-slate-500"> · SPI registers need kernel probe</span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Location map + details — dark-themed Leaflet map with GPS pin,
          accuracy radius, and location history trail. */}
      {locations.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
          {/* Map — takes 3/5 width on desktop */}
          <div className="lg:col-span-3 card p-0 overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-800/60">
              <MapPin size={16} className="text-cyan-400" />
              <h2 className="font-semibold text-slate-200 text-sm">Location Map</h2>
              <span className="text-xs text-slate-500 ml-auto">
                {locations.length} report{locations.length === 1 ? '' : 's'}
              </span>
            </div>
            <MapContainer
              center={[latestLocation.latitude, latestLocation.longitude]}
              zoom={13}
              scrollWheelZoom={true}
              style={{ height: '400px', width: '100%' }}
              className="rounded-b-2xl"
            >
              <TileLayer
                url="https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=en"
                subdomains={['0', '1', '2', '3']}
                maxZoom={21}
                attribution='&copy; Google Maps'
              />
              <FitBounds points={locations} />

              {/* Location history trail — polyline connecting all points */}
              {locations.length > 1 && (
                <Polyline
                  positions={locations.map((l) => [l.latitude, l.longitude]).reverse()}
                  pathOptions={{
                    color: '#06b6d4',
                    weight: 2,
                    opacity: 0.5,
                    dashArray: '5,8',
                  }}
                />
              )}

              {/* Markers for each location point */}
              {locations.map((loc, idx) => {
                const isLatest = idx === 0;
                const color = isLatest ? '#06b6d4' : '#64748b';
                const pos = [loc.latitude, loc.longitude];
                return (
                  <Marker key={loc.id || idx} position={pos} icon={makeDetailIcon(color, isLatest)}>
                    <Popup>
                      <div style={{ minWidth: 180 }}>
                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                          {isLatest ? 'Latest Location' : `Report #${locations.length - idx}`}
                        </div>
                        <div style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace', marginBottom: 2 }}>
                          {loc.latitude?.toFixed(4)}, {loc.longitude?.toFixed(4)}
                        </div>
                        {(loc.city || loc.country) && (
                          <div style={{ fontSize: 11, color: '#475569', marginBottom: 2 }}>
                            {[loc.city, loc.region, loc.country].filter(Boolean).join(', ')}
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: '#475569' }}>
                          {loc.reported_at
                            ? safeFromNow(loc.reported_at)
                            : '—'}
                        </div>
                      </div>
                    </Popup>
                    {/* Accuracy radius circle for latest location */}
                    {isLatest && loc.accuracy_meters && (
                      <Circle
                        center={pos}
                        radius={loc.accuracy_meters}
                        pathOptions={{
                          color: '#06b6d4',
                          fillColor: '#06b6d4',
                          fillOpacity: 0.1,
                          weight: 1,
                        }}
                      />
                    )}
                  </Marker>
                );
              })}
            </MapContainer>
          </div>

          {/* Location details — takes 2/5 width on desktop */}
          <div className="lg:col-span-2 space-y-4">
            <div className="card">
              <div className="flex items-center gap-2 mb-3">
                <MapPin size={16} className="text-cyan-400" />
                <h2 className="font-semibold text-slate-200 text-sm">Latest Location</h2>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-xs text-slate-400">Coordinates</span>
                  <span className="text-sm font-mono text-slate-200">
                    {latestLocation.latitude?.toFixed(4)}, {latestLocation.longitude?.toFixed(4)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-slate-400">Source</span>
                  <span className="text-sm text-slate-200">{latestLocation.source}</span>
                </div>
                {latestLocation.accuracy_meters && (
                  <div className="flex justify-between">
                    <span className="text-xs text-slate-400">Accuracy</span>
                    <span className="text-sm font-mono text-slate-200">
                      ~{Math.round(latestLocation.accuracy_meters)}m
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-xs text-slate-400">Reported</span>
                  <span className="text-sm text-slate-200">
                    {safeFromNow(latestLocation.reported_at)}
                  </span>
                </div>
                {latestLocation.city && (
                  <div className="pt-2 border-t border-slate-800/50">
                    <p className="text-xs text-slate-400">
                      {latestLocation.city}, {latestLocation.region}, {latestLocation.country}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Location history mini-list */}
            {locations.length > 1 && (
              <div className="card">
                <h2 className="font-semibold text-slate-200 text-sm mb-3">History Trail</h2>
                <ul className="space-y-1.5 max-h-48 overflow-y-auto">
                  {locations.map((loc, idx) => (
                    <li key={loc.id || idx} className="flex items-center gap-2 text-xs">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${idx === 0 ? 'bg-cyan-400' : 'bg-slate-600'}`}
                      />
                      <span className="font-mono text-slate-400">
                        {loc.latitude?.toFixed(2)}, {loc.longitude?.toFixed(2)}
                      </span>
                      <span className="text-slate-500 ml-auto">
                        {safeFromNow(loc.reported_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      ) : device.status !== 'recovering' && (
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
        {isOperator && (device.status === 'stolen' || device.status === 'locked') && (
          <button
            className="btn-ghost text-amber-400 border-amber-700/50 hover:bg-amber-900/20"
            onClick={() => setModal('recover_duress')}
            title="Pretend to unlock — silently re-locks after a delay"
          >
            <ShieldAlert size={14} /> Release with Duress Code
          </button>
        )}
        {device.status === 'recovering' && (
          <span className="badge-recovering">
            <Loader size={11} className="animate-spin" />
            Recovery in progress — waiting for agent to decrypt
          </span>
        )}
        {/* Phase 7: Release device (ownership transfer / GDPR erasure).
            Served by both Express and the Worker (S4-serverless P3). */}
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
                  {safeFormat(loc.reported_at, 'MMM d, HH:mm:ss')}
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
                  {safeFormat(a.timestamp, 'MMM d, HH:mm:ss')}
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
