/**
 * Backup and restore for the serverless deployment (S350).
 *
 * The Node server writes encrypted backups to disk on a schedule. A Worker has no disk and no
 * process, so the equivalent is: collect the durable state, encrypt it, put it in object storage
 * on a cron tick, and provide a restore path that actually restores rather than describing how it
 * would.
 *
 * Three rules this file enforces, each of which is a mistake made somewhere before:
 *
 * 1. **Never write a plaintext backup.** The state includes per-device key hashes, admin password
 *    hashes and location history. With no key configured, the backup pass refuses and records
 *    why — it does not degrade to unencrypted "just this once".
 * 2. **Authenticated encryption, not just encryption.** AES-GCM means a truncated or edited
 *    backup fails to decrypt instead of restoring a plausible-looking subset.
 * 3. **A restore that runs.** The round-trip is covered by tests that export, wipe the store and
 *    restore — because a backup nobody has restored is a hypothesis.
 *
 * Format (`RMLB` = Remote Lockdown Backup):
 *
 *     magic "RMLB" | version 1 byte | iv 12 bytes | AES-GCM ciphertext
 *
 * The magic+version are the additional authenticated data, so a byte flip in the header fails the
 * same check as a byte flip in the payload. This format is the Worker's own: it is not
 * byte-compatible with the Node server's on-disk backups, and a restore of one into the other is
 * not supported. Both stores can hold the same data, but the envelopes differ.
 */
import { listAdmins, saveAdmins } from './admin-auth';
import type { Admin } from './admin-auth';
import {
  COMMAND_INDEX_KEY, auditKey, commandDeviceIndexKey, commandKey, getAuditEntry,
  listAuditIndex, listCommandIds, listCommands, listDevices,
  listLocationIdsRaw, listLocationsForDevice, locationKey, putDevice, saveAuditIndex,
  saveLocationIndex,
} from './kv-store';
import type { AuditEntry, Command, Device, LocationReport } from './kv-store';
import type { Env } from './pbl/env';

export const BACKUP_PREFIX = 'backups/';
export const BACKUP_MAGIC = 'RMLB';
export const BACKUP_VERSION = 1;
export const DEFAULT_BACKUP_RETENTION_DAYS = 30;

const MAGIC_BYTES = new TextEncoder().encode(BACKUP_MAGIC);
const IV_BYTES = 12;

export interface BackupPayloadV1 {
  version: 1;
  createdAt: string;
  counts: Record<string, number>;
  devices: Device[];
  commands: Command[];
  locations: LocationReport[];
  audit: AuditEntry[];
  admins: Admin[];
}

export interface BackupSummary {
  ok: true;
  key: string;
  bytes: number;
  counts: Record<string, number>;
  pruned: number;
}

/** A refusal, with the reason a human needs: no bucket, or no encryption key. */
export interface BackupFailure {
  ok: false;
  reason: string;
}

export type BackupResult = BackupSummary | BackupFailure;

/**
 * Type guard for the refusal branch.
 *
 * Narrowing on `result.ok` alone is not reliable here: this project's tsconfig is not strict, so
 * the literal discriminants widen and the compiler keeps both branches. An explicit predicate
 * states the intent once instead of leaning on a compiler setting.
 */
export function backupFailed(result: BackupResult): result is BackupFailure {
  return result.ok !== true;
}

