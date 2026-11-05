import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield, ShieldCheck, Trash2, RefreshCw, Search,
  Lock, Unlock, Cpu, Loader,
} from 'lucide-react';
import toast from 'react-hot-toast';
import pblApi from '../api/pblClient';
import { getInventoryStatus, getInventoryDevices } from '../api/inventory';
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
  // Inventory reported by a connected management source. Part of OUR PBL surface:
  // the upstream connector is an implementation detail and is never named here.
  const [inventory, setInventory] = useState({ state: 'loading', devices: [], fetchedAt: null });
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

  async function loadInventory() {
    try {
      const sources = await getInventoryStatus();
      const usable = sources.find((source) => source.enabled && source.configured);
      if (!usable) {
        // Nothing connected is a normal state, not an error: the page still lists
        // PBL-enrolled devices.
        setInventory({
          state: sources.some((source) => source.enabled) ? 'not-configured' : 'disabled',
          devices: [],
          fetchedAt: null,
        });
        return;
      }
      const { devices, fetchedAt } = await getInventoryDevices(usable.id);
      setInventory({ state: 'ready', devices: devices || [], fetchedAt: fetchedAt || null });
    } catch (err) {
      const code = err.response?.data?.code;
      setInventory({
        state: code === 'NOT_CONFIGURED' ? 'not-configured' : 'unreachable',
        devices: [],
        fetchedAt: null,
      });
    }
  }

  useEffect(() => {
    load();
    loadInventory();
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
                  {devices.length === 0 ? (
                    <div data-testid="pbl-empty-registry" className="max-w-lg mx-auto text-left space-y-2">
                      <p className="text-slate-300 font-medium text-center">
                        No devices have enrolled through the PBL firmware programme
                      </p>
                      <p className="text-xs">
                        This list is populated only by <code className="font-mono">POST /v1/enroll</code> — the
                        attestation flow firmware uses. A machine enrolled with the agent
                        (<code className="font-mono">/api/enroll/claim</code>) is deliberately a different
                        record and appears under <strong>Devices</strong> instead. An empty list here is
                        normal on a deployment that has only used agent enrolment.
                      </p>
                    </div>
                  ) : (
                    'No PBL devices match the current filter'
                  )}
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

      {/* Device inventory — read-only devices reported by a connected management
          source. Our own endpoints; the upstream is never named because it is an
          implementation detail, and every action stays on our command queue. */}
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <Cpu size={16} className="text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-200">Device inventory</h2>
            <span className="text-xs text-slate-500">read-only</span>
          </div>
          {inventory.state === 'ready' && inventory.fetchedAt && (
            <span className="text-xs text-slate-500">
              {inventory.devices.length} reported · fetched{' '}
              {new Date(inventory.fetchedAt).toLocaleTimeString()}
            </span>
          )}
        </div>

        {inventory.state === 'loading' && (
          <p className="text-sm text-slate-500">
            <Loader size={14} className="animate-spin inline mr-2" />
            Loading inventory…
          </p>
        )}

        {inventory.state === 'disabled' && (
          <p className="text-sm text-slate-500">
            No inventory source is connected to this server. Devices reported by a managed
            source appear here once one is configured; enforcement runs through our own
            command queue either way.
          </p>
        )}

        {inventory.state === 'not-configured' && (
          <p className="text-sm text-slate-500">
            An inventory source is connected but not authorised — add its credentials on the
            server to list its devices here.
          </p>
        )}

        {inventory.state === 'unreachable' && (
          <p className="text-sm text-amber-300/90">
            Inventory source unreachable — showing PBL-enrolled devices only. Enforcement
            is unaffected.
          </p>
        )}

        {inventory.state === 'ready' && inventory.devices.length === 0 && (
          <p className="text-sm text-slate-500">The connected source reports no devices.</p>
        )}

        {inventory.state === 'ready' && inventory.devices.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-800/50 text-slate-400 text-left">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Platform</th>
                  <th className="px-4 py-2.5 font-medium">Last seen</th>
                  <th className="px-4 py-2.5 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {inventory.devices.map((device) => (
                  <tr key={device.id} className="border-t border-slate-800">
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{device.name}</td>
                    <td className="px-4 py-2.5 text-slate-400 text-xs">{device.platform || '—'}</td>
                    <td className="px-4 py-2.5 text-slate-400 text-xs">
                      {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
                          device.online ? 'badge-active' : 'badge-inactive'
                        }`}
                      >
                        {device.online ? 'online' : 'offline'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
