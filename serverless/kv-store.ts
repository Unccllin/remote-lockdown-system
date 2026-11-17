/**
 * The Worker's KV storage layer: one module per decision, one block of code.
 *
 * Extracted from worker.ts (S278) with the same goal as S277's split — that file was still 4,925
 * lines and this is its largest cohesive block. Everything here is the per-entity storage the last
 * five ADRs describe; the ADR comments travel with the code that implements them.
 *
 *   devices   ADR-003  device:<id> + device_index + agent_key:<hash>
 *   commands  ADR-002  command:<id> + command_index
 *   locations ADR-004  location:<id> + per-device index, capped per device
 *   audit     ADR-005  audit:<id> + one index carrying the device id
 *   secrets   ADR-006  encryption_keys:<deviceId>, bios_passwords:<deviceId>
 *
 * Depends only on `Env` and the zero-dependency helpers in `http.ts`; nothing here imports back
 * from worker.ts, which is what keeps the split acyclic.
 */
import type { Env } from './pbl/env';
import { generateId, parseKvJson, sha256, b64decode, b64encode } from './http';

export interface Device {
  id: string;
  hostname: string;
  owner_name: string;
  status: 'active' | 'stolen' | 'locked' | 'recovering' | 'tracking';
  mac_address: string | null;
  hardware_uuid: string | null;
  serial_number: string | null;
  /** Hardware model reported by the check-in (from firmware_audit); display only. */
  model?: string | null;
  last_checkin: string | null;
  enrolled_at: string;
  api_key_hash: string;
  // Optional link to the firmware-side PBL device_id (64 hex chars, C1 §4).
  // Absent for agents that were never matched to a PBL boot record.
  pbl_device_id?: string | null;
  // Populated from checkin metadata (KV-RACE-001), not stored on `devices`.
  firmware_audit?: Record<string, unknown> | null;
  firmware_audit_at?: string | null;
  // D-222: the agent's own version, reported at check-in. Nullable and absent for
  // pre-D-222 agents — "never reported" is a different fact from "on version X", and a
  // rollout cannot be verified if a missing value reads as compliance.
  agent_version?: string | null;
  agent_version_at?: string | null;
  // Derived on the way out (D-258): the device is checking in, but its version report is
  // absent or more than an hour behind that check-in — i.e. the build it runs does not
  // report a version at all. A never-checked-in device is "offline", not stale.
  agent_version_stale?: boolean;
  // update_verification: "signature" when the agent has a pinned update key and
  // will only apply detached-signature-verified updates, "sha256-only" when it
  // would accept whatever this backend serves (B-006). Reported per check-in so
  // the operator can see which devices are unauthenticated for updates.
  update_verification?: 'signature' | 'sha256-only' | 'key-unreadable';
}

/** A hardware-test artifact as stored in KV, after parsing an upload (D-129). */
export interface HwTestArtifact {
  // Serial, rendered as a decimal string: the dashboard validates /^\d+$/.
  id: string;
  device_id: string | null;
  admin_id: string | null;
  hostname: string | null;
  harness_version: string | null;
  agent_hash: string | null;
  total_tests: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  artifact_json: unknown;
  created_at: string;
}

/**
 * An artifact as *uploaded*, before it is normalised into HwTestArtifact.
 *
 * Two shapes are accepted on purpose: CTRF (`results.{tool,summary,extra}`) from
 * harness v2.0, and the legacy flat shape the harness emitted for months before
 * CTRF support landed. A rejected artifact on window day is a lost hardware run.
 */
export interface HwTestArtifactUpload {
  results?: {
    tool?: { name?: string; version?: string };
    summary?: HwTestSummary;
    extra?: { environment?: HwTestEnvironment };
  };
  harness_version?: string;
  summary?: HwTestSummary;
  environment?: HwTestEnvironment;
  [key: string]: unknown;
}

export interface HwTestSummary {
  tests?: number;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  errors?: number;
}

export interface HwTestEnvironment {
  hostname?: string;
  agent_binary_hash?: string;
  [key: string]: unknown;
}


export interface Command {
  id: string;
  device_id: string;
  command_type: 'lockdown' | 'unlock' | 'track' | 'stop_track';
  status: 'pending' | 'executed' | 'failed' | 'cancelled';
  created_at: string;
  executed_at: string | null;
  command_uuid: string | null;
  // T7/T8: opt-in pre-boot authentication, chosen by the operator on flag-stolen.
  // The agent sets an HP power-on password / BitLocker TPM+PIN when it is true.
  enable_pba?: boolean;
  // D-204 / E-EFFECTIVENESS: reported by the agent on ACK. `lockdown_effective`
  // is false when boot-lock was attempted but zero critical controls applied —
  // the device is encrypted-only, which must not read as a clean lockdown.
  boot_lock_status?: string | null;
  boot_lock_detail?: unknown;
  lockdown_effective?: boolean | null;
  // D-011: files the agent could not encrypt (open/locked). The dashboard shows
  // these so an operator does not believe a folder is encrypted when it is not.
  encryption_blocked_files?: unknown;
  // Session context for the lock that was applied (duress / interactive logging).
  lock_session_context?: unknown;
  // Duress code: when truthy on an unlock command, the agent pretends
  // to unlock but silently re-encrypts and re-locks after a delay.
  // Set by the admin via the "Release with Duress Code" dashboard option.
  duress_code?: boolean | null;
}

export interface EncryptionKey {
  device_id: string;
  command_id: string;
  key_material: string;
  /**
   * ISO timestamp of escrow. Optional because records written before S269 have
   * none; key selection must therefore fall back to array order (escrow appends),
   * which is why "newest" is the last element rather than a sorted first.
   */
  created_at?: string;
  released_at: string | null;
}

