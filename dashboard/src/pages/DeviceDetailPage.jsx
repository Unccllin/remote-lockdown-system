import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ShieldAlert, Unlock, RefreshCw, ClipboardList } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import toast from 'react-hot-toast';
import api from '../api/client';
import ConfirmModal from '../components/ConfirmModal';

const STATUS_BADGE = {
  active: 'badge-active',
  stolen: 'badge-stolen',
  locked: 'badge-locked',
  inactive: 'badge-inactive',
};

export default function DeviceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [device, setDevice] = useState(null);
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [acting, setActing] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [devRes, auditRes] = await Promise.all([
        api.get(`/devices/${id}`),
        api.get(`/audit?device_id=${id}&limit=20`),
      ]);
      setDevice(devRes.data);
      setAudit(auditRes.data);
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

  if (loading) return <div className="text-slate-500 text-center py-32">Loading...</div>;
  if (!device) return <div className="text-slate-500 text-center py-32">Device not found.</div>;

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

      <div className="flex gap-3 mb-8">
        <button className="btn-ghost" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
        {device.status !== 'stolen' && device.status !== 'locked' && (
          <button className="btn-danger" onClick={() => setModal('flag')}>
            <ShieldAlert size={14} /> Flag as Stolen
          </button>
        )}
        {(device.status === 'stolen' || device.status === 'locked') && (
          <button className="btn-success" onClick={() => setModal('recover')}>
            <Unlock size={14} /> Recover Device
          </button>
        )}
      </div>

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
