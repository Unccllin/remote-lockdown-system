/**
 * Tests for the serverless worker.
 *
 * These tests use the unstable Cloudflare Workers testing approach:
 * we mock the KVNamespace and Request/Response objects to test the
 * handler logic without deploying.
 *
 * Run with: npx vitest run
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// Mock KV namespace
class MockKV {
  private data: Record<string, string> = {};

  async get(key: string): Promise<string | null> {
    return this.data[key] ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data[key] = value;
  }

  reset(): void {
    this.data = {};
  }
}

// Helper to create a Request
function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const url = `https://lockdown.example.com${path}`;
  const init: RequestInit = {
    method,
    headers: headers || {},
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!headers?.['Content-Type']) {
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    }
  }
  return new Request(url, init);
}

/**
 * Sign a request body with the agent's HMAC format:
 *   HMAC-SHA256(agent_key, "{timestamp}:{nonce}:{body_sha256}")
 *
 * This matches agent.py sign_headers() and server hmacAuth.js verifyHmac().
 */
function signRequest(
  body: string,
  agentKey: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const payload = `${timestamp}:${nonce}:${bodyHash}`;
  const signature = crypto.createHmac('sha256', agentKey).update(payload).digest('hex');
  return {
    ...headers,
    'X-Agent-Key': agentKey,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
    'X-Sig-Version': '1',
    'Content-Type': 'application/json',
  };
}

/** Enroll a device via admin API and return { device, apiKey }. */
async function enrollDevice(
  worker: { fetch: (req: Request, env: unknown) => Promise<Response> },
  env: unknown,
  hostname: string,
): Promise<{ device: any; apiKey: string }> {
  const req = makeRequest(
    'POST',
    '/api/enroll',
    { hostname, owner_name: 'Test' },
    { Authorization: 'Bearer test-admin-token' },
  );
  const resp = await worker.fetch(req, env);
  const data: any = await parseResponse(resp);
  return { device: data.device, apiKey: data.api_key };
}

// Helper to parse JSON response
async function parseResponse(resp: Response): Promise<unknown> {
  return JSON.parse(await resp.text());
}

// We need to import the worker handler
// Since the worker uses `export default`, we import it dynamically
let worker: { fetch: (req: Request, env: unknown) => Promise<Response> };

beforeEach(async () => {
  const mod = await import('./worker.js');
  worker = mod.default;
});

