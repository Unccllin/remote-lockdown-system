/**
 * Unit tests for the MeshCentral connector (src/integrations/meshcentral.js).
 *
 * This connector is registered in the integrations registry but was only ~11%
 * covered. Its failure paths are the interesting part: verified against a real
 * MeshCentral 1.3.1 instance (see docs/adr/INTEGRATION-OWNERSHIP.md), that build
 * has **no REST API** — every `/api/*` path is answered with the web UI's HTML.
 * The connector therefore has to fail loudly and usefully, never silently, and
 * must never put the credential in a log line or an error message.
 */

const meshcentral = require('../src/integrations/meshcentral');

const ENV_KEYS = [
  'MESHCENTRAL_URL',
  'MESHCENTRAL_TOKEN',
  'MESHCENTRAL_USER',
  'MESHCENTRAL_PASS',
  'MESHCENTRAL_2FA',
  'INTEGRATIONS_MESHCENTRAL',
];

let originalFetch;

beforeEach(() => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  ENV_KEYS.forEach((k) => delete process.env[k]);
});

/** Canned fetch response. */
function response({ status = 200, contentType = 'application/json', body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    json: async () => body,
  };
}

describe('status and configuration', () => {
  test('is off when nothing is configured', () => {
    expect(meshcentral.isEnabled()).toBe(false);
    expect(meshcentral.isConfigured()).toBe(false);
  });

  test('status reports the read-only mode and our id, not the upstream name', () => {
    const s = meshcentral.status();
    expect(s).toMatchObject({ id: 'meshcentral', mode: 'read-only', enabled: false });
  });

  test('a URL alone enables but does not configure it', () => {
    process.env.MESHCENTRAL_URL = 'https://mc.example.com/';
    expect(meshcentral.isEnabled()).toBe(true);
    expect(meshcentral.isConfigured()).toBe(false); // trailing slash is stripped, creds still missing
  });

  test('a token configures it', () => {
    process.env.MESHCENTRAL_URL = 'https://mc.example.com';
    process.env.MESHCENTRAL_TOKEN = 'tok-123';
    expect(meshcentral.isConfigured()).toBe(true);
  });

  test('user + password configures it', () => {
    process.env.MESHCENTRAL_URL = 'https://mc.example.com';
    process.env.MESHCENTRAL_USER = 'u';
    process.env.MESHCENTRAL_PASS = 'p';
    expect(meshcentral.isConfigured()).toBe(true);
  });

  test('INTEGRATIONS_MESHCENTRAL=off wins over a configured URL', () => {
    process.env.MESHCENTRAL_URL = 'https://mc.example.com';
    process.env.MESHCENTRAL_TOKEN = 'tok';
    process.env.INTEGRATIONS_MESHCENTRAL = 'off';
    expect(meshcentral.isEnabled()).toBe(false);
    expect(meshcentral.isConfigured()).toBe(false);
  });

  test('status never echoes the credential', () => {
    process.env.MESHCENTRAL_URL = 'https://mc.example.com';
    process.env.MESHCENTRAL_TOKEN = 'super-secret-token-value';
    expect(JSON.stringify(meshcentral.status())).not.toContain('super-secret-token-value');
  });
});

describe('getDevices — refusal paths', () => {
  test('refuses when switched off', async () => {
    process.env.MESHCENTRAL_URL = 'https://mc.example.com';
    process.env.INTEGRATIONS_MESHCENTRAL = 'off';
    await expect(meshcentral.getDevices()).rejects.toThrow(meshcentral.ConnectorNotConfigured);
    await expect(meshcentral.getDevices()).rejects.toThrow(/switched off/i);
  });

  test('refuses when no URL is set, naming the variable', async () => {
    await expect(meshcentral.getDevices()).rejects.toThrow(/MESHCENTRAL_URL/);
  });

  test('refuses when no credentials are set, naming both options', async () => {
    process.env.MESHCENTRAL_URL = 'https://mc.example.com';
    await expect(meshcentral.getDevices()).rejects.toThrow(/MESHCENTRAL_TOKEN/);
    await expect(meshcentral.getDevices()).rejects.toThrow(/MESHCENTRAL_USER/);
  });
});

describe('getDevices — upstream failure paths', () => {
  beforeEach(() => {
    process.env.MESHCENTRAL_URL = 'https://mc.example.com';
    process.env.MESHCENTRAL_TOKEN = 'tok-123';
  });

  test('an HTML answer is reported as "no REST API", not a JSON parse error', async () => {
    global.fetch = jest.fn(async () => response({ status: 404, contentType: 'text/html' }));
    await expect(meshcentral.getDevices()).rejects.toThrow(meshcentral.ConnectorUpstreamError);
    await expect(meshcentral.getDevices()).rejects.toThrow(/no REST API/i);
    await expect(meshcentral.getDevices()).rejects.toThrow(/404/);
  });

  test('a non-2xx JSON answer names the status', async () => {
    global.fetch = jest.fn(async () => response({ status: 503 }));
    await expect(meshcentral.getDevices()).rejects.toThrow(/HTTP 503/);
  });

  test('a network failure is wrapped, and the token is not in the message', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    let message = '';
    try {
      await meshcentral.getDevices();
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/request failed/i);
    expect(message).toMatch(/ECONNREFUSED/);
    expect(message).not.toContain('tok-123');
  });

  test('a payload without a node map is rejected', async () => {
    global.fetch = jest.fn(async () => response({ body: { unexpected: true } }));
    await expect(meshcentral.getDevices()).rejects.toThrow(/no node map/i);
  });
});

describe('getDevices — inventory shape', () => {
  beforeEach(() => {
    process.env.MESHCENTRAL_URL = 'https://mc.example.com';
    process.env.MESHCENTRAL_USER = 'u';
    process.env.MESHCENTRAL_PASS = 'S3cretPass';
  });

  test('normalizes nodes into OUR shape and sorts by name', async () => {
    global.fetch = jest.fn(async () =>
      response({
        body: {
          nodes: {
            n2: { name: 'zeta', conn: 0, lastconnecttime: 1700000000, osdesc: 'Windows 11' },
            n1: { name: 'alpha', conn: 1 },
          },
        },
      })
    );

    const { devices, fetchedAt } = await meshcentral.getDevices();
    expect(devices.map((d) => d.name)).toEqual(['alpha', 'zeta']);
    expect(devices[0]).toEqual({
      source: 'meshcentral',
      id: 'n1',
      name: 'alpha',
      online: true,
      lastSeenAt: null, // never connected: null, not 1970
      platform: null,
      meshId: null,
    });
    expect(devices[1]).toMatchObject({ id: 'n2', online: false, platform: 'Windows 11' });
    expect(devices[1].lastSeenAt).toBe(new Date(1700000000 * 1000).toISOString());
    expect(Number.isNaN(Date.parse(fetchedAt))).toBe(false);
  });

  test('sends credentials as the x-meshauth header, not in the URL', async () => {
    const fetchMock = jest.fn(async () => response({ body: { nodes: {} } }));
    global.fetch = fetchMock;
    await meshcentral.getDevices();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mc.example.com/api/nodes');
    expect(url).not.toContain('S3cretPass'); // credentials belong in the header
    const header = options.headers['x-meshauth'];
    expect(header).toBe(
      `${Buffer.from('u').toString('base64')},${Buffer.from('S3cretPass').toString('base64')}`
    );
  });

  test('falls back to rname and then to the node id for the display name', () => {
    expect(meshcentral._normalizeNode('id1', { rname: 'real-name' }).name).toBe('real-name');
    expect(meshcentral._normalizeNode('id1', {}).name).toBe('id1');
  });
});
