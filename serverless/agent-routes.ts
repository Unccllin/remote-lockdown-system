/**
 * The agent-facing routes: check-in, command ACK, key escrow, deadman report, location report.
 *
 * Extracted from worker.ts (S280). This is the agent protocol — the five handlers the Python
 * agent calls, mirroring the Express server's `/api/agent/*` routes so that either backend is a
 * drop-in for the agent. The contract they implement is why they move together: a check-in
 * releases the escrowed key, an ACK records which enforcement path actually ran, and the deadman
 * and location reports are the same credential on a different schedule.
 *
 * `verifyAgentAuth` (HMAC-SHA256 over `{timestamp}:{nonce}:{body_sha256}`, matching the agent's
 * `sign_headers()` and the Express `hmacAuth.js`) lives here because this module owns the agent
 * credential. It is exported: the ping, agent-update, EFS-cert and binary-download handlers still
 * in worker.ts authenticate the same way, and one verifier is the point.
 *
 * Deliberately NOT here: `serializeMutation`. The dispatcher wraps these handlers with it and the
 * admin mutations use it too, so the chain stays in worker.ts where both callers already reach
 * it — this module imports nothing from worker.ts, which is what keeps the split acyclic.
 */
import type { Env } from './pbl/env';
import {
  errorResponse, generateId, hmacSha256, jsonResponse, parseJsonBody, sha256, timingSafeEqualStr,
} from './http';
import {
  BiosPassword, Command, Device, LocationReport, activePollSeconds, addAuditEntry,
  addLocationReport, getCheckinMetadata, getCommand, getDeviceByApiKeyHash,
  groupPbaCredentials, listBiosPasswordsForDevice, listCommandsForDevice, listKeysForDevice,
  normalizeAgentVersion, normalizeUpdateVerification, putDevice, rememberNonce,
  saveBiosPasswordsForDevice, saveCheckinMetadata, saveKeysForDevice, updateCommand, watchKv,
} from './kv-store';

// ---------------------------------------------------------------------------
// Agent auth (HMAC-SHA256)
// ---------------------------------------------------------------------------

export async function verifyAgentAuth(
  request: Request,
  env: Env,
  body: string,
): Promise<Device | null> {
  const agentKey = request.headers.get('X-Agent-Key');
  const timestamp = request.headers.get('X-Timestamp');
  const nonce = request.headers.get('X-Nonce');
  const signature = request.headers.get('X-Signature');

  if (!agentKey || !timestamp || !nonce || !signature) {
    return null;
  }

  // Nonce format — same contract as the Node server's hmacAuth.js (32 hex chars). Without it an
  // empty or 4 KB nonce would be accepted, and then used as a KV key.
  if (!/^[0-9a-f]{32}$/i.test(nonce)) {
    return null;
  }

  // Find device by API key hash. ADR-003: one read through the `agent_key:` pointer, instead
  // of a scan of every device on every agent request.
  const keyHash = await sha256(agentKey);
  const device = await getDeviceByApiKeyHash(env, keyHash);
  if (!device) {
    return null;
  }

  // Verify HMAC signature
  // Signature = HMAC-SHA256(agent_key, "{timestamp}:{nonce}:{body_sha256}")
  // This matches the agent's sign_headers() format and the full server's
  // hmacAuth.js verifyHmac() — so the same agent can talk to either backend.
  const bodyHash = await sha256(body);
  const expectedSig = await hmacSha256(agentKey, `${timestamp}:${nonce}:${bodyHash}`);
  // Constant-time (review S7): the signature is derived from the device's secret key, so a plain
  // `!==` leaks how much of a forged signature matched.
  if (!timingSafeEqualStr(signature, expectedSig)) {
    return null;
  }

  // Check timestamp freshness. The window is also the replay window: a nonce is remembered
  // for exactly this long, because a request older than it is already refused above.
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  const window = signatureWindowSeconds(env);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > window) {
    return null;
  }

  // Replay protection. The Node server keeps a process-local nonce cache; a Worker has no such
  // memory, so the nonce is recorded in KV for the length of the signature window.
  //
  // Stated honestly: KV is eventually consistent across colos, so two replays arriving in
  // different locations at the same moment can both pass. This narrows the window rather than
  // closing it — an authoritative fix is a unique index in a relational store (see
  // docs/SERVERLESS-COST.md). `REPLAY_PROTECTION=off` exists for a staged rollout, not as a
  // supported production setting.
  if (String(env.REPLAY_PROTECTION ?? '').toLowerCase() !== 'off') {
    const fresh = await rememberNonce(env, device.id, nonce, window);
    if (!fresh) return null;
  }

  return device;
}

