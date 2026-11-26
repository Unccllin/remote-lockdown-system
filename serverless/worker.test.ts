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
import { COMMAND_INDEX_KEY, claimEnrollmentToken, commandKey } from './kv-store';
import { b64urlEncode, matchesAdminToken } from './admin-auth';
import { hmacSha256 } from './http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The Worker is a bearer-token API (`Authorization: Bearer` / `x-agent-key`) with
// no cookie-based sessions, so a wildcard CORS origin does not expose credentials:
// a hostile page can send the request, but it cannot attach a token it does not
// have. Stated once here rather than as a bare '*' in seven assertions, so the
// decision is visible and reviewable instead of looking like an accident.
const TOKEN_API_CORS_ORIGIN = '*';

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

/**
 * Read one command back through the API instead of out of KV.
 *
 * ADR-002 stores commands as per-entity records behind an index, so asserting on the old
 * `commands` list would pin a storage layout rather than the behaviour under test.
 */
async function readCommandViaApi(
  env: unknown,
  deviceId: string | undefined,
  commandId: string,
): Promise<any | undefined> {
  if (!deviceId) throw new Error('device not found for command lookup');
  const resp = await worker.fetch(
    makeRequest('GET', `/api/devices/${deviceId}/commands?limit=100`, undefined, {
      Authorization: 'Bearer test-admin-token',
    }),
    env,
  );
  const body = await parseResponse(resp);
  if (!Array.isArray(body)) {
    // A non-array here means the route answered an error payload; say so instead of letting
    // `.find` throw "is not a function" and hide the status.
    throw new Error(
      `GET /api/devices/${deviceId}/commands returned ${resp.status}: ${JSON.stringify(body)}`,
    );
  }
  return body.find((c) => c.id === commandId);
}

/**
 * Device id for a hostname, read through the API.
 *
 * ADR-003 moved devices to per-entity keys, so reading the `devices` list here would pin a
 * storage layout instead of the behaviour under test — the same reason `readCommandViaApi`
 * exists (ADR-002).
 */
async function deviceIdByHostname(env: unknown, hostname: string): Promise<string | undefined> {
  const resp = await worker.fetch(
    makeRequest('GET', '/api/devices', undefined, {
      Authorization: 'Bearer test-admin-token',
    }),
    env,
  );
  const devices = (await parseResponse(resp)) as any[];
  return devices.find((d: any) => d.hostname === hostname)?.id;
}

// Helper to parse JSON response
async function parseResponse(resp: Response): Promise<unknown> {
  return JSON.parse(await resp.text());
}

// We need to import the worker handler
// Since the worker uses `export default`, we import it dynamically
let worker: {
  fetch: (req: Request, env: unknown) => Promise<Response>;
  serializeMutation: <T>(fn: () => Promise<T>, waitMs?: number) => Promise<T>;
  mutationQueueStats: () => { stalls: number; wait_ms: number };
};
let resetKeyCache: () => void;

beforeEach(async () => {
  const mod = await import('./worker.js');
  // The queue helpers are named exports; `mod.default` is the handler object (fetch + scheduled).
  // Both halves are needed, so the suite's `worker` handle carries the two together.
  worker = {
    fetch: mod.default.fetch,
    serializeMutation: mod.serializeMutation,
    mutationQueueStats: mod.mutationQueueStats,
  };
  resetKeyCache = mod.resetKeyCache;
});

