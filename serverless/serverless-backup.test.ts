/**
 * Backup and restore (S350).
 *
 * The properties that matter are not "the file was written": they are that the backup contains no
 * readable credential, that an edited backup restores nothing, that a deployment with no key
 * refuses instead of degrading to plaintext, and that a restore actually puts the data back. Each
 * test below fails if the corresponding property is removed.
 */
import { beforeEach, describe, expect, it } from 'vitest';

class MemKV {
  private data: Record<string, string | Uint8Array> = {};
  /** Every key written, in order — so a test can prove an index is written once, not per record. */
  putLog: string[] = [];
  async get(key: string, options?: { type?: string } | string): Promise<unknown> {
    const val = this.data[key];
    if (val === undefined) return null;
    const str = typeof val === 'string' ? val : new TextDecoder().decode(val);
    const type = typeof options === 'string' ? options : options?.type;
    return type === 'json' ? JSON.parse(str) : str;
  }
  async put(key: string, value: string | Uint8Array, _opts?: unknown): Promise<void> {
    this.putLog.push(key);
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
  keys(): string[] {
    return Object.keys(this.data);
  }
}

interface StoredObject {
  bytes: Uint8Array;
  uploaded: Date;
  metadata?: Record<string, string>;
}

class MemR2 {
  objects = new Map<string, StoredObject>();
  async put(key: string, value: Uint8Array, opts?: { customMetadata?: Record<string, string> }): Promise<void> {
    this.objects.set(key, { bytes: value, uploaded: new Date(), metadata: opts?.customMetadata });
  }
  async get(key: string): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      arrayBuffer: async () => {
        const copy = new Uint8Array(object.bytes);
        return copy.buffer.slice(0) as ArrayBuffer;
      },
    };
  }
  async list(options?: { prefix?: string }): Promise<{ objects: Array<{ key: string; uploaded: Date; size: number }> }> {
    const prefix = options?.prefix ?? '';
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({ key, uploaded: object.uploaded, size: object.bytes.length })),
    };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const KEY_HEX = 'a'.repeat(64);

let kv: MemKV;
let r2: MemR2;
let env: Record<string, unknown>;
let backup: typeof import('./backup.js');
let store: typeof import('./kv-store.js');
let worker: { fetch: (req: Request, env: unknown) => Promise<Response> };

beforeEach(async () => {
  kv = new MemKV();
  r2 = new MemR2();
  env = {
    ADMIN_TOKEN: 'test-admin-token',
    LOCKDOWN_KV: kv,
    BACKUPS: r2,
    BACKUP_ENCRYPT_KEY: KEY_HEX,
  };
  backup = await import('./backup.js');
  store = await import('./kv-store.js');
  worker = (await import('./worker.js')).default;
});

async function seed(): Promise<void> {
  await store.putDevice(env as never, {
    id: 'dev-1',
    hostname: 'MOLE',
    status: 'stolen',
    api_key_hash: 'hash-ABC'.padEnd(64, '0'),
    created_at: '2026-11-01T00:00:00Z',
    last_checkin: '2026-11-24T11:00:00Z',
  } as never);
  await store.createCommand(env as never, {
    id: 'cmd-1',
    device_id: 'dev-1',
    command_type: 'lockdown',
    status: 'pending',
    created_at: '2026-11-24T10:00:00Z',
    executed_at: null,
    command_uuid: null,
  } as never);
  await store.addLocationReport(env as never, {
    id: 'loc-1',
    device_id: 'dev-1',
    latitude: -1.29,
    longitude: 36.82,
    accuracy_meters: 25,
    source: 'wifi',
    city: 'Nairobi',
    region: null,
    country: 'KE',
    ip_address: null,
    wifi_count: 3,
    created_at: '2026-11-24T09:00:00Z',
  } as never);
  await store.addAuditEntry(env as never, 'dev-1', 'device_flagged', 'flagged stolen by operator');
}

