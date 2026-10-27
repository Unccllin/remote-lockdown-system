/**
 * Integration surface (S142) — OURS, read-only, optional.
 *
 * These tests pin the rules from docs/adr/INTEGRATION-OWNERSHIP.md:
 *   - disabled/not-configured is a 503, not a 500 and not a silent empty list
 *   - an upstream failure is a 502 on that endpoint only
 *   - the normalized shape is ours, not MeshCentral's
 *   - the connector module exposes no mutating operation (read-only by
 *     construction, not by convention)
 */

const request = require('supertest');

const { mockPool, makeToken, createApp: _createApp } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

// Keep the real error classes (the route uses instanceof), stub the I/O.
jest.mock('../src/integrations/meshcentral', () => {
  const actual = jest.requireActual('../src/integrations/meshcentral');
  return { ...actual, getDevices: jest.fn(), status: jest.fn() };
});

const meshcentral = require('../src/integrations/meshcentral');
const integrationsRoutes = require('../src/routes/integrations');

function createApp() {
  return _createApp({ integrations: integrationsRoutes });
}

beforeEach(() => {
  jest.clearAllMocks();
  meshcentral.status.mockReturnValue({
    id: 'meshcentral',
    name: 'MeshCentral',
    enabled: true,
    configured: true,
    mode: 'read-only',
  });
});

describe('GET /api/integrations', () => {
  const app = createApp();

  test('requires auth', async () => {
    const res = await request(app).get('/api/integrations');
    expect(res.status).toBe(401);
  });

  test('lists connectors with their mode, without calling upstream', async () => {
    const res = await request(app)
      .get('/api/integrations')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.integrations).toHaveLength(1);
    expect(res.body.integrations[0]).toMatchObject({ id: 'meshcentral', mode: 'read-only' });
    expect(meshcentral.getDevices).not.toHaveBeenCalled();
  });
});

describe('GET /api/integrations/meshcentral/devices', () => {
  const app = createApp();

  test('requires auth', async () => {
    const res = await request(app).get('/api/integrations/meshcentral/devices');
    expect(res.status).toBe(401);
  });

  test('returns our normalized inventory shape', async () => {
    const devices = [
      {
        source: 'meshcentral',
        id: 'node/abc',
        name: 'LAPTOP-ALPHA',
        online: true,
        lastSeenAt: '2026-10-27T10:00:00.000Z',
        platform: 'Windows 11',
        meshId: 'mesh/1',
      },
    ];
    meshcentral.getDevices.mockResolvedValue({
      devices,
      fetchedAt: '2026-10-27T10:00:05.000Z',
    });

    const res = await request(app)
      .get('/api/integrations/meshcentral/devices')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('meshcentral');
    expect(res.body.readOnly).toBe(true);
    expect(res.body.devices).toEqual(devices);
  });

  test('not configured -> 503 with a machine-readable code, not a 500', async () => {
    meshcentral.getDevices.mockRejectedValue(
      new meshcentral.ConnectorNotConfigured('MESHCENTRAL_URL is not set')
    );

    const res = await request(app)
      .get('/api/integrations/meshcentral/devices')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NOT_CONFIGURED');
    expect(res.body.error).toMatch(/not configured/i);
  });

  test('upstream failure -> 502 on this endpoint only, no credentials echoed', async () => {
    meshcentral.getDevices.mockRejectedValue(
      new meshcentral.ConnectorUpstreamError('MeshCentral returned HTTP 500')
    );

    const res = await request(app)
      .get('/api/integrations/meshcentral/devices')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPSTREAM_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/token|auth=|password/i);
  });
});

describe('meshcentral connector is read-only by construction', () => {
  const actual = jest.requireActual('../src/integrations/meshcentral');

  test('exports no mutating operation', () => {
    const exported = Object.keys(actual);
    const mutating = exported.filter((name) =>
      /delete|remove|create|update|set|lock|unlock|action|command|run/i.test(name)
    );
    expect(mutating).toEqual([]);
  });

  test('normalizes conn/lastconnecttime into our shape', () => {
    const online = actual._normalizeNode('node/1', {
      name: 'HOST-A',
      conn: 1,
      lastconnecttime: 1700000000,
      osdesc: 'Windows 11',
      meshid: 'mesh/1',
    });
    expect(online).toMatchObject({ source: 'meshcentral', online: true, platform: 'Windows 11' });
    expect(online.lastSeenAt).toBe(new Date(1700000000 * 1000).toISOString());

    const never = actual._normalizeNode('node/2', { rname: 'HOST-B', conn: 0 });
    expect(never).toMatchObject({ id: 'node/2', name: 'HOST-B', online: false, lastSeenAt: null });
  });
});
