/**
 * Alert tick and replay protection (S349).
 *
 * Both are things the serverless deployment was missing rather than doing badly, and both fail
 * silently if they are wrong: an alert that never fires looks exactly like a fleet with nothing
 * to report, and a replay check that never rejects looks exactly like a healthy authentication.
 * So these tests assert on what was *sent* and on the second attempt, not on a 200.
 */
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

interface PutRecord {
  key: string;
  options?: { expirationTtl?: number };
}

class CountingKV {
  private data: Record<string, string | Uint8Array> = {};
  puts: PutRecord[] = [];

  async get(key: string, options?: { type?: 'json' | 'text' } | string): Promise<unknown> {
    const val = this.data[key];
    if (val === undefined) return null;
    const type = typeof options === 'string' ? options : options?.type;
    const str = typeof val === 'string' ? val : new TextDecoder().decode(val);
    return type === 'json' ? JSON.parse(str) : str;
  }

  async put(key: string, value: string | Uint8Array, options?: { expirationTtl?: number }): Promise<void> {
    this.puts.push({ key, options });
    this.data[key] = value;
  }

  async delete(key: string): Promise<void> {
    delete this.data[key];
  }

  async list(options?: { prefix?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
    const prefix = options?.prefix ?? '';
    return {
      keys: Object.keys(this.data).filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  }
}

let kv: CountingKV;
let env: Record<string, unknown>;
let worker: { fetch: (req: Request, env: unknown) => Promise<Response> };
let alerts: typeof import('./alerts.js');

beforeEach(async () => {
  kv = new CountingKV();
  env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: kv };
  worker = (await import('./worker.js')).default;
  alerts = await import('./alerts.js');
});

const NOW = Date.parse('2026-11-24T12:00:00Z');

function device(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'dev-1',
    hostname: 'MOLE',
    status: 'active',
    created_at: '2026-11-01T00:00:00Z',
    last_checkin: '2026-11-24T11:58:00Z',
    ...overrides,
  };
}

describe('computeStaleAlerts', () => {
  it('flags a device whose last check-in is older than the threshold', () => {
    const result = alerts.computeStaleAlerts(
      [device({ last_checkin: '2026-11-24T11:00:00Z' })] as never,
      NOW,
      600,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      eventType: 'device_stale',
      deviceId: 'dev-1',
      hostname: 'MOLE',
      reason: 'stale_checkin',
    });
  });

  it('does not flag a device that has never checked in', () => {
    // Enrolment-to-first-contact is not staleness; alerting there trains people to mute alerts.
    expect(alerts.computeStaleAlerts([device({ last_checkin: null })] as never, NOW, 600)).toEqual([]);
  });

  it('treats the boundary as fresh, and one second past it as stale', () => {
    const atBoundary = new Date(NOW - 600_000).toISOString();
    const past = new Date(NOW - 601_000).toISOString();
    expect(alerts.computeStaleAlerts([device({ last_checkin: atBoundary })] as never, NOW, 600)).toEqual([]);
    expect(alerts.computeStaleAlerts([device({ last_checkin: past })] as never, NOW, 600)).toHaveLength(1);
  });
});

describe('runAlertTick', () => {
  async function seedStale(status = 'stolen'): Promise<void> {
    // The real shape: a per-device record behind `device_index` (ADR-003). `devices` is the
    // legacy whole-list key, and seeding it exercises a migration rather than the read path.
    await kv.put('device_index', JSON.stringify(['dev-1']));
    await kv.put('device:dev-1', JSON.stringify(device({ status, last_checkin: '2026-11-24T10:00:00Z' })));
  }

  it('audits and notifies once, then suppresses the repeat', async () => {
    await seedStale();
    env.NOTIFICATION_WEBHOOK_URL = 'https://hooks.example.com/lockdown';
    const calls: Array<{ url: string; body: any }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const first = await alerts.runAlertTick(env as never, NOW, fakeFetch);
    expect(first).toMatchObject({ stale: 1, alerted: 1, suppressed: 0, notified: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      eventType: 'device_stale',
      payload: { deviceId: 'dev-1', hostname: 'MOLE', lastCheckin: '2026-11-24T10:00:00Z' },
    });
    expect(typeof calls[0].body.timestamp).toBe('string');

    const second = await alerts.runAlertTick(env as never, NOW, fakeFetch);
    expect(second).toMatchObject({ stale: 1, alerted: 0, suppressed: 1 });
    expect(calls).toHaveLength(1);
  });

  it('gives the marker an expiry so a recovered device can alert again later', async () => {
    await seedStale();
    env.ALERT_REPEAT_HOURS = '6';
    await alerts.runAlertTick(env as never, NOW, (async () => ({ ok: true, status: 200 }) as Response) as never);
    const marker = kv.puts.find((p) => p.key.startsWith('alert:device_stale:'));
    expect(marker?.options?.expirationTtl).toBe(6 * 3600);
  });

  it('formats a Slack message with the event type and payload', async () => {
    await seedStale();
    env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/x';
    const bodies: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    await alerts.runAlertTick(env as never, NOW, fakeFetch);
    expect(bodies[0]).toContain('*[device_stale]*');
    expect(bodies[0]).toContain('dev-1');
  });

  it('survives a failing webhook: audits the alert, counts the failure, does not throw', async () => {
    await seedStale();
    env.NOTIFICATION_WEBHOOK_URL = 'https://hooks.example.com/down';
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await alerts.runAlertTick(env as never, NOW, fakeFetch);
    expect(result).toMatchObject({ alerted: 1, notified: 0, failed: 1 });

    const indexIds = JSON.parse(String(await kv.get('audit_index')));
    const entries = await Promise.all(
      indexIds.map(async (e: { id: string }) => String(await kv.get(`audit:${e.id}`))),
    );
    expect(entries.some((e) => e.includes('health_alert'))).toBe(true);
  });

  it('with no channel configured, still alerts and audits — and does not call it a failure', async () => {
    await seedStale();
    const result = await alerts.runAlertTick(env as never, NOW, (async () => {
      throw new Error('must not be called');
    }) as unknown as typeof fetch);
    expect(result).toMatchObject({ alerted: 1, notified: 0, failed: 0 });
    expect(alerts.alertsConfigured(env as never)).toBe(false);
  });
});

