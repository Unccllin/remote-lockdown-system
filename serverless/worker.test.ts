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

  describe('POST /api/enroll/token', () => {
    it('creates a short-lived enrollment token (admin auth)', async () => {
      const req = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);

      expect(resp.status).toBe(200);
      expect(data.token).toBeDefined();
      expect(typeof data.token).toBe('string');
      expect(data.expires_at).toBeDefined();
      expect(data.expires_in).toBe(900); // 15 minutes
    });

    it('rejects without admin auth', async () => {
      const req = makeRequest('POST', '/api/enroll/token', {});
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(401);
    });

    it('stores the token in KV', async () => {
      const req = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);

      // Verify the token is stored in KV
      const stored = await kv.get(`enroll_token:${data.token}`);
      expect(stored).not.toBeNull();
      const tokenData = JSON.parse(stored!);
      expect(tokenData.expires_at).toBeDefined();
    });
  });

  describe('POST /api/enroll/claim', () => {
    it('enrolls a device using a valid enrollment token', async () => {
      // 1. Generate token
      const tokenReq = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const tokenResp = await worker.fetch(tokenReq, env);
      const tokenData: any = await parseResponse(tokenResp);
      const token = tokenData.token;

      // 2. Claim the token (no admin auth needed)
      const claimReq = makeRequest('POST', '/api/enroll/claim', {
        token,
        hostname: 'TOKEN-DEV-001',
        owner_name: 'Token Test',
      });
      const claimResp = await worker.fetch(claimReq, env);
      const claimData: any = await parseResponse(claimResp);

      expect(claimResp.status).toBe(201);
      expect(claimData.device.hostname).toBe('TOKEN-DEV-001');
      expect(claimData.api_key).toBeDefined();
    });

    it('rejects claim without a token', async () => {
      const req = makeRequest('POST', '/api/enroll/claim', {
        hostname: 'NO-TOKEN-001',
      });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(400);
    });

    it('rejects claim without hostname', async () => {
      // Generate a token first
      const tokenReq = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const tokenResp = await worker.fetch(tokenReq, env);
      const tokenData: any = await parseResponse(tokenResp);

      const req = makeRequest('POST', '/api/enroll/claim', {
        token: tokenData.token,
      });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(400);
    });

    it('rejects claim with an invalid token', async () => {
      const req = makeRequest('POST', '/api/enroll/claim', {
        token: 'nonexistent-token',
        hostname: 'INVALID-001',
      });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(401);
    });

    it('token is single-use — second claim fails', async () => {
      // Generate token
      const tokenReq = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const tokenResp = await worker.fetch(tokenReq, env);
      const tokenData: any = await parseResponse(tokenResp);
      const token = tokenData.token;

      // First claim succeeds
      const claim1 = makeRequest('POST', '/api/enroll/claim', {
        token,
        hostname: 'SINGLE-USE-001',
      });
      const resp1 = await worker.fetch(claim1, env);
      expect(resp1.status).toBe(201);

      // Second claim with same token fails
      const claim2 = makeRequest('POST', '/api/enroll/claim', {
        token,
        hostname: 'SINGLE-USE-002',
      });
      const resp2 = await worker.fetch(claim2, env);
      expect(resp2.status).toBe(401);
    });

    it('rejects claim with an expired token', async () => {
      // Generate token
      const tokenReq = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const tokenResp = await worker.fetch(tokenReq, env);
      const tokenData: any = await parseResponse(tokenResp);
      const token = tokenData.token;

      // Manually expire the token by overwriting its KV entry
      const expiredData = JSON.stringify({
        created_by: 'admin',
        created_at: new Date().toISOString(),
        expires_at: Math.floor(Date.now() / 1000) - 60, // expired 60s ago
      });
      await kv.put(`enroll_token:${token}`, expiredData);

      const claimReq = makeRequest('POST', '/api/enroll/claim', {
        token,
        hostname: 'EXPIRED-001',
      });
      const claimResp = await worker.fetch(claimReq, env);
      expect(claimResp.status).toBe(401);
    });

    it('does not require admin auth (token replaces admin password)', async () => {
      // Generate token with admin auth
      const tokenReq = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const tokenResp = await worker.fetch(tokenReq, env);
      const tokenData: any = await parseResponse(tokenResp);

      // Claim with NO Authorization header — should still succeed
      const claimReq = makeRequest('POST', '/api/enroll/claim', {
        token: tokenData.token,
        hostname: 'NO-AUTH-001',
      });
      const claimResp = await worker.fetch(claimReq, env);
      expect(claimResp.status).toBe(201);
    });

    it('enrolled device appears in device list', async () => {
      // Generate + claim
      const tokenReq = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const { token } = await parseResponse(await worker.fetch(tokenReq, env)) as any;

      const claimReq = makeRequest('POST', '/api/enroll/claim', {
        token,
        hostname: 'LIST-CHECK-001',
        owner_name: 'List Check',
      });
      await worker.fetch(claimReq, env);

      // List devices
      const listReq = makeRequest('GET', '/api/devices', undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const listResp = await worker.fetch(listReq, env);
      const listData: any = await parseResponse(listResp);
      expect(listData.some((d: any) => d.hostname === 'LIST-CHECK-001')).toBe(true);
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

  describe('Hardware ID capture at enrollment', () => {
    it('POST /api/enroll captures hardware_uuid, mac_address, serial_number', async () => {
      const req = makeRequest(
        'POST',
        '/api/enroll',
        {
          hostname: 'HW-001',
          owner_name: 'Test',
          hardware_uuid: 'uuid-hw-001',
          mac_address: 'AA:BB:CC:DD:EE:01',
          serial_number: 'SN-001',
        },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);

      expect(resp.status).toBe(201);
      expect(data.device.hardware_uuid).toBe('uuid-hw-001');
      expect(data.device.mac_address).toBe('AA:BB:CC:DD:EE:01');
      expect(data.device.serial_number).toBe('SN-001');
    });

    it('stored hardware IDs appear in device detail', async () => {
      const enrollReq = makeRequest(
        'POST',
        '/api/enroll',
        {
          hostname: 'HW-002',
          hardware_uuid: 'uuid-hw-002',
          mac_address: 'AA:BB:CC:DD:EE:02',
          serial_number: 'SN-002',
        },
        { Authorization: 'Bearer test-admin-token' },
      );
      const enrollResp = await worker.fetch(enrollReq, env);
      const enrollData: any = await parseResponse(enrollResp);
      const deviceId = enrollData.device.id;

      const getReq = makeRequest('GET', `/api/devices/${deviceId}`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const getResp = await worker.fetch(getReq, env);
      const getData: any = await parseResponse(getResp);

      expect(getData.hardware_uuid).toBe('uuid-hw-002');
      expect(getData.mac_address).toBe('AA:BB:CC:DD:EE:02');
      expect(getData.serial_number).toBe('SN-002');
    });

    it('POST /api/enroll/claim captures hardware IDs', async () => {
      // Generate token
      const tokenReq = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const { token } = await parseResponse(await worker.fetch(tokenReq, env)) as any;

      const claimReq = makeRequest('POST', '/api/enroll/claim', {
        token,
        hostname: 'HW-CLAIM-001',
        hardware_uuid: 'uuid-claim-001',
        mac_address: 'AA:BB:CC:DD:EE:03',
        serial_number: 'SN-003',
      });
      const claimResp = await worker.fetch(claimReq, env);
      const claimData: any = await parseResponse(claimResp);

      expect(claimResp.status).toBe(201);
      expect(claimData.device.hardware_uuid).toBe('uuid-claim-001');
      expect(claimData.device.mac_address).toBe('AA:BB:CC:DD:EE:03');
      expect(claimData.device.serial_number).toBe('SN-003');
    });
  });

  describe('Re-association by hardware UUID', () => {
    it('re-enrolling with same hardware_uuid returns same device ID with new API key', async () => {
      // First enrollment
      const enroll1 = makeRequest(
        'POST',
        '/api/enroll',
        {
          hostname: 'REASSOC-001',
          hardware_uuid: 'uuid-reassoc-001',
          mac_address: 'AA:BB:CC:DD:EE:10',
          serial_number: 'SN-REASSOC-001',
        },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp1 = await worker.fetch(enroll1, env);
      const data1: any = await parseResponse(resp1);
      const firstDeviceId = data1.device.id;
      const firstApiKey = data1.api_key;

      expect(resp1.status).toBe(201);

      // Second enrollment with same hardware_uuid but different hostname
      const enroll2 = makeRequest(
        'POST',
        '/api/enroll',
        {
          hostname: 'REASSOC-001-RENamed',
          hardware_uuid: 'uuid-reassoc-001',
          mac_address: 'AA:BB:CC:DD:EE:11',
          serial_number: 'SN-REASSOC-001-NEW',
        },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp2 = await worker.fetch(enroll2, env);
      const data2: any = await parseResponse(resp2);

      // Should return same device ID, new API key, reassociated flag
      expect(resp2.status).toBe(200);
      expect(data2.device.id).toBe(firstDeviceId);
      expect(data2.api_key).toBeDefined();
      expect(data2.api_key).not.toBe(firstApiKey);
      expect(data2.reassociated).toBe(true);
      // Hostname should be updated
      expect(data2.device.hostname).toBe('REASSOC-001-RENamed');
      expect(data2.device.hardware_uuid).toBe('uuid-reassoc-001');
    });

    it('re-associated device has updated hostname, mac_address, serial_number', async () => {
      // First enrollment
      const enroll1 = makeRequest(
        'POST',
        '/api/enroll',
        {
          hostname: 'REASSOC-DETAIL-001',
          hardware_uuid: 'uuid-reassoc-detail',
          mac_address: 'AA:BB:CC:DD:EE:20',
          serial_number: 'SN-OLD',
        },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp1 = await worker.fetch(enroll1, env);
      const data1: any = await parseResponse(resp1);
      const deviceId = data1.device.id;

      // Re-enroll with new details
      const enroll2 = makeRequest(
        'POST',
        '/api/enroll',
        {
          hostname: 'REASSOC-DETAIL-NEW',
          hardware_uuid: 'uuid-reassoc-detail',
          mac_address: 'AA:BB:CC:DD:EE:21',
          serial_number: 'SN-NEW',
        },
        { Authorization: 'Bearer test-admin-token' },
      );
      await worker.fetch(enroll2, env);

      // Verify via device detail
      const getReq = makeRequest('GET', `/api/devices/${deviceId}`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const getResp = await worker.fetch(getReq, env);
      const getData: any = await parseResponse(getResp);

      expect(getData.hostname).toBe('REASSOC-DETAIL-NEW');
      expect(getData.mac_address).toBe('AA:BB:CC:DD:EE:21');
      expect(getData.serial_number).toBe('SN-NEW');
      expect(getData.status).toBe('active');
    });

    it('re-association resets status to active', async () => {
      // Enroll
      const enroll1 = makeRequest(
        'POST',
        '/api/enroll',
        {
          hostname: 'REASSOC-STATUS-001',
          hardware_uuid: 'uuid-reassoc-status',
        },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp1 = await worker.fetch(enroll1, env);
      const data1: any = await parseResponse(resp1);
      const deviceId = data1.device.id;

      // Flag stolen
      await worker.fetch(
        makeRequest('POST', `/api/devices/${deviceId}/flag-stolen`, {
          hostname_confirm: 'REASSOC-STATUS-001',
        }, { Authorization: 'Bearer test-admin-token' }),
        env,
      );

      // Verify it's stolen
      const stolenResp = await worker.fetch(
        makeRequest('GET', `/api/devices/${deviceId}`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const stolenData: any = await parseResponse(stolenResp);
      expect(stolenData.status).toBe('stolen');

      // Re-enroll with same hardware_uuid
      const enroll2 = makeRequest(
        'POST',
        '/api/enroll',
        {
          hostname: 'REASSOC-STATUS-001',
          hardware_uuid: 'uuid-reassoc-status',
        },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp2 = await worker.fetch(enroll2, env);
      const data2: any = await parseResponse(resp2);

      expect(resp2.status).toBe(200);
      expect(data2.device.status).toBe('active');
    });

    it('re-association via enroll/claim with same hardware_uuid', async () => {
      // First enrollment via admin
      const enroll1 = makeRequest(
        'POST',
        '/api/enroll',
        {
          hostname: 'REASSOC-CLAIM-001',
          hardware_uuid: 'uuid-reassoc-claim',
        },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp1 = await worker.fetch(enroll1, env);
      const data1: any = await parseResponse(resp1);
      const firstDeviceId = data1.device.id;

      // Generate token and claim with same hardware_uuid
      const tokenReq = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const { token } = await parseResponse(await worker.fetch(tokenReq, env)) as any;

      const claimReq = makeRequest('POST', '/api/enroll/claim', {
        token,
        hostname: 'REASSOC-CLAIM-NEW',
        hardware_uuid: 'uuid-reassoc-claim',
      });
      const claimResp = await worker.fetch(claimReq, env);
      const claimData: any = await parseResponse(claimResp);

      expect(claimResp.status).toBe(200);
      expect(claimData.device.id).toBe(firstDeviceId);
      expect(claimData.reassociated).toBe(true);
      expect(claimData.device.hostname).toBe('REASSOC-CLAIM-NEW');
    });

    it('different hardware_uuid creates a new device (no re-association)', async () => {
      const enroll1 = makeRequest(
        'POST',
        '/api/enroll',
        {
          hostname: 'NEW-DEV-001',
          hardware_uuid: 'uuid-new-001',
        },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp1 = await worker.fetch(enroll1, env);
      const data1: any = await parseResponse(resp1);

      const enroll2 = makeRequest(
        'POST',
        '/api/enroll',
        {
          hostname: 'NEW-DEV-002',
          hardware_uuid: 'uuid-new-002',
        },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp2 = await worker.fetch(enroll2, env);
      const data2: any = await parseResponse(resp2);

      expect(resp2.status).toBe(201);
      expect(data2.device.id).not.toBe(data1.device.id);
      expect(data2.reassociated).toBeUndefined();
    });
  });

  describe('GET /api/devices/by-hardware/:uuid', () => {
    it('finds a device by hardware_uuid', async () => {
      // Enroll with hardware_uuid
      await worker.fetch(
        makeRequest('POST', '/api/enroll', {
          hostname: 'BYHW-001',
          hardware_uuid: 'uuid-byhw-001',
          mac_address: 'AA:BB:CC:DD:EE:30',
          serial_number: 'SN-BYHW-001',
        }, { Authorization: 'Bearer test-admin-token' }),
        env,
      );

      const req = makeRequest('GET', '/api/devices/by-hardware/uuid-byhw-001', undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);

      expect(resp.status).toBe(200);
      expect(data.hostname).toBe('BYHW-001');
      expect(data.hardware_uuid).toBe('uuid-byhw-001');
      expect(data.serial_number).toBe('SN-BYHW-001');
    });

    it('returns 404 for unknown hardware_uuid', async () => {
      const req = makeRequest('GET', '/api/devices/by-hardware/nonexistent-uuid', undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(404);
    });

    it('rejects without admin auth', async () => {
      const req = makeRequest('GET', '/api/devices/by-hardware/some-uuid');
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(401);
    });

    it('finds device by hardware_uuid reported via checkin (not enrollment)', async () => {
      // Enroll WITHOUT hardware_uuid
      const enrollResp = await worker.fetch(
        makeRequest('POST', '/api/enroll', {
          hostname: 'BYHW-CHECKIN-001',
        }, { Authorization: 'Bearer test-admin-token' }),
        env,
      );
      const enrollData: any = await parseResponse(enrollResp);
      const apiKey = enrollData.api_key;

      // Agent checks in with hardware_uuid
      const checkinBody = JSON.stringify({
        hostname: 'BYHW-CHECKIN-001',
        hardware_uuid: 'uuid-from-checkin',
        mac_address: 'AA:BB:CC:DD:EE:40',
        serial_number: 'SN-CHECKIN',
      });
      await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', checkinBody, signRequest(checkinBody, apiKey)),
        env,
      );

      // Now look up by the checkin-reported hardware_uuid
      const req = makeRequest('GET', '/api/devices/by-hardware/uuid-from-checkin', undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);

      expect(resp.status).toBe(200);
      expect(data.hostname).toBe('BYHW-CHECKIN-001');
      expect(data.hardware_uuid).toBe('uuid-from-checkin');
    });
  });

  describe('Serial number in checkin metadata', () => {
    it('serial_number from checkin appears in device detail', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'SERIAL-001');

      const checkinBody = JSON.stringify({
        hostname: 'SERIAL-001',
        hardware_uuid: 'uuid-serial-001',
        mac_address: 'AA:BB:CC:DD:EE:50',
        serial_number: 'SN-CHECKIN-001',
      });
      const checkinReq = makeRequest('POST', '/api/agent/checkin', checkinBody, signRequest(checkinBody, apiKey));
      const checkinResp = await worker.fetch(checkinReq, env);
      expect(checkinResp.status).toBe(200);

      const getReq = makeRequest('GET', `/api/devices/${device.id}`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const getResp = await worker.fetch(getReq, env);
      const getData: any = await parseResponse(getResp);

      expect(getData.serial_number).toBe('SN-CHECKIN-001');
      expect(getData.hardware_uuid).toBe('uuid-serial-001');
      expect(getData.mac_address).toBe('AA:BB:CC:DD:EE:50');
    });

    it('serial_number from checkin appears in device list', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'SERIAL-LIST-001');

      const checkinBody = JSON.stringify({
        hostname: 'SERIAL-LIST-001',
        serial_number: 'SN-LIST-001',
      });
      await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', checkinBody, signRequest(checkinBody, apiKey)),
        env,
      );

      const listReq = makeRequest('GET', '/api/devices', undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const listResp = await worker.fetch(listReq, env);
      const listData: any = await parseResponse(listResp);

      const found = listData.find((d: any) => d.hostname === 'SERIAL-LIST-001');
      expect(found).toBeDefined();
      expect(found.serial_number).toBe('SN-LIST-001');
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

// ---------------------------------------------------------------------------
// KV-RACE-001: Stale read race condition between checkin and ACK handlers
// ---------------------------------------------------------------------------
// Cloudflare KV is eventually consistent. A read after a write may return
// stale data. This test simulates that: after a write, the next read of
// the same key returns the PREVIOUS value, then subsequent reads return
// the current value. This exposes the race where the checkin handler
// reads stale device status and overwrites the ACK handler's status update.

class StaleKV {
  private data: Record<string, string> = {};
  private previousData: Record<string, string> = {};
  private staleKeys: Set<string> = new Set();
  // Only simulate stale reads for these keys (the ones that race)
  private monitoredKeys: Set<string>;
  // Monitoring is disabled until startMonitoring() is called, so setup
  // (enroll, flag-stolen) works normally without stale reads.
  private monitoring: boolean = false;

  constructor(monitoredKeys: string[] = ['devices']) {
    this.monitoredKeys = new Set(monitoredKeys);
  }

  async get(key: string): Promise<string | null> {
    // If a key is marked stale, return the previous value until clearStale()
    // is called. This simulates a long KV propagation delay (up to 60s in
    // real Cloudflare KV), where multiple reads return stale data.
    if (this.staleKeys.has(key)) {
      return this.previousData[key] ?? null;
    }
    return this.data[key] ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.previousData[key] = this.data[key] ?? '';
    this.data[key] = value;
    // Only mark as stale if monitoring is active AND this is a monitored key
    if (this.monitoring && this.monitoredKeys.has(key)) {
      this.staleKeys.add(key);
    }
  }

  startMonitoring(): void {
    this.monitoring = true;
  }

  clearStale(): void {
    this.staleKeys.clear();
  }

  reset(): void {
    this.data = {};
    this.previousData = {};
    this.staleKeys.clear();
    this.monitoring = false;
  }
}

describe('KV-RACE-001: checkin does not overwrite ACK status update', () => {
  let kv: StaleKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: StaleKV };

  beforeEach(() => {
    kv = new StaleKV();
    env = {
      ADMIN_TOKEN: 'test-admin-token',
      LOCKDOWN_KV: kv,
    };
  });

  it('device status stays locked after ACK even with stale KV reads', async () => {
    // 1. Enroll device
    const { device, apiKey } = await enrollDevice(worker, env, 'RACE-001');

    // 2. Flag stolen
    await worker.fetch(
      makeRequest('POST', `/api/devices/${device.id}/flag-stolen`, {
        hostname_confirm: 'RACE-001',
      }, { Authorization: 'Bearer test-admin-token' }),
      env,
    );

    // 3. Agent checkin — gets lockdown command
    const checkinBody = JSON.stringify({
      hostname: 'RACE-001',
      mac_address: 'AA:BB:CC:DD:EE:FF',
      hardware_uuid: 'test-uuid',
    });
    const checkinResp = await worker.fetch(
      makeRequest('POST', '/api/agent/checkin', checkinBody, signRequest(checkinBody, apiKey)),
      env,
    );
    const checkinData: any = await parseResponse(checkinResp);
    expect(checkinData.command).not.toBeNull();
    expect(checkinData.command.type).toBe('lockdown');
    const commandId = checkinData.command.id;

    // 4. Agent ACKs lockdown — ACK handler writes status=locked to devices key
    //    Enable stale monitoring NOW so the ACK's write to 'devices' marks it
    //    as stale. The next read of 'devices' (by the checkin handler) will
    //    return the OLD value (status=stolen), simulating KV propagation delay.
    kv.startMonitoring();
    const ackBody = JSON.stringify({
      hostname: 'RACE-001',
      command_id: commandId,
      result_status: 'executed',
      key_material: 'test-key-material-base64==',
    });
    const ackResp = await worker.fetch(
      makeRequest('POST', '/api/agent/command-ack', ackBody, signRequest(ackBody, apiKey)),
      env,
    );
    expect(ackResp.status).toBe(200);

    // 5. Agent checks in again — StaleKV returns stale devices (status=stolen)
    //    With the OLD code: checkin reads stale status=stolen, writes full array
    //    back → overwrites status=locked with status=stolen (BUG)
    //    With the FIX: checkin writes to device_checkin:{id}, not devices
    const checkin2Body = JSON.stringify({
      hostname: 'RACE-001',
      mac_address: 'AA:BB:CC:DD:EE:FF',
      hardware_uuid: 'test-uuid',
    });
    const checkin2Resp = await worker.fetch(
      makeRequest('POST', '/api/agent/checkin', checkin2Body, signRequest(checkin2Body, apiKey)),
      env,
    );
    const checkin2Data: any = await parseResponse(checkin2Resp);
    expect(checkin2Resp.status).toBe(200);

    // 6. Verify device status is still 'locked' (not overwritten to 'stolen')
    //    Clear stale reads first so we see the actual current KV state.
    kv.clearStale();
    const deviceResp = await worker.fetch(
      makeRequest('GET', `/api/devices/${device.id}`, undefined, {
        Authorization: 'Bearer test-admin-token',
      }),
      env,
    );
    const deviceData: any = await parseResponse(deviceResp);
    expect(deviceData.status).toBe('locked');
  });
});
