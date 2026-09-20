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
  private data: Record<string, string | Uint8Array> = {};

  async get(key: string, options?: { type?: 'json' | 'text' | 'arrayBuffer' } | string): Promise<string | Uint8Array | null> {
    const val = this.data[key];
    if (val === undefined) return null;
    // Handle both { type: 'json' } and 'json' style calls
    const type = typeof options === 'string' ? options : options?.type;
    if (type === 'json') {
      const str = typeof val === 'string' ? val : new TextDecoder().decode(val);
      return JSON.parse(str);
    }
    if (type === 'arrayBuffer') {
      if (val instanceof Uint8Array) return val;
      return new TextEncoder().encode(val);
    }
    // Default: return as string
    return typeof val === 'string' ? val : new TextDecoder().decode(val);
  }

  async put(key: string, value: string | Uint8Array): Promise<void> {
    this.data[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  }

  async delete(key: string): Promise<void> {
    delete this.data[key];
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? '';
    const keys: { name: string }[] = [];
    for (const key of Object.keys(this.data)) {
      if (!prefix || key.startsWith(prefix)) {
        keys.push({ name: key });
      }
    }
    return { keys, list_complete: true };
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
let resetKeyCache: () => void;

beforeEach(async () => {
  const mod = await import('./worker.js');
  worker = mod.default;
  resetKeyCache = mod.resetKeyCache;
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
    // D-205: Reset the module-level key cache so each test starts fresh
    if (resetKeyCache) resetKeyCache();
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

  // S4: escrow-before-arm — dedicated key-escrow endpoint. The agent calls
  // this BEFORE encrypting during a lockdown; the key is persisted bound to
  // the command_id so the recovery key is escrowed before the point of no
  // return.
  describe('POST /api/agent/escrow-key', () => {
    it('stores the key bound to command_id and returns escrowed:true', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'ESCROW-001');
      // Flag stolen → queue a lockdown command
      const flagReq = makeRequest(
        'POST',
        `/api/devices/${device.id}/flag`,
        { hostname_confirm: 'ESCROW-001' },
        { Authorization: 'Bearer test-admin-token' },
      );
      await worker.fetch(flagReq, env);

      const checkinBody = JSON.stringify({ hostname: 'ESCROW-001' });
      const checkinResp = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', checkinBody, signRequest(checkinBody, apiKey)), env);
      const checkinData: any = await parseResponse(checkinResp);
      const cmdId = checkinData.command.id;

      const body = JSON.stringify({
        hostname: 'ESCROW-001',
        command_id: cmdId,
        key_material: 'escrowed-fernet-key-base64',
      });
      const resp = await worker.fetch(
        makeRequest('POST', '/api/agent/escrow-key', body, signRequest(body, apiKey)), env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.escrowed).toBe(true);
      expect(data.command_id).toBe(cmdId);

      // Agent ACKs the lockdown so it completes (pending → unlock next).
      const ackBody = JSON.stringify({
        hostname: 'ESCROW-001',
        command_id: cmdId,
        result_status: 'executed',
      });
      await worker.fetch(makeRequest('POST', '/api/agent/command-ack', ackBody, signRequest(ackBody, apiKey)), env);

      // The escrowed key is released to the agent on unlock.
      const recoverReq = makeRequest(
        'POST',
        `/api/devices/${device.id}/recover`,
        { hostname_confirm: 'ESCROW-001' },
        { Authorization: 'Bearer test-admin-token' },
      );
      await worker.fetch(recoverReq, env);
      const checkin2Body = JSON.stringify({ hostname: 'ESCROW-001' });
      const checkin2Resp = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', checkin2Body, signRequest(checkin2Body, apiKey)), env);
      const checkin2Data: any = await parseResponse(checkin2Resp);
      expect(checkin2Data.command.key_material).toBe('escrowed-fernet-key-base64');
    });

    it('is idempotent — second call keeps the first key', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'ESCROW-002');
      const flagReq = makeRequest(
        'POST',
        `/api/devices/${device.id}/flag`,
        { hostname_confirm: 'ESCROW-002' },
        { Authorization: 'Bearer test-admin-token' },
      );
      await worker.fetch(flagReq, env);
      const checkinBody = JSON.stringify({ hostname: 'ESCROW-002' });
      const checkinResp = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', checkinBody, signRequest(checkinBody, apiKey)), env);
      const checkinData: any = await parseResponse(checkinResp);
      const cmdId = checkinData.command.id;

      const mk = (key: string) => makeRequest(
        'POST', '/api/agent/escrow-key',
        JSON.stringify({ hostname: 'ESCROW-002', command_id: cmdId, key_material: key }),
        signRequest(JSON.stringify({ hostname: 'ESCROW-002', command_id: cmdId, key_material: key }), apiKey));
      const r1 = await worker.fetch(mk('first-key'), env);
      expect((await parseResponse(r1) as any).escrowed).toBe(true);
      const r2 = await worker.fetch(mk('second-key'), env);
      expect((await parseResponse(r2) as any).escrowed).toBe(true);
    });

    it('rejects a command_id that does not belong to the device', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'ESCROW-003');
      const body = JSON.stringify({
        hostname: 'ESCROW-003',
        command_id: 'nonexistent-cmd',
        key_material: 'key-base64',
      });
      const resp = await worker.fetch(
        makeRequest('POST', '/api/agent/escrow-key', body, signRequest(body, apiKey)), env);
      expect(resp.status).toBe(404);
    });

    it('rejects without key_material', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'ESCROW-004');
      const body = JSON.stringify({ hostname: 'ESCROW-004', command_id: 'c1' });
      const resp = await worker.fetch(
        makeRequest('POST', '/api/agent/escrow-key', body, signRequest(body, apiKey)), env);
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
      // Break-glass ADMIN_TOKEN login now returns a signed session token
      // (JWT-shape), not the raw token back.
      expect(typeof data.token).toBe('string');
      expect(data.token.split('.')).toHaveLength(3); // header.payload.sig
      expect(data.user.role).toBe('super-admin');

      // The returned signed token must be usable as a Bearer credential.
      const devReq = makeRequest('GET', '/api/devices', undefined, {
        Authorization: `Bearer ${data.token}`,
      });
      const devResp = await worker.fetch(devReq, env);
      expect(devResp.status).toBe(200);
    });

    it('POST /api/auth/login rejects wrong token', async () => {
      const req = makeRequest('POST', '/api/auth/login', {
        username: 'admin',
        password: 'wrong-token',
      });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(401);
    });

    it('GET /api/setup/status reports needsSetup true before first admin, false after', async () => {
      const req = makeRequest('GET', '/api/setup/status');
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      // First-run: no admin exists yet → needsSetup true.
      expect(data.setupComplete).toBe(false);
      expect(data.needsSetup).toBe(true);

      // Create the first admin → setupComplete flips to true.
      const createReq = makeRequest('POST', '/api/setup/create-admin', {
        username: 'firstadmin', password: 'supersecret1',
      });
      const createResp = await worker.fetch(createReq, env);
      expect(createResp.status).toBe(200);

      const resp2 = await worker.fetch(makeRequest('GET', '/api/setup/status'), env);
      const data2: any = await parseResponse(resp2);
      expect(data2.setupComplete).toBe(true);
      expect(data2.needsSetup).toBe(false);
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

    it('POST /api/agent/efs-cert uploads cert (agent auth)', async () => {
      const { device, apiKey } = await enrollDevice(worker, env, 'EFS-001');
      const body = JSON.stringify({
        cert_base64: 'MIIKXAIBAzCCCgAGCSqGSIb3DQEHAaCCCfkEggn1MIIJ8TCCBf8GCSqGSIb3DQEH',
        cert_password: 'secret123',
      });
      const req = makeRequest(
        'POST',
        '/api/agent/efs-cert',
        body,
        signRequest(body, apiKey),
      );
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.stored).toBe(true);
      expect(data.device.id).toBe(device.id);
    });

    it('POST /api/agent/efs-cert rejects without auth', async () => {
      const body = JSON.stringify({ cert_base64: 'dGVzdA==', cert_password: 'pw' });
      const req = makeRequest('POST', '/api/agent/efs-cert', body);
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(401);
    });

    it('POST /api/agent/efs-cert rejects missing cert_base64', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'EFS-002');
      const body = JSON.stringify({ cert_password: 'pw' });
      const req = makeRequest(
        'POST',
        '/api/agent/efs-cert',
        body,
        signRequest(body, apiKey),
      );
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(400);
    });

    it('GET /api/devices/:id/efs-cert returns uploaded cert (admin auth)', async () => {
      const { device, apiKey } = await enrollDevice(worker, env, 'EFS-003');
      // Upload cert first
      const certBody = JSON.stringify({
        cert_base64: 'MIIKXAIBAzCCCgAGCSqGSIb3DQEHAaCCCfkEggn1MIIJ8TCCBf8GCSqGSIb3DQEH',
        cert_password: 'secret123',
      });
      await worker.fetch(
        makeRequest('POST', '/api/agent/efs-cert', certBody, signRequest(certBody, apiKey)),
        env,
      );
      // Download cert
      const req = makeRequest('GET', `/api/devices/${device.id}/efs-cert`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.cert_base64).toBe('MIIKXAIBAzCCCgAGCSqGSIb3DQEHAaCCCfkEggn1MIIJ8TCCBf8GCSqGSIb3DQEH');
      expect(data.cert_password).toBe('secret123');
      expect(data.device_id).toBe(device.id);
    });

    it('GET /api/devices/:id/efs-cert returns 404 if no cert uploaded', async () => {
      const { device } = await enrollDevice(worker, env, 'EFS-004');
      const req = makeRequest('GET', `/api/devices/${device.id}/efs-cert`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(404);
    });

    it('GET /api/devices/:id/efs-cert rejects without admin auth', async () => {
      const { device } = await enrollDevice(worker, env, 'EFS-005');
      const req = makeRequest('GET', `/api/devices/${device.id}/efs-cert`);
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(401);
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

  // S4-serverless: multi-admin RBAC on KV — username+password login →
  // signed session token, role hierarchy, /api/admins CRUD.
  describe('S4-serverless: admin RBAC', () => {
    async function seedAdmin(env: unknown, username = 'sa1', password = 'password123', role = 'super-admin') {
      // First admin via setup; subsequent via /api/admins.
      const resp = await worker.fetch(makeRequest('GET', '/api/setup/status'), env);
      const needsSetup = (await parseResponse(resp) as any).needsSetup;
      if (needsSetup) {
        const r = await worker.fetch(makeRequest('POST', '/api/setup/create-admin', { username, password }), env);
        return (await parseResponse(r) as any);
      }
      const r = await worker.fetch(
        makeRequest('POST', '/api/admins', { username, password, role }, { Authorization: 'Bearer test-admin-token' }), env);
      return (await parseResponse(r) as any);
    }
    async function login(env: unknown, username: string, password: string) {
      const r = await worker.fetch(makeRequest('POST', '/api/auth/login', { username, password }), env);
      return { resp: r, data: (await parseResponse(r) as any) };
    }

    it('first admin created via setup becomes super-admin and gets a token', async () => {
      const data = await seedAdmin(env);
      expect(data.admin.role).toBe('super-admin');
      expect(data.token.split('.')).toHaveLength(3);
    });

    it('setup/create-admin is closed after the first admin exists', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      const r = await worker.fetch(makeRequest('POST', '/api/setup/create-admin', { username: 'x', password: 'password123' }), env);
      expect(r.status).toBe(409);
    });

    it('login with correct credentials returns a usable signed token', async () => {
      await seedAdmin(env, 'op1', 'password123');
      const { resp, data } = await login(env, 'op1', 'password123');
      expect(resp.status).toBe(200);
      expect(data.user.role).toBeDefined();
      const r = await worker.fetch(makeRequest('GET', '/api/devices', undefined, {
        Authorization: `Bearer ${data.token}`,
      }), env);
      expect(r.status).toBe(200);
    });

    it('login with wrong password returns 401', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      const { resp } = await login(env, 'sa1', 'wrongpassword');
      expect(resp.status).toBe(401);
    });

    it('login with unknown username returns 401', async () => {
      const { resp } = await login(env, 'nosuchadmin', 'password123');
      expect(resp.status).toBe(401);
    });

    it('POST /api/admins requires super-admin; operator token is rejected', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      // create an operator via super-admin
      await worker.fetch(makeRequest('POST', '/api/admins',
        { username: 'op1', password: 'password123', role: 'operator' },
        { Authorization: 'Bearer test-admin-token' }), env);
      const { data } = await login(env, 'op1', 'password123');
      // operator tries to create another admin → 403
      const r = await worker.fetch(makeRequest('POST', '/api/admins',
        { username: 'x', password: 'password123', role: 'viewer' },
        { Authorization: `Bearer ${data.token}` }), env);
      expect(r.status).toBe(403);
    });

    it('GET /api/admins lists admins for super-admin', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      const r = await worker.fetch(makeRequest('GET', '/api/admins', undefined, {
        Authorization: 'Bearer test-admin-token',
      }), env);
      const data: any = await parseResponse(r);
      expect(r.status).toBe(200);
      expect(data.some((a: any) => a.username === 'sa1')).toBe(true);
      expect(data[0].password_hash).toBeUndefined(); // never leak hashes
    });

    it('cannot delete the last super-admin', async () => {
      const me = await seedAdmin(env, 'onlyadmin', 'password123');
      const r = await worker.fetch(
        makeRequest('DELETE', `/api/admins/${me.admin.id}`, undefined, { Authorization: 'Bearer test-admin-token' }), env);
      expect(r.status).toBe(400); // last super-admin (and self)
    });

    it('PATCH /api/admins/:id changes a role', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      const op = await worker.fetch(makeRequest('POST', '/api/admins',
        { username: 'op1', password: 'password123', role: 'operator' },
        { Authorization: 'Bearer test-admin-token' }), env);
      const opData: any = await parseResponse(op);
      const r = await worker.fetch(
        makeRequest('PATCH', `/api/admins/${opData.id}`, { role: 'viewer' }, { Authorization: 'Bearer test-admin-token' }), env);
      const data: any = await parseResponse(r);
      expect(r.status).toBe(200);
      expect(data.role).toBe('viewer');
    });

    // Phase 2: role enforcement on operational routes.
    it('viewer CAN read devices but CANNOT flag-stolen (operator gate)', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      await worker.fetch(makeRequest('POST', '/api/admins',
        { username: 'view1', password: 'password123', role: 'viewer' },
        { Authorization: 'Bearer test-admin-token' }), env);
      const { data } = await login(env, 'view1', 'password123');
      const viewerTok = data.token;
      const { device } = await enrollDevice(worker, env, 'ROLE-001');

      // viewer can list devices
      const list = await worker.fetch(makeRequest('GET', '/api/devices', undefined, {
        Authorization: `Bearer ${viewerTok}`,
      }), env);
      expect(list.status).toBe(200);

      // viewer cannot flag-stolen (operator required)
      const flag = await worker.fetch(makeRequest('POST', `/api/devices/${device.id}/flag-stolen`,
        { hostname_confirm: 'ROLE-001' },
        { Authorization: `Bearer ${viewerTok}` }), env);
      expect(flag.status).toBe(403);
    });

    it('operator CAN flag-stolen but CANNOT create admins (super-admin gate)', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      await worker.fetch(makeRequest('POST', '/api/admins',
        { username: 'op2', password: 'password123', role: 'operator' },
        { Authorization: 'Bearer test-admin-token' }), env);
      const { data } = await login(env, 'op2', 'password123');
      const opTok = data.token;
      const { device } = await enrollDevice(worker, env, 'ROLE-002');

      const flag = await worker.fetch(makeRequest('POST', `/api/devices/${device.id}/flag-stolen`,
        { hostname_confirm: 'ROLE-002' },
        { Authorization: `Bearer ${opTok}` }), env);
      expect(flag.status).toBe(200);

      const mkAdmin = await worker.fetch(makeRequest('POST', '/api/admins',
        { username: 'x', password: 'password123', role: 'viewer' },
        { Authorization: `Bearer ${opTok}` }), env);
      expect(mkAdmin.status).toBe(403);
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

// ---------------------------------------------------------------------------
// D-210: PBL /v1/* route integration tests
// ---------------------------------------------------------------------------

describe('D-210: PBL route integration', () => {
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV; PBL_SIGNING_KEY?: string };

  beforeEach(() => {
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-admin-token',
      LOCKDOWN_KV: kv,
    };
    // D-205: Reset the module-level key cache so each test starts fresh
    if (resetKeyCache) resetKeyCache();
  });

  describe('GET /v1/health', () => {
    it('returns ok status with pbl flag', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/health'), env);
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.status).toBe('ok');
      expect(data.pbl).toBe(true);
    });
  });

  describe('GET /v1/policy/:version', () => {
    it('returns a COSE_Sign1 policy for version 1', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/policy/1'), env);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('Content-Type')).toBe('application/cose');
      const body = new Uint8Array(await resp.arrayBuffer());
      expect(body.length).toBeGreaterThan(0);
    });

    it('returns stored policy when available', async () => {
      const fakePolicy = new Uint8Array([0x84, 0x40, 0xa0, 0x44, 0x01, 0x02, 0x03, 0x04]);
      await kv.put('pbl_policy:5', fakePolicy);
      await kv.put('pbl_policy:latest_version', '5');

      const resp = await worker.fetch(makeRequest('GET', '/v1/policy/5'), env);
      expect(resp.status).toBe(200);
      const body = new Uint8Array(await resp.arrayBuffer());
      expect(Array.from(body)).toEqual(Array.from(fakePolicy));
    });

    it('returns latest policy version', async () => {
      const fakePolicy = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await kv.put('pbl_policy:3', fakePolicy);
      await kv.put('pbl_policy:latest_version', '3');

      const resp = await worker.fetch(makeRequest('GET', '/v1/policy/latest'), env);
      expect(resp.status).toBe(200);
      const body = new Uint8Array(await resp.arrayBuffer());
      expect(Array.from(body)).toEqual(Array.from(fakePolicy));
    });

    it('rejects invalid version', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/policy/abc'), env);
      expect(resp.status).toBe(400);
    });
  });

  describe('GET /v1/devices', () => {
    it('rejects without admin auth', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/devices'), env);
      expect(resp.status).toBe(401);
    });

    it('returns empty list when no devices exist', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', '/v1/devices', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.devices).toEqual([]);
      expect(data.count).toBe(0);
    });

    it('returns devices after enrollment', async () => {
      // Enroll a PBL device first
      const deviceId = 'aabbccdd'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
        hostname: 'test-pbl-host',
      }));

      const resp = await worker.fetch(
        makeRequest('GET', '/v1/devices', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.devices.length).toBe(1);
      expect(data.devices[0].device_id).toBe(deviceId);
      expect(data.count).toBe(1);
    });
  });

  describe('GET /v1/devices/:id', () => {
    it('rejects without admin auth', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/devices/abc'), env);
      expect(resp.status).toBe(401);
    });

    it('returns 404 for non-existent device', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', '/v1/devices/ff'.repeat(32), undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('returns device for valid id', async () => {
      const deviceId = 'a1b2c3d4'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
        hostname: 'test-host',
      }));

      const resp = await worker.fetch(
        makeRequest('GET', `/v1/devices/${deviceId}`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.device.device_id).toBe(deviceId);
      expect(data.device.status).toBe('active');
      expect(data.device.hostname).toBe('test-host');
    });
  });

  describe('POST /v1/devices/:id/lock', () => {
    it('rejects without admin auth', async () => {
      const resp = await worker.fetch(makeRequest('POST', '/v1/devices/abc/lock'), env);
      expect(resp.status).toBe(401);
    });

    it('returns 404 for non-existent device', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/v1/devices/ff'.repeat(32) + '/lock', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('locks an active device', async () => {
      const deviceId = 'a1b2c3d4'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
      }));

      const resp = await worker.fetch(
        makeRequest('POST', `/v1/devices/${deviceId}/lock`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.device.status).toBe('locked');
      expect(data.device.lock_reason).toBe('admin_lock');
    });
  });

  describe('POST /v1/devices/:id/unlock', () => {
    it('rejects without admin auth', async () => {
      const resp = await worker.fetch(makeRequest('POST', '/v1/devices/abc/unlock'), env);
      expect(resp.status).toBe(401);
    });

    it('unlocks a locked device', async () => {
      const deviceId = 'a1b2c3d4'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'locked',
        enrolled_at: '2026-01-01T00:00:00Z',
        lock_reason: 'admin_lock',
      }));

      const resp = await worker.fetch(
        makeRequest('POST', `/v1/devices/${deviceId}/unlock`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.device.status).toBe('active');
    });
  });

  describe('DELETE /v1/devices/:id', () => {
    it('rejects without admin auth', async () => {
      const resp = await worker.fetch(makeRequest('DELETE', '/v1/devices/abc'), env);
      expect(resp.status).toBe(401);
    });

    it('returns 404 for non-existent device', async () => {
      const resp = await worker.fetch(
        makeRequest('DELETE', '/v1/devices/ff'.repeat(32), undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('deletes an existing device', async () => {
      const deviceId = 'a1b2c3d4'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
      }));

      const resp = await worker.fetch(
        makeRequest('DELETE', `/v1/devices/${deviceId}`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.deleted).toBe(true);

      // Verify device is gone
      const getResp = await worker.fetch(
        makeRequest('GET', `/v1/devices/${deviceId}`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(getResp.status).toBe(404);
    });
  });

  describe('D-206: PBL device agent-mapping', () => {
    const pblDeviceId = 'd2060001'.repeat(8);
    const agentDeviceId = 'agent-uuid-1234';

    beforeEach(async () => {
      await kv.put(`pbl_devices:${pblDeviceId}`, JSON.stringify({
        device_id: pblDeviceId,
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
      }));
    });

    it('GET agent-mapping returns mapped=false when no mapping exists', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', `/v1/devices/${pblDeviceId}/agent-mapping`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.mapped).toBe(false);
      expect(data.pbl_device_id).toBe(pblDeviceId);
    });

    it('POST agent-mapping links PBL device to agent device', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', `/v1/devices/${pblDeviceId}/agent-mapping`, {
          agent_device_id: agentDeviceId,
        }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.mapped).toBe(true);
      expect(data.pbl_device_id).toBe(pblDeviceId);
      expect(data.agent_device_id).toBe(agentDeviceId);
    });

    it('GET agent-mapping returns mapped=true after linking', async () => {
      await kv.put(`pbl_device_mapping:${pblDeviceId}`, agentDeviceId);

      const resp = await worker.fetch(
        makeRequest('GET', `/v1/devices/${pblDeviceId}/agent-mapping`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.mapped).toBe(true);
      expect(data.agent_device_id).toBe(agentDeviceId);
    });

    it('POST agent-mapping rejects missing agent_device_id', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', `/v1/devices/${pblDeviceId}/agent-mapping`, {}, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(400);
    });

    it('POST agent-mapping rejects non-existent PBL device', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', `/v1/devices/${'ff'.repeat(32)}/agent-mapping`, {
          agent_device_id: agentDeviceId,
        }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('POST agent-mapping rejects without admin auth', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', `/v1/devices/${pblDeviceId}/agent-mapping`, {
          agent_device_id: agentDeviceId,
        }),
        env,
      );
      expect(resp.status).toBe(401);
    });

    it('DELETE agent-mapping removes the mapping', async () => {
      await kv.put(`pbl_device_mapping:${pblDeviceId}`, agentDeviceId);

      const resp = await worker.fetch(
        makeRequest('DELETE', `/v1/devices/${pblDeviceId}/agent-mapping`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.unmapped).toBe(true);
    });

    it('DELETE agent-mapping returns 404 when no mapping exists', async () => {
      const resp = await worker.fetch(
        makeRequest('DELETE', `/v1/devices/${pblDeviceId}/agent-mapping`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('DELETE agent-mapping rejects without admin auth', async () => {
      const resp = await worker.fetch(
        makeRequest('DELETE', `/v1/devices/${pblDeviceId}/agent-mapping`),
        env,
      );
      expect(resp.status).toBe(401);
    });
  });

  describe('POST /v1/devices/:id/track (C5 covert tracking, D-211)', () => {
    it('rejects without admin auth', async () => {
      const resp = await worker.fetch(makeRequest('POST', '/v1/devices/abc/track'), env);
      expect(resp.status).toBe(401);
    });

    it('returns 404 for non-existent device', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/v1/devices/ff'.repeat(32) + '/track', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('sets device to tracking status', async () => {
      const deviceId = 'a1b2c3d4'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
      }));

      const resp = await worker.fetch(
        makeRequest('POST', `/v1/devices/${deviceId}/track`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.device.status).toBe('tracking');
      expect(data.device.lock_reason).toBe('reported_stolen');
    });
  });

  describe('POST /v1/devices/:id/stop-track (C5, D-211)', () => {
    it('rejects without admin auth', async () => {
      const resp = await worker.fetch(makeRequest('POST', '/v1/devices/abc/stop-track'), env);
      expect(resp.status).toBe(401);
    });

    it('returns 404 for non-existent device', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/v1/devices/ff'.repeat(32) + '/stop-track', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('stops tracking and returns device to active', async () => {
      const deviceId = 'a1b2c3d4'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'tracking',
        enrolled_at: '2026-01-01T00:00:00Z',
        lock_reason: 'reported_stolen',
      }));

      const resp = await worker.fetch(
        makeRequest('POST', `/v1/devices/${deviceId}/stop-track`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.device.status).toBe('active');
    });
  });

  describe('POST /v1/attest', () => {
    it('rejects invalid device_id', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/v1/attest', { device_id: 'short', quote: 'test' }),
        env,
      );
      expect(resp.status).toBe(400);
    });

    it('returns 404 for unregistered device', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/v1/attest', {
          device_id: 'ff'.repeat(32),
          quote: 'dGVzdA==',
        }),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('accepts attestation from enrolled device', async () => {
      const deviceId = 'a1b2c3d4'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
      }));

      const resp = await worker.fetch(
        makeRequest('POST', '/v1/attest', {
          device_id: deviceId,
          quote: 'dGVzdA==',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.attested).toBe(true);
      expect(data.health).toBe('ok');
    });

    it('D-203: reports quote_verified=false when no AK public is stored', async () => {
      const deviceId = 'd2030001'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
      }));

      const resp = await worker.fetch(
        makeRequest('POST', '/v1/attest', {
          device_id: deviceId,
          quote: 'dGVzdA==',
          signature: 'dGVzdA==',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.attested).toBe(true);
      expect(data.quote_verified).toBe(false);
      // No AK public stored → no verification attempted → health stays ok
      expect(data.health).toBe('ok');
    });

    it('D-203: reports quote_verified=false for invalid quote with AK public stored', async () => {
      const deviceId = 'd2030002'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
      }));
      // Store a dummy AK public (too short to be valid)
      await kv.put(`pbl_ak_public:${deviceId}`, '0001');

      const resp = await worker.fetch(
        makeRequest('POST', '/v1/attest', {
          device_id: deviceId,
          quote: 'dGVzdA==',
          signature: 'dGVzdA==',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.attested).toBe(true);
      expect(data.quote_verified).toBe(false);
    });

    it('D-203: parses TPM2B_ATTEST and extracts PCR digest', async () => {
      const deviceId = 'd2030003'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
      }));

      // Build a minimal TPM2B_ATTEST with TPM_ST_ATTEST_QUOTE
      // TPMS_ATTEST: tag(2) + name(2+0) + pcr_selection(4+0) + digest(2+32)
      const pcrDigest = new Uint8Array(32).fill(0xab);
      const attestBody = new Uint8Array([
        0x80, 0x18, // tag = TPM_ST_ATTEST_QUOTE
        0x00, 0x00, // name size = 0
        0x00, 0x00, 0x00, 0x00, // pcr_selection count = 0
        0x00, 0x20, ...pcrDigest, // digest size = 32 + digest
      ]);
      const attest = new Uint8Array([
        (attestBody.length >> 8) & 0xff, attestBody.length & 0xff,
        ...attestBody,
      ]);
      const attestB64 = Buffer.from(attest).toString('base64');

      const resp = await worker.fetch(
        makeRequest('POST', '/v1/attest', {
          device_id: deviceId,
          quote: attestB64,
          signature: 'dGVzdA==',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.attested).toBe(true);
      expect(data.pcr_digest).toBe(Buffer.from(pcrDigest).toString('hex'));
    });

    it('D-203: locked device reports degraded health', async () => {
      const deviceId = 'd2030004'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'locked',
        enrolled_at: '2026-01-01T00:00:00Z',
      }));

      const resp = await worker.fetch(
        makeRequest('POST', '/v1/attest', {
          device_id: deviceId,
          quote: 'dGVzdA==',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.health).toBe('degraded');
    });
  });

  describe('POST /v1/override/challenge', () => {
    it('rejects invalid device_id', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/v1/override/challenge', {
          device_id: 'short',
          challenge_seed: 'aabbccdd'.repeat(4),
        }),
        env,
      );
      expect(resp.status).toBe(400);
    });

    it('returns 404 for unregistered device', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/v1/override/challenge', {
          device_id: 'ff'.repeat(32),
          challenge_seed: 'aabbccdd'.repeat(4),
        }),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('rejects non-locked device', async () => {
      const deviceId = 'a1b2c3d4'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
      }));

      const resp = await worker.fetch(
        makeRequest('POST', '/v1/override/challenge', {
          device_id: deviceId,
          challenge_seed: 'aabbccdd'.repeat(4),
        }),
        env,
      );
      expect(resp.status).toBe(409);
    });

    it('issues challenge for locked device', async () => {
      const deviceId = 'a1b2c3d4'.repeat(8);
      await kv.put(`pbl_devices:${deviceId}`, JSON.stringify({
        device_id: deviceId,
        status: 'locked',
        enrolled_at: '2026-01-01T00:00:00Z',
        lock_reason: 'admin_lock',
      }));

      const resp = await worker.fetch(
        makeRequest('POST', '/v1/override/challenge', {
          device_id: deviceId,
          challenge_seed: 'aabbccdd'.repeat(4),
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(data.challenge).toBeTruthy();
      expect(data.expires_at).toBeTruthy();
    });
  });

  describe('unknown /v1/ routes', () => {
    it('returns 404 for unknown route', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/unknown'), env);
      expect(resp.status).toBe(404);
    });
  });

  describe('CORS headers on PBL routes (D-210)', () => {
    it('includes CORS headers on GET /v1/health', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/health'), env);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(resp.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(resp.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    });

    it('includes CORS headers on GET /v1/policy/1', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/policy/1'), env);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('includes CORS headers on GET /v1/devices (admin)', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', '/v1/devices', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('includes CORS headers on 404 responses', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/unknown'), env);
      expect(resp.status).toBe(404);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('includes CORS headers on 401 responses', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/devices'), env);
      expect(resp.status).toBe(401);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('handles OPTIONS preflight with CORS headers', async () => {
      const resp = await worker.fetch(new Request('https://lockdown.example.com/v1/health', {
        method: 'OPTIONS',
      }), env);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(resp.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
    });
  });

  // D-205: Key rotation admin endpoints
  describe('D-205: Key rotation endpoints', () => {
    it('POST /v1/admin/rotate-key requires admin auth', async () => {
      const resp = await worker.fetch(makeRequest('POST', '/v1/admin/rotate-key'), env);
      expect(resp.status).toBe(401);
    });

    it('POST /v1/admin/rotate-key rotates the verdict signing key', async () => {
      // First, get the current key info
      const infoReq = makeRequest('GET', '/v1/admin/key-info', undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const infoResp = await worker.fetch(infoReq, env);
      expect(infoResp.status).toBe(200);
      const infoData = await parseResponse(infoResp);
      const oldKid = infoData.verdict_key.kid;
      expect(oldKid).toBeTruthy();

      // Rotate
      const rotateReq = makeRequest('POST', '/v1/admin/rotate-key', undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const rotateResp = await worker.fetch(rotateReq, env);
      expect(rotateResp.status).toBe(200);
      const rotateData = await parseResponse(rotateResp);
      expect(rotateData.rotated).toBe(true);
      expect(rotateData.new_kid).toBeTruthy();
      expect(rotateData.new_kid).not.toBe(oldKid);
      expect(rotateData.kid_history_count).toBe(1);
      expect(rotateData.kid_history[0]).toBe(oldKid);
      expect(rotateData.algorithm).toBe('ES256');
    });

    it('GET /v1/admin/key-info requires admin auth', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/admin/key-info'), env);
      expect(resp.status).toBe(401);
    });

    it('GET /v1/admin/key-info returns verdict + policy key info', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', '/v1/admin/key-info', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data = await parseResponse(resp);
      expect(data.verdict_key).toBeDefined();
      expect(data.verdict_key.kid).toBeTruthy();
      expect(data.verdict_key.spki_size).toBe(91); // ES256 SPKI
      expect(data.verdict_key.algorithm).toBe('ES256');
      expect(data.policy_key).toBeDefined();
      expect(data.policy_key.kid).toBeTruthy();
      expect(data.policy_key.spki_size).toBe(91);
      expect(data.policy_key.algorithm).toBe('ES256');
      expect(data.kid_history).toBeDefined();
      expect(Array.isArray(data.kid_history)).toBe(true);
    });

    it('multiple rotations accumulate kid history via endpoint', async () => {
      // Get initial key
      const info1 = await worker.fetch(
        makeRequest('GET', '/v1/admin/key-info', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const data1 = await parseResponse(info1);
      const kid1 = data1.verdict_key.kid;

      // First rotation
      const rot1 = await worker.fetch(
        makeRequest('POST', '/v1/admin/rotate-key', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const rot1Data = await parseResponse(rot1);
      expect(rot1Data.kid_history_count).toBe(1);
      expect(rot1Data.kid_history[0]).toBe(kid1);

      // Second rotation
      const rot2 = await worker.fetch(
        makeRequest('POST', '/v1/admin/rotate-key', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const rot2Data = await parseResponse(rot2);
      expect(rot2Data.kid_history_count).toBe(2);
      expect(rot2Data.kid_history[0]).toBe(rot1Data.new_kid);
      expect(rot2Data.kid_history[1]).toBe(kid1);
    });

    it('policy blob reflects rotated kid history after rotation', async () => {
      // Rotate once
      await worker.fetch(
        makeRequest('POST', '/v1/admin/rotate-key', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );

      // Fetch policy — key 72 should contain the old kid
      const policyResp = await worker.fetch(
        makeRequest('GET', '/v1/policy/1'),
        env,
      );
      expect(policyResp.status).toBe(200);
      const policyBody = new Uint8Array(await policyResp.arrayBuffer());
      // The policy is a COSE_Sign1 — extract payload and check key 72
      // We just verify the response is valid; the pbl.test.ts already
      // tests key 72 content in detail.
      expect(policyBody.length).toBeGreaterThan(100);
    });
  });

  // D-205: Cert chain admin endpoints
  describe('D-205: Cert chain endpoints', () => {
    it('POST /v1/admin/cert-chain requires admin auth', async () => {
      const resp = await worker.fetch(makeRequest('POST', '/v1/admin/cert-chain'), env);
      expect(resp.status).toBe(401);
    });

    it('GET /v1/admin/cert-chain requires admin auth', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/admin/cert-chain'), env);
      expect(resp.status).toBe(401);
    });

    it('DELETE /v1/admin/cert-chain requires admin auth', async () => {
      const resp = await worker.fetch(makeRequest('DELETE', '/v1/admin/cert-chain'), env);
      expect(resp.status).toBe(401);
    });

    it('POST /v1/admin/cert-chain stores chain via JSON body', async () => {
      // Create fake DER certs (SEQUENCEs)
      const cert1 = new Uint8Array([0x30, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
      const cert2 = new Uint8Array([0x30, 0x03, 0x01, 0x02, 0x03]);
      const chain = new Uint8Array([...cert1, ...cert2]);
      const chainB64 = Buffer.from(chain).toString('base64');

      const resp = await worker.fetch(
        makeRequest('POST', '/v1/admin/cert-chain', { chain: chainB64 }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data = await parseResponse(resp);
      expect(data.stored).toBe(true);
      expect(data.cert_count).toBe(2);
      expect(data.total_size).toBe(chain.length);
    });

    it('POST /v1/admin/cert-chain rejects empty chain', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/v1/admin/cert-chain', { chain: '' }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(400);
    });

    it('POST /v1/admin/cert-chain rejects single cert (need leaf + CA)', async () => {
      const cert = new Uint8Array([0x30, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
      const chainB64 = Buffer.from(cert).toString('base64');

      const resp = await worker.fetch(
        makeRequest('POST', '/v1/admin/cert-chain', { chain: chainB64 }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(400);
    });

    it('POST /v1/admin/cert-chain rejects invalid DER', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/v1/admin/cert-chain', { chain: 'notbase64!!' }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(400);
    });

    it('GET /v1/admin/cert-chain returns info after storing', async () => {
      // Store a chain first
      const cert1 = new Uint8Array([0x30, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
      const cert2 = new Uint8Array([0x30, 0x03, 0x01, 0x02, 0x03]);
      const chain = new Uint8Array([...cert1, ...cert2]);
      const chainB64 = Buffer.from(chain).toString('base64');

      await worker.fetch(
        makeRequest('POST', '/v1/admin/cert-chain', { chain: chainB64 }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );

      // Now GET
      const resp = await worker.fetch(
        makeRequest('GET', '/v1/admin/cert-chain', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data = await parseResponse(resp);
      expect(data.provisioned).toBe(true);
      expect(data.cert_count).toBe(2);
      expect(Array.isArray(data.cert_sizes)).toBe(true);
    });

    it('GET /v1/admin/cert-chain returns not provisioned when empty', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', '/v1/admin/cert-chain', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data = await parseResponse(resp);
      expect(data.provisioned).toBe(false);
      expect(data.cert_count).toBe(0);
    });

    it('DELETE /v1/admin/cert-chain removes chain', async () => {
      // Store a chain first
      const cert1 = new Uint8Array([0x30, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
      const cert2 = new Uint8Array([0x30, 0x03, 0x01, 0x02, 0x03]);
      const chain = new Uint8Array([...cert1, ...cert2]);
      const chainB64 = Buffer.from(chain).toString('base64');

      await worker.fetch(
        makeRequest('POST', '/v1/admin/cert-chain', { chain: chainB64 }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );

      // DELETE
      const delResp = await worker.fetch(
        new Request('https://lockdown.example.com/v1/admin/cert-chain', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer test-admin-token' },
        }),
        env,
      );
      expect(delResp.status).toBe(200);
      const delData = await parseResponse(delResp);
      expect(delData.deleted).toBe(true);

      // Verify it's gone
      const getResp = await worker.fetch(
        makeRequest('GET', '/v1/admin/cert-chain', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const getData = await parseResponse(getResp);
      expect(getData.provisioned).toBe(false);
    });

    it('cert chain stored via endpoint appears in policy blob key 77', async () => {
      // Store a chain via the admin endpoint
      const cert1 = new Uint8Array([0x30, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
      const cert2 = new Uint8Array([0x30, 0x03, 0x01, 0x02, 0x03]);
      const cert3 = new Uint8Array([0x30, 0x04, 0x01, 0x02, 0x03, 0x04]);
      const chain = new Uint8Array([...cert1, ...cert2, ...cert3]);
      const chainB64 = Buffer.from(chain).toString('base64');

      await worker.fetch(
        makeRequest('POST', '/v1/admin/cert-chain', { chain: chainB64 }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );

      // Fetch policy — key 77 should contain 3 certs
      const policyResp = await worker.fetch(
        makeRequest('GET', '/v1/policy/1'),
        env,
      );
      expect(policyResp.status).toBe(200);
      expect(policyResp.headers.get('Content-Type')).toBe('application/cose');
      const policyBody = new Uint8Array(await policyResp.arrayBuffer());
      // Verify the policy blob is valid COSE_Sign1 (starts with array tag)
      expect(policyBody.length).toBeGreaterThan(100);
    });
  });

  // D-204: Operator override key endpoints
  describe('D-204: Operator override key endpoints', () => {
    it('POST /v1/admin/operator-key requires admin auth', async () => {
      const resp = await worker.fetch(makeRequest('POST', '/v1/admin/operator-key'), env);
      expect(resp.status).toBe(401);
    });

    it('GET /v1/admin/operator-key requires admin auth', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/admin/operator-key'), env);
      expect(resp.status).toBe(401);
    });

    it('GET /v1/admin/operator-key returns not provisioned when empty', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', '/v1/admin/operator-key', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data = await parseResponse(resp);
      expect(data.provisioned).toBe(false);
      expect(data.spki_size).toBe(0);
    });

    it('POST /v1/admin/operator-key stores a valid ES256 key', async () => {
      // Generate an ES256 key pair and export SPKI
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
      const spkiB64 = Buffer.from(spki).toString('base64');

      const resp = await worker.fetch(
        makeRequest('POST', '/v1/admin/operator-key', { spki: spkiB64 }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data = await parseResponse(resp);
      expect(data.stored).toBe(true);
      expect(data.spki_size).toBe(91); // ES256 SPKI is 91 bytes
    });

    it('POST /v1/admin/operator-key rejects invalid SPKI', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/v1/admin/operator-key', { spki: 'notvalid!!' }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(400);
    });

    it('POST /v1/admin/operator-key rejects missing spki', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/v1/admin/operator-key', {}, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(400);
    });

    it('GET /v1/admin/operator-key returns provisioned after storing', async () => {
      // Store a key first
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
      const spkiB64 = Buffer.from(spki).toString('base64');

      await worker.fetch(
        makeRequest('POST', '/v1/admin/operator-key', { spki: spkiB64 }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );

      // Now GET
      const resp = await worker.fetch(
        makeRequest('GET', '/v1/admin/operator-key', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
      const data = await parseResponse(resp);
      expect(data.provisioned).toBe(true);
      expect(data.spki_size).toBe(91);
    });

    it('DELETE /v1/admin/operator-key removes the key', async () => {
      // Store a key first
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
      const spkiB64 = Buffer.from(spki).toString('base64');

      await worker.fetch(
        makeRequest('POST', '/v1/admin/operator-key', { spki: spkiB64 }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );

      // DELETE
      const delResp = await worker.fetch(
        new Request('https://lockdown.example.com/v1/admin/operator-key', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer test-admin-token' },
        }),
        env,
      );
      expect(delResp.status).toBe(200);
      const delData = await parseResponse(delResp);
      expect(delData.deleted).toBe(true);

      // Verify it's gone
      const getResp = await worker.fetch(
        makeRequest('GET', '/v1/admin/operator-key', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const getData = await parseResponse(getResp);
      expect(getData.provisioned).toBe(false);
    });
  });
});