export interface LocationReport {
  /** Stable record id (ADR-004). Deterministic for migrated rows, generated for new ones. */
  id: string;
  device_id: string;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  source: string;
  city: string | null;
  region: string | null;
  country: string | null;
  ip_address: string | null;
  wifi_count: number | null;
  /**
   * When the agent says the reading was taken; absent on every row written before this
   * existed, and on every online report (only the offline-scan backfill sends one).
   */
  observed_at?: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  device_id: string;
  action: string;
  detail: string;
  created_at: string;
  hostname?: string;
  admin_username?: string;
}

// S4-serverless: BIOS/PBA credential store (mirrors server's bios_passwords
// table). The agent ACKs these during lockdown (bios_password → 'setup',
// power_on_password → 'power_on', bitlocker_pin → 'bitlocker_pin',
// bitlocker_recovery_password → 'bitlocker_recovery'). Stored plaintext in
// KV — same threat posture as the encryption_keys store; a KV_KEK envelope
// layer can be added uniformly later.
export interface BiosPassword {
  device_id: string;
  password_type: 'setup' | 'power_on' | 'bitlocker_pin' | 'bitlocker_recovery';
  password: string;
  created_at: string;
}

/** Group bios_password rows by type, most recent of each (server parity). */
export function groupPbaCredentials(rows: BiosPassword[]): {
  setup_password: string | null;
  power_on_password: string | null;
  bitlocker_pin: string | null;
  bitlocker_recovery_password: string | null;
} {
  const creds = {
    setup_password: null as string | null,
    power_on_password: null as string | null,
    bitlocker_pin: null as string | null,
    bitlocker_recovery_password: null as string | null,
  };
  // rows sorted newest-first; first of each type wins.
  for (const row of rows) {
    if (row.password_type === 'setup' && !creds.setup_password) creds.setup_password = row.password;
    else if (row.password_type === 'power_on' && !creds.power_on_password) creds.power_on_password = row.password;
    else if (row.password_type === 'bitlocker_pin' && !creds.bitlocker_pin) creds.bitlocker_pin = row.password;
    else if (row.password_type === 'bitlocker_recovery' && !creds.bitlocker_recovery_password) creds.bitlocker_recovery_password = row.password;
  }
  return creds;
}




// ---------------------------------------------------------------------------
// Admin auth — resolves a Bearer credential to an admin record.
//
// Accepts either a signed session token (issued by /api/auth/login) or the
// break-glass ADMIN_TOKEN env secret (which maps to a synthetic super-admin).
// Returns the authenticated admin claims (id, username, role) or null.
// ---------------------------------------------------------------------------

export const DEVICES_KEY = 'devices';
export const COMMANDS_KEY = 'commands';
export const KEYS_KEY = 'encryption_keys';
export const LOCATIONS_KEY = 'locations';
export const AUDIT_KEY = 'audit_log';
export const HW_ARTIFACTS_KEY = 'hw_test_artifacts';

// Agent release metadata for GET /api/agent/update, written at release time by
// CI (see serverless/README.md). It holds the version, the binary's sha256/size
// and the detached Ed25519 signature over "v1:{version}:{sha256}" — produced
// wherever the signing key lives, never in the Worker. The Worker only serves it,
// so it cannot drift from the signature's payload.
export const AGENT_RELEASE_KEY = 'agent_release';
export const BIOS_PASSWORDS_KEY = 'bios_passwords';

// KV-RACE-001: Checkin metadata is stored in a separate KV key from device
// status. This prevents the checkin handler's read-modify-write of the
// `devices` key from racing with the ACK handler's status update.
// The checkin handler writes ONLY to `device_checkin:{id}`, never to
// `devices`. Admin endpoints merge checkin metadata when returning device data.
export const CHECKIN_KEY_PREFIX = 'device_checkin:';

// ADR-003: a device is its own KV record, so a mutation writes one device instead of the
// whole fleet. `device_index` lists the ids (append-mostly, ids only), and `agent_key:<hash>`
// points at a device so authentication is one read rather than a scan of every device.
//
// `devices` is the legacy whole-list key: read once by the migration, deleted after.
export const DEVICE_INDEX_KEY = 'device_index';
export const DEVICE_KEY_PREFIX = 'device:';
export const AGENT_KEY_PREFIX = 'agent_key:';

/** KV key for one device record (ADR-003). */
export function deviceKey(id: string): string {
  return `${DEVICE_KEY_PREFIX}${id}`;
}

/** KV key for the API-key-hash → device-id pointer (ADR-003). */
export function agentKeyKey(hash: string): string {
  return `${AGENT_KEY_PREFIX}${hash}`;
}

/** One device record, or null when the key is absent or unreadable. */
export async function getDeviceRecord(env: Env, id: string): Promise<Device | null> {
  const data = await env.LOCKDOWN_KV.get(deviceKey(id));
  if (!data) return null;
  try {
    return JSON.parse(data) as Device;
  } catch {
    return null;
  }
}

/**
 * Ids of every device, migrating the legacy whole-list key on first read.
 *
 * Same lazy, idempotent migration ADR-002 used for commands: two isolates migrating at once
 * write identical `device:<id>` records and the same index, then both delete the legacy key.
 */
