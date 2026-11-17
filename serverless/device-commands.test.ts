/**
 * GET /api/devices/:id/commands — the command ledger, and the only way to read the
 * evidence an ACK carries.
 *
 * Why this exists: `lockdown_effective` and `boot_lock_status` are written onto the
 * command record by the agent's ACK (S269), and no surface returned that record — the
 * POST that queues a command replies with what it just created, and nothing read it
 * back. A dashboard therefore showed `status: locked` while the field saying the
 * lockdown did NOT take effect was unreachable. Two facts, one visible.
 *
 * These tests pin the route's contract rather than an implementation: newest first,
 * scoped to one device, bounded, and carrying the evidence fields verbatim.
 */

import { describe, it, expect, beforeEach } from 'vitest';

class MockKV {
  private data: Record<string, string> = {};

  async get(key: string): Promise<string | null> {
    return this.data[key] ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data[key] = value;
  }

  async delete(key: string): Promise<void> {
    delete this.data[key];
  }

  async list(): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
    return { keys: Object.keys(this.data).map((name) => ({ name })), list_complete: true };
  }
}

const BASE = 'https://lockdown.example.com';
const DEVICE = 'dev-1';
const OTHER_DEVICE = 'dev-2';

let kv: MockKV;
let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV };
let worker: { fetch: (req: Request, env: unknown) => Promise<Response> };

beforeEach(async () => {
  kv = new MockKV();
  env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: kv };
  const mod = await import('./worker.js');
  worker = mod.default;
  await kv.put(
    'devices',
    JSON.stringify([
      { id: DEVICE, hostname: 'MOLE', status: 'locked', created_at: '2026-11-16T09:00:00Z' },
      { id: OTHER_DEVICE, hostname: 'OTHER', status: 'active', created_at: '2026-11-16T09:00:00Z' },
    ]),
  );
});

/** Two commands on the device (oldest first) and one on another device. */
async function seedCommands(): Promise<void> {
  await kv.put(
    'commands',
    JSON.stringify([
      {
        id: 'cmd-old',
        device_id: DEVICE,
        command_type: 'lockdown',
        status: 'executed',
        created_at: '2026-11-16T10:00:00Z',
        executed_at: '2026-11-16T10:00:04Z',
        command_uuid: 'u-old',
        // The pair that must travel together: the lock applied, the boot layer did not.
        lockdown_effective: false,
        boot_lock_status: 'partial',
        encryption_blocked_files: ['C:/Users/lab/Documents/secret.txt'],
      },
      {
        id: 'cmd-new',
        device_id: DEVICE,
        command_type: 'unlock',
        status: 'pending',
        created_at: '2026-11-16T11:00:00Z',
        executed_at: null,
        command_uuid: null,
      },
      {
        id: 'cmd-other',
        device_id: OTHER_DEVICE,
        command_type: 'lockdown',
        status: 'pending',
        created_at: '2026-11-16T12:00:00Z',
        executed_at: null,
        command_uuid: null,
      },
    ]),
  );
}

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, { method: 'GET', headers });
}

const auth = { Authorization: 'Bearer test-admin-token' };

describe('GET /api/devices/:id/commands', () => {
  it('returns this device’s commands newest first, evidence fields intact', async () => {
    await seedCommands();

    const resp = await worker.fetch(request(`/api/devices/${DEVICE}/commands`, auth), env);
    expect(resp.status).toBe(200);

    const commands = (await resp.json()) as Array<Record<string, unknown>>;
    expect(commands.map((c) => c.id)).toEqual(['cmd-new', 'cmd-old']);
    expect(commands.some((c) => c.device_id === OTHER_DEVICE)).toBe(false);

    const executed = commands.find((c) => c.id === 'cmd-old')!;
    // The evidence an operator needs to see next to `status: locked`:
    expect(executed.lockdown_effective).toBe(false);
    expect(executed.boot_lock_status).toBe('partial');
    expect(executed.encryption_blocked_files).toEqual(['C:/Users/lab/Documents/secret.txt']);
  });

  it('bounds `limit` instead of trusting it', async () => {
    await seedCommands();

    const one = await worker.fetch(request(`/api/devices/${DEVICE}/commands?limit=1`, auth), env);
    expect(((await one.json()) as unknown[]).length).toBe(1);

    // 0 and non-numeric fall back to a usable window rather than an empty page.
    const zero = await worker.fetch(request(`/api/devices/${DEVICE}/commands?limit=0`, auth), env);
    expect(((await zero.json()) as unknown[]).length).toBe(1);
    const junk = await worker.fetch(
      request(`/api/devices/${DEVICE}/commands?limit=not-a-number`, auth),
      env,
    );
    expect(((await junk.json()) as unknown[]).length).toBe(2);
  });

  it('404s for a device that does not exist (an empty list would read as "no commands")', async () => {
    const resp = await worker.fetch(request('/api/devices/nope/commands', auth), env);
    expect(resp.status).toBe(404);
  });

  it('requires a credential', async () => {
    const resp = await worker.fetch(request(`/api/devices/${DEVICE}/commands`), env);
    expect(resp.status).toBe(401);
  });
});
