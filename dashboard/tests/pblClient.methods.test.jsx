import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Method-level tests for the PBL API client.
 *
 * pblBaseUrl() was the only covered part of this module (tests/pblClient.test.jsx), so
 * pblDevices / pblPolicy / pblAdmin sat at ~6% function coverage. That single gap dragged the
 * dashboard's global function coverage below its 62% floor and failed the CI "Dashboard Tests"
 * job even though all 231 tests passed -- a coverage gate failing on an entire untested module
 * rather than on a regression.
 *
 * The axios instance is mocked at the factory, so these assert the *contract* the pages depend
 * on: which HTTP verb, which path, and which body/options each call produces.
 */
const get = vi.fn(() => Promise.resolve({ data: {} }));
const post = vi.fn(() => Promise.resolve({ data: {} }));
const del = vi.fn(() => Promise.resolve({ data: {} }));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({ get, post, delete: del, interceptors: { request: { use: vi.fn() } } })),
  },
}));

const { pblDevices, pblPolicy, pblAdmin } = await import('../src/api/pblClient');

beforeEach(() => {
  get.mockClear();
  post.mockClear();
  del.mockClear();
});

describe('pblDevices', () => {
  it('lists devices at the server root', async () => {
    await pblDevices.list();
    expect(get).toHaveBeenCalledWith('/v1/devices');
  });

  it('fetches one device', async () => {
    await pblDevices.get('abc');
    expect(get).toHaveBeenCalledWith('/v1/devices/abc');
  });

  it('locks, unlocks, tracks and stops tracking', async () => {
    await pblDevices.lock('abc');
    await pblDevices.unlock('abc');
    await pblDevices.track('abc');
    await pblDevices.stopTrack('abc');
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      '/v1/devices/abc/lock',
      '/v1/devices/abc/unlock',
      '/v1/devices/abc/track',
      '/v1/devices/abc/stop-track',
    ]);
  });

  it('deletes a device', async () => {
    await pblDevices.delete('abc');
    expect(del).toHaveBeenCalledWith('/v1/devices/abc');
  });

  it('reads and writes the agent mapping (D-206)', async () => {
    await pblDevices.getAgentMapping('abc');
    await pblDevices.linkAgentMapping('abc', 'agent-1');
    await pblDevices.unlinkAgentMapping('abc');

    expect(get).toHaveBeenCalledWith('/v1/devices/abc/agent-mapping');
    expect(post).toHaveBeenCalledWith('/v1/devices/abc/agent-mapping', {
      agent_device_id: 'agent-1',
    });
    expect(del).toHaveBeenCalledWith('/v1/devices/abc/agent-mapping');
  });
});

describe('pblPolicy', () => {
  it('lists policy versions', async () => {
    await pblPolicy.list();
    expect(get).toHaveBeenCalledWith('/v1/policy');
  });

  it('fetches a signed policy blob as binary', async () => {
    await pblPolicy.get(7);
    expect(get).toHaveBeenCalledWith('/v1/policy/7', { responseType: 'arraybuffer' });
  });

  it('stores a pre-signed blob as CBOR with an optional version', async () => {
    await pblPolicy.store('blob', 9);
    expect(post).toHaveBeenCalledWith('/v1/policy', 'blob', {
      headers: { 'Content-Type': 'application/cbor' },
      params: { version: 9 },
    });

    post.mockClear();
    await pblPolicy.store('blob');
    expect(post).toHaveBeenCalledWith('/v1/policy', 'blob', {
      headers: { 'Content-Type': 'application/cbor' },
      params: undefined,
    });
  });

  it('creates a policy from form fields as JSON', async () => {
    await pblPolicy.create({ version: 1 });
    expect(post).toHaveBeenCalledWith('/v1/policy/create', { version: 1 }, {
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

describe('pblAdmin', () => {
  it('reads signing-key info', async () => {
    await pblAdmin.getKeyInfo();
    expect(get).toHaveBeenCalledWith('/v1/admin/key-info');
  });
});