describe('replay protection', () => {
  const ADMIN = { Authorization: 'Bearer test-admin-token' };

  async function enroll(): Promise<{ id: string; apiKey: string }> {
    const resp = await worker.fetch(
      new Request('https://lockdown.example.com/api/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ADMIN },
        body: JSON.stringify({ hostname: 'REPLAY', owner_name: 'Test' }),
      }),
      env,
    );
    const data = (await resp.json()) as { device: { id: string }; api_key: string };
    return { id: data.device.id, apiKey: data.api_key };
  }

  function signed(body: string, apiKey: string, nonceOverride?: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = nonceOverride ?? crypto.randomBytes(16).toString('hex');
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const signature = crypto.createHmac('sha256', apiKey).update(`${timestamp}:${nonce}:${bodyHash}`).digest('hex');
    return {
      'Content-Type': 'application/json',
      'X-Agent-Key': apiKey,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': signature,
      'X-Sig-Version': '1',
    };
  }

  function checkin(headers: Record<string, string>, body: string): Promise<Response> {
    return worker.fetch(
      new Request('https://lockdown.example.com/api/agent/checkin', {
        method: 'POST',
        headers,
        body,
      }),
      env,
    );
  }

  it('accepts a signed request once and rejects the identical replay', async () => {
    const { apiKey } = await enroll();
    const body = JSON.stringify({ hostname: 'REPLAY' });
    const headers = signed(body, apiKey);

    expect((await checkin(headers, body)).status).toBe(200);
    expect((await checkin(headers, body)).status).toBe(401);
  });

  it('accepts a fresh nonce for the same device', async () => {
    const { apiKey } = await enroll();
    const body = JSON.stringify({ hostname: 'REPLAY' });
    expect((await checkin(signed(body, apiKey), body)).status).toBe(200);
    expect((await checkin(signed(body, apiKey), body)).status).toBe(200);
  });

  it('rejects a nonce that is not 32 hex characters, even when correctly signed', async () => {
    const { apiKey } = await enroll();
    const body = JSON.stringify({ hostname: 'REPLAY' });
    expect((await checkin(signed(body, apiKey, 'abc'), body)).status).toBe(401);
  });

  it('can be switched off for a staged rollout', async () => {
    const { apiKey } = await enroll();
    env.REPLAY_PROTECTION = 'off';
    const body = JSON.stringify({ hostname: 'REPLAY' });
    const headers = signed(body, apiKey);
    expect((await checkin(headers, body)).status).toBe(200);
    expect((await checkin(headers, body)).status).toBe(200);
  });
});

describe('relational (D1) replay store', () => {
  /** Minimal stand-in for the D1 API surface the store uses: prepare/bind/run -> meta.changes. */
  function fakeDb(changesFor: number[]): {
    db: { prepare: (sql: string) => { bind: (...args: unknown[]) => { run: () => Promise<{ meta: { changes: number } }> } } };
    statements: string[];
  } {
    const statements: string[] = [];
    let call = 0;
    const db = {
      prepare(sql: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async run() {
                statements.push(sql);
                const changes = changesFor[call] ?? 0;
                call += 1;
                return { meta: { changes } };
              },
            };
          },
        };
      },
    };
    return { db, statements };
  }

  it('rejects the second use of a nonce via the unique constraint, not a read-then-write', async () => {
    const store = await import('./kv-store.js');
    const { db, statements } = fakeDb([1, 0]); // first insert wins, second is refused

    expect(await store.rememberNonce({ DB: db, LOCKDOWN_KV: kv } as never, 'dev-1', 'a'.repeat(32), 300)).toBe(true);
    expect(await store.rememberNonce({ DB: db, LOCKDOWN_KV: kv } as never, 'dev-1', 'a'.repeat(32), 300)).toBe(false);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('ON CONFLICT (device_id, nonce) DO NOTHING');
    // No KV write at all when the relational store answers.
    expect(kv.puts.filter((p) => p.key.startsWith('nonce:'))).toHaveLength(0);
  });

  it('purges expired nonces and reports how many went', async () => {
    const store = await import('./kv-store.js');
    const { db, statements } = fakeDb([7]);
    expect(await store.purgeExpiredNonces({ DB: db, LOCKDOWN_KV: kv } as never, NOW)).toBe(7);
    expect(statements[0]).toContain('DELETE FROM nonces WHERE expires_at < ?');
  });

  it('is a no-op without a relational binding', async () => {
    const store = await import('./kv-store.js');
    expect(await store.purgeExpiredNonces({ LOCKDOWN_KV: kv } as never, NOW)).toBe(0);
  });
});
