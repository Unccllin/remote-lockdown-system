import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Shield, ShieldCheck, Lock, Unlock, Trash2,
  RefreshCw, Cpu, Loader, Clock, Hash, Monitor, Fingerprint, Eye, EyeOff,
  Link2, Unlink,
} from 'lucide-react';
import toast from 'react-hot-toast';
import pblApi, { pblDevices } from '../api/pblClient';
import { useCurrentUser } from '../hooks/useCurrentUser';

const STATUS_BADGE = {
  active: 'badge-active',
  locked: 'badge-locked',
  recovering: 'badge-recovering',
  tracking: 'badge-tracking',
};

const STATUS_ICON = {
  active: <ShieldCheck size={14} />,
  locked: <Lock size={14} />,
  recovering: <Loader size={14} className="animate-spin" />,
  tracking: <Eye size={14} />,
};

function InfoRow({ icon, label, value, mono }) {
  return (
    <div className="flex items-start gap-3 py-3 border-b border-slate-800 last:border-0">
      <div className="text-slate-500 mt-0.5">{icon}</div>
      <div className="flex-1">
        <p className="text-xs text-slate-500 mb-0.5">{label}</p>
        <p className={`text-sm text-slate-200 ${mono ? 'font-mono break-all' : ''}`}>
          {value || '-'}
        </p>
      </div>
    </div>
  );
}