export async function listDeviceIds(env: Env): Promise<string[]> {
  const data = await env.LOCKDOWN_KV.get(DEVICE_INDEX_KEY);
  if (data) {
    try {
      const parsed: unknown = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
      }
    } catch {
      // Corrupt index: fall through and rebuild it from the legacy key if that exists.
    }
  }

  const legacy = await env.LOCKDOWN_KV.get(DEVICES_KEY);
  if (!legacy) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacy);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const devices = parsed.filter(
    (d): d is Device => !!d && typeof (d as Device).id === 'string',
  );
  if (devices.length === 0) return [];

  for (const device of devices) {
    await env.LOCKDOWN_KV.put(deviceKey(device.id), JSON.stringify(device));
    if (device.api_key_hash) {
      await env.LOCKDOWN_KV.put(agentKeyKey(device.api_key_hash), device.id);
    }
  }
  const ids = devices.map((d) => d.id);
  await env.LOCKDOWN_KV.put(DEVICE_INDEX_KEY, JSON.stringify(ids));
  await env.LOCKDOWN_KV.delete(DEVICES_KEY);
  return ids;
}

export async function listDevices(env: Env): Promise<Device[]> {
  const ids = await listDeviceIds(env);
  const records = await Promise.all(ids.map((id) => getDeviceRecord(env, id)));
  // An index entry whose record is gone — released, or an append that has not propagated
  // across colos yet — is skipped rather than thrown, the same tolerance the list read had.
  return records.filter((d): d is Device => d !== null);
}

/**
 * Write one device, and keep the two derived structures in step with it.
 *
 * The index append is skipped when the id is already there, and an id the index is missing is
 * re-appended on every write: a lost append would hide the device from `listDevices`, which on
 * `devices` means a check-in that 404s.
 *
 * The `agent_key:` mapping follows `api_key_hash`. When a device is re-keyed the old mapping is
 * deleted; a notification that still carries the old key then fails closed instead of
 * authenticating against a device it no longer belongs to.
 */
export async function putDevice(env: Env, device: Device): Promise<void> {
  const previous = await getDeviceRecord(env, device.id);
  await env.LOCKDOWN_KV.put(deviceKey(device.id), JSON.stringify(device));

  const ids = await listDeviceIds(env);
  if (!ids.includes(device.id)) {
    await env.LOCKDOWN_KV.put(DEVICE_INDEX_KEY, JSON.stringify([...ids, device.id]));
  }

  if (device.api_key_hash) {
    await env.LOCKDOWN_KV.put(agentKeyKey(device.api_key_hash), device.id);
  }
  const staleHash = previous?.api_key_hash;
  if (staleHash && staleHash !== device.api_key_hash) {
    await env.LOCKDOWN_KV.delete(agentKeyKey(staleHash));
  }
}

/** Remove one device and everything derived from it. */
export async function deleteDevice(env: Env, id: string): Promise<void> {
  const existing = await getDeviceRecord(env, id);
  await env.LOCKDOWN_KV.delete(deviceKey(id));
  if (existing?.api_key_hash) {
    await env.LOCKDOWN_KV.delete(agentKeyKey(existing.api_key_hash));
  }
  const ids = await listDeviceIds(env);
  if (ids.includes(id)) {
    await env.LOCKDOWN_KV.put(DEVICE_INDEX_KEY, JSON.stringify(ids.filter((x) => x !== id)));
  }
}

/**
 * The device that owns an API-key hash, in one read.
 *
 * `agent_key:<hash>` is a pointer, not the source of truth: the hash on the loaded record must
 * still match, so a stale pointer to a re-keyed device fails closed. When the pointer is absent
 * (a namespace written before ADR-003, or a lost append) the fleet is scanned once and the
 * pointer is healed — correctness first, then the fast path.
 */
export async function getDeviceByApiKeyHash(env: Env, keyHash: string): Promise<Device | null> {
  const id = await env.LOCKDOWN_KV.get(agentKeyKey(keyHash));
  if (id) {
    const device = await getDeviceRecord(env, id);
    if (device && device.api_key_hash === keyHash) return device;
  }

  const devices = await listDevices(env);
  const found = devices.find((d) => d.api_key_hash === keyHash);
  if (!found) return null;
  await env.LOCKDOWN_KV.put(agentKeyKey(keyHash), found.id);
  return found;
}

// Checkin metadata helpers — separate KV key per device.
// This is the fix for KV-RACE-001: the checkin handler writes to
// `device_checkin:{id}` instead of modifying the `devices` array,
// so it can never overwrite the ACK handler's status update.
export interface CheckinMetadata {
  last_checkin: string | null;
  mac_address: string | null;
  hardware_uuid: string | null;
  serial_number: string | null;
  // firmware_audit: per-device SPI/Secure-Boot recon sent by the agent's
  // firmware_audit module (PblPersistDxe delivery-path decision input).
  // Stored on the checkin-metadata KV key (not `devices`) so it survives the
  // KV-RACE-001 separation and is refreshed every checkin.
  firmware_audit?: Record<string, unknown> | null;
  firmware_audit_at?: string | null;
  // How the device verifies updates (B-006). Absent means it never reported one;
  // "unknown" is not the same fact as "unverified".
  update_verification?: 'signature' | 'sha256-only' | 'key-unreadable';
  // D-222: the agent's version. Stored on the checkin-metadata key for the same
  // KV-RACE-001 reason as everything else here, and timestamped so a stale report is
  // distinguishable from a current one.
  agent_version?: string | null;
  agent_version_at?: string | null;
}

/**
 * D-222: the agent version string, as reported at check-in.
 *
 * Bounded and charset-restricted because it is device-reported data the dashboard renders
 * verbatim. Anything that does not look like a version stays undefined (unknown) rather
 * than being stored, so a malformed value cannot read as compliance.
 */