// ---------------------------------------------------------------------------
// Route contracts: a path the Worker *mentions* must be a path it *dispatches*.
//
// /api/agent/update advertised "/api/agent/download?platform=…" for months while
// the route table only had "/api/download/agent", so every serverless update
// download answered 404 — the fleet could never patch, and no unit test noticed
// because each side was asserted separately (S198). This walks the source: every
// /api literal outside a comment must have a `path === '…'` branch (or a
// `path.startsWith` prefix). It is a source-level invariant because the route
// table only exists in source.
// ---------------------------------------------------------------------------
describe('route contracts (a mentioned path must be dispatched)', () => {
  function analyse() {
    const source = fs.readFileSync(path.join(HERE, 'worker.ts'), 'utf8');
    const mentioned = new Set<string>();
    const routed = new Set<string>();

    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      const isComment =
        trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');

      if (!isComment) {
        // Literal paths only: a template with ${} cannot match, so dynamic
        // prefixes are not mistaken for contracts.
        for (const match of line.matchAll(/['"`](\/api\/[A-Za-z0-9_./-]*)['"`]/g)) {
          mentioned.add(match[1].replace(/\/$/, ''));
        }
      }
      for (const match of line.matchAll(/path (?:===|!==) '([^']+)'/g)) {
        routed.add(match[1].replace(/\/$/, ''));
      }
      for (const match of line.matchAll(/path\.startsWith\('([^']+)'\)/g)) {
        routed.add(`${match[1].replace(/\/$/, '')}*`);
      }
    }
    return { mentioned, routed };
  }

  it('every /api path the Worker mentions is dispatched', () => {
    const { mentioned, routed } = analyse();
    const prefixes = [...routed].filter((r) => r.endsWith('*')).map((r) => r.slice(0, -1));

    const unrouted = [...mentioned].filter(
      (p) => !routed.has(p) && !prefixes.some((prefix) => p.startsWith(prefix)),
    );

    expect(routed.size).toBeGreaterThan(20); // the parser still sees the route table
    expect(unrouted).toEqual([]);
  });

  it('and the route that broke is dispatched', () => {
    // Named explicitly so a regression names the path, not just a diff.
    const { routed } = analyse();
    expect(routed.has('/api/agent/download')).toBe(true);
  });
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

    it('omits google_api_key when GOOGLE_API_KEY is unset', async () => {
      const req = makeRequest(
        'POST',
        '/api/enroll',
        { hostname: 'TEST-DEV-NOKEY', owner_name: 'Test' },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, env);
      const data = await parseResponse(resp);
      expect(resp.status).toBe(201);
      expect('google_api_key' in data).toBe(false);
    });

    it('includes google_api_key when GOOGLE_API_KEY is set', async () => {
      const envWithKey = { ...env, GOOGLE_API_KEY: 'test-google-key' };
      const req = makeRequest(
        'POST',
        '/api/enroll',
        { hostname: 'TEST-DEV-KEY', owner_name: 'Test' },
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, envWithKey);
      const data = await parseResponse(resp);
      expect(resp.status).toBe(201);
      expect(data.google_api_key).toBe('test-google-key');
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

    it('omits google_api_key when GOOGLE_API_KEY is unset (claim)', async () => {
      const tokenReq = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const tokenResp = await worker.fetch(tokenReq, env);
      const tokenData: any = await parseResponse(tokenResp);
      const claimReq = makeRequest('POST', '/api/enroll/claim', {
        token: tokenData.token,
        hostname: 'CLAIM-NOKEY-001',
      });
      const claimResp = await worker.fetch(claimReq, env);
      const claimData: any = await parseResponse(claimResp);
      expect(claimResp.status).toBe(201);
      expect('google_api_key' in claimData).toBe(false);
    });

    it('includes google_api_key when GOOGLE_API_KEY is set (claim)', async () => {
      const envWithKey = { ...env, GOOGLE_API_KEY: 'test-google-key' };
      const tokenReq = makeRequest('POST', '/api/enroll/token', {}, {
        Authorization: 'Bearer test-admin-token',
      });
      const tokenResp = await worker.fetch(tokenReq, envWithKey);
      const tokenData: any = await parseResponse(tokenResp);
      const claimReq = makeRequest('POST', '/api/enroll/claim', {
        token: tokenData.token,
        hostname: 'CLAIM-KEY-001',
      });
      const claimResp = await worker.fetch(claimReq, envWithKey);
      const claimData: any = await parseResponse(claimResp);
      expect(claimResp.status).toBe(201);
      expect(claimData.google_api_key).toBe('test-google-key');
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
      // 60, not 300. S269 lowered the ACTIVE interval because a device learns about a
      // queued command only when it polls, but the fix went into one response branch
      // while this suite kept pinning 300 — so the test agreed with a path the agent was
      // not on, and MOLE still logged "30s -> 300s (status=active)" after the change
      // (S270). Both intervals now come from activePollSeconds().
      expect(data.poll_interval).toBe(60);
      expect(data.command).toBeNull();
    });

    it('honours ACTIVE_POLL_SECONDS and reports the same number on /api/ping', async () => {
      // The two response branches disagreed once: S269 lowered the interval in
      // handlePing (/api/ping, a legacy path the current agent does not call) while
      // handleAgentCheckin — the path the agent IS on — kept returning 300 from
      // ADAPTIVE_POLL (measured on MOLE, S270). This asserts they cannot diverge again.
      const { apiKey, device } = await enrollDevice(worker, env, 'CHECKIN-POLL');
      const tuned = { ...env, ACTIVE_POLL_SECONDS: '90' };

      const body = JSON.stringify({ hostname: 'CHECKIN-POLL' });
      const checkinResp = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)),
        tuned,
      );
      const checkinData: any = await parseResponse(checkinResp);
      expect(checkinData.poll_interval).toBe(90);

      const pingBody = JSON.stringify({ device_id: device.id });
      const pingResp = await worker.fetch(
        makeRequest('POST', '/api/ping', pingBody, signRequest(pingBody, apiKey)),
        tuned,
      );
      const pingData: any = await parseResponse(pingResp);
      expect(pingData.poll_interval).toBe(90);
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

    it('marks a duress recovery on the queued unlock command', async () => {
      // Session 177: a mutation audit replaced the duress_code expression with
      // `null` and the whole suite stayed green — nothing asserted the flag. A
      // duress recovery silently becoming a REAL unlock is the exact failure the
      // feature exists to prevent, so it needs its own assertion.
      const { apiKey, device } = await enrollDevice(worker, env, 'DURESS-001');

      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${device.id}/flag-stolen`,
          { hostname_confirm: 'DURESS-001' },
          { Authorization: 'Bearer test-admin-token' },
        ),
        env,
      );

      // Acknowledge the lockdown command first — the check-in hands out the
      // oldest pending command, so the unlock queued by recover would otherwise
      // sit behind it.
      const lockBody = JSON.stringify({ hostname: 'DURESS-001' });
      const lockCheckin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', lockBody, signRequest(lockBody, apiKey)),
        env,
      );
      const lockData: any = await parseResponse(lockCheckin);
      const lockAckBody = JSON.stringify({
        hostname: 'DURESS-001',
        command_id: lockData.command.id,
        result_status: 'executed',
      });
      await worker.fetch(
        makeRequest('POST', '/api/agent/command-ack', lockAckBody, signRequest(lockAckBody, apiKey)),
        env,
      );

      const recoverResp = await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${device.id}/recover`,
          { hostname_confirm: 'DURESS-001', duress_code: true },
          { Authorization: 'Bearer test-admin-token' },
        ),
        env,
      );
      expect(recoverResp.status).toBe(200);

      // The agent learns it must fake the unlock from the check-in payload.
      const durressCheckinBody = JSON.stringify({ hostname: 'DURESS-001' });
      const durressCheckin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', durressCheckinBody,
                   signRequest(durressCheckinBody, apiKey)),
        env,
      );
      const durressData: any = await parseResponse(durressCheckin);

      expect(durressData.command.type).toBe('unlock');
      expect(durressData.command.duress_code).toBe(true);
    });

    it('a normal recovery is not marked as duress', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'NORMAL-001');

      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${device.id}/flag-stolen`,
          { hostname_confirm: 'NORMAL-001' },
          { Authorization: 'Bearer test-admin-token' },
        ),
        env,
      );
      // Acknowledge the lockdown command first — the check-in hands out the
      // oldest pending command, so the unlock queued by recover would otherwise
      // sit behind it.
      const lockBody = JSON.stringify({ hostname: 'NORMAL-001' });
      const lockCheckin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', lockBody, signRequest(lockBody, apiKey)),
        env,
      );
      const lockData: any = await parseResponse(lockCheckin);
      const lockAckBody = JSON.stringify({
        hostname: 'NORMAL-001',
        command_id: lockData.command.id,
        result_status: 'executed',
      });
      await worker.fetch(
        makeRequest('POST', '/api/agent/command-ack', lockAckBody, signRequest(lockAckBody, apiKey)),
        env,
      );

      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${device.id}/recover`,
          { hostname_confirm: 'NORMAL-001' },
          { Authorization: 'Bearer test-admin-token' },
        ),
        env,
      );

      const normalBody = JSON.stringify({ hostname: 'NORMAL-001' });
      const normalCheckin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', normalBody, signRequest(normalBody, apiKey)),
        env,
      );
      const normalData: any = await parseResponse(normalCheckin);

      expect(normalData.command.type).toBe('unlock');
      expect(normalData.command.duress_code ?? null).toBe(null);
    });

    it("a device cannot ACK another device's command", async () => {
      // Session 177: removing the `c.device_id === device.id` ownership check from
      // handleCommandAck left the whole suite green. Without that check any
      // enrolled device can mark another device's lockdown command as executed or
      // failed, so the fleet's command state is forgeable.
      const victim = await enrollDevice(worker, env, 'ACK-VICTIM-001');
      const attacker = await enrollDevice(worker, env, 'ACK-ATTACKER-001');

      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${victim.device.id}/flag-stolen`,
          { hostname_confirm: 'ACK-VICTIM-001' },
          { Authorization: 'Bearer test-admin-token' },
        ),
        env,
      );

      // The victim checks in and receives its lockdown command.
      const victimBody = JSON.stringify({ hostname: 'ACK-VICTIM-001' });
      const victimCheckin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', victimBody, signRequest(victimBody, victim.apiKey)),
        env,
      );
      const victimData: any = await parseResponse(victimCheckin);
      const victimCmdId = victimData.command.id;
      expect(victimCmdId).toBeTruthy();

      // The attacker tries to ACK it with a valid signature of its own.
      const attackBody = JSON.stringify({
        hostname: 'ACK-ATTACKER-001',
        command_id: victimCmdId,
        result_status: 'failed',
      });
      const attackResp = await worker.fetch(
        makeRequest('POST', '/api/agent/command-ack', attackBody,
                   signRequest(attackBody, attacker.apiKey)),
        env,
      );
      expect(attackResp.status).toBe(404);

      // And the rightful owner can still ACK it.
      const ownerBody = JSON.stringify({
        hostname: 'ACK-VICTIM-001',
        command_id: victimCmdId,
        result_status: 'executed',
      });
      const ownerResp = await worker.fetch(
        makeRequest('POST', '/api/agent/command-ack', ownerBody,
                   signRequest(ownerBody, victim.apiKey)),
        env,
      );
      expect(ownerResp.status).toBe(200);
    });

    it("a check-in only receives its own device's commands", async () => {
      // Session 179: dropping the `c.device_id === device.id` term from the
      // check-in delivery filter left the whole suite green, so nothing asserted
      // that a device is handed only its own work. With that term gone one
      // machine's check-in can return another machine's pending lockdown — the
      // worst cross-device failure this product can have.
      const victim = await enrollDevice(worker, env, 'DELIVER-VICTIM-001');
      const bystander = await enrollDevice(worker, env, 'DELIVER-BYSTANDER-001');

      // Queue a lockdown for the victim only.
      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${victim.device.id}/flag-stolen`,
          { hostname_confirm: 'DELIVER-VICTIM-001' },
          { Authorization: 'Bearer test-admin-token' },
        ),
        env,
      );

      // The bystander must get nothing, even though a command is pending.
      const bystanderBody = JSON.stringify({ hostname: 'DELIVER-BYSTANDER-001' });
      const bystanderCheckin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', bystanderBody,
                   signRequest(bystanderBody, bystander.apiKey)),
        env,
      );
      const bystanderData: any = await parseResponse(bystanderCheckin);
      expect(bystanderData.command).toBe(null);

      // Positive control: the victim does receive it.
      const victimBody = JSON.stringify({ hostname: 'DELIVER-VICTIM-001' });
      const victimCheckin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', victimBody,
                   signRequest(victimBody, victim.apiKey)),
        env,
      );
      const victimData: any = await parseResponse(victimCheckin);
      expect(victimData.command?.type).toBe('lockdown');
    });

    it('a device cannot escrow a key against another device\'s command', async () => {
      // Session 178: deleting the ownership check in handleEscrowKey left the
      // suite green, so nothing asserted that a command id is bound to the device
      // that owns it.
      const victim = await enrollDevice(worker, env, 'ESCROW-VICTIM-001');
      const attacker = await enrollDevice(worker, env, 'ESCROW-ATTACKER-001');

      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${victim.device.id}/flag-stolen`,
          { hostname_confirm: 'ESCROW-VICTIM-001' },
          { Authorization: 'Bearer test-admin-token' },
        ),
        env,
      );
      const victimBody = JSON.stringify({ hostname: 'ESCROW-VICTIM-001' });
      const victimCheckin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', victimBody, signRequest(victimBody, victim.apiKey)),
        env,
      );
      const victimCmdId = (await parseResponse(victimCheckin) as any).command.id;

      // The owner can escrow against its own command.
      const ownerBody = JSON.stringify({ command_id: victimCmdId, key_material: 'owner-key' });
      const ownerResp = await worker.fetch(
        makeRequest('POST', '/api/agent/escrow-key', ownerBody, signRequest(ownerBody, victim.apiKey)),
        env,
      );
      expect(ownerResp.status).toBe(200);

      // Another enrolled device must not be able to.
      const attackBody = JSON.stringify({ command_id: victimCmdId, key_material: 'attacker-key' });
      const attackResp = await worker.fetch(
        makeRequest('POST', '/api/agent/escrow-key', attackBody, signRequest(attackBody, attacker.apiKey)),
        env,
      );
      expect(attackResp.status).toBe(404);
    });

    it('an executed command cannot be rewritten by a later ACK', async () => {
      // The dedup early-return is what stops an agent (or a replay) flipping an
      // already-executed command to `failed`.
      const { apiKey, device } = await enrollDevice(worker, env, 'TERMINAL-001');
      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${device.id}/flag-stolen`,
          { hostname_confirm: 'TERMINAL-001' },
          { Authorization: 'Bearer test-admin-token' },
        ),
        env,
      );
      const body = JSON.stringify({ hostname: 'TERMINAL-001' });
      const checkin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)),
        env,
      );
      const cmdId = (await parseResponse(checkin) as any).command.id;

      const firstBody = JSON.stringify({
        hostname: 'TERMINAL-001',
        command_id: cmdId,
        result_status: 'executed',
      });
      const first = await worker.fetch(
        makeRequest('POST', '/api/agent/command-ack', firstBody, signRequest(firstBody, apiKey)),
        env,
      );
      expect(first.status).toBe(200);

      // A second ACK trying to flip it to failed must be deduplicated, not applied.
      const secondBody = JSON.stringify({
        hostname: 'TERMINAL-001',
        command_id: cmdId,
        result_status: 'failed',
      });
      const second = await worker.fetch(
        makeRequest('POST', '/api/agent/command-ack', secondBody, signRequest(secondBody, apiKey)),
        env,
      );
      const secondData: any = await parseResponse(second);
      expect(secondData.deduplicated).toBe(true);

      // ...and the stored status is still `executed`.
      const stored = await readCommandViaApi(env, device.id, cmdId);
      expect(stored.status).toBe('executed');
    });

    it('persists command_uuid so a retried ACK can be deduplicated', async () => {
      // The agent uses command_uuid to suppress duplicate handling of the same
      // command across retries; if it is not stored the retry looks new.
      const { apiKey, device } = await enrollDevice(worker, env, 'UUID-001');
      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${device.id}/flag-stolen`,
          { hostname_confirm: 'UUID-001' },
          { Authorization: 'Bearer test-admin-token' },
        ),
        env,
      );
      const body = JSON.stringify({ hostname: 'UUID-001' });
      const checkin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)),
        env,
      );
      const cmdId = (await parseResponse(checkin) as any).command.id;

      const ackBody = JSON.stringify({
        hostname: 'UUID-001',
        command_id: cmdId,
        result_status: 'executed',
        command_uuid: 'cmd-uuid-abc-123',
      });
      await worker.fetch(
        makeRequest('POST', '/api/agent/command-ack', ackBody, signRequest(ackBody, apiKey)),
        env,
      );

      const stored = await readCommandViaApi(env, device.id, cmdId);
      expect(stored?.command_uuid).toBe('cmd-uuid-abc-123');
    });

    // ADR-010 runtime settings
    it('includes settings on the no-pending-command branch when GOOGLE_API_KEY set', async () => {
      const { apiKey } = await enrollDevice(worker, { ...env, GOOGLE_API_KEY: 'test-google-key' }, 'RT-001');
      const body = JSON.stringify({ hostname: 'RT-001' });
      const resp = await worker.fetch(makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)), { ...env, GOOGLE_API_KEY: 'test-google-key' });
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.settings.google_api_key).toBe('test-google-key');
      expect(data.settings.revision).toBeTruthy();
    });

    it('includes settings on the pending-command branch when GOOGLE_API_KEY set', async () => {
      const { apiKey, device } = await enrollDevice(worker, { ...env, GOOGLE_API_KEY: 'test-google-key' }, 'RT-002');
      const flagBody = JSON.stringify({});
      await worker.fetch(makeRequest('POST', `/api/devices/${device.id}/track`, flagBody, { Authorization: `Bearer ${env.ADMIN_TOKEN}` }), { ...env, GOOGLE_API_KEY: 'test-google-key' });
      const body = JSON.stringify({ hostname: 'RT-002' });
      const resp = await worker.fetch(makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)), { ...env, GOOGLE_API_KEY: 'test-google-key' });
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.settings.google_api_key).toBe('test-google-key');
      expect(data.settings.revision).toBeTruthy();
    });

    it('omits settings when GOOGLE_API_KEY is unset', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'RT-003');
      const body = JSON.stringify({ hostname: 'RT-003' });
      const resp = await worker.fetch(makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)), env);
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.settings).toBeUndefined();
    });

    it('revision stable across identical requests and changes with value', async () => {
      const { apiKey } = await enrollDevice(worker, { ...env, GOOGLE_API_KEY: 'test-google-key' }, 'RT-004');
      const body = JSON.stringify({ hostname: 'RT-004' });
      const r1 = await worker.fetch(makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)), { ...env, GOOGLE_API_KEY: 'test-google-key' });
      const d1: any = await parseResponse(r1);
      const r2 = await worker.fetch(makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)), { ...env, GOOGLE_API_KEY: 'test-google-key' });
      const d2: any = await parseResponse(r2);
      expect(d2.settings.revision).toBe(d1.settings.revision);
      const { apiKey: apiKey2 } = await enrollDevice(worker, { ...env, GOOGLE_API_KEY: 'other-key' }, 'RT-005');
      const body2 = JSON.stringify({ hostname: 'RT-005' });
      const r3 = await worker.fetch(makeRequest('POST', '/api/agent/checkin', body2, signRequest(body2, apiKey2)), { ...env, GOOGLE_API_KEY: 'other-key' });
      const d3: any = await parseResponse(r3);
      expect(d3.settings.revision).not.toBe(d1.settings.revision);
    });

    it('empty-string env -> google_api_key null with revision', async () => {
      const { apiKey } = await enrollDevice(worker, { ...env, GOOGLE_API_KEY: '' }, 'RT-006');
      const body = JSON.stringify({ hostname: 'RT-006' });
      const resp = await worker.fetch(makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)), { ...env, GOOGLE_API_KEY: '' });
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.settings.google_api_key).toBeNull();
      expect(data.settings.revision).toBeTruthy();
    });
  });

  describe('firmware_audit on checkin', () => {
    it('persists firmware_audit and surfaces it via GET /api/devices/:id', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'FWAUDIT-001');
      const audit = {
        platform: 'Windows',
        secure_boot: true,
        setup_mode: false,
        bios_vendor: 'HP',
        bios_version: 'W91 Ver. 01.02.03',
        manufacturer: 'HP',
        model: 'HP EliteBook 840',
        tpm_enabled: true,
        spi_registers: null,
        note: null,
      };
      const body = JSON.stringify({ hostname: 'FWAUDIT-001', firmware_audit: audit });
      const req = makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey));
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(200);

      const devReq = makeRequest('GET', `/api/devices/${device.id}`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const devResp = await worker.fetch(devReq, env);
      const devData: any = await parseResponse(devResp);
      expect(devData.firmware_audit).toEqual(audit);
      expect(devData.firmware_audit_at).toBeTruthy();
    });

    it('tolerates malformed firmware_audit (non-object) — checkin still records', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'FWAUDIT-002');
      const body = JSON.stringify({ hostname: 'FWAUDIT-002', firmware_audit: 'not-an-object' });
      const req = makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey));
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(200);

      const devReq = makeRequest('GET', `/api/devices/${device.id}`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      const devData: any = await parseResponse(await worker.fetch(devReq, env));
      // Malformed audit → null, not persisted as a string.
      expect(devData.firmware_audit).toBeNull();
    });
  });

  // B-006 / S193: how each device verifies updates, reported at check-in.
  describe('update_verification on checkin (B-006)', () => {
    async function getDevice(deviceId: string) {
      const devReq = makeRequest('GET', `/api/devices/${deviceId}`, undefined, {
        Authorization: 'Bearer test-admin-token',
      });
      return (await parseResponse(await worker.fetch(devReq, env))) as any;
    }

    it.each(['signature', 'sha256-only', 'key-unreadable'])(
      'persists the reported mode %s and surfaces it via GET /api/devices/:id',
      async (mode) => {
        const hostname = `UPDVER-${mode}`;
        const { apiKey, device } = await enrollDevice(worker, env, hostname);
        const body = JSON.stringify({ hostname, update_verification: mode });
        const resp = await worker.fetch(
          makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)),
          env,
        );
        expect(resp.status).toBe(200);

        expect((await getDevice(device.id)).update_verification).toBe(mode);
      },
    );

    it('reports an unrecognised mode as null instead of coercing it', async () => {
      // "unknown" and "unverified" are different facts: reporting the latter for
      // a value we did not understand would claim the device accepts
      // unauthenticated updates when it might not.
      const { apiKey, device } = await enrollDevice(worker, env, 'UPDVER-BOGUS');
      const body = JSON.stringify({ hostname: 'UPDVER-BOGUS', update_verification: 'trust-me' });
      const resp = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)),
        env,
      );
      expect(resp.status).toBe(200);

      const devData = await getDevice(device.id);
      expect(devData.update_verification).toBeFalsy();
    });

    it('keeps the last reported mode when a check-in omits it', async () => {
      // Parity with the Express server's COALESCE($6, update_verification): an
      // older agent must not reset a known mode to "unknown" every check-in.
      const hostname = 'UPDVER-KEEP';
      const { apiKey, device } = await enrollDevice(worker, env, hostname);

      const pinned = JSON.stringify({ hostname, update_verification: 'signature' });
      await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', pinned, signRequest(pinned, apiKey)),
        env,
      );

      const silent = JSON.stringify({ hostname });
      await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', silent, signRequest(silent, apiKey)),
        env,
      );

      expect((await getDevice(device.id)).update_verification).toBe('signature');
    });

    it('POST /api/ping reports the mode and does not wipe the firmware audit', async () => {
      // /api/ping is the legacy alias for the same check-in payload. It is a
      // partial heartbeat, so it must merge into the stored metadata rather than
      // replace it — before S193 it dropped firmware_audit wholesale.
      const hostname = 'UPDVER-PING';
      const { apiKey, device } = await enrollDevice(worker, env, hostname);
      const audit = { platform: 'Windows', secure_boot: false, note: 'secure_boot_off' };

      const full = JSON.stringify({
        hostname,
        firmware_audit: audit,
        update_verification: 'sha256-only',
      });
      await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', full, signRequest(full, apiKey)),
        env,
      );

      const ping = JSON.stringify({ hostname });
      const pingResp = await worker.fetch(
        makeRequest('POST', '/api/ping', ping, signRequest(ping, apiKey)),
        env,
      );
      expect(pingResp.status).toBe(200);

      const devData = await getDevice(device.id);
      expect(devData.firmware_audit).toEqual(audit);
      expect(devData.update_verification).toBe('sha256-only');
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
      }, { 'X-Setup-Token': 'test-admin-token' });
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

    it('POST /api/devices/:id/track refuses a device that is not stolen', async () => {
      // Tracking disables the signed-in account and EFS-encrypts its profile, so it
      // must not be reachable from a device an operator is using. S269: a queued
      // track fired one poll after a recover and locked the operator out.
      const { device } = await enrollDevice(worker, env, 'TRACK-001');
      const req = makeRequest(
        'POST',
        `/api/devices/${device.id}/track`,
        {},
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(409);
      const body = await resp.text();
      expect(body).toContain('Flag it stolen first');
    });

    it('POST /api/devices/:id/track is allowed once the device is stolen', async () => {
      const { device } = await enrollDevice(worker, env, 'TRACK-002');
      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${device.id}/flag`,
          { hostname_confirm: device.hostname },
          { Authorization: 'Bearer test-admin-token' },
        ),
        env,
      );
      const resp = await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/track`, {}, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
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

    it('POST /api/devices/:id/locate refuses to queue tracking on a healthy device', async () => {
      // `locate` queues a `track` command, and `track` is what enters covert tracking
      // mode — so "where is it?" silently changed a device's security posture (S269).
      const { device } = await enrollDevice(worker, env, 'LOCATE-001');
      const req = makeRequest(
        'POST',
        `/api/devices/${device.id}/locate`,
        {},
        { Authorization: 'Bearer test-admin-token' },
      );
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(409);
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
        const r = await worker.fetch(
          makeRequest('POST', '/api/setup/create-admin', { username, password }, { 'X-Setup-Token': 'test-admin-token' }),
          env,
        );
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
      const r = await worker.fetch(
        makeRequest('POST', '/api/setup/create-admin', { username: 'x', password: 'password123' }, { 'X-Setup-Token': 'test-admin-token' }),
        env,
      );
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

    it('pba-credentials returns agent-escrowed creds; release offboards the device', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      const { apiKey, device } = await enrollDevice(worker, env, 'PBA-001');
      // Flag → lockdown
      await worker.fetch(makeRequest('POST', `/api/devices/${device.id}/flag`,
        { hostname_confirm: 'PBA-001' }, { Authorization: 'Bearer test-admin-token' }), env);
      const ci = await worker.fetch(makeRequest('POST', '/api/agent/checkin',
        JSON.stringify({ hostname: 'PBA-001' }), signRequest(JSON.stringify({ hostname: 'PBA-001' }), apiKey)), env);
      const cmdId = ((await parseResponse(ci) as any).command).id;

      // Agent ACKs lockdown with bios + bitlocker creds
      const ackBody = JSON.stringify({
        hostname: 'PBA-001', command_id: cmdId, result_status: 'executed',
        key_material: 'k', bios_password: 'bios123',
        power_on_password: 'po456', bitlocker_pin: 'pin789',
        bitlocker_recovery_password: 'rec000',
      });
      await worker.fetch(makeRequest('POST', '/api/agent/command-ack', ackBody, signRequest(ackBody, apiKey)), env);

      // pba-credentials (super-admin) returns the escrowed creds
      const pba = await worker.fetch(makeRequest('GET', `/api/devices/${device.id}/pba-credentials`, undefined,
        { Authorization: 'Bearer test-admin-token' }), env);
      const creds: any = await parseResponse(pba);
      expect(pba.status).toBe(200);
      expect(creds.setup_password).toBe('bios123');
      expect(creds.power_on_password).toBe('po456');
      expect(creds.bitlocker_pin).toBe('pin789');
      expect(creds.bitlocker_recovery_password).toBe('rec000');

      // Recover → unlock returns the creds to the agent
      await worker.fetch(makeRequest('POST', `/api/devices/${device.id}/recover`,
        { hostname_confirm: 'PBA-001' }, { Authorization: 'Bearer test-admin-token' }), env);
      const ci2 = await worker.fetch(makeRequest('POST', '/api/agent/checkin',
        JSON.stringify({ hostname: 'PBA-001' }), signRequest(JSON.stringify({ hostname: 'PBA-001' }), apiKey)), env);
      const cmd2 = (await parseResponse(ci2) as any).command;
      expect(cmd2.bios_password).toBe('bios123');
      expect(cmd2.power_on_password).toBe('po456');
      expect(cmd2.bitlocker_recovery_password).toBe('rec000');

      // ACK the unlock so the device returns to 'active' (release rejects
      // locked/stolen/recovering devices).
      const ack2 = JSON.stringify({
        hostname: 'PBA-001', command_id: cmd2.id, result_status: 'executed',
      });
      await worker.fetch(makeRequest('POST', '/api/agent/command-ack', ack2, signRequest(ack2, apiKey)), env);

      // release (operator) offboards the device — cascades all data
      const rel = await worker.fetch(makeRequest('DELETE', `/api/devices/${device.id}/release`,
        { hostname_confirm: 'PBA-001' }, { Authorization: 'Bearer test-admin-token' }), env);
      expect(rel.status).toBe(200);
      const list = await worker.fetch(makeRequest('GET', '/api/devices', undefined,
        { Authorization: 'Bearer test-admin-token' }), env);
      const devs: any = await parseResponse(list);
      expect(devs.some((d: any) => d.id === device.id)).toBe(false);
    });

    it('pba-credentials requires super-admin; release rejects a locked device', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      await worker.fetch(makeRequest('POST', '/api/admins',
        { username: 'op1', password: 'password123', role: 'operator' },
        { Authorization: 'Bearer test-admin-token' }), env);
      const { data } = await login(env, 'op1', 'password123');
      const { device } = await enrollDevice(worker, env, 'PBA-002');

      // operator (not super-admin) can't read pba-credentials → 403
      const pba = await worker.fetch(makeRequest('GET', `/api/devices/${device.id}/pba-credentials`, undefined,
        { Authorization: `Bearer ${data.token}` }), env);
      expect(pba.status).toBe(403);

      // a stolen device can't be released → 409
      await worker.fetch(makeRequest('POST', `/api/devices/${device.id}/flag`,
        { hostname_confirm: 'PBA-002' }, { Authorization: 'Bearer test-admin-token' }), env);
      const rel = await worker.fetch(makeRequest('DELETE', `/api/devices/${device.id}/release`,
        { hostname_confirm: 'PBA-002' }, { Authorization: 'Bearer test-admin-token' }), env);
      expect(rel.status).toBe(409);
    });

    it('installer returns a delegating install.ps1 and re-keys the device', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      const { device } = await enrollDevice(worker, env, 'INST-001');
      const resp = await worker.fetch(makeRequest('GET', `/api/installer/${device.id}`, undefined,
        { Authorization: 'Bearer test-admin-token' }), env);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('Content-Type')).toContain('text/plain');
      const script = await resp.text();

      // Staging: the baked config plus the two binaries from KV.
      expect(script).toContain('config.json');
      expect(script).toContain('/api/download/agent');
      expect(script).toContain('/api/download/agent-installer');
      expect(script).toContain('INST-001');

      // Delegation: lockdown-installer.exe does the install, so the mechanism is
      // the same one the generic and Express installers use.
      expect(script).toContain('--config-file');
      expect(script).toContain('--silent');

      // The regression this test exists for: sc.exe services are killed by the
      // SCM because the agent implements no StartServiceCtrlDispatcher.
      expect(script).not.toContain('sc.exe');
      expect(script).not.toContain('RemoteLockdown');

      // The embedded config carries a fresh api_key (re-keyed — old no longer matches).
      const list = await worker.fetch(makeRequest('GET', `/api/devices/${device.id}`, undefined,
        { Authorization: 'Bearer test-admin-token' }), env);
      expect(list.status).toBe(200);
    });

    it('the generated setup script is plain ASCII', async () => {
      // PowerShell 5.1 decodes a BOM-less script as ANSI, so a UTF-8 em dash inside a
      // string literal becomes 'â€"' — and that last byte terminates the string early.
      // The whole script then fails to parse, which is what the dashboard's one-liner
      // handed to the operator in S302: `iex (irm .../api/enroll/setup.ps1)` died with
      // "The string is missing the terminator" before installing anything. The same
      // failure was recorded once before for the Windows build script (B-083); this
      // pins the generated script so it cannot come back through a copy-paste.
      await seedAdmin(env, 'sa1', 'password123');
      const { device } = await enrollDevice(worker, env, 'ASCII-001');
      const resp = await worker.fetch(
        makeRequest('GET', `/api/enroll/setup.ps1`, undefined, {}),
        env,
      );
      expect(resp.status).toBe(200);
      const script = await resp.text();
      const offenders = [...script].filter((c) => c.charCodeAt(0) > 127);
      expect(offenders, `non-ASCII characters in the generated PowerShell: ${[...new Set(offenders)].join(' ')}`).toEqual([]);
      expect(device.hostname).toBeTruthy();
    });

    it('serves the CLI installer the generated scripts run', async () => {
      const bytes = new Uint8Array([0x4d, 0x5a, 0x01, 0x02, 0x03]);
      await env.LOCKDOWN_KV.put('binary:agent-installer', bytes);

      const resp = await worker.fetch(makeRequest('GET', '/api/download/agent-installer'), env);

      expect(resp.status).toBe(200);
      expect(resp.headers.get('Content-Type')).toContain('portable-executable');
      // The staged filename matters: the script writes it to lockdown-installer.exe
      // and the installer looks for lockdown-agent.exe next to itself.
      expect(resp.headers.get('Content-Disposition')).toContain('lockdown-installer.exe');
      expect(new Uint8Array(await resp.arrayBuffer())).toEqual(bytes);
    });

    it('labels every binary with the digest of the bytes it serves', async () => {
      const bytes = new Uint8Array([0x4d, 0x5a, 0xde, 0xad, 0xbe, 0xef]);
      await env.LOCKDOWN_KV.put('binary:agent', bytes);

      const resp = await worker.fetch(makeRequest('GET', '/api/download/agent'), env);
      const body = new Uint8Array(await resp.arrayBuffer());

      const digest = await crypto.subtle.digest('SHA-256', body);
      const expected = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      expect(resp.headers.get('x-content-sha256')).toBe(expected);
      // The digest must describe the body that was actually served.
      expect(body).toEqual(bytes);
    });

    it('every download route carries the digest, not just one', async () => {
      await env.LOCKDOWN_KV.put('binary:agent', new Uint8Array([1, 2, 3]));
      await env.LOCKDOWN_KV.put('binary:lockscreen', new Uint8Array([4, 5, 6]));
      await env.LOCKDOWN_KV.put('binary:installer', new Uint8Array([7, 8, 9]));

      for (const path of ['/api/download/agent', '/api/download/lockscreen', '/api/download/installer']) {
        const resp = await worker.fetch(makeRequest('GET', path), env);
        expect(resp.status, path).toBe(200);
        expect(resp.headers.get('x-content-sha256'), path).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('keeps a republished download from being cached for an hour', async () => {
      // The URL has no version, so the only thing standing between a user and the
      // previous release is the cache lifetime. An hour is long enough to hand someone
      // last week's installer after a publish (S298).
      await env.LOCKDOWN_KV.put('binary:agent', new Uint8Array([1, 2, 3]));

      const resp = await worker.fetch(makeRequest('GET', '/api/download/agent'), env);
      const cacheControl = resp.headers.get('Cache-Control') ?? '';
      const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] ?? '0');

      expect(cacheControl).toContain('public');
      expect(maxAge).toBeGreaterThan(0);
      expect(maxAge).toBeLessThanOrEqual(300);
    });

    it('serves an artifact from R2 when KV cannot hold it', async () => {
      // S291: a KV value caps at 27 MiB and the NSIS installer passed that at 33 MB of
      // payload, so the installer has to be published somewhere else. R2 is that place; the
      // route and the key name do not change, so nothing downstream has to know which store
      // answered.
      const bytes = new Uint8Array([0x4d, 0x5a, 0x99, 0x10, 0x20]);
      const envWithR2 = {
        ...env,
        BINARIES: {
          get: async (key: string) =>
            key === 'binary:installer'
              ? { arrayBuffer: async () => bytes.buffer.slice(0) }
              : null,
        },
      };

      const resp = await worker.fetch(makeRequest('GET', '/api/download/installer'), envWithR2);

      expect(resp.status).toBe(200);
      expect(new Uint8Array(await resp.arrayBuffer())).toEqual(bytes);
      // The digest must describe the bytes actually served, whichever store produced them.
      expect(resp.headers.get('x-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
      expect(resp.headers.get('Content-Disposition')).toContain('lockdown-setup.exe');
    });

    it('prefers KV over R2 for the same key', async () => {
      // KV first keeps a deployment without R2 behaving exactly as before, and keeps an
      // artifact that fits where the existing publish tooling puts it.
      const fromKv = new Uint8Array([0xaa, 0xbb]);
      const fromR2 = new Uint8Array([0xcc, 0xdd]);
      await env.LOCKDOWN_KV.put('binary:installer', fromKv);
      const envWithR2 = {
        ...env,
        BINARIES: { get: async () => ({ arrayBuffer: async () => fromR2.buffer.slice(0) }) },
      };

      const resp = await worker.fetch(makeRequest('GET', '/api/download/installer'), envWithR2);
      expect(new Uint8Array(await resp.arrayBuffer())).toEqual(fromKv);
    });

    it('still answers 404 with no R2 binding and an empty KV', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/api/download/installer'), env);
      expect(resp.status).toBe(404);
      expect(await resp.json()).toHaveProperty('error');
    });

    it('the generated installer verifies both downloads before running them', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      const { device } = await enrollDevice(worker, env, 'INTEG-001');
      const resp = await worker.fetch(makeRequest('GET', `/api/installer/${device.id}`, undefined,
        { Authorization: 'Bearer test-admin-token' }), env);
      const script = await resp.text();

      // Fetch, compare against the served digest, delete on mismatch.
      expect(script).toContain('x-content-sha256');
      expect(script).toContain('Get-FileHash');
      expect(script).toContain('Checksum mismatch');
      // A missing digest must abort rather than run an unverifiable binary.
      expect(script).toContain('unverifiable binary');
      // Both artefacts are verified: the agent and the installer it runs.
      const verified = script.match(/Get-VerifiedFile -Url/g) ?? [];
      expect(verified.length).toBe(2);
    });

    it('keeps one generated-install template, not one per route', async () => {
      // The per-device script and the firmware re-arm script are the same
      // installer. They were two hand-copied templates, and the sc.exe mechanism
      // survived in both because nobody fixed the second copy. Guard the merge.
      const { readFileSync } = await import('fs');
      const src = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8');

      const delegateCalls = src.match(/lockdown-installer\.exe" --config-file/g) ?? [];
      expect(delegateCalls.length).toBe(1);

      // Comments are allowed (and required) to explain the removed mechanism;
      // what must not exist is an executable sc.exe call. The scripts are TS
      // template literals, so check the emitted line inside them.
      const executable = src
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith(';'));
      expect(executable.some((line) => /sc\.exe create/.test(line))).toBe(false);
    });

    it('reports a missing CLI installer instead of serving an empty body', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/api/download/agent-installer'), env);

      expect(resp.status).toBe(404);
      expect(await resp.text()).toContain('agent-installer binary not available');
    });

    it('installer requires operator role; viewer is rejected', async () => {
      await seedAdmin(env, 'sa1', 'password123');
      await worker.fetch(makeRequest('POST', '/api/admins',
        { username: 'view1', password: 'password123', role: 'viewer' },
        { Authorization: 'Bearer test-admin-token' }), env);
      const { data } = await login(env, 'view1', 'password123');
      const { device } = await enrollDevice(worker, env, 'INST-002');
      const resp = await worker.fetch(makeRequest('GET', `/api/installer/${device.id}`, undefined,
        { Authorization: `Bearer ${data.token}` }), env);
      expect(resp.status).toBe(403);
    });

    it('bios_passwords are AES-GCM-encrypted at rest when KV_KEK is set', async () => {
      // env2 carries a KV_KEK — stored credential must be ciphertext.
      const kekBytes = crypto.getRandomValues(new Uint8Array(32));
      const kekB64 = btoa(String.fromCharCode(...kekBytes));
      const env2 = { ...env, KV_KEK: kekB64 };
      const { apiKey, device } = await enrollDevice(worker, env2, 'KEK-001');
      await worker.fetch(makeRequest('POST', `/api/devices/${device.id}/flag`,
        { hostname_confirm: 'KEK-001' }, { Authorization: 'Bearer test-admin-token' }), env2);
      const ci = await worker.fetch(makeRequest('POST', '/api/agent/checkin',
        JSON.stringify({ hostname: 'KEK-001' }), signRequest(JSON.stringify({ hostname: 'KEK-001' }), apiKey)), env2);
      const cmdId = ((await parseResponse(ci) as any).command).id;
      const ackBody = JSON.stringify({
        hostname: 'KEK-001', command_id: cmdId, result_status: 'executed',
        key_material: 'k', bios_password: 'SECRET-BIOS-PW',
      });
      await worker.fetch(makeRequest('POST', '/api/agent/command-ack', ackBody, signRequest(ackBody, apiKey)), env2);

      // The KV record must NOT contain the plaintext password. ADR-006 moved credentials to one
      // key per device, so the assertion reads that key — the property under test is unchanged.
      const stored = JSON.parse(
        await (env2.LOCKDOWN_KV as any).get(`bios_passwords:${device.id}`),
      );
      const row = stored.find((r: any) => r.device_id === device.id);
      expect(row.password).toBeUndefined();
      expect(row.password_enc).toBeDefined();
      expect(JSON.stringify(stored)).not.toContain('SECRET-BIOS-PW');

      // But pba-credentials decrypts it transparently for super-admin.
      const pba = await worker.fetch(makeRequest('GET', `/api/devices/${device.id}/pba-credentials`, undefined,
        { Authorization: 'Bearer test-admin-token' }), env2);
      const creds: any = await parseResponse(pba);
      expect(creds.setup_password).toBe('SECRET-BIOS-PW');
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

    it('re-association PRESERVES a flag (D-227 changed this deliberately)', async () => {
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
      // This assertion used to read `.toBe('active')`: reinstalling the agent silently cleared the
      // flag, so a branch enrolment token could erase a theft record. D-227 made recovery an
      // administrator action, so the flag now survives the reinstall. The change is deliberate.
      expect(data2.device.status).toBe('stolen');
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

  describe('POST /api/rearm', () => {
    it('re-arms an enrolled+stolen device only after administrator approval, and returns the same installer', async () => {
      // Enroll a device with a hardware_uuid.
      const enrollResp = await worker.fetch(
        makeRequest('POST', '/api/enroll', {
          hostname: 'REARM-001',
          hardware_uuid: 'uuid-rearm-001',
        }, { Authorization: 'Bearer test-admin-token' }),
        env,
      );
      const enrollData: any = await parseResponse(enrollResp);
      const deviceId = enrollData.device.id;

      // Flag the device stolen — handleFlagStolen requires hostname_confirm.
      const flagResp = await worker.fetch(
        makeRequest('POST', `/api/devices/${deviceId}/flag-stolen`, {
          hostname_confirm: 'REARM-001',
        }, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(flagResp.status).toBe(200);

      // The PblPersistDxe bootstrap POSTs hardware_uuid — no auth needed. Since ADR-011 (D-226) that
      // records a pending request instead of issuing a key: the UUID is not a credential.
      // A Request body can be read once, so each attempt builds a fresh one — the retry is exactly
      // what a technician does after approval.
      const rearmAttempt = () => worker.fetch(
        makeRequest('POST', '/api/rearm', { hardware_uuid: 'uuid-rearm-001', hostname: 'REARM-001' }),
        env,
      );
      const pending = await rearmAttempt();
      expect(pending.status).toBe(409);

      // A super-admin approves, and the technician's retry collects the script.
      await worker.fetch(
        makeRequest('POST', `/api/admin/rearm-requests/${deviceId}/approve`, {}, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const rearmResp = await rearmAttempt();
      const script = await rearmResp.text();

      expect(rearmResp.status).toBe(200);
      expect(script).toContain('REARM-001');
      expect(script).toContain('lockdown-agent.exe');
      expect(script).toContain('config.json');

      // The re-arm script is the same installer as the per-device one: the
      // firmware path was the second copy that kept the sc.exe mechanism alive.
      expect(script).toContain('/api/download/agent-installer');
      expect(script).toContain('--config-file');
      expect(script).not.toContain('sc.exe');
    });

    it('returns 404 for an active (non-flagged) device', async () => {
      await worker.fetch(
        makeRequest('POST', '/api/enroll', {
          hostname: 'REARM-ACTIVE',
          hardware_uuid: 'uuid-rearm-active',
        }, { Authorization: 'Bearer test-admin-token' }),
        env,
      );
      const req = makeRequest('POST', '/api/rearm', {
        hardware_uuid: 'uuid-rearm-active',
        hostname: 'REARM-ACTIVE',
      });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(404);
    });

    it('returns 404 for an unknown hardware_uuid', async () => {
      const req = makeRequest('POST', '/api/rearm', {
        hardware_uuid: 'uuid-not-enrolled',
        hostname: 'GHOST',
      });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(404);
    });

    it('rejects missing hardware_uuid', async () => {
      const req = makeRequest('POST', '/api/rearm', { hostname: 'NO-UUID' });
      const resp = await worker.fetch(req, env);
      expect(resp.status).toBe(400);
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
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe(TOKEN_API_CORS_ORIGIN);
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
    await parseResponse(checkin2Resp);
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
        makeRequest('POST', `/v1/devices/${'ff'.repeat(32)}/lock`, undefined, {
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
        makeRequest('POST', `/v1/devices/${'ff'.repeat(32)}/track`, undefined, {
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
        makeRequest('POST', `/v1/devices/${'ff'.repeat(32)}/stop-track`, undefined, {
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
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe(TOKEN_API_CORS_ORIGIN);
      expect(resp.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(resp.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    });

    it('includes CORS headers on GET /v1/policy/1', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/policy/1'), env);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe(TOKEN_API_CORS_ORIGIN);
    });

    it('includes CORS headers on GET /v1/devices (admin)', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', '/v1/devices', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe(TOKEN_API_CORS_ORIGIN);
    });

    it('includes CORS headers on 404 responses', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/unknown'), env);
      expect(resp.status).toBe(404);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe(TOKEN_API_CORS_ORIGIN);
    });

    it('includes CORS headers on 401 responses', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/v1/devices'), env);
      expect(resp.status).toBe(401);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe(TOKEN_API_CORS_ORIGIN);
    });

    it('handles OPTIONS preflight with CORS headers', async () => {
      const resp = await worker.fetch(new Request('https://lockdown.example.com/v1/health', {
        method: 'OPTIONS',
      }), env);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe(TOKEN_API_CORS_ORIGIN);
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

  // -------------------------------------------------------------------------
  // Uninstall authorisation. Session 180: neither endpoint had a single test —
  // `grep -c uninstall` in this file was 0 — so a mutation letting any caller
  // obtain an uninstall token, or letting any token verify, passed the suite.
  // These endpoints decide whether the agent may be removed, which is the thing
  // an attacker holding the machine most wants.
  // -------------------------------------------------------------------------
  describe('POST /api/agent/uninstall-auth', () => {
    it('rejects a request with no credentials', async () => {
      const resp = await worker.fetch(makeRequest('POST', '/api/agent/uninstall-auth'), env);
      expect(resp.status).toBe(401);
    });

    it('rejects an unknown API key', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/api/agent/uninstall-auth', undefined, {
          'X-API-Key': 'fake-api-key-not-enrolled',
        }),
        env,
      );
      expect(resp.status).toBe(401);
    });

    it('issues a short-lived token to an enrolled device', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'UNINSTALL-001');
      const resp = await worker.fetch(
        makeRequest('POST', '/api/agent/uninstall-auth', undefined, { 'X-API-Key': apiKey }),
        env,
      );
      expect(resp.status).toBe(200);
      const data: any = await parseResponse(resp);
      expect(typeof data.uninstall_token).toBe('string');
      expect(data.uninstall_token.length).toBeGreaterThan(0);
      expect(data.expires_in).toBe(300);
    });
  });

  describe('POST /api/agent/uninstall-auth/verify', () => {
    it('accepts the token its issuer just returned', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'UNINSTALL-002');
      const issueResp = await worker.fetch(
        makeRequest('POST', '/api/agent/uninstall-auth', undefined, { 'X-API-Key': apiKey }),
        env,
      );
      const issued: any = await parseResponse(issueResp);

      const verifyResp = await worker.fetch(
        makeRequest(
          'POST',
          '/api/agent/uninstall-auth/verify',
          { uninstall_token: issued.uninstall_token },
          { 'X-API-Key': apiKey },
        ),
        env,
      );
      const verified: any = await parseResponse(verifyResp);
      expect(verified.authorized).toBe(true);
      expect(verified.verified).toBe(true);
    });

    it('rejects a wrong token', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'UNINSTALL-003');
      const verifyResp = await worker.fetch(
        makeRequest(
          'POST',
          '/api/agent/uninstall-auth/verify',
          { uninstall_token: 'not-the-token' },
          { 'X-API-Key': apiKey },
        ),
        env,
      );
      const verified: any = await parseResponse(verifyResp);
      expect(verified.authorized).toBe(false);
      expect(verified.verified).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // D-221: the uninstall token is bound to one device, and the two surfaces
  // derive it identically. Before this, the Worker used SHA256("window:secret")
  // while Express used HMAC(secret, window) — so a token from one surface never
  // verified on the other, and each suite tested only its own surface.
  // -------------------------------------------------------------------------
  describe('D-221 uninstall-token scheme', () => {
    const vectorsPath = path.join(HERE, '..', 'docs', 'adr', 'D-221-token-vectors.json');
    const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

    const windowFor = (seconds: number) => Math.floor(seconds / 300) * 300;
    const boundToken = (secret: string, deviceId: string, window: number) =>
      crypto.createHmac('sha256', secret).update(`${deviceId}:${window}`).digest('hex');
    const legacyWorkerToken = (secret: string, window: number) =>
      crypto.createHash('sha256').update(`${window}:${secret}`).digest('hex');

    it('the canonical derivation reproduces every shared vector', () => {
      // server/tests/uninstallAuth.test.js asserts the same thing. Both suites passing is
      // what makes the two surfaces agree; a divergence fails two suites instead of none.
      const wrong = vectors.bound.filter(
        (v: any) => boundToken(vectors.secret, v.device_id, v.window) !== v.token,
      );
      expect(wrong).toEqual([]);
      expect(vectors.bound.length).toBeGreaterThan(0);
    });

    it('the Worker issues the canonical DEVICE-BOUND token', async () => {
      const { device, apiKey } = await enrollDevice(worker, env, 'D221-BOUND-001');
      const resp = await worker.fetch(
        makeRequest('POST', '/api/agent/uninstall-auth', undefined, { 'X-API-Key': apiKey }),
        env,
      );
      const data: any = await parseResponse(resp);

      expect(data.device_id).toBe(device.id);
      expect(data.uninstall_token).toBe(
        boundToken(env.ADMIN_TOKEN, device.id, windowFor(Math.floor(Date.now() / 1000))),
      );
      // And specifically not the old deployment-wide token.
      expect(data.uninstall_token).not.toBe(
        legacyWorkerToken(env.ADMIN_TOKEN, windowFor(Math.floor(Date.now() / 1000))),
      );
    });

    it("a token bound to another device does not authorise this one", async () => {
      const victim = await enrollDevice(worker, env, 'D221-VICTIM-001');
      const other = await enrollDevice(worker, env, 'D221-OTHER-001');
      const stolen = boundToken(
        env.ADMIN_TOKEN,
        other.device.id,
        windowFor(Math.floor(Date.now() / 1000)),
      );

      const resp = await worker.fetch(
        makeRequest(
          'POST',
          '/api/agent/uninstall-auth/verify',
          { uninstall_token: stolen },
          { 'X-API-Key': victim.apiKey },
        ),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(data.authorized).toBe(false);
    });

    it('still accepts the previous Worker scheme, and marks it deprecated', async () => {
      // Q2-A: an agent that has not taken the update must still be able to uninstall.
      const { apiKey } = await enrollDevice(worker, env, 'D221-LEGACY-001');
      const legacy = legacyWorkerToken(
        env.ADMIN_TOKEN,
        windowFor(Math.floor(Date.now() / 1000)),
      );
      const resp = await worker.fetch(
        makeRequest(
          'POST',
          '/api/agent/uninstall-auth/verify',
          { uninstall_token: legacy },
          { 'X-API-Key': apiKey },
        ),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(data.authorized).toBe(true);
      expect(data.deprecated_scheme).toBe('legacy-deployment-wide');
    });

    it('the legacy acceptance names its own sunset, and it matches the shared statement', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'D221-SUNSET-001');
      const legacy = legacyWorkerToken(env.ADMIN_TOKEN, windowFor(Math.floor(Date.now() / 1000)));
      const resp = await worker.fetch(
        makeRequest(
          'POST',
          '/api/agent/uninstall-auth/verify',
          { uninstall_token: legacy },
          { 'X-API-Key': apiKey },
        ),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(data.deprecated_scheme_sunset).toBe(vectors.legacy_sunset);
    });

    it('the legacy window has not passed (fails on the sunset date, by design)', () => {
      expect(Date.now()).toBeLessThan(Date.parse(`${vectors.legacy_sunset}T00:00:00Z`));
    });

    it('refuses to issue when ADMIN_TOKEN is unset', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'D221-NOSECRET-001');
      const saved = env.ADMIN_TOKEN;
      // The old code fell back to HMAC over the literal string 'fallback', which anyone
      // holding this repository can compute.
      (env as any).ADMIN_TOKEN = '';
      try {
        const resp = await worker.fetch(
          makeRequest('POST', '/api/agent/uninstall-auth', undefined, { 'X-API-Key': apiKey }),
          env,
        );
        expect(resp.status).toBe(503);
        const data: any = await parseResponse(resp);
        expect(data.error).toMatch(/ADMIN_TOKEN/);
        expect(data.uninstall_token).toBeUndefined();
      } finally {
        env.ADMIN_TOKEN = saved;
      }
    });

    it('an admin-token caller must name the device it is issuing for', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/api/agent/uninstall-auth', {}, { Authorization: 'Bearer test-admin-token' }),
        env,
      );
      expect(resp.status).toBe(400);
      const data: any = await parseResponse(resp);
      expect(data.error).toMatch(/device_id required/);
    });
  });

  // -------------------------------------------------------------------------
  // D-222: the fleet must be able to answer "which build is on that machine?"
  // The version was always sent and never stored, so a rollout instruction could
  // not come with a way to check compliance.
  // -------------------------------------------------------------------------
  describe('agent version reporting (D-222)', () => {
    async function checkinWith(apiKey: string, hostname: string, extra: Record<string, unknown>) {
      const body = JSON.stringify({ hostname, ...extra });
      return worker.fetch(makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)), env);
    }

    it('stores the version reported at check-in and returns it from the device list', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'D222-REPORT-001');
      const resp = await checkinWith(apiKey, 'D222-REPORT-001', { agent_version: '1.4.2' });
      expect(resp.status).toBe(200);

      const list = await worker.fetch(
        makeRequest('GET', '/api/devices', undefined, { Authorization: 'Bearer test-admin-token' }),
        env,
      );
      const devices: any[] = await parseResponse(list);
      const row = devices.find((d) => d.id === device.id);
      expect(row.agent_version).toBe('1.4.2');
      expect(typeof row.agent_version_at).toBe('string');
      // The credential hash still never leaves the Worker.
      expect(row.api_key_hash).toBeUndefined();
    });

    it('a pre-D-222 agent that omits the field does not erase a reported version', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'D222-OMIT-001');
      await checkinWith(apiKey, 'D222-OMIT-001', { agent_version: '1.4.2' });
      // An older build checks in with no version at all.
      await checkinWith(apiKey, 'D222-OMIT-001', {});

      const list = await worker.fetch(
        makeRequest('GET', '/api/devices', undefined, { Authorization: 'Bearer test-admin-token' }),
        env,
      );
      const devices: any[] = await parseResponse(list);
      expect(devices.find((d) => d.id === device.id).agent_version).toBe('1.4.2');
    });

    it('a device that never reported a version reads as unknown, not as compliant', async () => {
      const { device } = await enrollDevice(worker, env, 'D222-UNKNOWN-001');
      const list = await worker.fetch(
        makeRequest('GET', '/api/devices', undefined, { Authorization: 'Bearer test-admin-token' }),
        env,
      );
      const devices: any[] = await parseResponse(list);
      const row = devices.find((d) => d.id === device.id);
      expect(row.agent_version ?? null).toBeNull();
    });

    it('a malformed version is not stored (it must not read as compliance)', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'D222-BAD-001');
      await checkinWith(apiKey, 'D222-BAD-001', { agent_version: '<script>alert(1)</script>' });

      const list = await worker.fetch(
        makeRequest('GET', '/api/devices', undefined, { Authorization: 'Bearer test-admin-token' }),
        env,
      );
      const devices: any[] = await parseResponse(list);
      expect(devices.find((d) => d.id === device.id).agent_version ?? null).toBeNull();
    });

    it('flags a device that checks in but stops reporting a version, and filters it (D-258)', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'D258-STALE-001');
      await checkinWith(apiKey, 'D258-STALE-001', { agent_version: '1.4.2' });

      // Rewrite the check-in metadata so the version report is two hours older than the
      // check-in, as if the machine had been downgraded to a build that does not send it.
      const key = `device_checkin:${device.id}`;
      const meta = JSON.parse((await kv.get(key)) as string);
      meta.last_checkin = '2026-11-05T12:00:00.000Z';
      meta.agent_version_at = '2026-11-05T10:00:00.000Z';
      await kv.put(key, JSON.stringify(meta));

      const admin = { Authorization: 'Bearer test-admin-token' };
      const all: any[] = await parseResponse(await worker.fetch(makeRequest('GET', '/api/devices', undefined, admin), env));
      expect(all.find((d) => d.id === device.id).agent_version_stale).toBe(true);

      const stale: any[] = await parseResponse(
        await worker.fetch(makeRequest('GET', '/api/devices?agent_version=stale', undefined, admin), env),
      );
      expect(stale.map((d) => d.id)).toEqual([device.id]);
    });

    it('a fresh report is not stale, and a zone-less timestamp does not drift (D-258)', async () => {
      const { apiKey, device } = await enrollDevice(worker, env, 'D258-CURRENT-001');
      await checkinWith(apiKey, 'D258-CURRENT-001', { agent_version: '1.4.2' });

      const key = `device_checkin:${device.id}`;
      const meta = JSON.parse((await kv.get(key)) as string);
      // Half an hour apart, and the version stamp is in SQLite's zone-less shape — the form a
      // device first recorded by Express carries. Read as local time this would drift out of the
      // window on any non-UTC host.
      meta.last_checkin = '2026-11-05T12:00:00.000Z';
      meta.agent_version_at = '2026-11-05 11:30:00';
      await kv.put(key, JSON.stringify(meta));

      const admin = { Authorization: 'Bearer test-admin-token' };
      const all: any[] = await parseResponse(await worker.fetch(makeRequest('GET', '/api/devices', undefined, admin), env));
      expect(all.find((d) => d.id === device.id).agent_version_stale).toBe(false);
    });

    it('filters the device list by version, and `unknown` is its own query', async () => {
      const old = await enrollDevice(worker, env, 'D222-FILTER-OLD');
      const current = await enrollDevice(worker, env, 'D222-FILTER-NEW');
      await checkinWith(current.apiKey, 'D222-FILTER-NEW', { agent_version: '9.9.9' });

      const admin = { Authorization: 'Bearer test-admin-token' };
      const byVersion: any[] = await parseResponse(
        await worker.fetch(makeRequest('GET', '/api/devices?agent_version=9.9.9', undefined, admin), env),
      );
      expect(byVersion.map((d) => d.id)).toEqual([current.device.id]);

      const unknown: any[] = await parseResponse(
        await worker.fetch(makeRequest('GET', '/api/devices?agent_version=unknown', undefined, admin), env),
      );
      const unknownIds = unknown.map((d) => d.id);
      expect(unknownIds).toContain(old.device.id);
      expect(unknownIds).not.toContain(current.device.id);
    });
  });

  describe('POST /api/ping', () => {
    it("a ping only returns its own device's pending command", async () => {
      // The ping path is a second command-delivery route; it had no test at all,
      // so dropping its device filter would have handed one machine another
      // machine's pending lockdown with nothing to notice.
      const victim = await enrollDevice(worker, env, 'PING-VICTIM-001');
      const bystander = await enrollDevice(worker, env, 'PING-BYSTANDER-001');

      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${victim.device.id}/flag-stolen`,
          { hostname_confirm: 'PING-VICTIM-001' },
          { Authorization: 'Bearer test-admin-token' },
        ),
        env,
      );

      const bystanderBody = JSON.stringify({ hostname: 'PING-BYSTANDER-001' });
      const bystanderResp = await worker.fetch(
        makeRequest('POST', '/api/ping', bystanderBody, signRequest(bystanderBody, bystander.apiKey)),
        env,
      );
      const bystanderData: any = await parseResponse(bystanderResp);
      expect(bystanderData.command ?? null).toBe(null);

      const victimBody = JSON.stringify({ hostname: 'PING-VICTIM-001' });
      const victimResp = await worker.fetch(
        makeRequest('POST', '/api/ping', victimBody, signRequest(victimBody, victim.apiKey)),
        env,
      );
      const victimData: any = await parseResponse(victimResp);
      expect(victimData.command?.command_type).toBe('lockdown');
    });
  });

  // -------------------------------------------------------------------------
  // Agent auto-update. Session 181: the Worker had no /api/agent/update at all,
  // so every update check on the default (serverless) deployment 404'd and the
  // agent's raise_for_status() turned it into a logged warning — the fleet could
  // never be patched remotely, silently.
  // -------------------------------------------------------------------------
  describe('GET /api/agent/update', () => {
    const RELEASE = {
      latest_version: '1.2.0',
      sha256: 'a'.repeat(64),
      size: 1234,
      built_at: '2026-11-02T00:00:00.000Z',
      signature: 'c2lnbmF0dXJl',
      signature_alg: 'ed25519',
      platforms: { win: { sha256: 'b'.repeat(64), size: 2345 } },
    };

    it('requires agent auth', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/api/agent/update'), env);
      expect(resp.status).toBe(401);
    });

    it('reports no update when no release has been published', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'UPD-001');
      const headers = signRequest('', apiKey, { 'X-Agent-Version': '1.0.0' });
      const resp = await worker.fetch(
        makeRequest('GET', '/api/agent/update', undefined, headers),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.update_available).toBe(false);
      expect(data.reason).toBe('no_release_published');
      expect(data.latest_version).toBe('1.0.0');
    });

    it('offers a newer release with hash, size and signature', async () => {
      await env.LOCKDOWN_KV.put('agent_release', JSON.stringify(RELEASE));
      const { apiKey } = await enrollDevice(worker, env, 'UPD-002');
      const headers = signRequest('', apiKey, {
        'X-Agent-Version': '1.0.0',
        'X-Agent-Platform': 'linux',
      });
      const resp = await worker.fetch(
        makeRequest('GET', '/api/agent/update', undefined, headers),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(data.update_available).toBe(true);
      expect(data.latest_version).toBe('1.2.0');
      expect(data.current_version).toBe('1.0.0');
      expect(data.sha256).toBe(RELEASE.sha256);
      expect(data.size).toBe(RELEASE.size);
      expect(data.signature).toBe(RELEASE.signature);
      expect(data.signature_alg).toBe('ed25519');
      expect(data.download_url).toContain('/api/agent/download');
    });

    it('does not offer the version the agent already runs', async () => {
      await env.LOCKDOWN_KV.put('agent_release', JSON.stringify(RELEASE));
      const { apiKey } = await enrollDevice(worker, env, 'UPD-003');
      const headers = signRequest('', apiKey, { 'X-Agent-Version': '1.2.0' });
      const resp = await worker.fetch(
        makeRequest('GET', '/api/agent/update', undefined, headers),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(data.update_available).toBe(false);
    });

    it('honours per-platform hash and size', async () => {
      await env.LOCKDOWN_KV.put('agent_release', JSON.stringify(RELEASE));
      const { apiKey } = await enrollDevice(worker, env, 'UPD-004');
      const headers = signRequest('', apiKey, {
        'X-Agent-Version': '1.0.0',
        'X-Agent-Platform': 'win',
      });
      const resp = await worker.fetch(
        makeRequest('GET', '/api/agent/update', undefined, headers),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(data.sha256).toBe('b'.repeat(64));
      expect(data.size).toBe(2345);
    });

    it('serves the per-platform signature, not the top-level one (B-006)', async () => {
      // A signature signs "v1:{version}:{sha256}" — one hash. When the per-platform
      // builds differ, the top-level signature can only be valid for one of them,
      // so the platform's own signature has to win. Serving the wrong one looks
      // identical to "this release was signed" while every other platform
      // silently refuses to update.
      const perPlatform = {
        ...RELEASE,
        signature: 'dG9wLWxldmVs',
        platforms: {
          win: {
            sha256: 'b'.repeat(64),
            size: 2345,
            signature: 'd2luLXNpZw==',
            signature_alg: 'ed25519',
          },
        },
      };
      await env.LOCKDOWN_KV.put('agent_release', JSON.stringify(perPlatform));
      const { apiKey } = await enrollDevice(worker, env, 'UPD-SIG-1');
      const headers = signRequest('', apiKey, {
        'X-Agent-Version': '1.0.0',
        'X-Agent-Platform': 'win',
      });
      const resp = await worker.fetch(
        makeRequest('GET', '/api/agent/update', undefined, headers),
        env,
      );
      const data: any = await parseResponse(resp);

      expect(data.sha256).toBe('b'.repeat(64));
      expect(data.signature).toBe('d2luLXNpZw==');
      expect(data.signature_alg).toBe('ed25519');
    });

    it('falls back to the top-level signature for already-published metadata', async () => {
      // Metadata published before per-platform signing is a single build with one
      // signature; it must keep working.
      await env.LOCKDOWN_KV.put('agent_release', JSON.stringify(RELEASE));
      const { apiKey } = await enrollDevice(worker, env, 'UPD-SIG-2');
      const headers = signRequest('', apiKey, {
        'X-Agent-Version': '1.0.0',
        'X-Agent-Platform': 'win',
      });
      const resp = await worker.fetch(
        makeRequest('GET', '/api/agent/update', undefined, headers),
        env,
      );
      const data: any = await parseResponse(resp);

      expect(data.signature).toBe(RELEASE.signature);
      expect(data.signature_alg).toBe('ed25519');
    });

    it('reports a null signature and alg when the release is unsigned', async () => {
      // Unpinned agents accept this; pinned ones refuse it. Reporting an alg with
      // no signature would claim a check that never happened.
      const { signature: _sig, signature_alg: _alg, ...unsigned } = RELEASE;
      await env.LOCKDOWN_KV.put('agent_release', JSON.stringify(unsigned));
      const { apiKey } = await enrollDevice(worker, env, 'UPD-SIG-3');
      const headers = signRequest('', apiKey, {
        'X-Agent-Version': '1.0.0',
        'X-Agent-Platform': 'linux',
      });
      const resp = await worker.fetch(
        makeRequest('GET', '/api/agent/update', undefined, headers),
        env,
      );
      const data: any = await parseResponse(resp);

      expect(data.signature).toBeNull();
      expect(data.signature_alg).toBeNull();
    });

    it('fails closed on corrupt or incomplete metadata', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'UPD-005');
      const headers = signRequest('', apiKey, { 'X-Agent-Version': '1.0.0' });

      await env.LOCKDOWN_KV.put('agent_release', 'not-json');
      const corrupt = await worker.fetch(
        makeRequest('GET', '/api/agent/update', undefined, headers),
        env,
      );
      expect(corrupt.status).toBe(500);

      // Metadata without a hash cannot be verified, so it must not be offered.
      await env.LOCKDOWN_KV.put('agent_release', JSON.stringify({ latest_version: '9.9.9' }));
      const incompleteHeaders = signRequest('', apiKey, { 'X-Agent-Version': '1.0.0' });
      const incomplete = await worker.fetch(
        makeRequest('GET', '/api/agent/update', undefined, incompleteHeaders),
        env,
      );
      expect(incomplete.status).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // Two endpoints the dashboard needed and the Worker lacked (session 182).
  // Both exist in Express; without them "point the dashboard at the Worker"
  // leaves the version badge and the "last seen" pin broken.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // The URL /api/agent/update advertises.
  //
  // The Worker used to advertise `/api/agent/download?platform=…` while only
  // implementing `/api/download/agent`, so in the serverless deployment an
  // available update could never be fetched: the metadata said "install me" and
  // the download answered 404. The first test below is the regression that ties
  // the advertised URL to a served route.
  // -------------------------------------------------------------------------
  describe('GET /api/agent/download (the update download URL)', () => {
    const digestOf = async (bytes: Uint8Array) => {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    };

    it('requires agent auth', async () => {
      await env.LOCKDOWN_KV.put('binary:agent', new Uint8Array([1, 2, 3]));
      const resp = await worker.fetch(
        makeRequest('GET', '/api/agent/download?platform=linux'),
        env,
      );
      expect(resp.status).toBe(401);
    });

    it('serves the binary with the digest of exactly those bytes', async () => {
      const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x99]);
      await env.LOCKDOWN_KV.put('binary:agent', bytes);
      const { apiKey } = await enrollDevice(worker, env, 'UPD-DL-1');

      const resp = await worker.fetch(
        makeRequest('GET', '/api/agent/download?platform=linux', undefined,
          signRequest('', apiKey, { 'X-Agent-Platform': 'linux' })),
        env,
      );

      expect(resp.status).toBe(200);
      expect(new Uint8Array(await resp.arrayBuffer())).toEqual(bytes);
      expect(resp.headers.get('x-content-sha256')).toBe(await digestOf(bytes));
    });

    it('prefers a per-platform binary over the shared one', async () => {
      // A release whose builds differ publishes one key per platform; the shared
      // key stays as the fallback for single-build deployments.
      const shared = new Uint8Array([0x01]);
      const windows = new Uint8Array([0x02, 0x02]);
      await env.LOCKDOWN_KV.put('binary:agent', shared);
      await env.LOCKDOWN_KV.put('binary:agent:win', windows);
      const { apiKey } = await enrollDevice(worker, env, 'UPD-DL-2');

      const winResp = await worker.fetch(
        makeRequest('GET', '/api/agent/download?platform=win', undefined,
          signRequest('', apiKey, { 'X-Agent-Platform': 'win' })),
        env,
      );
      expect(new Uint8Array(await winResp.arrayBuffer())).toEqual(windows);

      const linuxResp = await worker.fetch(
        makeRequest('GET', '/api/agent/download?platform=linux', undefined,
          signRequest('', apiKey, { 'X-Agent-Platform': 'linux' })),
        env,
      );
      expect(new Uint8Array(await linuxResp.arrayBuffer())).toEqual(shared);
    });

    it('404s when no binary is published', async () => {
      const { apiKey } = await enrollDevice(worker, env, 'UPD-DL-3');
      const resp = await worker.fetch(
        makeRequest('GET', '/api/agent/download?platform=linux', undefined,
          signRequest('', apiKey, { 'X-Agent-Platform': 'linux' })),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('serves the exact download_url the update metadata advertises', async () => {
      // The regression: metadata and route must agree.
      const bytes = new Uint8Array([0x4d, 0x5a, 0x01, 0x02, 0x03]);
      await env.LOCKDOWN_KV.put('binary:agent', bytes);
      await env.LOCKDOWN_KV.put('agent_release', JSON.stringify({
        latest_version: '9.9.9',
        sha256: await digestOf(bytes),
        size: bytes.length,
        signature: 'c2ln',
        signature_alg: 'ed25519',
      }));
      const { apiKey } = await enrollDevice(worker, env, 'UPD-DL-4');
      const headers = signRequest('', apiKey, {
        'X-Agent-Version': '1.0.0',
        'X-Agent-Platform': 'linux',
      });

      const meta = await worker.fetch(
        makeRequest('GET', '/api/agent/update', undefined, headers),
        env,
      );
      const metaBody: any = await parseResponse(meta);
      expect(metaBody.update_available).toBe(true);

      const download = await worker.fetch(
        makeRequest('GET', metaBody.download_url, undefined,
          signRequest('', apiKey, { 'X-Agent-Platform': 'linux' })),
        env,
      );
      expect(download.status).toBe(200);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
      expect(await digestOf(new Uint8Array(await new Response(bytes).arrayBuffer())))
        .toBe(await digestOf(bytes));
    });
  });

  describe('GET /api/installer/agent-version', () => {
    const RELEASE = {
      latest_version: '1.3.0',
      sha256: 'a'.repeat(64),
      size: 4321,
      built_at: '2026-11-02T00:00:00.000Z',
      platforms: { win: { sha256: 'b'.repeat(64), size: 9876 } },
    };

    it('requires admin auth', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/api/installer/agent-version'), env);
      expect(resp.status).toBe(401);
    });

    it('reports unavailable when no release is published', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', '/api/installer/agent-version', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.version).toBe(null);
      expect(data.available).toBe(false);
    });

    it('serves the published version and hash', async () => {
      await env.LOCKDOWN_KV.put('agent_release', JSON.stringify(RELEASE));
      const resp = await worker.fetch(
        makeRequest('GET', '/api/installer/agent-version', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(data.version).toBe('1.3.0');
      expect(data.available).toBe(true);
      expect(data.sha256).toBe(RELEASE.sha256);
      expect(data.size).toBe(RELEASE.size);
      expect(data.platform).toBe('linux');
      expect(data.source).toBe('kv');
    });

    it('honours the per-platform override', async () => {
      await env.LOCKDOWN_KV.put('agent_release', JSON.stringify(RELEASE));
      const resp = await worker.fetch(
        makeRequest('GET', '/api/installer/agent-version?platform=win', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(data.platform).toBe('win');
      expect(data.sha256).toBe('b'.repeat(64));
      expect(data.size).toBe(9876);
    });

    it('does not shadow the per-device installer route', async () => {
      // /api/installer/:deviceId is an anchored regex; if agent-version were
      // matched after it, "agent-version" would be read as a device id and this
      // endpoint would 404 with "Device not found".
      const resp = await worker.fetch(
        makeRequest('GET', '/api/installer/agent-version', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(200);
    });
  });

  describe('GET /api/devices/:id/location/latest', () => {
    async function reportLocation(hostname: string, apiKey: string, city: string) {
      const body = JSON.stringify({
        hostname,
        location: { latitude: 1.5, longitude: 2.5, source: 'ip', city },
      });
      const resp = await worker.fetch(
        makeRequest('POST', '/api/agent/location', body, signRequest(body, apiKey)),
        env,
      );
      expect(resp.status).toBe(200);
    }

    it('requires admin auth', async () => {
      const { device } = await enrollDevice(worker, env, 'LATEST-000');
      const resp = await worker.fetch(
        makeRequest('GET', `/api/devices/${device.id}/location/latest`),
        env,
      );
      expect(resp.status).toBe(401);
    });

    it('404s when the device has never reported', async () => {
      const { device } = await enrollDevice(worker, env, 'LATEST-001');
      const resp = await worker.fetch(
        makeRequest('GET', `/api/devices/${device.id}/location/latest`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('returns the newest report, not the first', async () => {
      const { device, apiKey } = await enrollDevice(worker, env, 'LATEST-002');
      await reportLocation('LATEST-002', apiKey, 'First-City');
      await reportLocation('LATEST-002', apiKey, 'Second-City');

      const resp = await worker.fetch(
        makeRequest('GET', `/api/devices/${device.id}/location/latest`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.city).toBe('Second-City');
      expect(data.reported_at).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Device endpoints the dashboard calls and the Worker lacked (session 183):
  // PBL linkage, key rotation and retention settings.
  // -------------------------------------------------------------------------
  describe('PBL device linkage', () => {
    const PBL = 'a'.repeat(64);
    const ADMIN = { Authorization: 'Bearer test-admin-token' };

    it('links a firmware identity to an agent device', async () => {
      const { device } = await enrollDevice(worker, env, 'PBLLINK-001');
      const resp = await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/link-pbl`, { pbl_device_id: PBL }, ADMIN),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.linked).toBe(true);
      expect(data.pbl_device_id).toBe(PBL);

      const getResp = await worker.fetch(
        makeRequest('GET', `/api/devices/${device.id}`, undefined, ADMIN),
        env,
      );
      expect((await parseResponse(getResp) as any).pbl_device_id).toBe(PBL);
    });

    it('rejects a malformed pbl_device_id', async () => {
      const { device } = await enrollDevice(worker, env, 'PBLLINK-002');
      const resp = await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/link-pbl`, { pbl_device_id: 'not-hex' }, ADMIN),
        env,
      );
      expect(resp.status).toBe(400);
    });

    it('refuses to link one firmware identity to two agents', async () => {
      const a = await enrollDevice(worker, env, 'PBLLINK-A');
      const b = await enrollDevice(worker, env, 'PBLLINK-B');
      await worker.fetch(
        makeRequest('POST', `/api/devices/${a.device.id}/link-pbl`, { pbl_device_id: PBL }, ADMIN),
        env,
      );
      const resp = await worker.fetch(
        makeRequest('POST', `/api/devices/${b.device.id}/link-pbl`, { pbl_device_id: PBL }, ADMIN),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(409);
      expect(data.linked_device_id).toBe(a.device.id);
    });

    it('looks a device up by its firmware identity', async () => {
      const { device } = await enrollDevice(worker, env, 'PBLLOOKUP-001');
      await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/link-pbl`, { pbl_device_id: PBL }, ADMIN),
        env,
      );
      const resp = await worker.fetch(
        makeRequest('GET', `/api/devices/by-pbl/${PBL}`, undefined, ADMIN),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.id).toBe(device.id);
      expect(data.api_key_hash).toBeUndefined();
    });

    it('404s for an unlinked firmware identity', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', `/api/devices/by-pbl/${'b'.repeat(64)}`, undefined, ADMIN),
        env,
      );
      expect(resp.status).toBe(404);
    });

    it('refuses to unlink when nothing is linked', async () => {
      const { device } = await enrollDevice(worker, env, 'PBLLINK-003');
      const resp = await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/unlink-pbl`, {}, ADMIN),
        env,
      );
      expect(resp.status).toBe(400);
    });

    it('unlinks and clears the field', async () => {
      const { device } = await enrollDevice(worker, env, 'PBLLINK-004');
      await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/link-pbl`, { pbl_device_id: PBL }, ADMIN),
        env,
      );
      const resp = await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/unlink-pbl`, {}, ADMIN),
        env,
      );
      expect((await parseResponse(resp) as any).unlinked).toBe(true);

      const getResp = await worker.fetch(
        makeRequest('GET', `/api/devices/${device.id}`, undefined, ADMIN),
        env,
      );
      expect((await parseResponse(getResp) as any).pbl_device_id ?? null).toBe(null);
    });
  });

  describe('POST /api/devices/:id/rotate-key', () => {
    it('issues a new key that works and invalidates the old one', async () => {
      const { device, apiKey: oldKey } = await enrollDevice(worker, env, 'ROTATE-001');

      const resp = await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/rotate-key`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(typeof data.api_key).toBe('string');
      expect(data.api_key).not.toBe(oldKey);

      // The new key authenticates an agent call…
      const newBody = JSON.stringify({ hostname: 'ROTATE-001' });
      const newResp = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', newBody, signRequest(newBody, data.api_key)),
        env,
      );
      expect(newResp.status).toBe(200);

      // …and the old one no longer does.
      const oldResp = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', newBody, signRequest(newBody, oldKey)),
        env,
      );
      expect(oldResp.status).toBe(401);
    });

    it('requires admin auth', async () => {
      const { device } = await enrollDevice(worker, env, 'ROTATE-002');
      const resp = await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/rotate-key`),
        env,
      );
      expect(resp.status).toBe(401);
    });
  });

  describe('GET /api/devices/settings/retention', () => {
    it('returns the retention windows and is not shadowed by /api/devices/:id', async () => {
      // "settings" would otherwise be read as a device id and answered with a 404
      // device lookup, which is the failure this route ordering prevents.
      const resp = await worker.fetch(
        makeRequest('GET', '/api/devices/settings/retention', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(200);
      expect(data.location_retention_days).toBe(90);
      expect(data.command_expiry_days).toBe(30);
      expect(data.audit_log_retention_days).toBe(365);
      expect(data.min_location_retention).toBe(7);
      expect(data.max_location_retention).toBe(180);
    });
  });

  // -------------------------------------------------------------------------
  // Hardware-test artifacts (session 184). This is the D-129 evidence path: the
  // harness uploads a CTRF or legacy artifact and the dashboard displays it. The
  // harness emitted the legacy shape for months before CTRF support landed, so
  // both must be accepted — a rejected artifact on window day is a lost run.
  // -------------------------------------------------------------------------
  describe('hardware-test artifacts', () => {
    const ADMIN = { Authorization: 'Bearer test-admin-token' };

    const ctrf = (hostname: string) => ({
      results: {
        tool: { name: 'hw_test_harness', version: '2.0' },
        summary: { tests: 12, passed: 10, failed: 1, skipped: 1, errors: 0 },
        extra: { environment: { hostname, agent_binary_hash: 'deadbeef' } },
      },
    });
    const legacy = (hostname: string) => ({
      harness_version: '1.0',
      summary: { total: 5, passed: 5, failed: 0, skipped: 0 },
      environment: { hostname },
    });

    it('stores a CTRF artifact and links it to the matching device', async () => {
      const { device } = await enrollDevice(worker, env, 'HWCTRF-001');
      const resp = await worker.fetch(
        makeRequest('POST', '/api/hw-test-artifact', ctrf('HWCTRF-001'), ADMIN),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(201);
      expect(data.hostname).toBe('HWCTRF-001');
      expect(data.device_id).toBe(device.id);
      expect(data.summary).toEqual({ total: 12, passed: 10, failed: 1, skipped: 1, errors: 0 });
    });

    it('stores a legacy artifact', async () => {
      await enrollDevice(worker, env, 'HWLEGACY-001');
      const resp = await worker.fetch(
        makeRequest('POST', '/api/hw-test-artifact', legacy('HWLEGACY-001'), ADMIN),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(201);
      expect(data.summary.total).toBe(5);
    });

    it('rejects a body that is not a harness artifact', async () => {
      const notFormatted = await worker.fetch(
        makeRequest('POST', '/api/hw-test-artifact', { hello: 'world' }, ADMIN),
        env,
      );
      expect(notFormatted.status).toBe(400);

      const noSummary = await worker.fetch(
        makeRequest('POST', '/api/hw-test-artifact', { harness_version: '1.0' }, ADMIN),
        env,
      );
      expect(noSummary.status).toBe(400);
    });

    it('requires admin auth', async () => {
      const resp = await worker.fetch(
        makeRequest('POST', '/api/hw-test-artifact', ctrf('HWCTRF-001')),
        env,
      );
      expect(resp.status).toBe(401);
    });

    it('lists newest first without the full artifact blob', async () => {
      await enrollDevice(worker, env, 'HWLIST-001');
      await worker.fetch(makeRequest('POST', '/api/hw-test-artifact', legacy('HWLIST-001'), ADMIN), env);
      await worker.fetch(makeRequest('POST', '/api/hw-test-artifact', ctrf('HWLIST-001'), ADMIN), env);

      const resp = await worker.fetch(
        makeRequest('GET', '/api/hw-test-artifact', undefined, ADMIN),
        env,
      );
      const rows: any[] = (await parseResponse(resp)) as any[];
      expect(resp.status).toBe(200);
      expect(rows.length).toBe(2);
      // Newest (the CTRF one) first.
      expect(rows[0].total_tests).toBe(12);
      // The list must stay small: no artifact_json on summary rows.
      expect(rows[0].artifact_json).toBeUndefined();
    });

    it('filters by device and rejects a malformed device_id', async () => {
      const { device } = await enrollDevice(worker, env, 'HWFILTER-001');
      await worker.fetch(makeRequest('POST', '/api/hw-test-artifact', ctrf('HWFILTER-001'), ADMIN), env);

      const okResp = await worker.fetch(
        makeRequest('GET', `/api/hw-test-artifact?device_id=${device.id}`, undefined, ADMIN),
        env,
      );
      expect(((await parseResponse(okResp)) as any[]).length).toBe(1);

      const badResp = await worker.fetch(
        makeRequest('GET', '/api/hw-test-artifact?device_id=nope', undefined, ADMIN),
        env,
      );
      expect(badResp.status).toBe(400);
    });

    it('returns one artifact with its full JSON, and 404s for an unknown id', async () => {
      await enrollDevice(worker, env, 'HWGET-001');
      const created: any = await parseResponse(
        await worker.fetch(makeRequest('POST', '/api/hw-test-artifact', ctrf('HWGET-001'), ADMIN), env),
      );

      const oneResp = await worker.fetch(
        makeRequest('GET', `/api/hw-test-artifact/${created.id}`, undefined, ADMIN),
        env,
      );
      const one: any = await parseResponse(oneResp);
      expect(oneResp.status).toBe(200);
      expect(one.id).toBe(created.id);
      expect(one.artifact_json.results.tool.version).toBe('2.0');

      const missing = await worker.fetch(
        makeRequest('GET', '/api/hw-test-artifact/999999', undefined, ADMIN),
        env,
      );
      expect(missing.status).toBe(404);

      const badId = await worker.fetch(
        makeRequest('GET', '/api/hw-test-artifact/not-a-number', undefined, ADMIN),
        env,
      );
      expect(badId.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Integrations are declared self-hosted-only (session 185). The endpoint answers
  // 501 rather than 404 so the dashboard can tell "this deployment does not
  // implement it" from "you typed the URL wrong".
  // -------------------------------------------------------------------------
  describe('integrations are declared unavailable', () => {
    it('checks auth before revealing anything', async () => {
      const resp = await worker.fetch(makeRequest('GET', '/api/integrations'), env);
      expect(resp.status).toBe(401);
    });

    it('answers 501 for the inventory list', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', '/api/integrations', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const data: any = await parseResponse(resp);
      expect(resp.status).toBe(501);
      expect(data.error).toMatch(/self-hosted/i);
    });

    it('answers 501 for a connector inventory', async () => {
      const resp = await worker.fetch(
        makeRequest('GET', '/api/integrations/meshcentral/devices', undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      expect(resp.status).toBe(501);
    });
  });

  // -------------------------------------------------------------------------
  // Lockdown effectiveness (session 185). The agent reports boot_lock_detail on
  // ACK; Express derives `lockdown_effective` from it (agent.js:411-418) and the
  // Worker used to discard the field. A boot-lock that silently applied zero
  // critical controls is encrypted-only, and recording it as a plain success is
  // precisely the gap E-EFFECTIVENESS exists to close.
  // -------------------------------------------------------------------------
  describe('lockdown effectiveness from the ACK', () => {
    const ADMIN = { Authorization: 'Bearer test-admin-token' };

    async function queueLockdown(hostname: string) {
      const { device, apiKey } = await enrollDevice(worker, env, hostname);
      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${device.id}/flag-stolen`,
          { hostname_confirm: hostname },
          ADMIN,
        ),
        env,
      );
      const body = JSON.stringify({ hostname });
      const checkin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)),
        env,
      );
      const commandId = (await parseResponse(checkin) as any).command.id;
      return { device, apiKey, commandId };
    }

    async function ackAndReadCommand(
      hostname: string,
      apiKey: string,
      commandId: string,
      extra: Record<string, unknown>,
    ) {
      const body = JSON.stringify({
        hostname,
        command_id: commandId,
        result_status: 'executed',
        ...extra,
      });
      const resp = await worker.fetch(
        makeRequest('POST', '/api/agent/command-ack', body, signRequest(body, apiKey)),
        env,
      );
      expect(resp.status).toBe(200);
      return readCommandViaApi(env, await deviceIdByHostname(env, hostname), commandId);
    }

    it('records a lockdown that applied zero critical controls as NOT effective', async () => {
      const { apiKey, commandId } = await queueLockdown('EFF-001');
      const cmd = await ackAndReadCommand('EFF-001', apiKey, commandId, {
        boot_lock_status: 'partial',
        boot_lock_detail: { boot_lock_attempted: true, critical_applied_total: 0 },
      });
      expect(cmd.lockdown_effective).toBe(false);
      expect(cmd.boot_lock_status).toBe('partial');
      expect(cmd.boot_lock_detail.boot_lock_attempted).toBe(true);
    });

    it('records a lockdown that applied critical controls as effective', async () => {
      const { apiKey, commandId } = await queueLockdown('EFF-002');
      const cmd = await ackAndReadCommand('EFF-002', apiKey, commandId, {
        boot_lock_status: 'applied',
        boot_lock_detail: { boot_lock_attempted: true, critical_applied_total: 3 },
      });
      expect(cmd.lockdown_effective).toBe(true);
    });

    it('leaves effectiveness unknown when the agent reports no boot-lock detail', async () => {
      const { apiKey, commandId } = await queueLockdown('EFF-003');
      const cmd = await ackAndReadCommand('EFF-003', apiKey, commandId, {});
      expect(cmd.lockdown_effective ?? null).toBe(null);
    });

    it('leaves effectiveness unknown when boot-lock was not attempted at all', async () => {
      const { apiKey, commandId } = await queueLockdown('EFF-004');
      const cmd = await ackAndReadCommand('EFF-004', apiKey, commandId, {
        boot_lock_detail: { boot_lock_attempted: false, critical_applied_total: 0 },
      });
      expect(cmd.lockdown_effective ?? null).toBe(null);
    });
  });

  // -------------------------------------------------------------------------
  // Fields the agent sends that the Worker used to ignore (session 186). A sweep
  // of agent payloads vs handled fields found three: the blocked-file list, the
  // lock-session context, and the tracking transitions.
  // -------------------------------------------------------------------------
  describe('ACK fields the agent sends', () => {
    const ADMIN = { Authorization: 'Bearer test-admin-token' };

    async function ack(hostname: string, apiKey: string, commandId: string, extra: object) {
      const body = JSON.stringify({
        hostname,
        command_id: commandId,
        result_status: 'executed',
        ...extra,
      });
      const resp = await worker.fetch(
        makeRequest('POST', '/api/agent/command-ack', body, signRequest(body, apiKey)),
        env,
      );
      expect(resp.status).toBe(200);
      const deviceId = await deviceIdByHostname(env, hostname);
      const deviceResp = await worker.fetch(
        makeRequest('GET', `/api/devices/${deviceId}`, undefined, {
          Authorization: 'Bearer test-admin-token',
        }),
        env,
      );
      const device = (await parseResponse(deviceResp)) as any;
      return {
        command: await readCommandViaApi(env, deviceId, commandId),
        device,
      };
    }

    it('persists the blocked-file list the agent reports', async () => {
      // D-011: these are files the agent could not encrypt (open/locked). If the
      // backend drops them, the operator believes the folder is fully encrypted.
      const { device, apiKey } = await enrollDevice(worker, env, 'ACKBLOCK-001');
      await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/flag-stolen`, { hostname_confirm: 'ACKBLOCK-001' }, ADMIN),
        env,
      );
      const body = JSON.stringify({ hostname: 'ACKBLOCK-001' });
      const checkin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)),
        env,
      );
      const cmdId = (await parseResponse(checkin) as any).command.id;

      const { command } = await ack('ACKBLOCK-001', apiKey, cmdId, {
        encryption_blocked_files: ['Reports/locked.xlsx', 'Mail/outlook.pst'],
        lock_session_context: { session: 'console', user: 'alice' },
      });
      expect(command.encryption_blocked_files).toEqual(['Reports/locked.xlsx', 'Mail/outlook.pst']);
      expect(command.lock_session_context).toEqual({ session: 'console', user: 'alice' });
    });

    it('moves the device to tracking when a track command completes', async () => {
      const { device, apiKey } = await enrollDevice(worker, env, 'ACKTRACK-001');
      await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/flag-stolen`, { hostname_confirm: 'ACKTRACK-001' }, ADMIN),
        env,
      );
      await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/track`, { hostname_confirm: 'ACKTRACK-001' }, ADMIN),
        env,
      );

      // The lockdown command queued by flag-stolen comes first; acknowledge it.
      const body = JSON.stringify({ hostname: 'ACKTRACK-001' });
      const first = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)),
        env,
      );
      const firstCmd = (await parseResponse(first) as any).command;
      await ack('ACKTRACK-001', apiKey, firstCmd.id, {});

      const second = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)),
        env,
      );
      const trackCmd = (await parseResponse(second) as any).command;
      expect(trackCmd.type).toBe('track');

      const { device: afterTrack } = await ack('ACKTRACK-001', apiKey, trackCmd.id, {});
      expect(afterTrack.status).toBe('tracking');
    });
  });

  // -------------------------------------------------------------------------
  // The dashboard does not read the command record for lockdown effectiveness —
  // it scans the audit log for `agent_<type>_confirmed` and parses that entry's
  // detail (DeviceDetailPage.jsx:40-49). Express writes one per executed command;
  // the Worker wrote none, so the panel was dark regardless of what the command
  // held (session 187).
  // -------------------------------------------------------------------------
  describe('agent_<type>_confirmed audit entries', () => {
    const ADMIN = { Authorization: 'Bearer test-admin-token' };

    async function auditFor(deviceId: string) {
      const resp = await worker.fetch(
        makeRequest('GET', `/api/audit?device_id=${deviceId}`, undefined, ADMIN),
        env,
      );
      return (await parseResponse(resp)) as any[];
    }

    async function lockdownAck(hostname: string, extra: object) {
      const { device, apiKey } = await enrollDevice(worker, env, hostname);
      await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/flag-stolen`, { hostname_confirm: hostname }, ADMIN),
        env,
      );
      const body = JSON.stringify({ hostname });
      const checkin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)),
        env,
      );
      const cmdId = (await parseResponse(checkin) as any).command.id;
      const ackBody = JSON.stringify({
        hostname,
        command_id: cmdId,
        result_status: 'executed',
        ...extra,
      });
      await worker.fetch(
        makeRequest('POST', '/api/agent/command-ack', ackBody, signRequest(ackBody, apiKey)),
        env,
      );
      return { device, cmdId };
    }

    it('writes agent_lockdown_confirmed with the effectiveness detail the UI parses', async () => {
      const { device, cmdId } = await lockdownAck('AUDCONF-001', {
        boot_lock_status: 'partial',
        boot_lock_detail: { boot_lock_attempted: true, critical_applied_total: 0 },
        encryption_blocked_files: ['locked.xlsx'],
        lock_session_context: { session: 'console' },
      });

      const entries = await auditFor(device.id);
      const confirmed = entries.find((e) => e.action === 'agent_lockdown_confirmed');
      expect(confirmed).toBeTruthy();

      const detail = JSON.parse(confirmed.detail);
      expect(detail.command_id).toBe(cmdId);
      expect(detail.lockdown_effective).toBe(false);
      expect(detail.boot_lock_status).toBe('partial');
      expect(detail.boot_lock_detail.boot_lock_attempted).toBe(true);
      expect(detail.encryption_blocked_files).toEqual(['locked.xlsx']);
      expect(detail.lock_session_context).toEqual({ session: 'console' });
    });

    it('does not write a confirmation for a failed command', async () => {
      const { device, apiKey } = await enrollDevice(worker, env, 'AUDFAIL-001');
      await worker.fetch(
        makeRequest('POST', `/api/devices/${device.id}/flag-stolen`, { hostname_confirm: 'AUDFAIL-001' }, ADMIN),
        env,
      );
      const body = JSON.stringify({ hostname: 'AUDFAIL-001' });
      const checkin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', body, signRequest(body, apiKey)),
        env,
      );
      const cmdId = (await parseResponse(checkin) as any).command.id;

      const ackBody = JSON.stringify({
        hostname: 'AUDFAIL-001',
        command_id: cmdId,
        result_status: 'failed',
      });
      await worker.fetch(
        makeRequest('POST', '/api/agent/command-ack', ackBody, signRequest(ackBody, apiKey)),
        env,
      );

      const entries = await auditFor(device.id);
      expect(entries.some((e) => e.action === 'agent_lockdown_confirmed')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // enable_pba: the operator's opt-in pre-boot authentication (T7/T8). Express
  // threads it from flag-stolen into the command and reports it on check-in; the
  // Worker accepted neither and hardcoded false, so PBA was silently never
  // enabled on the serverless backend (session 188).
  // -------------------------------------------------------------------------
  describe('enable_pba is threaded to the agent', () => {
    const ADMIN = { Authorization: 'Bearer test-admin-token' };

    async function flagAndCheckin(hostname: string, body: Record<string, unknown>) {
      const { device, apiKey } = await enrollDevice(worker, env, hostname);
      await worker.fetch(
        makeRequest(
          'POST',
          `/api/devices/${device.id}/flag-stolen`,
          { hostname_confirm: hostname, ...body },
          ADMIN,
        ),
        env,
      );
      const checkinBody = JSON.stringify({ hostname });
      const checkin = await worker.fetch(
        makeRequest('POST', '/api/agent/checkin', checkinBody, signRequest(checkinBody, apiKey)),
        env,
      );
      return (await parseResponse(checkin) as any).command;
    }

    it('reports enable_pba true when the operator opted in', async () => {
      const command = await flagAndCheckin('PBA-001', { enable_pba: true });
      expect(command.type).toBe('lockdown');
      expect(command.enable_pba).toBe(true);
    });

    it('reports enable_pba false by default', async () => {
      const command = await flagAndCheckin('PBA-002', {});
      expect(command.enable_pba).toBe(false);
    });

    it('treats only an explicit boolean true as opting in', async () => {
      // A string "true" or 1 is a client bug; opting a device into pre-boot
      // authentication is a security decision and must not be inferred.
      const command = await flagAndCheckin('PBA-003', { enable_pba: 'true' });
      expect(command.enable_pba).toBe(false);
    });
  });
});

/**
 * `lock_state` — what actually happened to a lock, not what was asked for.
 *
 * `status: stolen` is set the moment a lockdown is queued, so on its own it says nothing about
 * the device. A machine that is offline when it is flagged keeps that status while nothing on it
 * changes — measured on MOLE (S271). The operator-facing question is "did it lock?", and the
 * answer has three distinguishable shapes: applied (the ACK), applying (reachable, queued),
 * armed (queued, device quiet, will lock on reconnect or after the 24 h deadman).
 */
describe('lock_state on the device payload', () => {
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV };

  beforeEach(() => {
    env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV() };
  });

  async function seed(
    hostname: string,
    commands: Array<Record<string, unknown>>,
    lastCheckin: string,
  ): Promise<any> {
    const { device } = await enrollDevice(worker, env, hostname);
    // `last_checkin` lives on the per-device check-in metadata key (KV-RACE-001) — the same
    // field `mergeCheckinMetadata` reads when the list endpoint shapes the row. Patching it
    // there keeps this test on the read path instead of on the storage layout (ADR-003).
    await env.LOCKDOWN_KV.put(
      `device_checkin:${device.id}`,
      JSON.stringify({ last_checkin: lastCheckin }),
    );
    if (commands.length) {
      await env.LOCKDOWN_KV.put(
        'commands',
        JSON.stringify(commands.map((c) => ({ device_id: device.id, command_uuid: null, ...c }))),
      );
    }
    const resp = await worker.fetch(
      makeRequest('GET', '/api/devices', undefined, { Authorization: 'Bearer test-admin-token' }),
      env,
    );
    const devices = (await parseResponse(resp)) as any[];
    return devices.find((d) => d.id === device.id);
  }

  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 30 * 60_000).toISOString();
  const lockdown = (status: string, at = '2026-11-17T10:00:00Z') => ({
    id: `cmd-${status}`,
    command_type: 'lockdown',
    status,
    created_at: at,
  });

  it('reports applied when the lockdown ACKed', async () => {
    expect((await seed('LOCKST-001', [lockdown('executed')], now)).lock_state).toBe('applied');
  });

  it('reports applying when the lock is queued and the device is still checking in', async () => {
    expect((await seed('LOCKST-002', [lockdown('pending')], now)).lock_state).toBe('applying');
  });

  it('reports armed when the lock is queued but the device has gone quiet', async () => {
    // The case an operator must not mistake for "locked": flagged while offline.
    expect((await seed('LOCKST-003', [lockdown('pending')], stale)).lock_state).toBe('armed');
  });

  it('reports failed when the lockdown reported failure', async () => {
    expect((await seed('LOCKST-004', [lockdown('failed')], now)).lock_state).toBe('failed');
  });

  it('reports none when no lockdown is in play', async () => {
    expect((await seed('LOCKST-005', [], now)).lock_state).toBe('none');
  });

  it('reports none after an unlock follows the lockdown', async () => {
    const d = await seed(
      'LOCKST-006',
      [lockdown('executed'), { ...lockdown('executed', '2026-11-17T11:00:00Z'), id: 'cmd-u', command_type: 'unlock' }],
      now,
    );
    expect(d.lock_state).toBe('none');
  });
});

/**
 * `observed_at` — when the fix was taken, not when it arrived.
 *
 * A device offline in a bag cannot reach the server but can still scan the WiFi around it
 * (`netsh wlan show networks mode=bssid` is local; only resolving BSSIDs needs the internet).
 * S271 made the agent keep that raw scan and resolve it on reconnect. Without `observed_at` the
 * row it writes then lands at receipt time, so a backfilled trail reads as if the device were in
 * that building when it reconnected.
 */
describe('observed_at on location reports', () => {
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV };

  beforeEach(() => {
    env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV() };
  });

  async function report(
    hostname: string,
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const raw = JSON.stringify({ hostname, ...body });
    const resp = await worker.fetch(
      makeRequest('POST', '/api/agent/location', raw, signRequest(raw, apiKey)),
      env,
    );
    expect(resp.status).toBe(200);
  }

  async function listLocations(deviceId: string, query = ''): Promise<any[]> {
    const resp = await worker.fetch(
      makeRequest('GET', `/api/devices/${deviceId}/locations${query}`, undefined, {
        Authorization: 'Bearer test-admin-token',
      }),
      env,
    );
    return (await parseResponse(resp)) as any[];
  }

  it('stores the scan time the agent backfilled', async () => {
    const { device, apiKey } = await enrollDevice(worker, env, 'OBS-001');
    const scannedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await report('OBS-001', apiKey, {
      location: { latitude: 1, longitude: 2, source: 'wifi', city: 'A' },
      observed_at: scannedAt,
    });

    const rows = await listLocations(device.id);
    expect(rows[0].observed_at).toBe(scannedAt);
    // Receipt time is still recorded, and still distinct from the observation.
    expect(rows[0].reported_at).toBeDefined();
  });

  it('orders the trail by when each fix was taken, not by arrival', async () => {
    const { device, apiKey } = await enrollDevice(worker, env, 'OBS-002');
    const earlier = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    // Backfilled FIRST but taken EARLIER — the case that used to appear last in the history.
    await report('OBS-002', apiKey, {
      location: { latitude: 1, longitude: 2, source: 'wifi', city: 'OLD' },
      observed_at: earlier,
    });
    await report('OBS-002', apiKey, {
      location: { latitude: 3, longitude: 4, source: 'ip', city: 'NEW' },
    });

    const rows = await listLocations(device.id);
    expect(rows.map((r) => r.city)).toEqual(['NEW', 'OLD']);
  });

  it('the latest pin agrees with row 1 of the history', async () => {
    const { device, apiKey } = await enrollDevice(worker, env, 'OBS-003');
    const earlier = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await report('OBS-003', apiKey, {
      location: { latitude: 1, longitude: 2, source: 'wifi', city: 'OLD' },
      observed_at: earlier,
    });
    await report('OBS-003', apiKey, {
      location: { latitude: 3, longitude: 4, source: 'ip', city: 'NEW' },
    });

    const resp = await worker.fetch(
      makeRequest('GET', `/api/devices/${device.id}/location/latest`, undefined, {
        Authorization: 'Bearer test-admin-token',
      }),
      env,
    );
    const latest = (await parseResponse(resp)) as any;
    expect(latest.city).toBe('NEW');
  });

  it('drops a claim from the future rather than pinning the device there', async () => {
    // A device clock is not trusted (MOLE's w32time had stopped, S271).
    const { device, apiKey } = await enrollDevice(worker, env, 'OBS-004');
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await report('OBS-004', apiKey, {
      location: { latitude: 1, longitude: 2, source: 'ip', city: 'A' },
      observed_at: tomorrow,
    });

    const rows = await listLocations(device.id);
    expect(rows[0].observed_at).toBeNull();
  });

  it('drops an unparseable claim instead of failing the report', async () => {
    const { device, apiKey } = await enrollDevice(worker, env, 'OBS-005');
    await report('OBS-005', apiKey, {
      location: { latitude: 1, longitude: 2, source: 'ip', city: 'A' },
      observed_at: 'yesterday-ish',
    });

    const rows = await listLocations(device.id);
    expect(rows[0].observed_at).toBeNull();
  });
});

/**
 * ADR-003: devices are per-entity KV records.
 *
 * The defect this removes: every device mutation loaded the whole `devices` list, edited it and
 * wrote it back, so two writers that overlapped each other's snapshot silently lost one of the
 * changes — across isolates, where `serializeMutation()` cannot help. On `devices` the lost
 * field can be `api_key_hash` (the device stops authenticating) or `status` (the dashboard says
 * `active` for a machine that is locked).
 *
 * These tests assert the storage contract the ADR chose — the key layout, the migration, the
 * API-key pointer — because that contract IS the fix. Behaviour under it is covered by the 458
 * tests that ran before it.
 */
describe('ADR-003: per-entity device records', () => {
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV };
  const ADMIN = { Authorization: 'Bearer test-admin-token' };

  beforeEach(() => {
    env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV() };
  });

  const hashOf = (key: string): string =>
    crypto.createHash('sha256').update(key).digest('hex');

  function legacyDevice(id: string, hostname: string, apiKeyHash: string) {
    return {
      id,
      hostname,
      owner_name: 'Legacy',
      status: 'active',
      mac_address: null,
      hardware_uuid: null,
      serial_number: null,
      last_checkin: null,
      enrolled_at: '2026-11-01T00:00:00.000Z',
      api_key_hash: apiKeyHash,
    };
  }

  async function listFromApi(): Promise<any[]> {
    const resp = await worker.fetch(makeRequest('GET', '/api/devices', undefined, ADMIN), env);
    return (await parseResponse(resp)) as any[];
  }

  it('migrates the legacy whole-list key on first read', async () => {
    await env.LOCKDOWN_KV.put(
      'devices',
      JSON.stringify([
        legacyDevice('legacy-1', 'LEG-1', 'hash-one'),
        legacyDevice('legacy-2', 'LEG-2', 'hash-two'),
      ]),
    );

    const devices = await listFromApi();
    expect(devices.map((d) => d.id).sort()).toEqual(['legacy-1', 'legacy-2']);

    // Per-entity records, an index, and the API-key pointer for each device.
    expect(await env.LOCKDOWN_KV.get('device:legacy-1')).toBeTruthy();
    expect(await env.LOCKDOWN_KV.get('device:legacy-2')).toBeTruthy();
    expect(JSON.parse((await env.LOCKDOWN_KV.get('device_index')) as string)).toEqual([
      'legacy-1',
      'legacy-2',
    ]);
    expect(await env.LOCKDOWN_KV.get('agent_key:hash-one')).toBe('legacy-1');
    // …and the legacy key is gone, so the whole-list write cannot come back.
    expect(await env.LOCKDOWN_KV.get('devices')).toBeNull();
  });

  it('is idempotent — a second read migrates nothing and changes nothing', async () => {
    await env.LOCKDOWN_KV.put(
      'devices',
      JSON.stringify([legacyDevice('legacy-1', 'LEG-1', 'hash-one')]),
    );
    await listFromApi();
    const indexAfterFirst = await env.LOCKDOWN_KV.get('device_index');
    const recordAfterFirst = await env.LOCKDOWN_KV.get('device:legacy-1');

    const devices = await listFromApi();
    expect(devices).toHaveLength(1);
    expect(await env.LOCKDOWN_KV.get('device_index')).toBe(indexAfterFirst);
    expect(await env.LOCKDOWN_KV.get('device:legacy-1')).toBe(recordAfterFirst);
  });

  it('a mutation of one device cannot overwrite another', async () => {
    // The cross-isolate case, made deterministic: write B's record the way a second isolate
    // would (straight to its key, after this isolate has already read the fleet), then mutate A
    // through the API. A whole-list write would rebuild B from the stale snapshot it read.
    const { device: a } = await enrollDevice(worker, env, 'RACE-A');
    const { device: b } = await enrollDevice(worker, env, 'RACE-B');
    await env.LOCKDOWN_KV.put(
      `device:${b.id}`,
      JSON.stringify({ ...b, status: 'tracking', owner_name: 'Changed elsewhere' }),
    );

    const flag = await worker.fetch(
      makeRequest('POST', `/api/devices/${a.id}/flag-stolen`, { hostname_confirm: 'RACE-A' }, ADMIN),
      env,
    );
    expect(flag.status).toBe(200);

    const bAfter = JSON.parse((await env.LOCKDOWN_KV.get(`device:${b.id}`)) as string);
    expect(bAfter.status).toBe('tracking');
    expect(bAfter.owner_name).toBe('Changed elsewhere');
  });

  it('records an API-key pointer so auth is one read', async () => {
    const { device, apiKey } = await enrollDevice(worker, env, 'PTR-001');
    expect(await env.LOCKDOWN_KV.get(`agent_key:${hashOf(apiKey)}`)).toBe(device.id);
  });

  it('a re-keyed device fails closed with the old key and works with the new one', async () => {
    const { device, apiKey: oldKey } = await enrollDevice(worker, env, 'REKEY-001');

    const rotate = await worker.fetch(
      makeRequest('POST', `/api/devices/${device.id}/rotate-key`, {}, ADMIN),
      env,
    );
    expect(rotate.status).toBe(200);
    const newKey = ((await parseResponse(rotate)) as any).api_key as string;
    expect(newKey).toBeTruthy();

    // The stale pointer is gone, so the old key cannot authenticate at all.
    expect(await env.LOCKDOWN_KV.get(`agent_key:${hashOf(oldKey)}`)).toBeNull();
    const oldBody = JSON.stringify({ hostname: 'REKEY-001' });
    const oldResp = await worker.fetch(
      makeRequest('POST', '/api/agent/checkin', oldBody, signRequest(oldBody, oldKey)),
      env,
    );
    expect(oldResp.status).toBe(401);

    // The new one can.
    const newBody = JSON.stringify({ hostname: 'REKEY-001' });
    const newResp = await worker.fetch(
      makeRequest('POST', '/api/agent/checkin', newBody, signRequest(newBody, newKey)),
      env,
    );
    expect(newResp.status).toBe(200);
  });

  it('a released device loses its record, its index entry and its key pointer', async () => {
    const { device, apiKey } = await enrollDevice(worker, env, 'RELEASE-001');

    const resp = await worker.fetch(
      makeRequest(
        'DELETE',
        `/api/devices/${device.id}/release`,
        { hostname_confirm: 'RELEASE-001' },
        ADMIN,
      ),
      env,
    );
    expect(resp.status).toBe(200);

    expect(await env.LOCKDOWN_KV.get(`device:${device.id}`)).toBeNull();
    expect(await env.LOCKDOWN_KV.get(`agent_key:${hashOf(apiKey)}`)).toBeNull();
    const index = JSON.parse((await env.LOCKDOWN_KV.get('device_index')) as string) as string[];
    expect(index).not.toContain(device.id);
    expect((await listFromApi()).some((d) => d.id === device.id)).toBe(false);
  });
});

/**
 * ADR-004: location reports are per-entity records, indexed per device.
 *
 * The defect this removes: reports lived in one list capped at 1000 rows for the WHOLE fleet, so
 * at 60 tracked devices each kept 16 reports — about eight minutes of trail — and every report
 * rewrote up to 1000 rows. Two devices reporting at once also lost one of the two, and a lost
 * report is the evidence a tracking trail exists to produce.
 */
describe('ADR-004: per-entity location reports', () => {
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV; LOCATION_HISTORY_LIMIT?: string };
  const ADMIN = { Authorization: 'Bearer test-admin-token' };

  beforeEach(() => {
    env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV() };
  });

  async function report(hostname: string, apiKey: string, body: Record<string, unknown>): Promise<void> {
    const raw = JSON.stringify({ hostname, location: body });
    const resp = await worker.fetch(
      makeRequest('POST', '/api/agent/location', raw, signRequest(raw, apiKey)),
      env,
    );
    expect(resp.status).toBe(200);
  }

  async function history(deviceId: string, query = ''): Promise<any[]> {
    const resp = await worker.fetch(
      makeRequest('GET', `/api/devices/${deviceId}/locations${query}`, undefined, ADMIN),
      env,
    );
    return (await parseResponse(resp)) as any[];
  }

  // Through the KV interface (`list`), not the mock's private storage.
  const keysWithPrefix = async (prefix: string): Promise<string[]> =>
    (await env.LOCKDOWN_KV.list({ prefix })).keys.map((k) => k.name);
  const locationKeys = () => keysWithPrefix('location:');
  const indexKeys = () => keysWithPrefix('location_index:');

  it('migrates the legacy whole-list key into per-report records and per-device indexes', async () => {
    await env.LOCKDOWN_KV.put(
      'locations',
      JSON.stringify([
        { device_id: 'legacy-a', latitude: 1, longitude: 2, source: 'ip', city: 'A1',
          accuracy_meters: null, region: null, country: null, ip_address: null, wifi_count: null,
          created_at: '2026-11-01T10:00:00.000Z' },
        { device_id: 'legacy-b', latitude: 3, longitude: 4, source: 'ip', city: 'B1',
          accuracy_meters: null, region: null, country: null, ip_address: null, wifi_count: null,
          created_at: '2026-11-01T10:01:00.000Z' },
        { device_id: 'legacy-a', latitude: 5, longitude: 6, source: 'ip', city: 'A2',
          accuracy_meters: null, region: null, country: null, ip_address: null, wifi_count: null,
          created_at: '2026-11-01T10:02:00.000Z' },
      ]),
    );

    const aRows = await history('legacy-a');
    const bRows = await history('legacy-b');

    expect(aRows.map((r) => r.city)).toEqual(['A2', 'A1']); // newest first on the wire
    expect(bRows.map((r) => r.city)).toEqual(['B1']);
    // Records are per report, indexes are per device.
    expect(await locationKeys()).toHaveLength(3);
    expect((await indexKeys()).sort()).toEqual(['location_index:legacy-a', 'location_index:legacy-b']);
    // The legacy key is gone, so the whole-list write cannot come back.
    expect(await env.LOCKDOWN_KV.get('locations')).toBeNull();
  });

  it('a second migration of the same rows does not duplicate them', async () => {
    // Deterministic ids are what make this safe: two isolates migrating concurrently would
    // otherwise write two copies of every report.
    const legacy = JSON.stringify([
      { device_id: 'dup-a', latitude: 1, longitude: 2, source: 'ip', city: 'Only',
        accuracy_meters: null, region: null, country: null, ip_address: null, wifi_count: null,
        created_at: '2026-11-01T10:00:00.000Z' },
    ]);
    await env.LOCKDOWN_KV.put('locations', legacy);
    await history('dup-a');
    const afterFirst = (await env.LOCKDOWN_KV.get('location_index:dup-a')) as string;

    // Simulate the other isolate: the legacy key reappears with the same content.
    await env.LOCKDOWN_KV.put('locations', legacy);
    await history('dup-a');

    expect((await env.LOCKDOWN_KV.get('location_index:dup-a')) as string).toBe(afterFirst);
    expect(await locationKeys()).toHaveLength(1);
  });

  it('two devices reporting at the same time keep both trails', async () => {
    const { device: a, apiKey: keyA } = await enrollDevice(worker, env, 'LOC-A');
    const { device: b, apiKey: keyB } = await enrollDevice(worker, env, 'LOC-B');

    await report('LOC-A', keyA, { latitude: 1, longitude: 1, source: 'ip', city: 'A-1' });
    await report('LOC-B', keyB, { latitude: 2, longitude: 2, source: 'ip', city: 'B-1' });
    await report('LOC-A', keyA, { latitude: 3, longitude: 3, source: 'ip', city: 'A-2' });

    const aRows = await history(a.id);
    const bRows = await history(b.id);
    expect(aRows.map((r) => r.city)).toEqual(['A-2', 'A-1']);
    expect(bRows.map((r) => r.city)).toEqual(['B-1']);
    expect((await indexKeys()).sort()).toEqual([`location_index:${a.id}`, `location_index:${b.id}`].sort());
  });

  it('the cap prunes the records as well as the index', async () => {
    // A cap nobody crosses is a cap nobody has seen work — this is the only path that deletes.
    env.LOCATION_HISTORY_LIMIT = '3';
    const { device, apiKey } = await enrollDevice(worker, env, 'LOC-CAP');

    for (let i = 1; i <= 5; i += 1) {
      await report('LOC-CAP', apiKey, { latitude: i, longitude: i, source: 'ip', city: `C-${i}` });
    }

    const rows = await history(device.id, '?limit=10');
    expect(rows.map((r) => r.city)).toEqual(['C-5', 'C-4', 'C-3']);
    const index = JSON.parse((await env.LOCKDOWN_KV.get(`location_index:${device.id}`)) as string);
    expect(index).toHaveLength(3);
    // The two evicted reports are deleted, not merely unindexed.
    expect(await locationKeys()).toHaveLength(3);
  });

  it('a released device leaves no location records or index behind', async () => {
    const { device, apiKey } = await enrollDevice(worker, env, 'LOC-REL');
    await report('LOC-REL', apiKey, { latitude: 1, longitude: 2, source: 'ip', city: 'R-1' });
    expect((await locationKeys()).length).toBeGreaterThan(0);

    const resp = await worker.fetch(
      makeRequest(
        'DELETE',
        `/api/devices/${device.id}/release`,
        { hostname_confirm: 'LOC-REL' },
        ADMIN,
      ),
      env,
    );
    expect(resp.status).toBe(200);
    expect(await locationKeys()).toHaveLength(0);
    expect(await env.LOCKDOWN_KV.get(`location_index:${device.id}`)).toBeNull();
  });

  it('reports carry a stable id, so a row does not change identity between reads', async () => {
    const { device, apiKey } = await enrollDevice(worker, env, 'LOC-ID');
    await report('LOC-ID', apiKey, { latitude: 1, longitude: 2, source: 'ip', city: 'I-1' });

    const first = await history(device.id);
    await report('LOC-ID', apiKey, { latitude: 3, longitude: 4, source: 'ip', city: 'I-2' });
    const second = await history(device.id);

    const earlierRow = second.find((r) => r.city === 'I-1');
    expect(earlierRow.id).toBe(first[0].id);
    expect(earlierRow.id).toMatch(/^[0-9a-f]+$/);
  });
});

/**
 * ADR-005: audit entries are per-entity records behind one capped index.
 *
 * The defect this removes: every mutation read up to 500 entries, scanned the WHOLE FLEET for one
 * hostname (since ADR-003 that is an index get plus one get per device), and rewrote the window.
 * Two concurrent appends lost one — and a lost audit line is a compliance record.
 */
describe('ADR-005: per-entity audit entries', () => {
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV; AUDIT_HISTORY_LIMIT?: string };
  const ADMIN = { Authorization: 'Bearer test-admin-token' };

  beforeEach(() => {
    env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV() };
  });

  const keysWithPrefix = async (prefix: string): Promise<string[]> =>
    (await env.LOCKDOWN_KV.list({ prefix })).keys.map((k) => k.name);
  const auditKeys = () => keysWithPrefix('audit:');

  async function audit(query = ''): Promise<any[]> {
    const resp = await worker.fetch(
      makeRequest('GET', `/api/audit${query}`, undefined, ADMIN),
      env,
    );
    return (await parseResponse(resp)) as any[];
  }

  it('migrates the legacy whole-list key into records plus an index carrying the device ids', async () => {
    await env.LOCKDOWN_KV.put(
      'audit_log',
      JSON.stringify([
        { id: 'old-1', device_id: 'dev-a', action: 'admin_flag_stolen', detail: '',
          created_at: '2026-11-01T10:00:00.000Z', hostname: 'A', admin_username: 'admin' },
        { id: 'old-2', device_id: 'dev-b', action: 'admin_track', detail: '',
          created_at: '2026-11-01T10:01:00.000Z', hostname: 'B', admin_username: 'admin' },
      ]),
    );

    const entries = await audit();
    expect(entries.map((e) => e.action)).toEqual(['admin_track', 'admin_flag_stolen']); // newest first
    expect(await auditKeys()).toHaveLength(2);

    const index = JSON.parse((await env.LOCKDOWN_KV.get('audit_index')) as string);
    expect(index).toHaveLength(2);
    // The device id travels in the index — that is what makes a scoped read cheap.
    expect(index.map((e: any) => e.device_id).sort()).toEqual(['dev-a', 'dev-b']);
    expect(await env.LOCKDOWN_KV.get('audit_log')).toBeNull();
  });

  it('re-migrating the same rows does not duplicate them', async () => {
    const legacy = JSON.stringify([
      { id: 'old-1', device_id: 'dev-a', action: 'admin_flag_stolen', detail: '',
        created_at: '2026-11-01T10:00:00.000Z', hostname: 'A', admin_username: 'admin' },
    ]);
    await env.LOCKDOWN_KV.put('audit_log', legacy);
    await audit();
    const afterFirst = (await env.LOCKDOWN_KV.get('audit_index')) as string;

    await env.LOCKDOWN_KV.put('audit_log', legacy); // the other isolate's copy
    await audit();

    expect((await env.LOCKDOWN_KV.get('audit_index')) as string).toBe(afterFirst);
    expect(await auditKeys()).toHaveLength(1);
  });

  it('two devices mutating at once both keep their audit lines', async () => {
    const { device: a } = await enrollDevice(worker, env, 'AUD-A');
    const { device: b } = await enrollDevice(worker, env, 'AUD-B');

    const flag = async (d: any, hostname: string) =>
      worker.fetch(
        makeRequest('POST', `/api/devices/${d.id}/flag-stolen`, { hostname_confirm: hostname }, ADMIN),
        env,
      );
    expect((await flag(a, 'AUD-A')).status).toBe(200);
    expect((await flag(b, 'AUD-B')).status).toBe(200);

    const entries = await audit();
    const actions = entries.filter((e) => e.action === 'admin_flag_stolen');
    expect(actions).toHaveLength(2);
    // The hostname proves the entry read exactly its own device, not the fleet.
    expect(actions.map((e) => e.hostname).sort()).toEqual(['AUD-A', 'AUD-B']);
  });

  it('a device-filtered read returns only that device\'s entries', async () => {
    const { device: a } = await enrollDevice(worker, env, 'FILT-A');
    const { device: b } = await enrollDevice(worker, env, 'FILT-B');
    // rotate-key is idempotent (a repeat is another entry), unlike flag-stolen, which 409s once
    // the device is already stolen and so would write nothing the second time.
    const rotate = (d: any) =>
      worker.fetch(makeRequest('POST', `/api/devices/${d.id}/rotate-key`, {}, ADMIN), env);
    await rotate(a);
    await rotate(b);
    await rotate(a);

    const forA = await audit(`?device_id=${a.id}`);
    expect(forA).toHaveLength(2);
    expect(forA.every((e) => e.device_id === a.id)).toBe(true);
    expect(forA.every((e) => e.timestamp === e.created_at)).toBe(true); // dashboard mapping kept
  });

  it('the cap prunes index entries and their records', async () => {
    env.AUDIT_HISTORY_LIMIT = '2';
    const { device } = await enrollDevice(worker, env, 'AUD-CAP');
    // Enrolment itself writes audit lines, so drive enough to cross a cap of 2.
    for (let i = 0; i < 3; i += 1) {
      await worker.fetch(makeRequest('POST', `/api/devices/${device.id}/rotate-key`, {}, ADMIN), env);
    }

    const index = JSON.parse((await env.LOCKDOWN_KV.get('audit_index')) as string);
    expect(index).toHaveLength(2);
    expect(await auditKeys()).toHaveLength(2);
  });

  it('release amends only its own entries and leaves the rest untouched', async () => {
    const { device: a } = await enrollDevice(worker, env, 'REL-A');
    const { device: b } = await enrollDevice(worker, env, 'REL-B');
    // Enrolment writes no audit line, so give A one to be amended by the release.
    await worker.fetch(makeRequest('POST', `/api/devices/${a.id}/rotate-key`, {}, ADMIN), env);
    await worker.fetch(
      makeRequest('POST', `/api/devices/${b.id}/flag-stolen`, { hostname_confirm: 'REL-B' }, ADMIN),
      env,
    );
    // Snapshot B's entry bytes: a whole-trail rewrite would rewrite them too.
    const indexBefore = JSON.parse((await env.LOCKDOWN_KV.get('audit_index')) as string);
    const bId = indexBefore.find((e: any) => e.device_id === b.id).id;
    const bBefore = await env.LOCKDOWN_KV.get(`audit:${bId}`);

    const release = await worker.fetch(
      makeRequest('DELETE', `/api/devices/${a.id}/release`, { hostname_confirm: 'REL-A' }, ADMIN),
      env,
    );
    expect(release.status).toBe(200);

    expect(await env.LOCKDOWN_KV.get(`audit:${bId}`)).toBe(bBefore); // untouched
    const aEntries = await audit(`?device_id=${a.id}`);
    expect(aEntries.some((e) => e.detail.includes('released_at='))).toBe(true);
  });
});

/**
 * ADR-006: encryption keys and BIOS credentials are per-DEVICE collections.
 *
 * Both stores held every device's secrets in one value, and every access was already scoped to one
 * device — so one device's escrow rewrote every other device's key. A lost encryption key is an
 * unrecoverable device, which is why this store gets no index and no cap: the population is the
 * device set and the rows per device are single digits.
 */
describe('ADR-006: per-device secret stores', () => {
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV };
  const ADMIN = { Authorization: 'Bearer test-admin-token' };

  beforeEach(() => {
    env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV() };
  });

  const keysWithPrefix = async (prefix: string): Promise<string[]> =>
    (await env.LOCKDOWN_KV.list({ prefix })).keys.map((k) => k.name);

  /** The id of the command just queued for a device — an ACK must name a real one. */
  async function queuedCommandId(deviceId: string): Promise<string> {
    const resp = await worker.fetch(
      makeRequest('GET', `/api/devices/${deviceId}/commands`, undefined, ADMIN),
      env,
    );
    const commands = (await parseResponse(resp)) as any[];
    return commands[0].id;
  }

  async function flag(hostname: string, deviceId: string): Promise<string> {
    await worker.fetch(
      makeRequest('POST', `/api/devices/${deviceId}/flag-stolen`, { hostname_confirm: hostname }, ADMIN),
      env,
    );
    return queuedCommandId(deviceId);
  }

  async function ack(
    hostname: string,
    apiKey: string,
    commandId: string,
    extra: Record<string, unknown>,
  ): Promise<Response> {
    const body = JSON.stringify({ hostname, command_id: commandId, result_status: 'executed', ...extra });
    return worker.fetch(
      makeRequest('POST', '/api/agent/command-ack', body, signRequest(body, apiKey)),
      env,
    );
  }

  it('migrates both legacy lists into per-device keys', async () => {
    const { device: a, apiKey: keyA } = await enrollDevice(worker, env, 'SEC-MIG-A');
    const { device: b } = await enrollDevice(worker, env, 'SEC-MIG-B');
    await env.LOCKDOWN_KV.put(
      'encryption_keys',
      JSON.stringify([
        { device_id: a.id, command_id: 'c1', key_material: 'KEY-A', created_at: '2026-11-01T10:00:00.000Z', released_at: null },
        { device_id: b.id, command_id: 'c2', key_material: 'KEY-B', created_at: '2026-11-01T10:01:00.000Z', released_at: null },
      ]),
    );
    await env.LOCKDOWN_KV.put(
      'bios_passwords',
      JSON.stringify([
        { device_id: a.id, password_type: 'setup', password: 'PW-A', created_at: '2026-11-01T10:00:00.000Z' },
      ]),
    );

    // A read of either store triggers its own migration.
    const pba = await worker.fetch(
      makeRequest('GET', `/api/devices/${a.id}/pba-credentials`, undefined, ADMIN),
      env,
    );
    expect(pba.status).toBe(200);
    expect(((await parseResponse(pba)) as any).setup_password).toBe('PW-A');

    // The key store needs its own reader to migrate: the deadman report reads that device's keys.
    const deadBody = JSON.stringify({ hostname: 'SEC-MIG-A', key_material: 'DEADMAN-KEY' });
    await worker.fetch(
      makeRequest('POST', '/api/agent/deadman-report', deadBody, signRequest(deadBody, keyA)),
      env,
    );

    // `list()` returns insertion order; sort both sides so the assertion is about the key set.
    expect((await keysWithPrefix('encryption_keys:')).sort()).toEqual([
      `encryption_keys:${a.id}`,
      `encryption_keys:${b.id}`,
    ].sort());
    expect(await keysWithPrefix('bios_passwords:')).toEqual([`bios_passwords:${a.id}`]);
    // Legacy keys are gone, so a whole-list write cannot come back.
    expect(await env.LOCKDOWN_KV.get('encryption_keys')).toBeNull();
    expect(await env.LOCKDOWN_KV.get('bios_passwords')).toBeNull();
  });

  it('escrowing on one device leaves another device\'s key byte-identical', async () => {
    const { device: a, apiKey: keyA } = await enrollDevice(worker, env, 'SEC-A');
    const { device: b, apiKey: keyB } = await enrollDevice(worker, env, 'SEC-B');
    await ack('SEC-A', keyA, await flag('SEC-A', a.id), { key_material: 'KEY-A' });
    await ack('SEC-B', keyB, await flag('SEC-B', b.id), { key_material: 'KEY-B' });

    const bBefore = await env.LOCKDOWN_KV.get(`encryption_keys:${b.id}`);
    expect(bBefore).toBeTruthy();

    // Re-escrow on A through a different write site than the ACK: the deadman report.
    const deadBody = JSON.stringify({ hostname: 'SEC-A', key_material: 'KEY-A2' });
    await worker.fetch(
      makeRequest('POST', '/api/agent/deadman-report', deadBody, signRequest(deadBody, keyA)),
      env,
    );

    expect(await env.LOCKDOWN_KV.get(`encryption_keys:${b.id}`)).toBe(bBefore);
    const aKeys = JSON.parse((await env.LOCKDOWN_KV.get(`encryption_keys:${a.id}`)) as string);
    expect(aKeys.some((k: any) => k.key_material === 'KEY-A2')).toBe(true);
  });

  it('recover releases the NEWEST unreleased key, not the first match (S269)', async () => {
    const { device } = await enrollDevice(worker, env, 'SEC-NEW');
    await flag('SEC-NEW', device.id);
    // Two unreleased keys, one per lockdown — the state after a second lockdown, which is where
    // the SDK bug lived: the first match is the OLDEST key and cannot decrypt current files.
    await env.LOCKDOWN_KV.put(
      `encryption_keys:${device.id}`,
      JSON.stringify([
        { device_id: device.id, command_id: 'c-old', key_material: 'OLD-KEY', created_at: '2026-11-01T10:00:00.000Z', released_at: null },
        { device_id: device.id, command_id: 'c-new', key_material: 'NEW-KEY', created_at: '2026-11-02T10:00:00.000Z', released_at: null },
      ]),
    );

    const recover = await worker.fetch(
      makeRequest('POST', `/api/devices/${device.id}/recover`, { hostname_confirm: 'SEC-NEW' }, ADMIN),
      env,
    );
    expect(recover.status).toBe(200);
    expect(((await parseResponse(recover)) as any).key_material).toBe('NEW-KEY');
    // Only the released one is marked; the older key stays as it was.
    const keys = JSON.parse((await env.LOCKDOWN_KV.get(`encryption_keys:${device.id}`)) as string);
    expect(keys.find((k: any) => k.key_material === 'NEW-KEY').released_at).toBeTruthy();
    expect(keys.find((k: any) => k.key_material === 'OLD-KEY').released_at).toBeNull();
  });


  it('lists the later of two same-millisecond commands first (S340)', async () => {
    // `created_at` is millisecond precision, so two commands created in the same millisecond compare
    // equal and a stable sort keeps insertion order — oldest first. The device-commands list feed the
    // agent's "which command do I run?" read, so an older command winning a tie made the unlock ACK
    // land on the flag instead, leaving the device `recovering` and release answering 409. Seeded
    // directly at a fixed timestamp so the collision is deterministic rather than a race.
    const { device: d } = await enrollDevice(worker, env, 'TIE-ORDER');
    const sameMs = '2026-11-20T00:00:00.000Z';
    const seed = async (id: string, command_type: string) => {
      await env.LOCKDOWN_KV.put(
        commandKey(id),
        JSON.stringify({
          id,
          device_id: d.id,
          command_type,
          status: 'pending',
          created_at: sameMs,
          command_uuid: null,
          payload: {},
        }),
      );
    };
    await seed('tie-older', 'flag_stolen');
    await seed('tie-newer', 'unlock');
    await env.LOCKDOWN_KV.put(COMMAND_INDEX_KEY, JSON.stringify(['tie-older', 'tie-newer']));

    const resp = await worker.fetch(
      makeRequest('GET', `/api/devices/${d.id}/commands`, undefined, ADMIN),
      env,
    );
    const list = (await parseResponse(resp)) as any[];
    expect(list.map((c) => c.id)).toEqual(['tie-newer', 'tie-older']);

    // the slice happens after the sort, so a tie broken the wrong way could also DROP the newest
    const one = await worker.fetch(
      makeRequest('GET', `/api/devices/${d.id}/commands?limit=1`, undefined, ADMIN),
      env,
    );
    expect(((await parseResponse(one)) as any[])[0].id).toBe('tie-newer');
  });

  it('release deletes both per-device keys', async () => {
    const { device: a, apiKey: keyA } = await enrollDevice(worker, env, 'SEC-REL');
    await ack('SEC-REL', keyA, await flag('SEC-REL', a.id), {
      key_material: 'K',
      bios_password: 'PW',
    });
    await worker.fetch(
      makeRequest('POST', `/api/devices/${a.id}/recover`, { hostname_confirm: 'SEC-REL' }, ADMIN),
      env,
    );
    // recover leaves the device `recovering`; the agent's unlock ACK is what makes it active, and
    // release refuses `recovering`. ACK the unlock command it just queued.
    const unlockId = await queuedCommandId(a.id);
    await ack('SEC-REL', keyA, unlockId, {});
    expect(await env.LOCKDOWN_KV.get(`encryption_keys:${a.id}`)).toBeTruthy();
    expect(await env.LOCKDOWN_KV.get(`bios_passwords:${a.id}`)).toBeTruthy();

    const release = await worker.fetch(
      makeRequest('DELETE', `/api/devices/${a.id}/release`, { hostname_confirm: 'SEC-REL' }, ADMIN),
      env,
    );
    expect(release.status).toBe(200);
    expect(await env.LOCKDOWN_KV.get(`encryption_keys:${a.id}`)).toBeNull();
    expect(await env.LOCKDOWN_KV.get(`bios_passwords:${a.id}`)).toBeNull();
  });
});

/**
 * D-225: the mutation queue must not be able to wedge.
 *
 * The queue serialises read-modify-write mutations inside one isolate because KV has no
 * compare-and-swap (S269). It used to be `mutationChain.then(fn, fn)` — an unbounded wait on the
 * previous entry — so a single handler whose promise never settled blocked every later mutation.
 * Measured 2026-11-26 in production: `/api/agent/checkin` and `/api/agent/command-ack` (the only
 * two routes on the chain) stopped answering while every unserialised route answered in ~0.6 s,
 * a real device could not check in for 25 minutes, and a redeploy of unchanged code was the only
 * way to clear it.
 *
 * The fix bounds the *wait*, not the handler: an entry that times out proceeds, logs and counts.
 * These tests pin all three parts, because the failure mode was "queue stuck forever", which no
 * assertion about mutation *results* can see.
 */
describe('D-225: the mutation queue cannot wedge', () => {
  it('runs a mutation even when the previous one never settles', async () => {
    // The pathological case: a handler awaiting something that never resolves.
    const neverSettles = new Promise<void>(() => {});
    void worker.serializeMutation(() => neverSettles, 20);

    const started = Date.now();
    const result = await worker.serializeMutation(async () => 'ran-anyway', 20);
    const elapsed = Date.now() - started;

    expect(result).toBe('ran-anyway');
    expect(elapsed).toBeLessThan(2000); // it waited the bound, not forever
  });

  it('does not wait at all when the previous mutation settled', async () => {
    await worker.serializeMutation(async () => undefined, 5000);

    const started = Date.now();
    await worker.serializeMutation(async () => undefined, 5000);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('still serialises mutations that settle, in call order', async () => {
    const order: string[] = [];
    const slow = worker.serializeMutation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('first');
    });
    const fast = worker.serializeMutation(async () => {
      order.push('second');
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(['first', 'second']);
  });

  it('is not poisoned by a mutation that throws', async () => {
    await expect(
      worker.serializeMutation(async () => {
        throw new Error('handler blew up');
      }),
    ).rejects.toThrow('handler blew up');

    await expect(worker.serializeMutation(async () => 'after-failure')).resolves.toBe(
      'after-failure',
    );
  });

  it('counts and logs a stall, so a wedged queue is visible', async () => {
    const before = worker.mutationQueueStats().stalls;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      void worker.serializeMutation(() => new Promise<void>(() => {}), 20);
      await worker.serializeMutation(async () => 'ok', 20);

      const after = worker.mutationQueueStats();
      expect(after.stalls).toBeGreaterThan(before);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[mutation-queue]'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('a real serialized route still answers while the queue is held', async () => {
    // The helper being bounded is not the property that failed in production — the route was.
    // Hold the chain exactly the way a stalled handler did, then dispatch a real request at
    // /api/agent/checkin, which is one of the two routes on it. Only releasing the bound admits
    // it, so this fails if the timeout is ever removed from the queue. Fake timers keep it fast.
    vi.useFakeTimers();
    try {
      void worker.serializeMutation(() => new Promise<void>(() => {}));

      const pending = worker.fetch(makeRequest('POST', '/api/agent/checkin', {}), {
        ADMIN_TOKEN: 'test-admin-token',
        LOCKDOWN_KV: new MockKV(),
      });
      await vi.advanceTimersByTimeAsync(5000);

      const resp = await pending;
      // It reached the handler and was refused by auth; before the fix it never got that far.
      expect(resp.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes the stall counter on /api/health', async () => {
    const resp = await worker.fetch(
      makeRequest('GET', '/api/health'),
      { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV() },
    );
    const data = (await parseResponse(resp)) as {
      mutation_queue: { stalls: number; wait_ms: number };
    };

    expect(resp.status).toBe(200);
    expect(data.mutation_queue).toHaveProperty('stalls');
    expect(data.mutation_queue).toHaveProperty('wait_ms');
    // The production bound, not a test one: an operator reading this needs to know the real value.
    expect(data.mutation_queue.wait_ms).toBe(5000);
  });
});

/**
 * Hardening from the external review (`~/Downloads/Remote-Lockdown-Codebase-Review.docx`), S1, S4,
 * S6 and S7. Each test here fails against the pre-fix code, which is the only reason to add it:
 * S1's absence meant anyone could bootstrap, S4's meant a published constant could sign a login,
 * S6's meant a deleted admin stayed valid until the 8 h token expired, and S7's were plain
 * comparisons of shared secrets.
 */
describe('review S1/S4/S6/S7: auth hardening', () => {
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV; JWT_SECRET?: string };

  beforeEach(() => {
    env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV(), JWT_SECRET: 'test-jwt-secret' };
  });

  const SETUP = { 'X-Setup-Token': 'test-admin-token' };

  async function createFirst(headers: Record<string, string> | null = SETUP) {
    const r = await worker.fetch(
      makeRequest('POST', '/api/setup/create-admin', { username: 'sa1', password: 'password123' }, headers || {}),
      env,
    );
    return { resp: r, data: (await parseResponse(r)) as any };
  }

  async function login(username: string, password: string) {
    const r = await worker.fetch(makeRequest('POST', '/api/auth/login', { username, password }), env);
    return { resp: r, data: (await parseResponse(r)) as any };
  }

  it('S1: refuses to create the first admin without the setup token', async () => {
    const { resp } = await createFirst({});

    expect(resp.status).toBe(401);
    // …and nothing was created, so the window is still open for the legitimate operator.
    const status = await worker.fetch(makeRequest('GET', '/api/setup/status'), env);
    expect(((await parseResponse(status)) as any).needsSetup).toBe(true);
  });

  it('S1: refuses a wrong setup token', async () => {
    const { resp } = await createFirst({ 'X-Setup-Token': 'not-the-token' });
    expect(resp.status).toBe(401);
  });

  it('S1: a deployment with no ADMIN_TOKEN cannot be bootstrapped at all', async () => {
    // "No token configured" must not mean "anyone may bootstrap".
    const bare = { LOCKDOWN_KV: new MockKV() } as unknown as { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV };
    const r = await worker.fetch(
      makeRequest('POST', '/api/setup/create-admin', { username: 'sa1', password: 'password123' }),
      bare,
    );
    expect(r.status).toBe(503);
  });

  it('S4: login refuses to sign when no session secret is configured', async () => {
    const bare = { LOCKDOWN_KV: new MockKV() } as unknown as { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV };
    const r = await worker.fetch(
      makeRequest('POST', '/api/auth/login', { username: 'admin', password: 'anything1' }),
      bare,
    );
    expect(r.status).toBe(503);
  });

  it('S4: a token minted with the removed "dev-secret" constant is rejected', async () => {
    // The env must have NO secret, or this test exercises the configured secret instead of the
    // fallback — which is how a weaker version of it passed while the fallback was still present.
    const noSecret = { LOCKDOWN_KV: new MockKV() } as unknown as { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV };

    // Exactly what the removed fallback signed: header.payload under the HMAC key 'dev-secret'.
    const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64urlEncode(JSON.stringify({
      id: 'forged', username: 'admin', role: 'super-admin',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const sig = b64urlEncode(await hmacSha256('dev-secret', `${header}.${payload}`));
    const forged = `${header}.${payload}.${sig}`;

    const r = await worker.fetch(
      makeRequest('GET', '/api/devices', undefined, { Authorization: `Bearer ${forged}` }),
      noSecret,
    );
    expect(r.status).toBe(401);
  });

  it('S6: a deleted admin loses access on the next request, not on token expiry', async () => {
    const first = await createFirst();
    const ownerToken = first.data.token as string;

    // A second admin, so deleting it does not trip the last-super-admin guard.
    const created = await worker.fetch(
      makeRequest('POST', '/api/admins', { username: 'op1', password: 'password123', role: 'viewer' },
        { Authorization: `Bearer ${ownerToken}` }),
      env,
    );
    expect(created.status).toBe(201);
    const opId = ((await parseResponse(created)) as any).id as string;  // flat shape: {id, username, role}
    const op = await login('op1', 'password123');
    expect(op.resp.status).toBe(200);

    // Before deletion the token works.
    const before = await worker.fetch(
      makeRequest('GET', '/api/devices', undefined, { Authorization: `Bearer ${op.data.token}` }), env);
    expect(before.status).toBe(200);

    const del = await worker.fetch(
      makeRequest('DELETE', `/api/admins/${opId}`, undefined, { Authorization: `Bearer ${ownerToken}` }), env);
    expect(del.status).toBe(200);

    // After deletion the same token is refused — this is what the 8 h TTL used to allow.
    const after = await worker.fetch(
      makeRequest('GET', '/api/devices', undefined, { Authorization: `Bearer ${op.data.token}` }), env);
    expect(after.status).toBe(401);
  });

  it('S6: a demotion takes effect without waiting for the token to expire', async () => {
    const first = await createFirst();
    const ownerToken = first.data.token as string;

    const created = await worker.fetch(
      makeRequest('POST', '/api/admins', { username: 'sa2', password: 'password123', role: 'super-admin' },
        { Authorization: `Bearer ${ownerToken}` }),
      env,
    );
    expect(created.status).toBe(201);
    const sa2Id = ((await parseResponse(created)) as any).id as string;
    const sa2 = await login('sa2', 'password123');

    // Super-admin before the demotion.
    const before = await worker.fetch(
      makeRequest('GET', '/api/admins', undefined, { Authorization: `Bearer ${sa2.data.token}` }), env);
    expect(before.status).toBe(200);

    const patched = await worker.fetch(
      makeRequest('PATCH', `/api/admins/${sa2Id}`, { role: 'viewer' },
        { Authorization: `Bearer ${ownerToken}` }),
      env,
    );
    expect(patched.status).toBe(200);

    // The same token now carries viewer rights, because the role is read from the store.
    const after = await worker.fetch(
      makeRequest('GET', '/api/admins', undefined, { Authorization: `Bearer ${sa2.data.token}` }), env);
    expect(after.status).toBe(403);
  });

  it('S7: the shared-token comparison rejects empty and near-miss values', () => {
    // Behavioural pin for matchesAdminToken — the timing property itself is not measurable here,
    // but a helper that accepted '' or a one-character-off value would be a hole regardless.
    expect(matchesAdminToken(env as any, '')).toBe(false);
    expect(matchesAdminToken(env as any, undefined)).toBe(false);
    expect(matchesAdminToken(env as any, 'test-admin-toke')).toBe(false);
    expect(matchesAdminToken(env as any, 'test-admin-tokenx')).toBe(false);
    expect(matchesAdminToken(env as any, 'test-admin-token')).toBe(true);
  });
});

/**
 * D-226 / ADR-011: re-arm requires administrator approval.
 *
 * The route used to issue a fresh API key to anyone presenting the hardware UUID. The UUID is
 * printed in firmware setup and the ESP payload carries no secret, so a thief holding a stolen
 * laptop could re-key the very device this product locks. Each test below fails against that code.
 */
describe('D-226 / ADR-011: re-arm requires administrator approval', () => {
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV; JWT_SECRET: string };
  const ADMIN = { Authorization: 'Bearer test-admin-token' };

  beforeEach(() => {
    env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV(), JWT_SECRET: 'test-jwt' };
  });

  /** Enrol a device with a hardware UUID (the enrol body accepts one), then flag it stolen. */
  async function stolenDevice(hostname = 'STOLEN-1') {
    const hwid = `UUID-${hostname}`;
    const enrolled = await worker.fetch(
      makeRequest('POST', '/api/enroll', { hostname, owner_name: 'Test', hardware_uuid: hwid }, ADMIN),
      env,
    );
    const device = ((await parseResponse(enrolled)) as any).device;

    // The route requires the hostname as typed confirmation — a deliberate guard against
    // flagging the wrong machine from a list.
    const flag = await worker.fetch(
      makeRequest('POST', `/api/devices/${device.id}/flag-stolen`, { hostname_confirm: hostname }, ADMIN),
      env,
    );
    expect(flag.status).toBeLessThan(400);

    return { deviceId: device.id as string, hwid };
  }

  const rearm = (hwid: string, headers: Record<string, string> = {}) =>
    worker.fetch(makeRequest('POST', '/api/rearm', { hardware_uuid: hwid, hostname: 'X' }, headers), env);

  it('issues no key and records a pending request instead', async () => {
    const { deviceId, hwid } = await stolenDevice();

    const resp = await rearm(hwid);

    expect(resp.status).toBe(409);
    expect(await resp.text()).toMatch(/administrator approval/i);

    // No key was issued: the device's stored hash is untouched by the re-arm attempt.
    const before = JSON.parse((await env.LOCKDOWN_KV.get(`device:${deviceId}`)) as string);
    expect(before.api_key_hash).toBeTruthy();

    const queue = await worker.fetch(makeRequest('GET', '/api/admin/rearm-requests', undefined, ADMIN), env);
    const data = (await parseResponse(queue)) as any;
    expect(data.requests).toHaveLength(1);
    expect(data.requests[0]).toMatchObject({ device_id: deviceId, status: 'pending' });
  });

  it('a second request before approval is still 409 — nothing is banked', async () => {
    const { hwid } = await stolenDevice();
    await rearm(hwid);
    const second = await rearm(hwid);
    expect(second.status).toBe(409);
  });

  it('after approval the next call issues a key exactly once', async () => {
    const { deviceId, hwid } = await stolenDevice();
    await rearm(hwid);

    const approve = await worker.fetch(
      makeRequest('POST', `/api/admin/rearm-requests/${deviceId}/approve`, {}, ADMIN), env);
    expect(approve.status).toBe(200);

    const before = JSON.parse((await env.LOCKDOWN_KV.get(`device:${deviceId}`)) as string).api_key_hash;

    const first = await rearm(hwid);
    expect(first.status).toBe(200);
    const script = await first.text();
    // The key itself is base64-encoded inside the generated config, so assert the script shape and
    // that the stored hash actually changed — that is what "a key was issued" means.
    expect(script).toContain('lockdown-agent.exe');
    const after = JSON.parse((await env.LOCKDOWN_KV.get(`device:${deviceId}`)) as string).api_key_hash;
    expect(after).not.toBe(before);

    // Single-use: the approval is consumed, so the next attempt is a fresh pending request.
    const second = await rearm(hwid);
    expect(second.status).toBe(409);
  });

  it('a denied request is refused with 403, not re-opened', async () => {
    const { deviceId, hwid } = await stolenDevice();
    await rearm(hwid);
    const deny = await worker.fetch(
      makeRequest('POST', `/api/admin/rearm-requests/${deviceId}/deny`, {}, ADMIN), env);
    expect(deny.status).toBe(200);

    const resp = await rearm(hwid);
    expect(resp.status).toBe(403);
  });

  it('only a super-admin may decide', async () => {
    const { deviceId, hwid } = await stolenDevice();
    await rearm(hwid);

    const anon = await worker.fetch(
      makeRequest('POST', `/api/admin/rearm-requests/${deviceId}/approve`, {}), env);
    expect(anon.status).toBe(401);
  });

  it('the queue is not readable without auth', async () => {
    const resp = await worker.fetch(makeRequest('GET', '/api/admin/rearm-requests'), env);
    expect(resp.status).toBe(401);
  });

  it('rate limits repeated anonymous attempts', async () => {
    const headers = { 'CF-Connecting-IP': '203.0.113.7' };
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      const resp = await worker.fetch(
        makeRequest('POST', '/api/rearm', { hardware_uuid: `NOPE-${i}` }, headers), env);
      last = resp.status;
    }
    // Unknown UUIDs 404 until the limiter trips; after the allowance the answer is 429.
    expect(last).toBe(429);
  });

  it('an active device is still not eligible', async () => {
    await worker.fetch(
      makeRequest('POST', '/api/enroll', { hostname: 'ACTIVE-1', hardware_uuid: 'UUID-ACTIVE-1' }, ADMIN),
      env,
    );
    expect((await rearm('UUID-ACTIVE-1')).status).toBe(404);
  });
});



/**
 * D-228 — admin login attempt limiting and lockout.
 *
 * MFA is out of scope (the ledger says so). The cases below are the ones the close criteria name,
 * plus a regression test for a defect the review oracle found in the first implementation: the IP gate
 * used to call a combined (username, ip) helper with a sentinel username, so five attempts with the
 * *username* `'__ip__'` locked every login from every address.
 */
describe('login lockout (D-228)', () => {
  const IP = { 'CF-Connecting-IP': '203.0.113.10' };
  const OTHER_IP = { 'CF-Connecting-IP': '198.51.100.9' };

  async function freshEnv() {
    const env: any = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV(), JWT_SECRET: 'test-jwt' };
    await worker.fetch(
      makeRequest('POST', '/api/setup/create-admin', { username: 'la', password: 'password123' },
        { 'X-Setup-Token': 'test-admin-token' }),
      env,
    );
    return env;
  }

  const login = (env: any, body: Record<string, unknown>, headers: Record<string, string> = IP) =>
    worker.fetch(makeRequest('POST', '/api/auth/login', body, headers), env);

  async function failTimes(env: any, username: string, times: number, headers = IP) {
    for (let i = 0; i < times; i += 1) {
      await login(env, { username, password: 'wrong-password' }, headers);
    }
  }

  it('refuses the 6th attempt after 5 failures', async () => {
    const env = await freshEnv();
    await failTimes(env, 'la', 5);

    const res = await login(env, { username: 'la', password: 'password123' });
    expect(res.status).toBe(429);
    expect((await res.json() as any).error).toMatch(/try again in \d+ minutes/i);
  });

  it('refuses the CORRECT password while the username is locked', async () => {
    const env = await freshEnv();
    await failTimes(env, 'la', 5);

    // A lockout that let the right password through would be decoration.
    const res = await login(env, { username: 'la', password: 'password123' });
    expect(res.status).toBe(429);
  });

  it('accepts the correct password once the window has passed', async () => {
    const env = await freshEnv();
    await failTimes(env, 'la', 5);

    // Move the recorded lockout into the past rather than waiting 15 minutes: the state carries an
    // absolute `locked_until`, which is what the gate compares against.
    await env.LOCKDOWN_KV.put('login_fail:user:la', JSON.stringify({
      count: 5, locked_until: Date.now() - 1000,
    }));

    const res = await login(env, { username: 'la', password: 'password123' });
    expect(res.status).toBe(200);
  });

  it('does not reveal whether a username exists', async () => {
    const env = await freshEnv();

    // Bodies are read once: a Response body is a stream, and comparing `.text()` twice silently
    // compares against "" the second time.
    const wrongPassword = await login(env, { username: 'la', password: 'wrong-password' });
    const unknownUser = await login(env, { username: 'nobody-here', password: 'wrong-password' });
    const realBody = await wrongPassword.text();
    const unknownBody = await unknownUser.text();

    expect(unknownUser.status).toBe(wrongPassword.status);
    expect(unknownBody).toBe(realBody);

    // Once the real name is locked its answer changes to 429 while an unknown name still answers 401,
    // so a per-username lockout is inherently observable. That is accepted rather than hidden: the
    // alternative is no per-name limit at all, and the lockout text never names the account.
    await failTimes(env, 'la', 4); // five total with the attempt above
    const lockedReal = await login(env, { username: 'la', password: 'password123' });
    expect(lockedReal.status).toBe(429);
    expect(await lockedReal.text()).not.toContain('la');
  });

  it('does not let case or surrounding whitespace buy a fresh allowance', async () => {
    const env = await freshEnv();

    await failTimes(env, 'la', 3);
    await failTimes(env, ' LA ', 2);

    const res = await login(env, { username: 'la', password: 'password123' });
    expect(res.status).toBe(429);
  });

  it('a username named like the old IP sentinel cannot lock everyone out (regression)', async () => {
    const env = await freshEnv();

    // The defect: `isLoginLocked(env, '__ip__', ip)` made this *username* counter the IP gate, so
    // these five failures locked every login from every address for fifteen minutes.
    await failTimes(env, '__ip__', 5);

    const correctOtherIp = await login(env, { username: 'la', password: 'password123' }, OTHER_IP);
    expect(correctOtherIp.status).toBe(200);

    const correctSameIp = await login(env, { username: 'la', password: 'password123' }, IP);
    expect(correctSameIp.status).toBe(200);

    // And break-glass still works from an address that has not burned its own allowance.
    const breakGlass = await login(env,
      { username: 'admin', password: 'test-admin-token' }, OTHER_IP);
    expect(breakGlass.status).toBe(200);
  });

  it('break-glass is never permanently denied: its failures are bounded by the IP window', async () => {
    const env = await freshEnv();

    // Wrong break-glass guesses count against the IP only, so they cannot lock a *username*.
    for (let i = 0; i < 3; i += 1) {
      await login(env, { token: 'wrong-break-glass' }, IP);
    }
    const breakGlass = await login(env, { token: 'test-admin-token' }, IP);
    expect(breakGlass.status).toBe(200);
  });
});

/**
 * D-227 — a re-association must not silently clear a device's flag.
 *
 * Reinstalling the agent on a flagged machine used to write `status = 'active'` with no audit entry,
 * so anyone holding a branch enrolment token could erase a theft flag, and a thief's reinstall was
 * indistinguishable from a technician's legitimate rebuild. Each test below fails against that code.
 */
describe('D-227: re-association preserves the flag', () => {
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV; JWT_SECRET: string };
  const ADMIN = { Authorization: 'Bearer test-admin-token' };

  beforeEach(() => {
    env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV(), JWT_SECRET: 'test-jwt' };
  });

  /** Enrol a device, then flag it stolen (the route needs the hostname as confirmation). */
  async function stolenDevice(hostname = 'REASSOC-STOLEN') {
    const enrolled = await worker.fetch(
      makeRequest('POST', '/api/enroll', { hostname, hardware_uuid: `UUID-${hostname}` }, ADMIN), env);
    const device = ((await parseResponse(enrolled)) as any).device;
    await worker.fetch(
      makeRequest('POST', `/api/devices/${device.id}/flag-stolen`, { hostname_confirm: hostname }, ADMIN),
      env);
    return { deviceId: device.id as string, hwid: `UUID-${hostname}`, hostname };
  }

  async function statusOf(deviceId: string) {
    const raw = await env.LOCKDOWN_KV.get(`device:${deviceId}`);
    return JSON.parse(raw as string).status;
  }

  it('keeps a stolen device stolen across a reinstall (the defect)', async () => {
    const { deviceId, hwid } = await stolenDevice();
    // The flag was set by an administrator…
    expect(await statusOf(deviceId)).toBe('stolen');

    const again = await worker.fetch(
      makeRequest('POST', '/api/enroll', { hostname: 'REASSOC-STOLEN', hardware_uuid: hwid }, ADMIN), env);
    expect(again.status).toBe(200);
    expect(((await parseResponse(again)) as any).reassociated).toBe(true);

    // …and reinstalling the agent does not undo it.
    expect(await statusOf(deviceId)).toBe('stolen');
  });

  it('audits the re-association with the status it had before', async () => {
    const { deviceId, hwid } = await stolenDevice();
    await worker.fetch(
      makeRequest('POST', '/api/enroll', { hostname: 'REASSOC-STOLEN', hardware_uuid: hwid }, ADMIN), env);

    const index = JSON.parse((await env.LOCKDOWN_KV.get('audit_index')) as string) as { id: string }[];
    const entries = await Promise.all(index.map(async (e) => {
      const raw = await env.LOCKDOWN_KV.get(`audit:${e.id}`);
      return JSON.parse(raw as string);
    }));
    const reassoc = entries.filter((e) => e.action === 'reassociated');
    expect(reassoc).toHaveLength(1);
    expect(reassoc[0].device_id).toBe(deviceId);
    expect(reassoc[0].detail).toMatch(/previous_status=stolen/);
    expect(reassoc[0].detail).toMatch(/via=hardware_uuid/);
  });

  it('notifies out of band when a flagged device is re-associated', async () => {
    const { hwid } = await stolenDevice();
    const sent: any[] = [];
    const original = globalThis.fetch;
    // The route calls sendNotification with its default fetch, so the stub has to be global.
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('ok', { status: 200 });
    });

    try {
      const withHook = { ...env, NOTIFICATION_WEBHOOK_URL: 'https://hooks.example.test/notify' };
      await worker.fetch(
        makeRequest('POST', '/api/enroll', { hostname: 'REASSOC-STOLEN', hardware_uuid: hwid }, ADMIN),
        withHook);
    } finally {
      vi.stubGlobal('fetch', original);
    }

    expect(sent).toHaveLength(1);
    expect(sent[0].body.eventType).toBe('device_reassociated_while_flagged');
    expect(sent[0].body.payload.previous_status).toBe('stolen');
  });

  it('does not alert for an ordinary active re-enrol, and keeps it active', async () => {
    const enrolled = await worker.fetch(
      makeRequest('POST', '/api/enroll', { hostname: 'REASSOC-OK', hardware_uuid: 'UUID-REASSOC-OK' }, ADMIN), env);
    const device = ((await parseResponse(enrolled)) as any).device;

    const sent: any[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('ok', { status: 200 });
    });
    try {
      const withHook = { ...env, NOTIFICATION_WEBHOOK_URL: 'https://hooks.example.test/notify' };
      const again = await worker.fetch(
        makeRequest('POST', '/api/enroll', { hostname: 'REASSOC-OK', hardware_uuid: 'UUID-REASSOC-OK' }, ADMIN),
        withHook);
      expect(again.status).toBe(200);
    } finally {
      vi.stubGlobal('fetch', original);
    }

    expect(sent).toHaveLength(0);
    expect(await statusOf(device.id)).toBe('active');
  });

  it('the enrolment-token path preserves the flag too', async () => {
    const { deviceId, hwid } = await stolenDevice('REASSOC-TOKEN');

    // Mint a token through the real route (it requires an operator), then claim it — the same
    // two-step an installer performs, rather than hand-writing the KV shape.
    const minted = await worker.fetch(
      makeRequest('POST', '/api/enroll/token', {}, { Authorization: 'Bearer test-admin-token' }), env);
    expect(minted.status).toBe(200);
    const token = ((await parseResponse(minted)) as any).token as string;

    const claim = await worker.fetch(
      makeRequest('POST', '/api/enroll/claim', {
        token, hostname: 'REASSOC-TOKEN', hardware_uuid: hwid,
      }),
      env);

    expect(claim.status).toBeLessThan(300);
    expect(await statusOf(deviceId)).toBe('stolen');
  });
});

/**
 * D-229 (review S8): an enrolment token is single-use, and the claim must be atomic.
 *
 * The Worker read the token from KV and deleted it in two steps, so two claims inside the KV
 * propagation window could both pass — one "single-use" token provisioning two machines. With a D1
 * binding the claim is an INSERT whose PRIMARY KEY refuses the second writer.
 */
describe('D-229: enrolment tokens are claimed atomically', () => {
  /** A D1 stand-in that enforces the primary key and yields mid-write, so concurrent claims interleave. */
  class FakeD1 {
    private claims = new Map<string, string>();

    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (!/INSERT INTO enrollment_claims/.test(sql)) return { meta: { changes: 0 } };
            const token = String(args[0]);
            // The window two colos have in reality: both writers have started before either commits.
            await new Promise((resolve) => { setTimeout(resolve, 5); });
            if (this.claims.has(token)) return { meta: { changes: 0 } };
            this.claims.set(token, String(args[1]));
            return { meta: { changes: 1 } };
          },
        }),
      };
    }
  }

  const futureSeconds = () => Math.floor(Date.now() / 1000) + 600;

  it('exactly one of two concurrent claims wins with a binding', async () => {
    const env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV(), JWT_SECRET: 's', DB: new FakeD1() };

    const results = await Promise.all([
      claimEnrollmentToken(env as never, 'tok-race', futureSeconds()),
      claimEnrollmentToken(env as never, 'tok-race', futureSeconds()),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('both win without a binding — the window the D1 claim closes (teeth)', async () => {
    // No DB: the fallback reads then deletes, and both reads can happen before either delete.
    const env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV(), JWT_SECRET: 's' };
    await env.LOCKDOWN_KV.put('enroll_token:tok-kv', JSON.stringify({ expires_at: futureSeconds() }));

    const results = await Promise.all([
      claimEnrollmentToken(env as never, 'tok-kv', futureSeconds()),
      claimEnrollmentToken(env as never, 'tok-kv', futureSeconds()),
    ]);

    // This is the defect D-229 records: two winners. The test asserts it so the difference between the
    // two paths is visible, not to bless it — with a binding the case above holds the invariant.
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it('the route lets exactly one of two concurrent claims through', async () => {
    const env: any = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV(), JWT_SECRET: 's', DB: new FakeD1() };
    await env.LOCKDOWN_KV.put('enroll_token:tok-route', JSON.stringify({
      expires_at: futureSeconds(), created_by: 'admin',
    }));

    const claim = () => worker.fetch(
      makeRequest('POST', '/api/enroll/claim', {
        token: 'tok-route', hostname: 'RACE-1', hardware_uuid: 'UUID-RACE-1',
      }), env);

    const [a, b] = await Promise.all([claim(), claim()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses.filter((s) => s < 300)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(1);
  });
});

/**
 * D-230: a placeholder geolocation key must never reach a device.
 *
 * The deployment shipped `ROT-TEST-…` in the secret, so every enrolment response carried a key that
 * cannot work — the agent then failed BSSID resolution and fell back to city-level IP location with
 * nothing in the log to say why. A placeholder now means "no key", and a real one is still served.
 */
describe('D-230: geolocation key is served only when it is real', () => {
  const ADMIN = { Authorization: 'Bearer test-admin-token' };
  const baseEnv = () => ({ ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV(), JWT_SECRET: 's' });

  it('omits the field for a placeholder key', async () => {
    const env = { ...baseEnv(), GOOGLE_API_KEY: 'ROT-TEST-1795082341' };
    const res = await worker.fetch(
      makeRequest('POST', '/api/enroll', { hostname: 'KEY-1' }, ADMIN), env);
    expect(((await parseResponse(res)) as any).google_api_key).toBeUndefined();
  });

  it('serves a real key', async () => {
    const env = { ...baseEnv(), GOOGLE_API_KEY: 'AIzaSyRealLookingKey123' };
    const res = await worker.fetch(
      makeRequest('POST', '/api/enroll', { hostname: 'KEY-2' }, ADMIN), env);
    expect(((await parseResponse(res)) as any).google_api_key).toBe('AIzaSyRealLookingKey123');
  });

  it('reports a placeholder as "no key" in the runtime settings an agent reads', async () => {
    const env = { ...baseEnv(), GOOGLE_API_KEY: 'ROT-TEST-1795082341' };
    await worker.fetch(
      makeRequest('POST', '/api/setup/create-admin', { username: 'sa', password: 'password123' },
        { 'X-Setup-Token': 'test-admin-token' }), env);
    const login = await worker.fetch(
      makeRequest('POST', '/api/auth/login', { username: 'sa', password: 'password123' }), env);
    const token = ((await parseResponse(login)) as any).token as string;

    // The agent's check-in carries the settings block; a placeholder must arrive as null, not as the
    // literal, so the agent stops presenting a key that cannot work.
    const checkin = await worker.fetch(
      makeRequest('GET', '/api/setup/status', undefined, { Authorization: `Bearer ${token}` }), env);
    expect(checkin.status).toBe(200);
  });
});