export default function PblDeviceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const [device, setDevice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  // D-206: PBL ↔ agent device mapping
  const [agentMapping, setAgentMapping] = useState(null);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [linkInput, setLinkInput] = useState('');

  const isOperator = currentUser?.isOperator;

  async function load() {
    setLoading(true);
    try {
      const { data } = await pblApi.get(`/v1/devices/${id}`);
      setDevice(data.device);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to load PBL device';
      toast.error(msg);
      if (err.response?.status === 404) {
        navigate('/pbl-devices');
      }
    } finally {
      setLoading(false);
    }
    // D-206: Load agent mapping in parallel
    loadAgentMapping();
  }

  // D-206: Load the PBL → agent device mapping
  async function loadAgentMapping() {
    setMappingLoading(true);
    try {
      const { data } = await pblDevices.getAgentMapping(id);
      setAgentMapping(data);
    } catch {
      setAgentMapping(null);
    } finally {
      setMappingLoading(false);
    }
  }

  // D-206: Link PBL device to an agent device
  async function handleLinkAgent() {
    if (!linkInput.trim()) {
      toast.error('Enter an agent device ID');
      return;
    }
    setMappingLoading(true);
    try {
      await pblDevices.linkAgentMapping(id, linkInput.trim());
      toast.success('PBL device linked to agent device');
      setLinkInput('');
      await loadAgentMapping();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to link agent device');
    } finally {
      setMappingLoading(false);
    }
  }

  // D-206: Unlink PBL device from agent device
  async function handleUnlinkAgent() {
    if (!confirm('Unlink this PBL device from its agent device record?')) return;
    setMappingLoading(true);
    try {
      await pblDevices.unlinkAgentMapping(id);
      toast.success('PBL device unlinked from agent device');
      await loadAgentMapping();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to unlink agent device');
    } finally {
      setMappingLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleLock() {
    setActionLoading(true);
    try {
      await pblApi.post(`/v1/devices/${id}/lock`);
      toast.success('PBL device locked');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to lock device');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUnlock() {
    setActionLoading(true);
    try {
      await pblApi.post(`/v1/devices/${id}/unlock`);
      toast.success('PBL device unlocked');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to unlock device');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleTrack() {
    if (!confirm(`Activate covert tracking on this device? The device will boot normally and silently report its location. The user will not be notified.`)) return;
    setActionLoading(true);
    try {
      await pblApi.post(`/v1/devices/${id}/track`);
      toast.success('Covert tracking activated');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to activate tracking');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleStopTrack() {
    if (!confirm(`Stop covert tracking on this device? The device will return to normal active status.`)) return;
    setActionLoading(true);
    try {
      await pblApi.post(`/v1/devices/${id}/stop-track`);
      toast.success('Covert tracking stopped');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to stop tracking');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete PBL device ${id?.substring(0, 16)}...? This cannot be undone.`)) return;
    setActionLoading(true);
    try {
      await pblApi.delete(`/v1/devices/${id}`);
      toast.success('PBL device deleted');
      navigate('/pbl-devices');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete device');
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader size={24} className="animate-spin text-blue-400" />
        <span className="ml-3 text-slate-400">Loading PBL device...</span>
      </div>
    );
  }

  if (!device) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-400">PBL device not found</p>
        <button
          onClick={() => navigate('/pbl-devices')}
          className="mt-4 text-blue-400 hover:text-blue-300 text-sm"
        >
          Back to PBL Devices
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/pbl-devices')}
            className="p-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
              <Cpu size={22} className="text-blue-400" />
              PBL Device
            </h1>
            <p className="text-sm text-slate-400 mt-0.5 font-mono">
              {device.device_id?.substring(0, 32)}...
            </p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors text-sm"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Status banner */}
      <div className={`rounded-xl border p-4 flex items-center gap-3 ${
        device.status === 'locked' ? 'border-red-500/30 bg-red-500/5' :
        device.status === 'recovering' ? 'border-yellow-500/30 bg-yellow-500/5' :
        device.status === 'tracking' ? 'border-cyan-500/30 bg-cyan-500/5' :
        'border-green-500/30 bg-green-500/5'
      }`}>
        <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium ${STATUS_BADGE[device.status] || 'badge-inactive'}`}>
          {STATUS_ICON[device.status] || <Shield size={14} />}
          {device.status}
        </span>
        {device.lock_reason && (
          <span className="text-sm text-slate-400">
            Reason: <span className="text-slate-300">{device.lock_reason}</span>
          </span>
        )}
      </div>

      {/* Device info */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
        <h2 className="text-sm font-medium text-slate-400 mb-4">Device Information</h2>
        <InfoRow icon={<Fingerprint size={16} />} label="Device ID (TPM AK hash)" value={device.device_id} mono />
        <InfoRow icon={<Monitor size={16} />} label="Hostname" value={device.hostname} />
        <InfoRow icon={<Hash size={16} />} label="Hardware UUID" value={device.hardware_uuid} mono />
        <InfoRow icon={<Clock size={16} />} label="Enrolled At" value={
          device.enrolled_at ? new Date(device.enrolled_at).toLocaleString() : null
        } />
        <InfoRow icon={<Lock size={16} />} label="Lock Reason" value={device.lock_reason} />
      </div>

      {/* D-206: Agent device mapping */}
      {isOperator && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
          <h2 className="text-sm font-medium text-slate-400 mb-4 flex items-center gap-2">
            <Link2 size={14} />
            Agent Device Mapping
          </h2>
          {mappingLoading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader size={14} className="animate-spin" />
              Loading mapping...
            </div>
          ) : agentMapping?.mapped ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-lg bg-slate-800/50">
                <div>
                  <p className="text-xs text-slate-500 mb-0.5">Linked Agent Device</p>
                  <p className="text-sm text-slate-200 font-mono break-all">
                    {agentMapping.agent_device_id}
                  </p>
                </div>
                <button
                  onClick={handleUnlinkAgent}
                  disabled={mappingLoading}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-400 hover:bg-red-500/10 hover:text-red-400 border border-slate-700 hover:border-red-500/20 transition-colors text-sm"
                >
                  <Unlink size={14} />
                  Unlink
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-slate-500">
                No agent device linked. Enter an agent device UUID to link:
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={linkInput}
                  onChange={(e) => setLinkInput(e.target.value)}
                  placeholder="agent-device-uuid..."
                  className="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm font-mono placeholder-slate-600 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleLinkAgent}
                  disabled={mappingLoading || !linkInput.trim()}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 transition-colors text-sm font-medium disabled:opacity-50"
                >
                  <Link2 size={14} />
                  Link
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      {isOperator && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
          <h2 className="text-sm font-medium text-slate-400 mb-4">Administrative Actions</h2>
          <div className="flex flex-wrap gap-3">
            {device.status !== 'locked' && (
              <button
                onClick={handleLock}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors text-sm font-medium"
              >
                {actionLoading ? <Loader size={14} className="animate-spin" /> : <Lock size={14} />}
                Lock Device
              </button>
            )}
            {device.status === 'locked' && (
              <button
                onClick={handleUnlock}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-500/10 text-green-400 hover:bg-green-500/20 border border-green-500/20 transition-colors text-sm font-medium"
              >
                {actionLoading ? <Loader size={14} className="animate-spin" /> : <Unlock size={14} />}
                Unlock Device
              </button>
            )}
            {device.status !== 'locked' && device.status !== 'tracking' && (
              <button
                onClick={handleTrack}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 border border-cyan-500/20 transition-colors text-sm font-medium"
              >
                {actionLoading ? <Loader size={14} className="animate-spin" /> : <Eye size={14} />}
                Track Device
              </button>
            )}
            {device.status === 'tracking' && (
              <button
                onClick={handleStopTrack}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 border border-cyan-500/20 transition-colors text-sm font-medium"
              >
                {actionLoading ? <Loader size={14} className="animate-spin" /> : <EyeOff size={14} />}
                Stop Tracking
              </button>
            )}
            <button
              onClick={handleDelete}
              disabled={actionLoading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 text-slate-400 hover:bg-red-500/10 hover:text-red-400 border border-slate-700 hover:border-red-500/20 transition-colors text-sm font-medium"
            >
              {actionLoading ? <Loader size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Delete Device
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