/** Hardware model from a check-in's firmware_audit block, when present and non-empty. */
export function firmwareAuditModel(audit: unknown): string | null {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return null;
  const model = (audit as Record<string, unknown>)['model'];
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

export function normalizeAgentVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Accept only the two modes the agent can report.
 *
 * An unrecognised or absent value must stay null (unknown) rather than be coerced
 * — "unknown" and "unverified" are different facts, and the dashboard shows them
 * differently.
 */
export function normalizeUpdateVerification(
  value: unknown,
): 'signature' | 'sha256-only' | 'key-unreadable' | undefined {
  return value === 'signature' || value === 'sha256-only' || value === 'key-unreadable'
    ? value
    : undefined;
}

/**
 * A timestamp as written by either backend, in milliseconds (D-258).
 *
 * The Worker writes `new Date().toISOString()`, but a device first recorded by Express can carry
 * SQLite's zone-less `2026-11-05 10:00:00`, which V8 parses as *local* time. Zoneless values are
 * read as UTC — both backends write UTC — so the staleness window does not depend on where the
 * code runs.
 */
export function parseDbTimestamp(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const raw = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * How often an ACTIVE device should poll, in seconds.
 *
 * 60 rather than 300: the agent only learns about a queued command when it polls, so a
 * five-minute interval made flagging a device look inert for five minutes (S269).
 *
 * A function, not two literals, because the S269 fix landed in one response branch while
 * `ADAPTIVE_POLL` kept returning 300 from the other — measured on MOLE as
 * "Adaptive polling: 30s -> 300s (status=active)" AFTER the fix (S270). A change nobody
 * read back is a change nobody can rely on.
 */
export function activePollSeconds(env: Env): number {
  const raw = Number(env.ACTIVE_POLL_SECONDS ?? 60);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}


export const AGENT_VERSION_STALE_MS = 60 * 60 * 1000;

export function isAgentVersionStale(device: Device): boolean {
  const lastCheckin = parseDbTimestamp(device.last_checkin);
  if (lastCheckin === null) return false;
  const reported = parseDbTimestamp(device.agent_version_at);
  if (reported === null) return true;
  return lastCheckin - reported > AGENT_VERSION_STALE_MS;
}

export async function getCheckinMetadata(env: Env, deviceId: string): Promise<CheckinMetadata | null> {
  const data = await env.LOCKDOWN_KV.get(`${CHECKIN_KEY_PREFIX}${deviceId}`);
  return data ? parseKvJson<CheckinMetadata>(data, `${CHECKIN_KEY_PREFIX}${deviceId}`) : null;
}

export async function saveCheckinMetadata(env: Env, deviceId: string, metadata: CheckinMetadata): Promise<void> {
  await env.LOCKDOWN_KV.put(`${CHECKIN_KEY_PREFIX}${deviceId}`, JSON.stringify(metadata));
}

// Merge checkin metadata into a device object for admin API responses.
// Falls back to the device's own fields if no checkin metadata exists
// (e.g., for devices enrolled before the KV-RACE-001 fix).
export function mergeCheckinMetadata(device: Device, metadata: CheckinMetadata | null): Device {
  if (!metadata) return device;
  return {
    ...device,
    last_checkin: metadata.last_checkin ?? device.last_checkin,
    mac_address: metadata.mac_address ?? device.mac_address,
    hardware_uuid: metadata.hardware_uuid ?? device.hardware_uuid,
    serial_number: metadata.serial_number ?? device.serial_number,
    firmware_audit: metadata.firmware_audit ?? device.firmware_audit ?? null,
    firmware_audit_at: metadata.firmware_audit_at ?? device.firmware_audit_at ?? null,
    update_verification: metadata.update_verification ?? null,
    agent_version: metadata.agent_version ?? device.agent_version ?? null,
    agent_version_at: metadata.agent_version_at ?? device.agent_version_at ?? null,
    // Surface the hardware model the check-in reported. It only exists inside
    // firmware_audit, and nothing mapped it onto the device, so the UI showed its
    // 'no value' placeholder on every device.
    model: firmwareAuditModel(metadata.firmware_audit) ?? device.model ?? null,
    agent_version_stale: isAgentVersionStale({
      ...device,
      last_checkin: metadata.last_checkin ?? device.last_checkin,
      agent_version_at: metadata.agent_version_at ?? device.agent_version_at ?? null,
    }),
  };
}

export const COMMAND_INDEX_KEY = 'command_index';
export const COMMAND_KEY_PREFIX = 'command:';

/** KV key for one command record (ADR-002). */
export function commandKey(id: string): string {
  return `${COMMAND_KEY_PREFIX}${id}`;
}

/** One command record, or null when the key is absent or unreadable. */
export async function getCommand(env: Env, id: string): Promise<Command | null> {
  const data = await env.LOCKDOWN_KV.get(commandKey(id));
  if (!data) return null;
  try {
    return JSON.parse(data) as Command;
  } catch {
    return null;
  }
}

/**
 * Ids of every command, migrating the legacy whole-list key on first read.
 *
 * ADR-002: commands are per-entity records so an ACK cannot rewrite the list a concurrent
 * lock/flag was building. The migration is lazy and idempotent — two isolates migrating at
 * once write identical `command:<id>` records and the same index, then both delete the
 * legacy key.
 */
export async function listCommandIds(env: Env): Promise<string[]> {
  const data = await env.LOCKDOWN_KV.get(COMMAND_INDEX_KEY);
  if (data) {
    try {
      const parsed: unknown = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
      }
    } catch {
      // Corrupt index: fall through and rebuild it from the legacy key if that exists.
    }
  }

  const legacy = await env.LOCKDOWN_KV.get(COMMANDS_KEY);
  if (!legacy) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacy);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const commands = parsed.filter(
    (c): c is Command => !!c && typeof (c as Command).id === 'string',
  );
  if (commands.length === 0) return [];

  for (const command of commands) {
    await env.LOCKDOWN_KV.put(commandKey(command.id), JSON.stringify(command));
  }
  const ids = commands.map((c) => c.id);
  await env.LOCKDOWN_KV.put(COMMAND_INDEX_KEY, JSON.stringify(ids));
  await env.LOCKDOWN_KV.delete(COMMANDS_KEY);
  return ids;
}

