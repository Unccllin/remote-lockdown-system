/**
 * Scale properties of the serverless backend (S348).
 *
 * Two behaviours are pinned here, both of which a passing functional suite would not notice:
 *
 * 1. A check-in reads only ITS OWN device's commands. The global command index made every poll
 *    cost one read per command in the fleet — a 100-command history turned a 4-read check-in
 *    into a 104-read one — which is a bill that grows with command history x fleet size
 *    (docs/SERVERLESS-COST.md). The functional tests passed throughout, because the result was
 *    correct the whole time; only the cost was wrong. So this suite counts KV operations.
 * 2. Location retention actually deletes. The history cap is a size limit, not a policy: a
 *    device that stops checking in never fills it, and its oldest report would sit forever.
 */
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

class CountingKV {
  private data: Record<string, string | Uint8Array> = {};
  gets: string[] = [];
  puts: string[] = [];
  deletes: string[] = [];

  reset(): void {
    this.gets = [];
    this.puts = [];
    this.deletes = [];
  }

  async get(key: string, options?: { type?: 'json' | 'text' | 'arrayBuffer' } | string): Promise<unknown> {
    this.gets.push(key);
    const val = this.data[key];
    if (val === undefined) return null;
    const type = typeof options === 'string' ? options : options?.type;
    const str = typeof val === 'string' ? val : new TextDecoder().decode(val);
    if (type === 'json') return JSON.parse(str);
    if (type === 'arrayBuffer') return typeof val === 'string' ? new TextEncoder().encode(val) : val;
    return str;
  }

  async put(key: string, value: string | Uint8Array): Promise<void> {
    this.puts.push(key);
    this.data[key] = value;
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    delete this.data[key];
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? '';
    const keys = Object.keys(this.data)
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }

  has(key: string): boolean {
    return this.data[key] !== undefined;
  }
}

let kv: CountingKV;
let env: Record<string, unknown>;
let worker: {
  fetch: (req: Request, env: unknown) => Promise<Response>;
  scheduled?: (controller: unknown, env: unknown) => Promise<void>;
};
let createCommand: (typeof import('./kv-store.js'))['createCommand'];
let deleteCommandsForDevice: (typeof import('./kv-store.js'))['deleteCommandsForDevice'];
let listCommandsForDevice: (typeof import('./kv-store.js'))['listCommandsForDevice'];
let listLocationsForDevice: (typeof import('./kv-store.js'))['listLocationsForDevice'];
let purgeExpiredLocations: (typeof import('./kv-store.js'))['purgeExpiredLocations'];

const ADMIN = { Authorization: 'Bearer test-admin-token' };

beforeEach(async () => {
  kv = new CountingKV();
  env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: kv };
  const workerMod = await import('./worker.js');
  worker = workerMod.default;
  const store = await import('./kv-store.js');
  createCommand = store.createCommand;
  deleteCommandsForDevice = store.deleteCommandsForDevice;
  listCommandsForDevice = store.listCommandsForDevice;
  listLocationsForDevice = store.listLocationsForDevice;
  purgeExpiredLocations = store.purgeExpiredLocations;
});

function makeRequest(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json', ...headers };
  }
  return new Request(`https://lockdown.example.com${path}`, init);
}

/** Enrol a device through the admin API and return its id and agent key. */
async function enroll(hostname: string): Promise<{ id: string; apiKey: string }> {
  const resp = await worker.fetch(
    makeRequest('POST', '/api/enroll', { hostname, owner_name: 'Test' }, ADMIN),
    env,
  );
  const data = (await resp.json()) as { device: { id: string }; api_key: string };
  return { id: data.device.id, apiKey: data.api_key };
}

/** Sign a check-in body the way the agent does (HMAC over timestamp:nonce:body_hash). */
function signedHeaders(body: string, apiKey: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const signature = crypto
    .createHmac('sha256', apiKey)
    .update(`${timestamp}:${nonce}:${bodyHash}`)
    .digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Agent-Key': apiKey,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
    'X-Sig-Version': '1',
  };
}

async function seedCommands(deviceId: string, count: number, type = 'lockdown'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `cmd-${deviceId}-${i}`;
    ids.push(id);
    await createCommand(env, {
      id,
      device_id: deviceId,
      command_type: type,
      status: i === count - 1 ? 'pending' : 'executed',
      created_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
      executed_at: i === count - 1 ? null : new Date(Date.UTC(2026, 10, 1, 0, i, 5)).toISOString(),
      command_uuid: null,
    });
  }
  return ids;
}

async function checkin(deviceId: string, apiKey: string): Promise<{ status: number; body: any }> {
  const payload = JSON.stringify({ hostname: `host-${deviceId}` });
  const resp = await worker.fetch(
    makeRequest('POST', '/api/agent/checkin', payload, signedHeaders(payload, apiKey)),
    env,
  );
  return { status: resp.status, body: await resp.json() };
}