describe('writeBackup', () => {
  it('writes an encrypted envelope and reports what it contains', async () => {
    await seed();
    const result = await backup.writeBackup(env as never, new Date('2026-11-24T03:00:00Z'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.key).toMatch(/^backups\/2026-11-24T03-00-00-000Z\.rmlb$/);
    expect(result.counts).toMatchObject({ devices: 1, commands: 1, locations: 1 });
    expect(r2.objects.has(result.key)).toBe(true);
  });

  it('contains no readable credential or hostname', async () => {
    await seed();
    const result = await backup.writeBackup(env as never);
    if (!result.ok) throw new Error('backup failed');

    const bytes = new TextDecoder('latin1').decode(r2.objects.get(result.key)!.bytes);
    expect(bytes).not.toContain('MOLE');
    expect(bytes).not.toContain('hash-ABC');
    expect(bytes).not.toContain('flagged stolen');
    // The envelope header is the only recognisable part, by design.
    expect(bytes.startsWith('RMLB')).toBe(true);
  });

  it('refuses to write when no encryption key is configured', async () => {
    delete env.BACKUP_ENCRYPT_KEY;
    const result = await backup.writeBackup(env as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('refusing to write a plaintext backup');
    expect(r2.objects.size).toBe(0);
  });

  it('refuses a key that is not 64 hex characters', async () => {
    env.BACKUP_ENCRYPT_KEY = 'short';
    const result = await backup.writeBackup(env as never);
    expect(result.ok).toBe(false);
    expect(r2.objects.size).toBe(0);
  });

  it('skips (does not throw) when no bucket is bound', async () => {
    delete env.BACKUPS;
    const result = await backup.writeBackup(env as never);
    expect(result).toEqual({ ok: false, reason: 'no BACKUPS bucket bound' });
  });
});

describe('restoreBackup', () => {
  it('restores devices, commands, locations and audit into a fresh store', async () => {
    await seed();
    const written = await backup.writeBackup(env as never);
    if (!written.ok) throw new Error('backup failed');
    const blob = r2.objects.get(written.key)!.bytes;

    // A brand-new deployment: empty KV, same bucket and key.
    const freshKv = new MemKV();
    const freshEnv = { ...env, LOCKDOWN_KV: freshKv };
    const restored = await backup.restoreBackup(freshEnv as never, blob);

    expect(restored.counts).toMatchObject({ devices: 1, commands: 1, locations: 1 });
    const devices = await store.listDevices(freshEnv as never);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: 'dev-1', status: 'stolen' });
    // The key hash must survive or every restored device re-enrols by hand.
    expect(devices[0].api_key_hash).toBe('hash-ABC'.padEnd(64, '0'));

    expect(await store.listCommandsForDevice(freshEnv as never, 'dev-1')).toHaveLength(1);
    expect(await store.listLocationsForDevice(freshEnv as never, 'dev-1')).toHaveLength(1);
  });

  it('rejects an edited backup, and writes nothing', async () => {
    await seed();
    const written = await backup.writeBackup(env as never);
    if (!written.ok) throw new Error('backup failed');
    const tampered = new Uint8Array(r2.objects.get(written.key)!.bytes);
    tampered[tampered.length - 1] ^= 0xff;

    const freshKv = new MemKV();
    const freshEnv = { ...env, LOCKDOWN_KV: freshKv };
    await expect(backup.restoreBackup(freshEnv as never, tampered)).rejects.toThrow();
    // AES-GCM authenticates before the payload is parsed, so nothing was written.
    expect(await store.listDevices(freshEnv as never)).toHaveLength(0);
  });

  it('rejects a backup written under a different key', async () => {
    await seed();
    const written = await backup.writeBackup(env as never);
    if (!written.ok) throw new Error('backup failed');
    const blob = r2.objects.get(written.key)!.bytes;

    const wrongKeyEnv = { ...env, LOCKDOWN_KV: new MemKV(), BACKUP_ENCRYPT_KEY: 'b'.repeat(64) };
    await expect(backup.restoreBackup(wrongKeyEnv as never, blob)).rejects.toThrow();
  });

  it('refuses to restore with no key rather than failing silently', async () => {
    const noKeyEnv = { ...env, LOCKDOWN_KV: new MemKV(), BACKUP_ENCRYPT_KEY: undefined };
    await expect(backup.restoreBackup(noKeyEnv as never, new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /BACKUP_ENCRYPT_KEY missing or malformed/,
    );
  });
});

describe('restore does not hammer a single key (the 429 the drill found)', () => {
  it('writes each index once, not once per record', async () => {
    // Seed one device with many reports and commands — the shape that failed in production.
    await store.putDevice(env as never, {
      id: 'dev-many', hostname: 'BULK', status: 'active', created_at: '2026-11-01T00:00:00Z',
    } as never);
    for (let i = 0; i < 25; i += 1) {
      await store.addLocationReport(env as never, {
        id: `loc-${i}`, device_id: 'dev-many', latitude: -1.29, longitude: 36.82,
        accuracy_meters: 20, source: 'wifi', city: 'Nairobi', region: null, country: 'KE',
        ip_address: null, wifi_count: 2, created_at: `2026-11-24T0${i % 10}:00:00Z`,
      } as never);
      await store.createCommand(env as never, {
        id: `cmd-${i}`, device_id: 'dev-many', command_type: 'lockdown', status: 'executed',
        created_at: `2026-11-24T0${i % 10}:00:00Z`, executed_at: null, command_uuid: null,
      } as never);
    }

    const written = await backup.writeBackup(env as never);
    if (!written.ok) throw new Error('backup failed');
    const blob = r2.objects.get(written.key)!.bytes;

    const freshKv = new MemKV();
    const freshEnv = { ...env, LOCKDOWN_KV: freshKv };
    await backup.restoreBackup(freshEnv as never, blob);

    const indexWrites = freshKv.putLog.filter((k) => k.startsWith('location_index:dev-many'));
    const commandIndexWrites = freshKv.putLog.filter((k) => k.startsWith('command_index:dev-many'));
    // KV allows one write per second to the same key; 25 back-to-back writes is a 429.
    expect(indexWrites).toHaveLength(1);
    expect(commandIndexWrites).toHaveLength(1);
    // and the data is actually there
    expect(await store.listLocationsForDevice(freshEnv as never, 'dev-many')).toHaveLength(25);
    expect(await store.listCommandsForDevice(freshEnv as never, 'dev-many')).toHaveLength(25);
  });
});

describe('retention and listing', () => {
  it('prunes only backups older than the window', async () => {
    await r2.put('backups/old.rmlb', new Uint8Array([1]));
    r2.objects.get('backups/old.rmlb')!.uploaded = new Date('2026-10-01T00:00:00Z');
    await r2.put('backups/new.rmlb', new Uint8Array([2]));
    r2.objects.get('backups/new.rmlb')!.uploaded = new Date('2026-11-23T00:00:00Z');

    const pruned = await backup.pruneBackups(env as never, new Date('2026-11-24T00:00:00Z'));
    expect(pruned).toBe(1);
    expect(r2.objects.has('backups/old.rmlb')).toBe(false);
    expect(r2.objects.has('backups/new.rmlb')).toBe(true);
  });

  it('lists newest first and never serves a key outside the backup prefix', async () => {
    await r2.put('backups/a.rmlb', new Uint8Array([1]));
    await r2.put('backups/b.rmlb', new Uint8Array([2]));
    const listed = await backup.listBackups(env as never);
    expect(listed.map((b) => b.key)).toEqual(['backups/b.rmlb', 'backups/a.rmlb']);

    await r2.put('binaries/agent.exe', new Uint8Array([3]));
    expect(await backup.readBackup(env as never, 'binaries/agent.exe')).toBeNull();
  });
});

describe('backup routes', () => {
  const auth = { Authorization: 'Bearer test-admin-token' };

  it('takes a backup on demand', async () => {
    await seed();
    const resp = await worker.fetch(
      new Request('https://x.example.com/api/admin/backups', { method: 'POST', headers: auth }),
      env,
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { backup: { key: string } };
    expect(body.backup.key).toMatch(/^backups\//);
  });

  it('requires authentication', async () => {
    const resp = await worker.fetch(
      new Request('https://x.example.com/api/admin/backups', { method: 'POST' }),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it('restores from a stored backup by key', async () => {
    await seed();
    const created = await worker.fetch(
      new Request('https://x.example.com/api/admin/backups', { method: 'POST', headers: auth }),
      env,
    );
    const { backup: createdBackup } = (await created.json()) as { backup: { key: string } };

    // Wipe the store, then restore through the route.
    const freshKv = new MemKV();
    const freshEnv = { ...env, LOCKDOWN_KV: freshKv };
    const resp = await worker.fetch(
      new Request('https://x.example.com/api/admin/restore', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: createdBackup.key }),
      }),
      freshEnv,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { restored: boolean; counts: { devices: number } };
    expect(body.restored).toBe(true);
    expect(body.counts.devices).toBe(1);
    expect(await store.listDevices(freshEnv as never)).toHaveLength(1);
  });

  it('reports a missing key as 404 rather than restoring nothing quietly', async () => {
    const resp = await worker.fetch(
      new Request('https://x.example.com/api/admin/restore', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'backups/nope.rmlb' }),
      }),
      env,
    );
    expect(resp.status).toBe(404);
  });
});

describe('cron cadence: hourly tick, daily backup', () => {
  it('gates the backup on the 03:00 UTC tick', async () => {
    const mod = await import('./worker.js') as unknown as {
      shouldRunBackup: (c: { scheduledTime?: number } | undefined) => boolean;
    };
    expect(mod.shouldRunBackup({ scheduledTime: Date.UTC(2026, 10, 24, 3, 0, 0) })).toBe(true);
    expect(mod.shouldRunBackup({ scheduledTime: Date.UTC(2026, 10, 24, 4, 0, 0) })).toBe(false);
    expect(mod.shouldRunBackup({ scheduledTime: Date.UTC(2026, 10, 24, 15, 0, 0) })).toBe(false);
    // Unknown time must run, not skip: a backup that stops silently is the worse failure.
    expect(mod.shouldRunBackup(undefined)).toBe(true);
    expect(mod.shouldRunBackup({})).toBe(true);
  });

  it('writes a backup on the 03:00 tick and not on others', async () => {
    await seed();
    await worker.scheduled!({ scheduledTime: Date.UTC(2026, 10, 24, 4, 0, 0) }, env);
    expect([...r2.objects.keys()].filter((k) => k.startsWith('backups/'))).toHaveLength(0);

    await worker.scheduled!({ scheduledTime: Date.UTC(2026, 10, 24, 3, 0, 0) }, env);
    expect([...r2.objects.keys()].filter((k) => k.startsWith('backups/'))).toHaveLength(1);
  });
});