export async function listCommands(env: Env): Promise<Command[]> {
  const ids = await listCommandIds(env);
  const records = await Promise.all(ids.map((id) => getCommand(env, id)));
  // An index entry whose record is gone — deleted, or an append that has not propagated
  // across colos yet — is skipped rather than thrown: a poll must not fail because one id
  // lagged, which is the same tolerance the list-based read had.
  return records.filter((c): c is Command => c !== null);
}

/** Remove every command belonging to a device, one record at a time. */
export async function deleteCommandsForDevice(env: Env, deviceId: string): Promise<number> {
  const ids = await listCommandIds(env);
  const keep: string[] = [];
  let removed = 0;
  for (const id of ids) {
    const command = await getCommand(env, id);
    if (command && command.device_id === deviceId) {
      await env.LOCKDOWN_KV.delete(commandKey(id));
      removed += 1;
    } else {
      keep.push(id);
    }
  }
  if (removed > 0) {
    await env.LOCKDOWN_KV.put(COMMAND_INDEX_KEY, JSON.stringify(keep));
  }
  return removed;
}

/**
 * How far a device's lock has actually got, derived rather than stored.
 *
 * `status: stolen` is set when a lockdown is QUEUED, so on its own it says what we asked for,
 * not what happened. A device that is offline when it is flagged keeps that status while
 * nothing on it has changed — measured on MOLE, and the reason this field exists (S271): an
 * operator must not tell anyone a laptop is locked when the machine never heard us.
 *
 * - `applied`  — a lockdown executed (evidence: the ACK)
 * - `applying` — queued, and the device checked in recently enough to pick it up
 * - `armed`    — queued, but the device has gone quiet: it will lock when it reconnects
 *                (or, if it heard the flag before going dark, after the 24 h deadman)
 * - `failed`   — a lockdown was attempted and reported failed
 * - `none`     — no lockdown in play, or an unlock came after it
 */
export const LOCK_STATE_FRESH_MS = 180_000;

export function lockStateFor(
  commands: Command[],
  // Narrow on purpose: this runs against the device as returned to the client, which has
  // `api_key_hash` stripped. Asking for the whole Device type would force the hash back in.
  device: { id: string; last_checkin?: string | null },
  now: number = Date.now(),
): 'applied' | 'applying' | 'armed' | 'failed' | 'none' {
  const forDevice = commands.filter((c) => c.device_id === device.id);
  const newest = (type: Command['command_type']): Command | undefined =>
    forDevice
      .filter((c) => c.command_type === type)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

  const lockdown = newest('lockdown');
  if (!lockdown) return 'none';

  const unlock = newest('unlock');
  if (unlock && String(unlock.created_at) >= String(lockdown.created_at)) return 'none';

  if (lockdown.status === 'executed') return 'applied';
  if (lockdown.status === 'failed') return 'failed';
  if (lockdown.status === 'cancelled') return 'none';

  // Pending: is the device reachable enough to fetch it on its next poll?
  const lastCheckin = device.last_checkin ? Date.parse(String(device.last_checkin)) : NaN;
  const fresh = Number.isFinite(lastCheckin) && now - lastCheckin <= LOCK_STATE_FRESH_MS;
  return fresh ? 'applying' : 'armed';
}

export async function createCommand(env: Env, command: Command): Promise<void> {
  await env.LOCKDOWN_KV.put(commandKey(command.id), JSON.stringify(command));
  const ids = await listCommandIds(env);
  if (!ids.includes(command.id)) {
    await env.LOCKDOWN_KV.put(COMMAND_INDEX_KEY, JSON.stringify([...ids, command.id]));
  }
}

/**
 * Apply a patch to one command. Returns the stored record, or null when it is gone.
 *
 * This is the point of ADR-002: an ACK reads and writes exactly one key, so it cannot
 * clobber a device/command list that another request is building from an older snapshot.
 */
export async function updateCommand(
  env: Env,
  id: string,
  patch: Partial<Command>,
): Promise<Command | null> {
  const current = await getCommand(env, id);
  if (!current) return null;
  const next: Command = { ...current, ...patch };
  await env.LOCKDOWN_KV.put(commandKey(id), JSON.stringify(next));
  return next;
}

// ADR-006: encryption keys and BIOS credentials are per-DEVICE collections. Every reader and
// writer of both stores already scopes to one device, so `device_id` is the partition — no index
// and no cap, because the population is the device set and the rows per device are single digits.
// Truncating secrets is the one thing a cap must never do: a lost key is an unrecoverable device.
export const KEYS_PREFIX = 'encryption_keys:';
export const BIOS_PASSWORDS_PREFIX = 'bios_passwords:';

export function keysKey(deviceId: string): string {
  return `${KEYS_PREFIX}${deviceId}`;
}

export function biosPasswordsKey(deviceId: string): string {
  return `${BIOS_PASSWORDS_PREFIX}${deviceId}`;
}

/**
 * Move the legacy whole lists into per-device keys, once per store.
 *
 * No ids are generated, so two isolates migrating at once write identical values.
 */
export async function migrateLegacyKeys(env: Env): Promise<void> {
  const legacy = await env.LOCKDOWN_KV.get(KEYS_KEY);
  if (!legacy) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacy);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  const rows = parsed.filter(
    (r): r is EncryptionKey => !!r && typeof (r as EncryptionKey).device_id === 'string',
  );
  const byDevice = new Map<string, EncryptionKey[]>();
  for (const row of rows) {
    const list = byDevice.get(row.device_id) ?? [];
    list.push(row);
    byDevice.set(row.device_id, list);
  }
  for (const [deviceId, deviceKeys] of byDevice) {
    const existing = await listKeysForDeviceRaw(env, deviceId);
    // Legacy rows are older than anything written after the change; keep both, oldest first.
    await env.LOCKDOWN_KV.put(
      keysKey(deviceId),
      JSON.stringify([...deviceKeys, ...existing]),
    );
  }
  await env.LOCKDOWN_KV.delete(KEYS_KEY);
}

