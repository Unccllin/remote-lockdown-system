import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield, ShieldCheck, Trash2, RefreshCw, Search,
  Lock, Unlock, Cpu, Loader,
} from 'lucide-react';
import toast from 'react-hot-toast';
import pblApi from '../api/pblClient';
import { useCurrentUser } from '../hooks/useCurrentUser';

const STATUS_BADGE = {
  active: 'badge-active',
  locked: 'badge-locked',
  recovering: 'badge-recovering',
};

const STATUS_ICON = {
  active: <ShieldCheck size={11} />,
  locked: <Lock size={11} />,
  recovering: <Loader size={11} className="animate-spin" />,
};

export default function PblDevicesPage() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [actionLoading, setActionLoading] = useState(null);
  const currentUser = useCurrentUser();
  const navigate = useNavigate();

  const isOperator = currentUser?.isOperator;

  async function load() {
    setLoading(true);
    try {
      const { data } = await pblApi.get('/v1/devices');
      const devs = data.devices || [];
      setDevices(devs);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to load PBL devices';
      toast.error(msg);
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleLock(deviceId) {
    setActionLoading(`lock-${deviceId}`);
    try {
      await pblApi.post(`/v1/devices/${deviceId}/lock`);
      toast.success('PBL device locked');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to lock device');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleUnlock(deviceId) {
    setActionLoading(`unlock-${deviceId}`);
    try {
      await pblApi.post(`/v1/devices/${deviceId}/unlock`);
      toast.success('PBL device unlocked');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to unlock device');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDelete(deviceId) {
    if (!confirm(`Delete PBL device ${deviceId.substring(0, 16)}...? This cannot be undone.`)) return;
    setActionLoading(`delete-${deviceId}`);
    try {
      await pblApi.delete(`/v1/devices/${deviceId}`);
      toast.success('PBL device deleted');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete device');
    } finally {
      setActionLoading(null);
    }
  }

  const filtered = useMemo(() => {
    let result = devices;
    if (statusFilter !== 'all') {
      result = result.filter((d) => d.status === statusFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((d) =>
        d.device_id?.toLowerCase().includes(q) ||
        d.hostname?.toLowerCase().includes(q) ||
        d.hardware_uuid?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [devices, search, statusFilter]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Cpu size={24} className="text-blue-400" />
            PBL Devices
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Pre-Boot Lock firmware devices (TPM-based identity)
          </p>
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

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            placeholder="Search by device ID, hostname, or hardware UUID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="locked">Locked</option>
          <option value="recovering">Recovering</option>
        </select>
      </div>

      {/* Device count */}
      <div className="text-sm text-slate-400">
        {loading ? 'Loading...' : `${filtered.length} device${filtered.length !== 1 ? 's' : ''}`}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800/50 text-slate-400 text-left">
              <th className="px-4 py-3 font-medium">Device ID</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Hostname</th>
              <th className="px-4 py-3 font-medium">Hardware UUID</th>
              <th className="px-4 py-3 font-medium">Enrolled</th>
              <th className="px-4 py-3 font-medium">Lock Reason</th>
              {isOperator && <th className="px-4 py-3 font-medium text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={isOperator ? 7 : 6} className="px-4 py-8 text-center text-slate-500">
                  <Loader size={20} className="animate-spin inline mr-2" />
                  Loading PBL devices...
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={isOperator ? 7 : 6} className="px-4 py-8 text-center text-slate-500">
                  No PBL devices found
                </td>
              </tr>
            ) : (
              filtered.map((device) => (
                <tr key={device.device_id} className="border-t border-slate-800 hover:bg-slate-800/30">
                  <td className="px-4 py-3 font-mono text-xs text-slate-300">
                    <button
                      onClick={() => navigate(`/pbl-devices/${device.device_id}`)}
                      className="text-blue-400 hover:text-blue-300 hover:underline text-left"
                    >
                      {device.device_id?.substring(0, 32)}...
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${STATUS_BADGE[device.status] || 'badge-inactive'}`}>
                      {STATUS_ICON[device.status] || <Shield size={11} />}
                      {device.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{device.hostname || '-'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {device.hardware_uuid ? `${device.hardware_uuid.substring(0, 16)}...` : '-'}
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-xs">
                    {device.enrolled_at ? new Date(device.enrolled_at).toLocaleDateString() : '-'}
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-xs">
                    {device.lock_reason || '-'}
                  </td>
                  {isOperator && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {device.status !== 'locked' && (
                          <button
                            onClick={() => handleLock(device.device_id)}
                            disabled={actionLoading === `lock-${device.device_id}`}
                            title="Lock device"
                            className="p-1.5 rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                          >
                            {actionLoading === `lock-${device.device_id}` ? (
                              <Loader size={14} className="animate-spin" />
                            ) : (
                              <Lock size={14} />
                            )}
                          </button>
                        )}
                        {device.status === 'locked' && (
                          <button
                            onClick={() => handleUnlock(device.device_id)}
                            disabled={actionLoading === `unlock-${device.device_id}`}
                            title="Unlock device"
                            className="p-1.5 rounded-lg text-slate-400 hover:bg-green-500/10 hover:text-green-400 transition-colors"
                          >
                            {actionLoading === `unlock-${device.device_id}` ? (
                              <Loader size={14} className="animate-spin" />
                            ) : (
                              <Unlock size={14} />
                            )}
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(device.device_id)}
                          disabled={actionLoading === `delete-${device.device_id}`}
                          title="Delete device"
                          className="p-1.5 rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                        >
                          {actionLoading === `delete-${device.device_id}` ? (
                            <Loader size={14} className="animate-spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