/** The signature freshness window in seconds (default 300, matching the Node server). */
export function signatureWindowSeconds(env: Env): number {
  const raw = Number.parseInt(String(env.HMAC_TIMESTAMP_WINDOW_SECONDS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}
/**
 * Agent-compatible checkin — matches the full server's /api/agent/checkin
 * response shape so the agent doesn't need to know which backend it's
 * talking to.
 *
 * Response: { device_id, status, poll_interval, command: { id, type,
 *   command_uuid, key_material, bios_password, power_on_password,
 *   enable_pba, ... } | null }
 *
 * For unlock commands, the encryption key + BIOS password are released
 * in the response (same as the full server's fetchUnlockMaterials).
 */
async function agentRuntimeSettings(env: Env): Promise<{ google_api_key: string | null; revision: string } | undefined> {
  if (env.GOOGLE_API_KEY === undefined) return undefined;
  const raw = env.GOOGLE_API_KEY;
  const key = (raw || '').trim();
  const google_api_key = key === '' ? null : key;
  const canonical = JSON.stringify({ google_api_key });
  const buf = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return { google_api_key, revision: hex.slice(0, 16) };
}

export async function handleAgentCheckin(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  // D-225: every KV step below is watched, because a KV operation that never settles is what
  // wedged this route for 25 minutes in production and left no trace of which one it was. The
  // label names the step, not the store, so a stall report says what to look at.
  const device = await watchKv('checkin.auth', () => verifyAgentAuth(request, env, body));
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const payload = parseJsonBody(body);
  if (!payload) return errorResponse('Invalid JSON body', 400);
  const { mac_address, hardware_uuid, serial_number } = payload;
  // firmware_audit: optional per-device SPI/Secure-Boot recon (PblPersistDxe
  // delivery-path decision). Validate it is a plain object — same contract
  // as the Express server (agent.js): malformed/non-object → null, still
  // records the checkin (partial data is still useful posture signal).
  const firmwareAudit = (payload.firmware_audit
    && typeof payload.firmware_audit === 'object'
    && !Array.isArray(payload.firmware_audit))
    ? payload.firmware_audit as Record<string, unknown>
    : null;

  // KV-RACE-001: write check-in metadata to `device_checkin:<id>`, never to the device record,
  // so a check-in cannot overwrite an ACK's status write.
  //
  // ADR-003: `device` is the record verifyAgentAuth just loaded — one read. Reading the fleet
  // here to find it again would cost one get per device on the hottest path in the system.
  // Save checkin metadata to a separate KV key (the fix for KV-RACE-001)
  // update_verification falls back to the stored value when this check-in omits
  // it, mirroring the Express server's `COALESCE($6, update_verification)`: an
  // older agent must not reset a known mode to "unknown" on every check-in.
  const existingMetadata = await watchKv('checkin.metadata.get', () =>
    getCheckinMetadata(env, device.id),
  );
  await watchKv('checkin.metadata.put', () =>
    saveCheckinMetadata(env, device.id, {
    last_checkin: new Date().toISOString(),
    mac_address: mac_address || device.mac_address,
    hardware_uuid: hardware_uuid || device.hardware_uuid,
    serial_number: serial_number || device.serial_number,
    firmware_audit: firmwareAudit,
    firmware_audit_at: firmwareAudit ? new Date().toISOString() : null,
    update_verification:
      normalizeUpdateVerification(payload.update_verification)
      ?? existingMetadata?.update_verification,
    // D-222: same rule as update_verification — a pre-D-222 agent that omits the field
    // must not erase a version an earlier check-in reported.
    // The agent reports its build as the X-Agent-Version header (agent.py:3437); reading only
    // payload.agent_version left this null forever, so the dashboard's Agent column was blank.
    agent_version: normalizeAgentVersion(payload.agent_version ?? request.headers.get('X-Agent-Version')) ?? existingMetadata?.agent_version,
    agent_version_at: normalizeAgentVersion(payload.agent_version ?? request.headers.get('X-Agent-Version'))
      ? new Date().toISOString()
      : (existingMetadata?.agent_version_at ?? null),
    }),
  );
  // The check-in deliberately writes NO device record: it updates only `device_checkin:<id>`,
  // so it cannot race with an ACK's status write on `device:<id>` (KV-RACE-001, ADR-003).

  // Check for pending commands (oldest first). Per-device index, not the global one:
  // the global read costs one key per command in the fleet on every poll (S348).
  const commands = await watchKv('checkin.commands.list', () =>
    listCommandsForDevice(env, device.id),
  );
  const pendingCmds = commands
    .filter((c) => c.device_id === device.id && c.status === 'pending')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const pendingCmd = pendingCmds[0] || null;

  // Adaptive poll interval based on device status. `active` comes from
  // activePollSeconds() so both response branches agree.
  const status = device.status;
  const ADAPTIVE_POLL: Record<string, number> = {
    stolen: 30, tracking: 30, recovering: 30, locked: 60, active: activePollSeconds(env),
  };
  const pollInterval = ADAPTIVE_POLL[status] ?? activePollSeconds(env);

  const runtimeSettings = await agentRuntimeSettings(env);

  if (!pendingCmd) {
    return jsonResponse({
      device_id: device.id,
      status,
      poll_interval: pollInterval,
      command: null,
      ...(runtimeSettings ? { settings: runtimeSettings } : {}),
    });
  }

  // For unlock commands, fetch the encryption key + BIOS password.
  // The key is stored in KV when the agent ACKed the lockdown. We return
  // it to the agent so it can decrypt the files. This matches the full
  // server's fetchUnlockMaterials() — the key is not "gated" by a release
  // flag; it's just returned when an unlock command is pending.
  let keyMaterial: string | null = null;
  let biosPassword: string | null = null;
  let powerOnPassword: string | null = null;
  let bitlockerPin: string | null = null;
  let bitlockerRecoveryPassword: string | null = null;
  if (pendingCmd.command_type === 'unlock') {
    const keys = await listKeysForDevice(env, device.id);
    // Find the most recent key for this device (lockdown ACK key, not
    // deadman key). Match by device_id and exclude the synthetic 'deadman'
    // command_id. Sort by created_at implicitly via array order (most
    // recently pushed is last, but we search all and pick the first match).
    // Newest first. `find()` returns the FIRST match, which is the OLDEST escrowed
    // key: after a second lockdown the agent was handed the previous key and
    // decryption failed with cryptography.fernet.InvalidToken while the correct key
    // sat in KV (S269). Escrow appends, so the last element is the newest; created_at
    // is used when present because it is the explicit ordering.
    const deviceKeys = keys
      .filter((k) => k.device_id === device.id && k.command_id !== 'deadman')
      .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
    const deviceKey = deviceKeys.length ? deviceKeys[deviceKeys.length - 1] : undefined;
    if (deviceKey) {
      keyMaterial = deviceKey.key_material;
      // Mark as released for tracking purposes (the agent has it now)
      if (!deviceKey.released_at) {
        deviceKey.released_at = new Date().toISOString();
        await saveKeysForDevice(env, device.id, keys);
      }
    }
    // S4-serverless: fetch the stored BIOS/PBA credentials the agent needs
    // to remove UEFI lockdown (setup + power-on) and that the dashboard
    // shows in the PBA Recovery panel (bitlocker pin + recovery).
    const devicePws = (await listBiosPasswordsForDevice(env, device.id)).sort((a, b) =>
      b.created_at.localeCompare(a.created_at));
    const creds = groupPbaCredentials(devicePws);
    biosPassword = creds.setup_password;
    powerOnPassword = creds.power_on_password;
    bitlockerPin = creds.bitlocker_pin;
    bitlockerRecoveryPassword = creds.bitlocker_recovery_password;
  }

  return jsonResponse({
    device_id: device.id,
    status,
    poll_interval: pendingCmd.command_type === 'unlock' ? 30 : pollInterval,
    command: {
      id: pendingCmd.id,
      type: pendingCmd.command_type,
      command_uuid: pendingCmd.command_uuid || null,
      key_material: keyMaterial,
      bios_password: biosPassword,
      power_on_password: powerOnPassword,
      // Was hardcoded false, so the opt-in flag the operator sets at flag-stolen
      // never reached the agent: PBA was silently never enabled on this backend.
      enable_pba: pendingCmd.enable_pba === true,
      bitlocker_pin: bitlockerPin,
      bitlocker_recovery_password: bitlockerRecoveryPassword,
      // Duress code: forwarded from the queued unlock command so the
      // agent knows to pretend-unlock and silently re-lock.
      duress_code: pendingCmd.duress_code ?? null,
    },
    ...(runtimeSettings ? { settings: runtimeSettings } : {}),
  });
}

/**
 * Agent-compatible deadman report — matches the full server's
 * /api/agent/deadman-report. Stores the encryption key and marks the
 * device as locked.
 */
export async function handleDeadmanReport(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const device = await verifyAgentAuth(request, env, body);
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const payload = parseJsonBody(body);
  if (!payload) return errorResponse('Invalid JSON body', 400);
  const { key_material } = payload;

  if (!key_material) {
    return errorResponse('key_material required', 400);
  }

  // Store the encryption key (idempotent — replace if exists for this device)
  const keys = await listKeysForDevice(env, device.id);
  const filtered = keys.filter((k) => k.command_id !== 'deadman');
  filtered.push({
    device_id: device.id,
    command_id: 'deadman',
    key_material,
    released_at: null,
  });
  await saveKeysForDevice(env, device.id, filtered);

  // Mark device as locked (the deadman switch actually encrypted it). ADR-003: one device.
  device.status = 'locked';
  await putDevice(env, device);

  console.log('Deadman report: device=%s key stored, status=locked', device.hostname);
  return jsonResponse({ ok: true });
}

/**
 * Agent-compatible location report — stores location data in KV.
 *
 * `observed_at` (top level of the body, not inside `location`) is the time the scan was taken,
 * sent only when a device resolves a scan it took while offline. Mirrors the Express route: an
 * unusable or future value is dropped rather than stored, so the read side falls back to receipt
 * time instead of pinning the device somewhere it will be tomorrow.
 */
const OBSERVED_AT_MAX_SKEW_MS = 5 * 60 * 1000;

function normalizeObservedAt(value: unknown, now: number = Date.now()): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (ms > now + OBSERVED_AT_MAX_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

/** The time a location row describes: the scan time when the agent sent one, else receipt. */
export function locationTime(l: LocationReport): string {
  return l.observed_at || l.created_at;
}

export async function handleAgentLocation(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const device = await verifyAgentAuth(request, env, body);
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const payload = parseJsonBody(body);
  if (!payload) return errorResponse('Invalid JSON body', 400);
  const { location } = payload;
  if (!location) {
    return errorResponse('location required', 400);
  }

  await addLocationReport(env, {
    id: generateId(),
    device_id: device.id,
    latitude: location.latitude ?? null,
    longitude: location.longitude ?? null,
    accuracy_meters: location.accuracy_meters ?? null,
    source: location.source || 'ip',
    city: location.city ?? null,
    region: location.region ?? null,
    country: location.country ?? null,
    ip_address: location.ip ?? null,
    wifi_count: location.wifi_count ?? null,
    observed_at: normalizeObservedAt(payload.observed_at),
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true });
}

export async function handleCommandAck(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const device = await verifyAgentAuth(request, env, body);
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const payload = parseJsonBody(body);
  if (!payload) return errorResponse('Invalid JSON body', 400);
  const {
    command_id,
    result_status,
    key_material,
    bios_password,
    power_on_password,
    bitlocker_pin,
    bitlocker_recovery_password,
    boot_lock_status,
    boot_lock_detail,
    encryption_blocked_files,
    lock_session_context,
  } = payload;

  if (!command_id || !result_status) {
    return errorResponse('command_id and result_status required', 400);
  }

  // Update command status. One command, one key (ADR-002): this used to read and rewrite
  // the whole list, so an ACK and a concurrent lock/flag overwrote each other's fields.
  const command = await getCommand(env, command_id);
  if (!command || command.device_id !== device.id) {
    return errorResponse('Command not found', 404);
  }

  // Idempotent: if already executed, return success
  if (command.status === 'executed') {
    return jsonResponse({ ok: true, deduplicated: true });
  }

  // E-EFFECTIVENESS: a lockdown that reports boot-lock attempted with zero
  // critical controls applied is NOT effective — the device is encrypted-only.
  // The rule is Express's (server/src/routes/agent.js:411-418). This handler used
  // to destructure boot_lock_detail and discard it, so on the serverless backend
  // every silently no-op'd boot-lock was recorded as a plain success.
  let lockdownEffective: boolean | null = null;
  if (result_status === 'executed' && command.command_type === 'lockdown' && boot_lock_detail) {
    const detail = boot_lock_detail as {
      boot_lock_attempted?: unknown;
      critical_applied_total?: unknown;
    };
    if (detail.boot_lock_attempted === true) {
      const criticalTotal =
        typeof detail.critical_applied_total === 'number' ? detail.critical_applied_total : 0;
      lockdownEffective = criticalTotal > 0;
    }
  }

  const confirmed = (await updateCommand(env, command_id, {
    status: result_status,
    executed_at: new Date().toISOString(),
    boot_lock_status: typeof boot_lock_status === 'string' ? boot_lock_status : null,
    boot_lock_detail: (boot_lock_detail ?? null) as Command['boot_lock_detail'],
    lockdown_effective: lockdownEffective,
    encryption_blocked_files: (encryption_blocked_files ?? null) as Command['encryption_blocked_files'],
    lock_session_context: (lock_session_context ?? null) as Command['lock_session_context'],
    ...(payload.command_uuid ? { command_uuid: payload.command_uuid } : {}),
  })) ?? command;
  // `confirmed` is the record as stored; the audit detail below must read THAT, not the
  // snapshot taken before the update (which is what the in-place mutation used to hide).

  // Store encryption key if provided
  if (key_material) {
    const keys = await listKeysForDevice(env, device.id);
    // Remove any existing key for this command (the rows are already this device's).
    const filtered = keys.filter((k) => k.command_id !== command_id);
    filtered.push({
      device_id: device.id,
      command_id,
      key_material,
      released_at: null,
    });
    await saveKeysForDevice(env, device.id, filtered);
  }

  // S4-serverless: store BIOS/PBA credentials by type (mirrors server's
  // bios_passwords inserts). These power both the unlock-materials path in
  // checkin and the pba-credentials admin endpoint.
  const credsToStore: Array<[string | undefined, BiosPassword['password_type']]> = [
    [bios_password, 'setup'],
    [power_on_password, 'power_on'],
    [bitlocker_pin, 'bitlocker_pin'],
    [bitlocker_recovery_password, 'bitlocker_recovery'],
  ];
  const anyCreds = credsToStore.some(([v]) => v != null && v !== '');
  if (anyCreds) {
    const pws = await listBiosPasswordsForDevice(env, device.id);
    for (const [value, type] of credsToStore) {
      if (value == null || value === '') continue;
      // Replace any existing credential of this type for the device.
      const idx = pws.findIndex((p) => p.password_type === type);
      const row: BiosPassword = {
        device_id: device.id,
        password_type: type,
        password: value,
        created_at: new Date().toISOString(),
      };
      if (idx >= 0) pws[idx] = row; else pws.push(row);
    }
    await saveBiosPasswordsForDevice(env, device.id, pws);
  }

  // Update device status based on command result. ADR-003: write this one device, and only
  // when the status actually changes — the old shape rewrote the whole fleet, including for an
  // ACK that moved nothing.
  if (result_status === 'executed') {
    const statusForCommand: Record<Command['command_type'], Device['status']> = {
      lockdown: 'locked',
      unlock: 'active',
      track: 'tracking',
      stop_track: 'active',
    };
    const nextStatus = statusForCommand[command.command_type];
    if (nextStatus && device.status !== nextStatus) {
      device.status = nextStatus;
      await putDevice(env, device);
    }
  }

  // The dashboard's lockdown-effectiveness panel does not read the command record:
  // it scans the AUDIT log for the most recent `agent_<type>_confirmed` entry and
  // parses that entry's detail (dashboard/src/pages/DeviceDetailPage.jsx:40-49).
  // Express writes one per executed command (server/src/routes/agent.js:525-534), so
  // without this the panel was dark on the serverless backend no matter what the
  // command record held — which made the effectiveness fields restored in sessions
  // 185-186 unreachable from the UI.
  if (result_status === 'executed') {
    await addAuditEntry(
      env,
      device.id,
      `agent_${command.command_type}_confirmed`,
      JSON.stringify({
        command_id,
        command_uuid: confirmed.command_uuid ?? undefined,
        boot_lock_status: confirmed.boot_lock_status ?? undefined,
        boot_lock_detail: confirmed.boot_lock_detail ?? undefined,
        lockdown_effective: confirmed.lockdown_effective ?? undefined,
        encryption_blocked_files: confirmed.encryption_blocked_files ?? undefined,
        lock_session_context: confirmed.lock_session_context ?? undefined,
      }),
    );
  }

  console.log(
    'ACK: device=%s command=%s status=%s boot_lock=%s',
    device.hostname,
    command_id,
    result_status,
    boot_lock_status,
  );

  return jsonResponse({ ok: true });
}

/**
 * S4: Escrow-before-arm — dedicated key-escrow endpoint (agent path).
 *
 * Mirrors the Express server's /api/agent/escrow-key. The agent calls this
 * BEFORE encrypting during a lockdown; the server persists the key bound
 * to the command_id so the recovery key is escrowed before the point of
 * no return. If escrow fails the agent refuses to encrypt — the device
 * stays unlocked rather than locked-out.
 *
 * Idempotent on (device_id, command_id): retries keep the first key.
 */
export async function handleEscrowKey(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const device = await verifyAgentAuth(request, env, body);
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const payload = parseJsonBody(body);
  if (!payload) return errorResponse('Invalid JSON body', 400);
  const { command_id, key_material } = payload;
  if (!command_id || !key_material) {
    return errorResponse('command_id and key_material required', 400);
  }
  if (typeof key_material !== 'string') {
    return errorResponse('key_material must be a string', 400);
  }

  // The command must exist and belong to this device. Read this device's index only.
  const commands = await listCommandsForDevice(env, device.id);
  const cmd = commands.find(
    (c) => c.id === command_id && c.device_id === device.id,
  );
  if (!cmd) {
    return errorResponse('Command not found for this device', 404);
  }

  // Idempotent: keep the first escrowed key for this device+command.
  const keys = await listKeysForDevice(env, device.id);
  const exists = keys.some((k) => k.command_id === command_id);
  if (!exists) {
    keys.push({
      device_id: device.id,
      command_id,
      key_material,
      created_at: new Date().toISOString(),
      released_at: null,
    });
    await saveKeysForDevice(env, device.id, keys);
  }

  return jsonResponse({ escrowed: true, command_id });
}