/** One device's encryption keys, oldest first. No migration pass — the callers do that. */
export async function listKeysForDeviceRaw(env: Env, deviceId: string): Promise<EncryptionKey[]> {
  const data = await env.LOCKDOWN_KV.get(keysKey(deviceId));
  return data ? parseKvJson<EncryptionKey[]>(data, keysKey(deviceId)) : [];
}

/** One device's encryption keys, oldest first, migrating the legacy list on first read. */
export async function listKeysForDevice(env: Env, deviceId: string): Promise<EncryptionKey[]> {
  await migrateLegacyKeys(env);
  return listKeysForDeviceRaw(env, deviceId);
}

export async function saveKeysForDevice(
  env: Env,
  deviceId: string,
  keys: EncryptionKey[],
): Promise<void> {
  await env.LOCKDOWN_KV.put(keysKey(deviceId), JSON.stringify(keys));
}

export async function deleteKeysForDevice(env: Env, deviceId: string): Promise<void> {
  await env.LOCKDOWN_KV.delete(keysKey(deviceId));
}

// S4-serverless: secrets envelope for bios_passwords at rest. When KV_KEK
// is provisioned, each credential's `password` is AES-256-GCM-encrypted
// before it lands in KV and decrypted transparently on read. Rows written
// before KV_KEK existed (plaintext `password`) still read back — a row is
// treated as encrypted only when `password_enc` is present.
export interface StoredBiosPassword extends Omit<BiosPassword, 'password'> {
  password?: string;      // plaintext (legacy / no KEK)
  password_enc?: string;  // base64(nonce||ciphertext) when KV_KEK set
}

export async function getKek(env: Env): Promise<CryptoKey | null> {
  const kek = (env as { KV_KEK?: string }).KV_KEK;
  if (!kek) return null;
  const raw = b64decode(kek);
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encSecret(env: Env, plaintext: string): Promise<{ password_enc?: string; password?: string }> {
  const kek = await getKek(env);
  if (!kek) return { password: plaintext };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource }, kek, new TextEncoder().encode(plaintext));
  const blob = new Uint8Array(nonce.length + ct.byteLength);
  blob.set(nonce, 0);
  blob.set(new Uint8Array(ct), nonce.length);
  return { password_enc: b64encode(blob.buffer) };
}

export async function decSecret(env: Env, row: StoredBiosPassword): Promise<string> {
  if (row.password_enc) {
    const kek = await getKek(env);
    if (!kek) return ''; // encrypted but no KEK — can't decrypt
    const blob = b64decode(row.password_enc);
    const nonce = blob.slice(0, 12);
    const ct = blob.slice(12);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource }, kek, ct as BufferSource);
    return new TextDecoder().decode(pt);
  }
  return row.password ?? '';
}

/** Move the legacy BIOS-credential list into per-device keys, once. */
export async function migrateLegacyBiosPasswords(env: Env): Promise<void> {
  const legacy = await env.LOCKDOWN_KV.get(BIOS_PASSWORDS_KEY);
  if (!legacy) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacy);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  const rows = parsed.filter(
    (r): r is StoredBiosPassword =>
      !!r && typeof (r as StoredBiosPassword).device_id === 'string',
  );
  const byDevice = new Map<string, StoredBiosPassword[]>();
  for (const row of rows) {
    const list = byDevice.get(row.device_id) ?? [];
    list.push(row);
    byDevice.set(row.device_id, list);
  }
  for (const [deviceId, deviceRows] of byDevice) {
    const existing = await listStoredBiosPasswordsForDeviceRaw(env, deviceId);
    await env.LOCKDOWN_KV.put(
      biosPasswordsKey(deviceId),
      JSON.stringify([...deviceRows, ...existing]),
    );
  }
  await env.LOCKDOWN_KV.delete(BIOS_PASSWORDS_KEY);
}

export async function listStoredBiosPasswordsForDeviceRaw(
  env: Env,
  deviceId: string,
): Promise<StoredBiosPassword[]> {
  const data = await env.LOCKDOWN_KV.get(biosPasswordsKey(deviceId));
  return data
    ? parseKvJson<StoredBiosPassword[]>(data, biosPasswordsKey(deviceId))
    : [];
}

/** One device's BIOS/PBA credentials, decrypted. Migrates the legacy list on first read. */
export async function listBiosPasswordsForDevice(env: Env, deviceId: string): Promise<BiosPassword[]> {
  await migrateLegacyBiosPasswords(env);
  const stored = await listStoredBiosPasswordsForDeviceRaw(env, deviceId);
  const out: BiosPassword[] = [];
  for (const r of stored) {
    out.push({
      device_id: r.device_id,
      password_type: r.password_type,
      password: await decSecret(env, r),
      created_at: r.created_at,
    });
  }
  return out;
}

export async function saveBiosPasswordsForDevice(
  env: Env,
  deviceId: string,
  pws: BiosPassword[],
): Promise<void> {
  const stored: StoredBiosPassword[] = [];
  for (const p of pws) {
    const enc = await encSecret(env, p.password);
    stored.push({
      device_id: p.device_id,
      password_type: p.password_type,
      created_at: p.created_at,
      ...enc,
    });
  }
  await env.LOCKDOWN_KV.put(biosPasswordsKey(deviceId), JSON.stringify(stored));
}

