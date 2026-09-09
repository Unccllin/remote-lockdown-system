/**
 * D-206: Bidirectional PBL ↔ agent status sync tests.
 *
 * Tests the syncPblStatusToAgent (pbl.js) and syncAgentStatusToPbl (devices.js)
 * helper functions that keep PBL device status and agent device status in sync.
 */

const { setSharedKvStore, createSharedEnv } = require('../src/pbl/kvStore');
const { syncPblStatusToAgent } = require('../src/routes/pbl');
const { syncAgentStatusToPbl } = require('../src/routes/devices');

// Mock the database pool and deviceQueries so we don't need a real DB
jest.mock('../src/db/pool', () => {
  const mockQuery = jest.fn();
  return { query: mockQuery };
});
jest.mock('../src/db/deviceQueries', () => ({
  getDeviceByPblDeviceId: jest.fn(),
  setPblDeviceId: jest.fn(),
  getDeviceByHardwareIdentity: jest.fn(),
}));

const pool = require('../src/db/pool');
const { getDeviceByPblDeviceId } = require('../src/db/deviceQueries');

const PBL_DEVICE_ID = 'ab'.repeat(32);

beforeEach(() => {
  setSharedKvStore(new Map());
  jest.clearAllMocks();
});

describe('D-206: syncPblStatusToAgent (PBL → Agent)', () => {
  it('updates agent device status to locked when PBL status is locked', async () => {
    getDeviceByPblDeviceId.mockResolvedValue({ id: 'agent-uuid-1', status: 'active' });
    pool.query.mockResolvedValue({ rows: [] });

    await syncPblStatusToAgent(PBL_DEVICE_ID, 'locked');

    expect(getDeviceByPblDeviceId).toHaveBeenCalledWith(PBL_DEVICE_ID);
    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE devices SET status = $2 WHERE id = $1 AND status != $2',
      ['agent-uuid-1', 'locked'],
    );
  });

  it('updates agent device status to stolen when PBL status is tracking', async () => {
    getDeviceByPblDeviceId.mockResolvedValue({ id: 'agent-uuid-1', status: 'active' });
    pool.query.mockResolvedValue({ rows: [] });

    await syncPblStatusToAgent(PBL_DEVICE_ID, 'tracking');

    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE devices SET status = $2 WHERE id = $1 AND status != $2',
      ['agent-uuid-1', 'stolen'],
    );
  });

  it('updates agent device status to active when PBL status is active', async () => {
    getDeviceByPblDeviceId.mockResolvedValue({ id: 'agent-uuid-1', status: 'locked' });
    pool.query.mockResolvedValue({ rows: [] });

    await syncPblStatusToAgent(PBL_DEVICE_ID, 'active');

    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE devices SET status = $2 WHERE id = $1 AND status != $2',
      ['agent-uuid-1', 'active'],
    );
  });

  it('does nothing when no agent device is linked', async () => {
    getDeviceByPblDeviceId.mockResolvedValue(null);

    await syncPblStatusToAgent(PBL_DEVICE_ID, 'locked');

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('does nothing for unknown PBL status', async () => {
    getDeviceByPblDeviceId.mockResolvedValue({ id: 'agent-uuid-1', status: 'active' });

    await syncPblStatusToAgent(PBL_DEVICE_ID, 'unknown_status');

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('does not throw when database query fails (best-effort)', async () => {
    getDeviceByPblDeviceId.mockResolvedValue({ id: 'agent-uuid-1', status: 'active' });
    pool.query.mockRejectedValue(new Error('DB connection failed'));

    // Should not throw
    await expect(syncPblStatusToAgent(PBL_DEVICE_ID, 'locked')).resolves.toBeUndefined();
  });

  it('does not throw when getDeviceByPblDeviceId fails (best-effort)', async () => {
    getDeviceByPblDeviceId.mockRejectedValue(new Error('DB connection failed'));

    // Should not throw
    await expect(syncPblStatusToAgent(PBL_DEVICE_ID, 'locked')).resolves.toBeUndefined();
  });
});

describe('D-206: syncAgentStatusToPbl (Agent → PBL)', () => {
  it('updates PBL device status to locked when agent is flagged stolen', async () => {
    const env = createSharedEnv();
    await env.LOCKDOWN_KV.put(
      `pbl_devices:${PBL_DEVICE_ID}`,
      JSON.stringify({ device_id: PBL_DEVICE_ID, status: 'active' }),
    );

    await syncAgentStatusToPbl({ pbl_device_id: PBL_DEVICE_ID }, 'locked');

    const data = await env.LOCKDOWN_KV.get(`pbl_devices:${PBL_DEVICE_ID}`, 'text');
    const device = JSON.parse(data);
    expect(device.status).toBe('locked');
    expect(device.lock_reason).toBe('admin_lock');
  });

  it('updates PBL device status to tracking when agent starts tracking', async () => {
    const env = createSharedEnv();
    await env.LOCKDOWN_KV.put(
      `pbl_devices:${PBL_DEVICE_ID}`,
      JSON.stringify({ device_id: PBL_DEVICE_ID, status: 'locked', lock_reason: 'admin_lock' }),
    );

    await syncAgentStatusToPbl({ pbl_device_id: PBL_DEVICE_ID }, 'tracking');

    const data = await env.LOCKDOWN_KV.get(`pbl_devices:${PBL_DEVICE_ID}`, 'text');
    const device = JSON.parse(data);
    expect(device.status).toBe('tracking');
    expect(device.lock_reason).toBe('reported_stolen');
  });

  it('updates PBL device status to active and clears lock_reason when agent recovers', async () => {
    const env = createSharedEnv();
    await env.LOCKDOWN_KV.put(
      `pbl_devices:${PBL_DEVICE_ID}`,
      JSON.stringify({ device_id: PBL_DEVICE_ID, status: 'locked', lock_reason: 'admin_lock' }),
    );

    await syncAgentStatusToPbl({ pbl_device_id: PBL_DEVICE_ID }, 'active');

    const data = await env.LOCKDOWN_KV.get(`pbl_devices:${PBL_DEVICE_ID}`, 'text');
    const device = JSON.parse(data);
    expect(device.status).toBe('active');
    expect(device.lock_reason).toBeUndefined();
  });

  it('does nothing when agent device has no pbl_device_id', async () => {
    const env = createSharedEnv();
    await env.LOCKDOWN_KV.put(
      `pbl_devices:${PBL_DEVICE_ID}`,
      JSON.stringify({ device_id: PBL_DEVICE_ID, status: 'active' }),
    );

    await syncAgentStatusToPbl({ pbl_device_id: null }, 'locked');

    const data = await env.LOCKDOWN_KV.get(`pbl_devices:${PBL_DEVICE_ID}`, 'text');
    const device = JSON.parse(data);
    expect(device.status).toBe('active');  // unchanged
  });

  it('does nothing when agent device is null', async () => {
    await syncAgentStatusToPbl(null, 'locked');
    // Should not throw
  });

  it('does nothing when PBL device not found in KV', async () => {
    // No PBL device stored in KV
    await syncAgentStatusToPbl({ pbl_device_id: 'ff'.repeat(32) }, 'locked');
    // Should not throw
  });
});

describe('D-206: Bidirectional sync integration', () => {
  it('PBL lock → agent locked → agent recover → PBL active round-trip', async () => {
    // Setup: agent device exists in DB, PBL device exists in KV
    getDeviceByPblDeviceId.mockResolvedValue({ id: 'agent-uuid-1', status: 'active' });
    pool.query.mockResolvedValue({ rows: [] });
    const env = createSharedEnv();
    await env.LOCKDOWN_KV.put(
      `pbl_devices:${PBL_DEVICE_ID}`,
      JSON.stringify({ device_id: PBL_DEVICE_ID, status: 'active' }),
    );

    // Step 1: PBL lock → agent status becomes locked
    await syncPblStatusToAgent(PBL_DEVICE_ID, 'locked');
    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE devices SET status = $2 WHERE id = $1 AND status != $2',
      ['agent-uuid-1', 'locked'],
    );

    // Step 2: Agent recover → PBL status becomes active
    await syncAgentStatusToPbl({ pbl_device_id: PBL_DEVICE_ID }, 'active');
    const data = await env.LOCKDOWN_KV.get(`pbl_devices:${PBL_DEVICE_ID}`, 'text');
    const device = JSON.parse(data);
    expect(device.status).toBe('active');
    expect(device.lock_reason).toBeUndefined();
  });
});