describe('Serverless Worker', () => {
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV };

  beforeEach(() => {
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-admin-token',
      LOCKDOWN_KV: kv,
    };
  });

  describe('GET /api/health', () => {
    it('returns ok status', async () => {
      const req = makeRequest('GET', '/api/health');
      const resp = await worker.fetch(req, env);
      const data = await parseResponse(resp);

      expect(resp.status).toBe(200);
      expect(data).toHaveProperty('status', 'ok');
      expect(data).toHaveProperty('serverless', true);
    });
  });

  describe('POST /api/enroll', () => {
    it('creates a new device and returns API key', async () => {
      const req = makeRequest(
        'POST',
        '/api/enroll',
        { hostname: 'TEST-DEV-001', owner_name: 'Test' },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, env);
      const data = await parseResponse(resp);

      expect(resp.status).toBe(201);
      expect(data).toHaveProperty('api_key');
      expect(data).toHaveProperty('device.hostname', 'TEST-DEV-001');
    });

    it('rejects without admin auth', async () => {
      const req = makeRequest('POST', '/api/enroll', { hostname: 'TEST' });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(401);
    });

    it('rejects without hostname', async () => {
      const req = makeRequest(
        'POST',
        '/api/enroll',
        {},
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(400);
    });
  });

  describe('GET /api/devices', () => {
    it('returns empty list when no devices', async () => {
      const req = makeRequest('GET', '/api/devices', undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      const data = await parseResponse(resp);

      expect(resp.status).toBe(200);
      expect(data).toEqual([]);
    });

    it('rejects without admin auth', async () => {
      const req = makeRequest('GET', '/api/devices');
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(401);
    });
  });

  describe('POST /api/agent/checkin (agent-compatible)', () => {
    it('rejects without auth headers', async () => {
      const req = makeRequest('POST', '/api/agent/checkin', { hostname: 'TEST' });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(401);
    });

    it('rejects with wrong HMAC signature', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'CHECKIN-001');
      const body = JSON.stringify({ hostname: 'CHECKIN-001' });
      const headers = signRequest(body, apiKey);
      headers['X-Signature'] = 'deadbeef'.repeat(8);
      const req = makeRequest('POST', '/api/agent/checkin', body, headers);
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(401);
    });

    it('returns device_id, status, poll_interval, command: null when no pending commands', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'CHECKIN-002');
      const body = JSON.stringify({ hostname: 'CHECKIN-002' });
      const req = makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey));
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);

      expect(resp.status).toBe(200);
      expect(data.device_id).toBe(device.id);
      expect(data.status).toBe('active');
      expect(data.poll_interval).toBe(300);
      expect(data.command).toBeNull();
    });

    it('returns lockdown command with type field (not command_type)', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'CHECKIN-003');
      // Flag device stolen to queue a lockdown command
      const flagReq = makeRequest(
        'POST',
        `/api/devices/${device.id}/flag`,
        { hostname_confirm: 'CHECKIN-003' },
        { Authorization: 'Bearer test-admin-token' },
      );
      await worker.fetch(flagReq, env);

      const body = JSON.stringify({ hostname: 'CHECKIN-003' });
      const req = makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey));
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);

      expect(resp.status).toBe(200);
      expect(data.command).not.toBeNull();
      expect(data.command.type).toBe('lockdown');
      expect(data.command.id).toBeDefined();
      expect(data.command.command_uuid).toBeNull();
      expect(data.command.key_material).toBeNull();
    });

    it('releases encryption key for unlock commands', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'CHECKIN-004');
      // Flag stolen → queue lockdown
      const flagReq = makeRequest(
        'POST',
        `/api/devices/${device.id}/flag`,
        { hostname_confirm: 'CHECKIN-004' },
        { Authorization: 'Bearer test-admin-token' },
      );
      await worker.fetch(flagReq, env);

      // Agent ACKs lockdown with a key
      const checkinBody = JSON.stringify({ hostname: 'CHECKIN-004' });
      const checkinReq = makeRequest('POST', '/api/agent/checkin', checkinBody, signRequest(checkinBody, apiKey));
      const checkinResp = await worker.fetch(checkinReq, env);
      const checkinData: any = await parseResponse(checkinResp);
      const cmdId = checkinData.command.id;

      const ackBody = JSON.stringify({
        hostname: 'CHECKIN-004',
        command_id: cmdId,
        result_status: 'executed',
        key_material: 'test-fernet-key-base64',
      });
      const ackReq = makeRequest('POST', '/api/agent/command-ack', ackBody, signRequest(ackBody, apiKey));
      const ackResp = await worker.fetch(ackReq, env);
      expect(ackResp.status).toBe(200);

      // Admin recovers → queues unlock + releases key
      const recoverReq = makeRequest(
        'POST',
        `/api/devices/${device.id}/recover`,
        { hostname_confirm: 'CHECKIN-004' },
        { Authorization: 'Bearer test-admin-token' },
      );
      await worker.fetch(recoverReq, env);

      // Agent checks in → should get unlock command with key_material
      const checkin2Body = JSON.stringify({ hostname: 'CHECKIN-004' });
      const checkin2Req = makeRequest('POST', '/api/agent/checkin', checkin2Body, signRequest(checkin2Body, apiKey));
      const checkin2Resp = await worker.fetch(checkin2Req, env);
      const checkin2Data: any = await parseResponse(checkin2Resp);

      expect(checkin2Data.command.type).toBe('unlock');
      expect(checkin2Data.command.key_material).toBe('test-fernet-key-base64');
    });
  });

  describe('POST /api/agent/deadman-report', () => {
    it('stores key and marks device locked', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'DEADMAN-001');
      const body = JSON.stringify({
        hostname: 'DEADMAN-001',
        key_material: 'deadman-key-base64',
      });
      const req = makeRequest('POST', '/api/agent/deadman-report', body, signRequest(body, apiKey));
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(200);

      // Verify device is locked
      const devReq = makeRequest('GET', `/api/devices/${device.id}`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const devResp = await worker.fetch(devReq, env);
      const devData: any = await parseResponse(devResp);
      expect(devData.status).toBe('locked');
    });

    it('rejects without key_material', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'DEADMAN-002');
      const body = JSON.stringify({ hostname: 'DEADMAN-002' });
      const req = makeRequest('POST', '/api/agent/deadman-report', body, signRequest(body, apiKey));
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(400);
    });
  });

  describe('Dashboard-compatible endpoints', () => {
    it('POST /api/auth/login validates admin token', async () => {
      const req = makeRequest('POST', '/api/auth/login', {
        username: 'admin',
        password: 'test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.token).toBe('test-admin-token');
      expect(data.user.role).toBe('super-admin');
    });

    it('POST /api/auth/login rejects wrong token', async () => {
      const req = makeRequest('POST', '/api/auth/login', {
        username: 'admin',
        password: 'wrong-token',
      });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(401);
    });

    it('GET /api/setup/status returns setupComplete true', async () => {
      const req = makeRequest('GET', '/api/setup/status');
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.setupComplete).toBe(true);
    });

    it('GET /api/health/detailed returns counts', async () => {
      await enrollDevice(worker, env, 'HEALTH-001');
      const req = makeRequest('GET', '/api/health/detailed', undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.devices).toBe(1);
      expect(data.serverless).toBe(true);
    });

    it('POST /api/devices enrolls (dashboard path)', async () => {
      const req = makeRequest(
        'POST',
        '/api/devices',
        { hostname: 'DASH-001', owner_name: 'Dash' },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(201);
      expect(data.device.hostname).toBe('DASH-001');
      expect(data.api_key).toBeDefined();
    });

    it('POST /api/devices/:id/flag-stolen flags device (dashboard path)', async () => {
      const { device } = await enrollDevice(worker, env, 'FLAG-STOLEN-001');
      const req = makeRequest(
        'POST',
        `/api/devices/${device.id}/flag-stolen`,
        { hostname_confirm: 'FLAG-STOLEN-001' },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.device.status).toBe('stolen');
      expect(data.command.command_type).toBe('lockdown');
    });

    it('POST /api/devices/:id/track sets tracking status', async () => {
      const { device } = await enrollDevice(worker, env, 'TRACK-001');
      const req = makeRequest(
        'POST',
        `/api/devices/${device.id}/track`,
        {},
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.device.status).toBe('tracking');
    });

    it('POST /api/devices/:id/stop-track restores active status', async () => {
      const { device } = await enrollDevice(worker, env, 'STOP-TRACK-001');
      // Start tracking first
      await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/track`, {}, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      // Stop tracking
      const req = makeRequest(
        'POST',
        `/api/devices/${device.id}/stop-track`,
        {},
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.device.status).toBe('active');
    });

    it('POST /api/devices/:id/locate queues track command', async () => {
      const { device } = await enrollDevice(worker, env, 'LOCATE-001');
      const req = makeRequest(
        'POST',
        `/api/devices/${device.id}/locate`,
        {},
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.command.command_type).toBe('track');
    });

    it('GET /api/devices/:id/locations returns empty array initially', async () => {
      const { device } = await enrollDevice(worker, env, 'LOC-001');
      const req = makeRequest('GET', `/api/devices/${device.id}/locations?limit=5`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(0);
    });

    it('GET /api/audit returns audit entries after actions', async () => {
      const { device } = await enrollDevice(worker, env, 'AUDIT-001');
      // Flag stolen to generate an audit entry
      await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/flag-stolen`, {
          hostname_confirm: 'AUDIT-001',
        }, { Authorization: 'Bearer test-admin-token' }),
        env,
      );
      const req = makeRequest('GET', '/api/audit?limit=10', undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].action).toBe('admin_flag_stolen');
    });

    it('GET /api/audit filtered by device_id', async () => {
      const { device: d1 } = await enrollDevice(worker, env, 'AUDIT-A');
      const { device: d2 } = await enrollDevice(worker, env, 'AUDIT-B');
      // Generate audit entries for both
      await worker.fetch(
        makeRequest('POST', `/api/devices/${d1.id}/flag-stolen`, {
          hostname_confirm: 'AUDIT-A',
        }, { Authorization: 'Bearer test-admin-token' }),
        env,
      );
      await worker.fetch(
        makeRequest('POST', `/api/devices/${d2.id}/flag-stolen`, {
          hostname_confirm: 'AUDIT-B',
        }, { Authorization: 'Bearer test-admin-token' }),
        env,
      );
      const req = makeRequest('GET', `/api/audit?device_id=${d1.id}`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.every((e: any) => e.device_id === d1.id)).toBe(true);
    });

    it('POST /api/agent/location stores location report', async () => {
      const { device, apiKey } = await enrollDevice(worker, env, 'GEO-001');
      const body = JSON.stringify({
        hostname: 'GEO-001',
        location: {
          latitude: 37.77,
          longitude: -122.41,
          source: 'ip',
          city: 'San Francisco',
        },
      });
      const req = makeRequest('POST', '/api/agent/location', body, signRequest(body, apiKey));
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(200);

      // Verify location is retrievable
      const locReq = makeRequest('GET', `/api/devices/${device.id}/locations`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const locResp = await worker.fetch(locReq, env);
      const locData: any = await parseResponse(locResp);
      expect(locData.length).toBe(1);
      expect(locData[0].latitude).toBe(37.77);
      expect(locData[0].city).toBe('San Francisco');
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      const req = makeRequest('GET', '/unknown');
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(404);
    });
  });

  describe('CORS', () => {
    it('handles OPTIONS preflight', async () => {
      const req = makeRequest('OPTIONS', '/api/health');
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });
});