export async function deleteBiosPasswordsForDevice(env: Env, deviceId: string): Promise<void> {
  await env.LOCKDOWN_KV.delete(biosPasswordsKey(deviceId));
}

// ADR-004: a location report is its own KV record, and the index is PER DEVICE — so two
// devices in tracking cannot push each other out of a shared window, and a report never
// rewrites the fleet's history. `locations` is the legacy whole list: migrated once, deleted.
export const LOCATION_KEY_PREFIX = 'location:';
export const LOCATION_INDEX_PREFIX = 'location_index:';

/**
 * How many reports one device keeps.
 *
 * 500 × the 30 s tracking poll ≈ 4 hours of continuous trail. The old shape was ONE list capped
 * at 1000 rows for the whole fleet — 16 reports per device at 60 devices, about 8 minutes — so a
 * device that went dark kept almost nothing and the chattiest device starved the rest. Bounded
 * on purpose: nothing sweeps these keys, and an unbounded trail is a privacy liability as much
 * as a storage cost.
 */
export const LOCATION_HISTORY_LIMIT = 500;

/**
 * The per-device cap, overridable the same way `ACTIVE_POLL_SECONDS` is — a limit nothing can
 * exercise is a limit nobody has seen work. Read per call, so a test (or an operator trimming
 * retention) does not need a different build.
 */
export function locationHistoryLimit(env: Env): number {
  const raw = Number(env.LOCATION_HISTORY_LIMIT ?? LOCATION_HISTORY_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : LOCATION_HISTORY_LIMIT;
}

/** KV key for one location report (ADR-004). */
export function locationKey(id: string): string {
  return `${LOCATION_KEY_PREFIX}${id}`;
}

/** KV key for one device's report ids, oldest first (ADR-004). */
export function locationIndexKey(deviceId: string): string {
  return `${LOCATION_INDEX_PREFIX}${deviceId}`;
}

/** One report, or null when the key is absent or unreadable. */
export async function getLocationReport(env: Env, id: string): Promise<LocationReport | null> {
  const data = await env.LOCKDOWN_KV.get(locationKey(id));
  if (!data) return null;
  try {
    return JSON.parse(data) as LocationReport;
  } catch {
    return null;
  }
}

/**
 * A stable id for a row in the legacy list.
 *
 * Deterministic on purpose: two isolates migrating at the same moment then write the same keys
 * instead of duplicating every report, which `generateId()` would do.
 */
export async function legacyLocationId(row: LocationReport): Promise<string> {
  const material = JSON.stringify([
    row.device_id,
    row.created_at,
    row.observed_at ?? null,
    row.latitude,
    row.longitude,
    row.city,
  ]);
  return `loc-${(await sha256(material)).slice(0, 24)}`;
}

/**
 * Move the legacy whole-list key into per-report records, once.
 *
 * Legacy rows are older than anything written after the change, so their ids go in front of
 * whatever index a device already has — that keeps the oldest-first order the read paths rely
 * on even if a device reported before the first location read triggered this.
 */
export async function migrateLegacyLocations(env: Env): Promise<void> {
  const legacy = await env.LOCKDOWN_KV.get(LOCATIONS_KEY);
  if (!legacy) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacy);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;

  const rows = parsed.filter(
    (r): r is LocationReport => !!r && typeof (r as LocationReport).device_id === 'string',
  );

  const legacyIdsByDevice = new Map<string, string[]>();
  for (const row of rows) {
    const id = await legacyLocationId(row);
    await env.LOCKDOWN_KV.put(locationKey(id), JSON.stringify({ ...row, id }));
    const ids = legacyIdsByDevice.get(row.device_id) ?? [];
    ids.push(id);
    legacyIdsByDevice.set(row.device_id, ids);
  }

  for (const [deviceId, legacyIds] of legacyIdsByDevice) {
    const existing = await listLocationIdsRaw(env, deviceId);
    const merged = [...legacyIds, ...existing.filter((id) => !legacyIds.includes(id))];
    await saveLocationIndex(env, deviceId, merged);
  }

  await env.LOCKDOWN_KV.delete(LOCATIONS_KEY);
}

/** One device's report ids, oldest first. No migration pass — the read paths do that. */
export async function listLocationIdsRaw(env: Env, deviceId: string): Promise<string[]> {
  const data = await env.LOCKDOWN_KV.get(locationIndexKey(deviceId));
  if (!data) return [];
  try {
    const parsed: unknown = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
    }
  } catch {
    // Corrupt index: treat as empty rather than failing the request.
  }
  return [];
}

/**
 * Persist a device's index, deleting the records that fall off the end.
 *
 * Trimming the records (not just the index) is what keeps the key count bounded: a command is
 * rewritten in place, but a report is immutable, so an id dropped from the index would otherwise
 * leave its record behind forever.
 */
export async function saveLocationIndex(env: Env, deviceId: string, ids: string[]): Promise<void> {
  const kept = ids.slice(-locationHistoryLimit(env));
  const evicted = ids.slice(0, Math.max(0, ids.length - kept.length));
  await env.LOCKDOWN_KV.put(locationIndexKey(deviceId), JSON.stringify(kept));
  for (const id of evicted) {
    await env.LOCKDOWN_KV.delete(locationKey(id));
  }
}

/** One device's reports, oldest first. */
export async function listLocationsForDevice(env: Env, deviceId: string): Promise<LocationReport[]> {
  await migrateLegacyLocations(env);
  const ids = await listLocationIdsRaw(env, deviceId);
  const records = await Promise.all(ids.map((id) => getLocationReport(env, id)));
  return records.filter((r): r is LocationReport => r !== null);
}