/** Retention window in days (default 30). Non-numeric falls back rather than keeping forever. */
export function backupRetentionDays(env: Env): number {
  const raw = Number.parseInt(String(env.BACKUP_RETENTION_DAYS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BACKUP_RETENTION_DAYS;
}

/**
 * The encryption key, or null when it is absent or malformed.
 *
 * A malformed key is treated as absent on purpose: deriving "something" from a short string would
 * produce a backup that looks fine and is protected by four characters.
 */
async function backupKey(env: Env): Promise<CryptoKey | null> {
  const hex = String(env.BACKUP_ENCRYPT_KEY ?? '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a payload into the RMLB envelope. */
export async function encryptBackup(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header = new Uint8Array(MAGIC_BYTES.length + 1);
  header.set(MAGIC_BYTES, 0);
  header[MAGIC_BYTES.length] = BACKUP_VERSION;

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, plaintext),
  );

  const out = new Uint8Array(header.length + IV_BYTES + ciphertext.length);
  out.set(header, 0);
  out.set(iv, header.length);
  out.set(ciphertext, header.length + IV_BYTES);
  return out;
}

/** Decrypt an RMLB envelope. Throws on a wrong key, a truncated file or an edited byte. */
export async function decryptBackup(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  const headerLength = MAGIC_BYTES.length + 1;
  if (blob.length <= headerLength + IV_BYTES) {
    throw new Error('backup is truncated');
  }
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (blob[i] !== MAGIC_BYTES[i]) throw new Error('not a backup file (bad magic)');
  }
  if (blob[MAGIC_BYTES.length] !== BACKUP_VERSION) {
    throw new Error(`unsupported backup version ${blob[MAGIC_BYTES.length]}`);
  }

  const header = blob.slice(0, headerLength);
  const iv = blob.slice(headerLength, headerLength + IV_BYTES);
  const ciphertext = blob.slice(headerLength + IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: header },
    key,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}

/** Read every durable entity into one payload. */
export async function collectBackup(env: Env, now: string = new Date().toISOString()): Promise<BackupPayloadV1> {
  const devices = await listDevices(env);
  const commands = await listCommands(env);
  const auditIndex = await listAuditIndex(env);
  const auditEntries = await Promise.all(auditIndex.map((entry) => getAuditEntry(env, entry.id)));
  const audit = auditEntries.filter((entry): entry is AuditEntry => entry !== null);

  const locations: LocationReport[] = [];
  for (const device of devices) {
    locations.push(...await listLocationsForDevice(env, device.id));
  }

  const admins = await listAdmins(env);

  return {
    version: 1,
    createdAt: now,
    counts: {
      devices: devices.length,
      commands: commands.length,
      locations: locations.length,
      audit: audit.length,
      admins: admins.length,
    },
    devices,
    commands,
    locations,
    audit,
    admins,
  };
}

function backupObjectKey(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${BACKUP_PREFIX}${stamp}.rmlb`;
}

/**
 * Collect, encrypt and store one backup. Never throws for a configuration problem: it returns
 * `{ ok: false, reason }` so the caller can audit it and carry on with the other cron passes.
 */
export async function writeBackup(
  env: Env,
  now: Date = new Date(),
): Promise<BackupResult> {
  if (!env.BACKUPS) {
    return { ok: false, reason: 'no BACKUPS bucket bound' };
  }
  const key = await backupKey(env);
  if (!key) {
    // Refusing is the whole point: an unencrypted backup of this store is a credential dump.
    return { ok: false, reason: 'BACKUP_ENCRYPT_KEY missing or not 64 hex characters — refusing to write a plaintext backup' };
  }

  const payload = await collectBackup(env, now.toISOString());
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await encryptBackup(key, plaintext);
  const objectKey = backupObjectKey(now);

  await env.BACKUPS.put(objectKey, encrypted, {
    customMetadata: {
      version: String(BACKUP_VERSION),
      createdAt: now.toISOString(),
      devices: String(payload.counts.devices),
      commands: String(payload.counts.commands),
    },
  });

  const pruned = await pruneBackups(env, now);
  return { ok: true, key: objectKey, bytes: encrypted.length, counts: payload.counts, pruned };
}

/** Delete backups older than the retention window. Returns how many were removed. */
export async function pruneBackups(env: Env, now: Date = new Date()): Promise<number> {
  if (!env.BACKUPS) return 0;
  const cutoff = now.getTime() - backupRetentionDays(env) * 86_400_000;
  const listed = await env.BACKUPS.list({ prefix: BACKUP_PREFIX });
  let removed = 0;
  for (const object of listed.objects) {
    const stamp = object.uploaded instanceof Date ? object.uploaded.getTime() : Date.parse(String(object.uploaded));
    if (Number.isFinite(stamp) && stamp < cutoff) {
      await env.BACKUPS.delete(object.key);
      removed += 1;
    }
  }
  return removed;
}

export interface RestoreSummary {
  ok: true;
  counts: Record<string, number>;
  createdAt: string;
}

/**
 * Decrypt and write a backup back into the store.
 *
 * Writes are idempotent per record id, so restoring the same backup twice is safe — but a restore
 * is not a merge: records written after the backup are left untouched, and deleted records are
 * not resurrected by anything other than this pass.
 */
export async function restoreBackup(env: Env, blob: Uint8Array): Promise<RestoreSummary> {
  const key = await backupKey(env);
  if (!key) {
    throw new Error('BACKUP_ENCRYPT_KEY missing or malformed — cannot decrypt a backup');
  }

  const plaintext = await decryptBackup(key, blob);
  let payload: BackupPayloadV1;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext)) as BackupPayloadV1;
  } catch (error) {
    // Authenticated encryption already guarantees these bytes are the ones that were written;
    // reaching here means the payload was produced by a different (or future) writer.
    throw new Error(`backup payload is not valid JSON: ${String(error)}`);
  }
  if (payload.version !== 1 || !Array.isArray(payload.devices)) {
    throw new Error('backup payload is not a v1 backup');
  }

  // Devices first: commands and locations reference them, and putDevice re-establishes the
  // per-device index and the api_key → device pointer that authentication depends on.
  for (const device of payload.devices) {
    await putDevice(env, device);
  }

  // Commands and locations are written as RECORDS IN ONE PASS, with each index written ONCE.
  //
  // The first version called createCommand()/addLocationReport() per record, and each of those
  // rewrites an index key. KV allows one write per second to the same key, so restoring a device
  // with 79 location reports produced 79 writes to `location_index:<device>` back to back and the
  // whole restore failed with `429 Too Many Requests`. Found by running the drill against
  // production with a 2-device / 79-report store — the smallest real fleet there is.
  //
  // Records land on distinct keys, so they are not rate limited; only the indexes were.
  const commandsByDevice = new Map<string, string[]>();
  for (const command of payload.commands) {
    await env.LOCKDOWN_KV.put(commandKey(command.id), JSON.stringify(command));
    const ids = commandsByDevice.get(command.device_id) ?? [];
    ids.push(command.id);
    commandsByDevice.set(command.device_id, ids);
  }
  if (payload.commands.length > 0) {
    const globalIds = await listCommandIds(env);
    await env.LOCKDOWN_KV.put(
      COMMAND_INDEX_KEY,
      JSON.stringify([...new Set([...globalIds, ...payload.commands.map((c) => c.id)])]),
    );
    for (const [deviceId, ids] of commandsByDevice) {
      // Read the raw index, not listCommandIdsForDevice(): the latter rebuilds and *persists* on a
      // miss, which would make this the second write to the same key in the same second — the exact
      // rate-limit shape the production drill hit. One read, one write.
      const raw = await env.LOCKDOWN_KV.get(commandDeviceIndexKey(deviceId));
      let existing: string[] = [];
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) existing = parsed.filter((id): id is string => typeof id === 'string');
        } catch {
          // Corrupt index: the ids being restored are a superset of what can be recovered here.
        }
      }
      await env.LOCKDOWN_KV.put(
        commandDeviceIndexKey(deviceId),
        JSON.stringify([...new Set([...existing, ...ids])]),
      );
    }
  }

  const locationsByDevice = new Map<string, string[]>();
  for (const location of payload.locations) {
    await env.LOCKDOWN_KV.put(locationKey(location.id), JSON.stringify(location));
    const ids = locationsByDevice.get(location.device_id) ?? [];
    ids.push(location.id);
    locationsByDevice.set(location.device_id, ids);
  }
  for (const [deviceId, ids] of locationsByDevice) {
    const existing = await listLocationIdsRaw(env, deviceId);
    // saveLocationIndex also re-applies the per-device history cap and deletes what falls off.
    await saveLocationIndex(env, deviceId, [...new Set([...existing, ...ids])]);
  }
  for (const entry of payload.audit) {
    await env.LOCKDOWN_KV.put(auditKey(entry.id), JSON.stringify(entry));
  }
  if (payload.audit.length > 0) {
    await saveAuditIndex(env, payload.audit.map((entry) => ({ id: entry.id, device_id: entry.device_id })));
  }
  if (payload.admins.length > 0) {
    await saveAdmins(env, payload.admins);
  }

  return { ok: true, counts: payload.counts, createdAt: payload.createdAt };
}

/** Backup objects currently in the bucket, newest first. */
export async function listBackups(
  env: Env,
): Promise<Array<{ key: string; uploaded: string; bytes: number }>> {
  if (!env.BACKUPS) return [];
  const listed = await env.BACKUPS.list({ prefix: BACKUP_PREFIX });
  return listed.objects
    .map((object) => ({
      key: object.key,
      uploaded: object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded),
      bytes: object.size,
    }))
    .sort((a, b) => b.key.localeCompare(a.key));
}

/** Fetch one backup object by key. */
export async function readBackup(env: Env, key: string): Promise<Uint8Array | null> {
  if (!env.BACKUPS) return null;
  if (!key.startsWith(BACKUP_PREFIX)) return null;
  const object = await env.BACKUPS.get(key);
  if (!object) return null;
  return new Uint8Array(await object.arrayBuffer());
}