describe('check-in cost: one device reads only its own commands', () => {
  it('does not read the fleet-wide command index', async () => {
    const mine = await enroll('MINE');
    const other = await enroll('OTHER');
    // A realistic history on someone else's device: this is what used to be read on every poll.
    await seedCommands(other.id, 60);
    await seedCommands(mine.id, 1, 'unlock');

    kv.reset();
    const result = await checkin(mine.id, mine.apiKey);
    expect(result.status).toBe(200);

    const commandGets = kv.gets.filter((key) => key.startsWith('command:'));
    const indexGets = kv.gets.filter((key) => key === 'command_index');

    // Before the per-device index: 1 (global index) + 61 (one record per command).
    expect(commandGets.length).toBeLessThanOrEqual(2);
    expect(indexGets).toHaveLength(0);
    // The pending command is still delivered — the saving must not cost correctness.
    expect(result.body.command?.id).toBe(`cmd-${mine.id}-0`);
  });

  it('rebuilds a missing per-device index once, then stays cheap', async () => {
    const device = await enroll('LEGACY');
    await seedCommands(device.id, 3);
    // A device enrolled before the per-device index existed: its own key is absent.
    await kv.delete(`command_index:${device.id}`);
    kv.reset();

    const first = await checkin(device.id, device.apiKey);
    expect(first.status).toBe(200);
    const firstGets = kv.gets.filter((key) => key.startsWith('command:')).length;
    expect(firstGets).toBeGreaterThanOrEqual(3); // the rebuild paid the old price once
    expect(kv.has(`command_index:${device.id}`)).toBe(true);

    kv.reset();
    const second = await checkin(device.id, device.apiKey);
    expect(second.status).toBe(200);
    expect(kv.gets.filter((key) => key.startsWith('command:')).length).toBeLessThanOrEqual(3);
  });
});

describe('per-device command index', () => {
  it('lists only this device’s commands', async () => {
    const a = await enroll('A');
    const b = await enroll('B');
    await seedCommands(a.id, 2);
    await seedCommands(b.id, 4);

    const forA = await listCommandsForDevice(env, a.id);
    expect(forA).toHaveLength(2);
    expect(forA.every((c) => c.device_id === a.id)).toBe(true);
  });

  it('deleting a device’s commands prunes both indexes', async () => {
    const a = await enroll('A');
    const b = await enroll('B');
    await seedCommands(a.id, 2);
    await seedCommands(b.id, 1);

    const removed = await deleteCommandsForDevice(env, a.id);
    expect(removed).toBe(2);
    expect(await listCommandsForDevice(env, a.id)).toHaveLength(0);
    // The other device is untouched.
    expect(await listCommandsForDevice(env, b.id)).toHaveLength(1);

    const globalIds = JSON.parse(String(await kv.get('command_index')));
    expect(globalIds.some((id: string) => id.startsWith(`cmd-${a.id}`))).toBe(false);
    expect(globalIds.some((id: string) => id.startsWith(`cmd-${b.id}`))).toBe(true);
  });
});

describe('location retention purge', () => {
  const DAY = 86_400_000;

  async function seedReport(deviceId: string, id: string, createdAt: string): Promise<void> {
    await kv.put(`location:${id}`, JSON.stringify({
      id,
      device_id: deviceId,
      latitude: -1.29,
      longitude: 36.82,
      accuracy_meters: 30,
      source: 'wifi',
      city: 'Nairobi',
      region: null,
      country: 'KE',
      ip_address: null,
      wifi_count: 4,
      created_at: createdAt,
    }));
    const indexKey = `location_index:${deviceId}`;
    const existing = JSON.parse(String((await kv.get(indexKey)) ?? '[]'));
    await kv.put(indexKey, JSON.stringify([...existing, id]));
  }

  it('deletes only reports older than the window, and keeps the boundary', async () => {
    const device = await enroll('RETENTION');
    const now = Date.parse('2026-11-24T12:00:00Z');
    env.LOCATION_RETENTION_DAYS = '90';

    await seedReport(device.id, 'loc-old', new Date(now - 91 * DAY).toISOString());
    await seedReport(device.id, 'loc-edge', new Date(now - 90 * DAY).toISOString());
    await seedReport(device.id, 'loc-new', new Date(now - 1 * DAY).toISOString());

    const result = await purgeExpiredLocations(env, now);
    expect(result.retentionDays).toBe(90);
    expect(result.deleted).toBe(1);

    const remaining = (await listLocationsForDevice(env, device.id)).map((r) => r.id);
    expect(remaining.sort()).toEqual(['loc-edge', 'loc-new']);
  });

  it('falls back to the default rather than keeping forever on a bad value', async () => {
    env.LOCATION_RETENTION_DAYS = 'not-a-number';
    const result = await purgeExpiredLocations(env, Date.now());
    expect(result.retentionDays).toBe(90);
  });

  it('clamps above the ceiling', async () => {
    env.LOCATION_RETENTION_DAYS = '9999';
    const result = await purgeExpiredLocations(env, Date.now());
    expect(result.retentionDays).toBe(180);
  });

  it('the cron handler purges and records the deletion in the audit trail', async () => {
    const device = await enroll('CRON');
    const now = Date.now();
    await seedReport(device.id, 'loc-ancient', new Date(now - 200 * DAY).toISOString());

    await worker.scheduled!({ cron: '0 3 * * *' }, env);

    expect(await listLocationsForDevice(env, device.id)).toHaveLength(0);
    const auditIds = JSON.parse(String((await kv.get('audit_index')) ?? '[]'));
    expect(auditIds.length).toBeGreaterThan(0);
    // Any entry, not the last one: the cron runs several passes, so which is written last is an
    // ordering detail rather than the property under test.
    const entries = await Promise.all(
      auditIds.map(async (entry: { id: string }) => String(await kv.get(`audit:${entry.id}`))),
    );
    expect(entries.some((entry) => entry.includes('location_retention_purge'))).toBe(true);
  });
});