/** Append one report for one device. */
export async function addLocationReport(env: Env, report: LocationReport): Promise<void> {
  await env.LOCKDOWN_KV.put(locationKey(report.id), JSON.stringify(report));
  const ids = await listLocationIdsRaw(env, report.device_id);
  await saveLocationIndex(env, report.device_id, [...ids, report.id]);
}

/** Remove every report belonging to a device, plus its index. */
export async function deleteLocationsForDevice(env: Env, deviceId: string): Promise<number> {
  // Migrate first: rows still sitting in the legacy list would otherwise be re-indexed to a
  // device that no longer exists.
  await migrateLegacyLocations(env);
  const ids = await listLocationIdsRaw(env, deviceId);
  for (const id of ids) {
    await env.LOCKDOWN_KV.delete(locationKey(id));
  }
  if (ids.length > 0) {
    await env.LOCKDOWN_KV.delete(locationIndexKey(deviceId));
  }
  return ids.length;
}

export async function saveHwArtifacts(env: Env, artifacts: HwTestArtifact[]): Promise<void> {
  await env.LOCKDOWN_KV.put(HW_ARTIFACTS_KEY, JSON.stringify(artifacts));
}

// ADR-005: an audit entry is its own record, behind ONE capped index. `audit_log` is the legacy
// whole list: migrated once, deleted.
export const AUDIT_KEY_PREFIX = 'audit:';
export const AUDIT_INDEX_KEY = 'audit_index';

/**
 * How many audit entries are retained.
 *
 * Twice the old 500, because the old cap was one window for the whole fleet and an entry is
 * small. Overridable as a `[vars]` entry like LOCATION_HISTORY_LIMIT — the pruning path is only
 * reachable by crossing the limit, so a limit nothing can cross is a limit nobody has seen work.
 */
export const AUDIT_HISTORY_LIMIT = 1000;

export function auditHistoryLimit(env: Env): number {
  const raw = Number(env.AUDIT_HISTORY_LIMIT ?? AUDIT_HISTORY_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : AUDIT_HISTORY_LIMIT;
}

/** An index entry: the id, plus the device it belongs to so a scoped read needs no records. */
export interface AuditIndexEntry {
  id: string;
  device_id: string;
}

/** KV key for one audit entry (ADR-005). */
export function auditKey(id: string): string {
  return `${AUDIT_KEY_PREFIX}${id}`;
}

/** One audit entry, or null when the key is absent or unreadable. */
export async function getAuditEntry(env: Env, id: string): Promise<AuditEntry | null> {
  const data = await env.LOCKDOWN_KV.get(auditKey(id));
  if (!data) return null;
  try {
    return JSON.parse(data) as AuditEntry;
  } catch {
    return null;
  }
}

/**
 * A stable id for a row in the legacy list.
 *
 * Deterministic so two isolates migrating at once write the same keys instead of duplicating
 * every entry — `generateId()` would double them.
 */
export async function legacyAuditId(row: AuditEntry): Promise<string> {
  const material = JSON.stringify([row.device_id, row.action, row.detail, row.created_at]);
  return `aud-${(await sha256(material)).slice(0, 24)}`;
}

/** The index, oldest first, migrating the legacy whole-list key on first use. */
export async function listAuditIndex(env: Env): Promise<AuditIndexEntry[]> {
  const data = await env.LOCKDOWN_KV.get(AUDIT_INDEX_KEY);
  if (data) {
    try {
      const parsed: unknown = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (e): e is AuditIndexEntry =>
            !!e && typeof (e as AuditIndexEntry).id === 'string',
        );
      }
    } catch {
      // Corrupt index: fall through and rebuild it from the legacy key if that exists.
    }
  }

  const legacy = await env.LOCKDOWN_KV.get(AUDIT_KEY);
  if (!legacy) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacy);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const rows = parsed.filter(
    (r): r is AuditEntry => !!r && typeof (r as AuditEntry).device_id === 'string',
  );
  if (rows.length === 0) return [];

  const index: AuditIndexEntry[] = [];
  for (const row of rows) {
    const id = await legacyAuditId(row);
    await env.LOCKDOWN_KV.put(auditKey(id), JSON.stringify({ ...row, id }));
    index.push({ id, device_id: row.device_id });
  }
  await saveAuditIndex(env, index);
  await env.LOCKDOWN_KV.delete(AUDIT_KEY);
  return index.slice(-auditHistoryLimit(env));
}

/**
 * Persist the index, deleting the records that fall off the end.
 *
 * Entries are immutable except for the release amendment, so a pruned id must take its record
 * with it or the key count would grow forever.
 */
export async function saveAuditIndex(env: Env, index: AuditIndexEntry[]): Promise<void> {
  const kept = index.slice(-auditHistoryLimit(env));
  const evicted = index.slice(0, Math.max(0, index.length - kept.length));
  await env.LOCKDOWN_KV.put(AUDIT_INDEX_KEY, JSON.stringify(kept));
  for (const entry of evicted) {
    await env.LOCKDOWN_KV.delete(auditKey(entry.id));
  }
}

/**
 * Record one audit entry.
 *
 * ADR-005: the hostname comes from this device's record — one get — instead of scanning the
 * fleet, which since ADR-003 was one index get plus one get per device on every mutation.
 */
export async function addAuditEntry(env: Env, deviceId: string, action: string, detail: string): Promise<void> {
  const device = await getDeviceRecord(env, deviceId);
  const entry: AuditEntry = {
    id: generateId(),
    device_id: deviceId,
    action,
    detail,
    created_at: new Date().toISOString(),
    hostname: device?.hostname || null,
    admin_username: 'admin',
  };
  await env.LOCKDOWN_KV.put(auditKey(entry.id), JSON.stringify(entry));
  const index = await listAuditIndex(env);
  await saveAuditIndex(env, [...index, { id: entry.id, device_id: deviceId }]);
}
