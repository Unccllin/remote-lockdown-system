/**
 * Remote Lockdown — Serverless Ping Endpoint
 * ============================================
 *
 * A lightweight Cloudflare Worker that replaces the need for an always-on
 * server. The agent pings this endpoint to:
 *   1. Check in (report status, get pending commands)
 *   2. ACK commands (report execution results)
 *
 * Admin operations:
 *   3. List devices
 *   4. Flag a device as stolen (queues a lockdown command)
 *   5. Recover a device (releases key, queues an unlock command)
 *
 * Storage: Cloudflare KV (free tier: 100K reads/day, 1K writes/day)
 *
 * API:
 *   POST /api/ping            — Agent check-in (HMAC-signed)
 *   POST /api/command-ack     — Agent ACK (HMAC-signed)
 *   GET  /api/devices         — List devices (admin auth)
 *   GET  /api/devices/:id     — Get device detail (admin auth)
 *   POST /api/devices/:id/flag    — Flag device stolen (admin auth)
 *   POST /api/devices/:id/recover — Recover device (admin auth)
 *   POST /api/enroll          — Enroll a new device (admin auth)
 *   POST /api/enroll/token    — Create a short-lived enrollment token (admin auth)
 *   POST /api/enroll/claim    — Enroll using an enrollment token (no admin auth)
 *   GET  /api/health          — Health check (no auth)
 *
 * Auth:
 *   - Agent: HMAC-SHA256 signature (same as the full server)
 *   - Admin: Bearer token (JWT or simple API key)
 *
 * Deployment:
 *   wrangler deploy
 *
 * Environment variables (set via wrangler secret or dashboard):
 *   ADMIN_TOKEN — admin API key for dashboard operations
 *   KV_NAMESPACE — bound KV namespace (see wrangler.toml)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Device {
  id: string;
  hostname: string;
  owner_name: string;
  status: 'active' | 'stolen' | 'locked' | 'recovering' | 'tracking';
  mac_address: string | null;
  hardware_uuid: string | null;
  serial_number: string | null;
  last_checkin: string | null;
  enrolled_at: string;
  api_key_hash: string;
}

interface Command {
  id: string;
  device_id: string;
  command_type: 'lockdown' | 'unlock' | 'track' | 'stop_track';
  status: 'pending' | 'executed' | 'failed';
  created_at: string;
  executed_at: string | null;
  command_uuid: string | null;
  // Duress code: when truthy on an unlock command, the agent pretends
  // to unlock but silently re-encrypts and re-locks after a delay.
  // Set by the admin via the "Release with Duress Code" dashboard option.
  duress_code?: boolean | null;
}

interface EncryptionKey {
  device_id: string;
  command_id: string;
  key_material: string;
  released_at: string | null;
}

interface LocationReport {
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
  created_at: string;
}

interface AuditEntry {
  id: string;
  device_id: string;
  action: string;
  detail: string;
  created_at: string;
  hostname?: string;
  admin_username?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateApiKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Key, X-Timestamp, X-Nonce, X-Signature, X-Sig-Version',
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Agent auth (HMAC-SHA256)
// ---------------------------------------------------------------------------

async function verifyAgentAuth(
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

  // Find device by API key hash
  const keyHash = await sha256(agentKey);
  const devices = await listDevices(env);
  const device = devices.find((d) => d.api_key_hash === keyHash);
  if (!device) {
    return null;
  }

  // Verify HMAC signature
  // Signature = HMAC-SHA256(agent_key, "{timestamp}:{nonce}:{body_sha256}")
  // This matches the agent's sign_headers() format and the full server's
  // hmacAuth.js verifyHmac() — so the same agent can talk to either backend.
  const bodyHash = await sha256(body);
  const expectedSig = await hmacSha256(agentKey, `${timestamp}:${nonce}:${bodyHash}`);
  if (signature !== expectedSig) {
    return null;
  }

  // Check timestamp freshness (within 5 minutes)
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (Math.abs(now - ts) > 300) {
    return null;
  }

  return device;
}

// ---------------------------------------------------------------------------
// Admin auth (simple bearer token)
// ---------------------------------------------------------------------------

function verifyAdminAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return false;
  }
  const token = auth.slice(7);
  return token === env.ADMIN_TOKEN;
}

// ---------------------------------------------------------------------------
// KV storage helpers
// ---------------------------------------------------------------------------

interface Env {
  ADMIN_TOKEN: string;
  LOCKDOWN_KV: KVNamespace;
}

const DEVICES_KEY = 'devices';
const COMMANDS_KEY = 'commands';
const KEYS_KEY = 'encryption_keys';
const LOCATIONS_KEY = 'locations';
const AUDIT_KEY = 'audit_log';

// KV-RACE-001: Checkin metadata is stored in a separate KV key from device
// status. This prevents the checkin handler's read-modify-write of the
// `devices` key from racing with the ACK handler's status update.
// The checkin handler writes ONLY to `device_checkin:{id}`, never to
// `devices`. Admin endpoints merge checkin metadata when returning device data.
const CHECKIN_KEY_PREFIX = 'device_checkin:';

async function listDevices(env: Env): Promise<Device[]> {
  const data = await env.LOCKDOWN_KV.get(DEVICES_KEY);
  return data ? JSON.parse(data) : [];
}

async function saveDevices(env: Env, devices: Device[]): Promise<void> {
  await env.LOCKDOWN_KV.put(DEVICES_KEY, JSON.stringify(devices));
}

// Checkin metadata helpers — separate KV key per device.
// This is the fix for KV-RACE-001: the checkin handler writes to
// `device_checkin:{id}` instead of modifying the `devices` array,
// so it can never overwrite the ACK handler's status update.
interface CheckinMetadata {
  last_checkin: string | null;
  mac_address: string | null;
  hardware_uuid: string | null;
  serial_number: string | null;
}

async function getCheckinMetadata(env: Env, deviceId: string): Promise<CheckinMetadata | null> {
  const data = await env.LOCKDOWN_KV.get(`${CHECKIN_KEY_PREFIX}${deviceId}`);
  return data ? JSON.parse(data) : null;
}

async function saveCheckinMetadata(env: Env, deviceId: string, metadata: CheckinMetadata): Promise<void> {
  await env.LOCKDOWN_KV.put(`${CHECKIN_KEY_PREFIX}${deviceId}`, JSON.stringify(metadata));
}

// Merge checkin metadata into a device object for admin API responses.
// Falls back to the device's own fields if no checkin metadata exists
// (e.g., for devices enrolled before the KV-RACE-001 fix).
function mergeCheckinMetadata(device: Device, metadata: CheckinMetadata | null): Device {
  if (!metadata) return device;
  return {
    ...device,
    last_checkin: metadata.last_checkin ?? device.last_checkin,
    mac_address: metadata.mac_address ?? device.mac_address,
    hardware_uuid: metadata.hardware_uuid ?? device.hardware_uuid,
    serial_number: metadata.serial_number ?? device.serial_number,
  };
}

async function listCommands(env: Env): Promise<Command[]> {
  const data = await env.LOCKDOWN_KV.get(COMMANDS_KEY);
  return data ? JSON.parse(data) : [];
}

async function saveCommands(env: Env, commands: Command[]): Promise<void> {
  await env.LOCKDOWN_KV.put(COMMANDS_KEY, JSON.stringify(commands));
}

async function listKeys(env: Env): Promise<EncryptionKey[]> {
  const data = await env.LOCKDOWN_KV.get(KEYS_KEY);
  return data ? JSON.parse(data) : [];
}

async function saveKeys(env: Env, keys: EncryptionKey[]): Promise<void> {
  await env.LOCKDOWN_KV.put(KEYS_KEY, JSON.stringify(keys));
}

async function listLocations(env: Env): Promise<LocationReport[]> {
  const data = await env.LOCKDOWN_KV.get(LOCATIONS_KEY);
  return data ? JSON.parse(data) : [];
}

async function saveLocations(env: Env, locations: LocationReport[]): Promise<void> {
  // Cap at 1000 most recent to stay within KV value size limits
  const capped = locations.slice(-1000);
  await env.LOCKDOWN_KV.put(LOCATIONS_KEY, JSON.stringify(capped));
}

async function listAudit(env: Env): Promise<AuditEntry[]> {
  const data = await env.LOCKDOWN_KV.get(AUDIT_KEY);
  return data ? JSON.parse(data) : [];
}

async function saveAudit(env: Env, entries: AuditEntry[]): Promise<void> {
  // Cap at 500 most recent to stay within KV value size limits
  const capped = entries.slice(-500);
  await env.LOCKDOWN_KV.put(AUDIT_KEY, JSON.stringify(capped));
}

async function addAuditEntry(env: Env, deviceId: string, action: string, detail: string): Promise<void> {
  const entries = await listAudit(env);
  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  entries.push({
    id: generateId(),
    device_id: deviceId,
    action,
    detail,
    created_at: new Date().toISOString(),
    hostname: device?.hostname || null,
    admin_username: 'admin',
  });
  await saveAudit(env, entries);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleHealth(): Promise<Response> {
  return jsonResponse({
    status: 'ok',
    timestamp: new Date().toISOString(),
    serverless: true,
  });
}

async function handlePing(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const device = await verifyAgentAuth(request, env, body);
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const payload = JSON.parse(body);
  const { hostname, mac_address, hardware_uuid, serial_number } = payload;

  // KV-RACE-001: Write checkin metadata to a separate KV key, NOT to
  // the `devices` key. Same fix as handleAgentCheckin.
  const devices = await listDevices(env);
  const idx = devices.findIndex((d) => d.id === device.id);
  if (idx >= 0) {
    await saveCheckinMetadata(env, device.id, {
      last_checkin: new Date().toISOString(),
      mac_address: mac_address || devices[idx].mac_address,
      hardware_uuid: hardware_uuid || devices[idx].hardware_uuid,
      serial_number: serial_number || devices[idx].serial_number,
    });
  }

  // Check for pending commands
  const commands = await listCommands(env);
  const pendingCmd = commands.find(
    (c) => c.device_id === device.id && c.status === 'pending',
  );

  if (pendingCmd) {
    return jsonResponse({
      status: devices[idx].status,
      command: {
        id: pendingCmd.id,
        command_type: pendingCmd.command_type,
        created_at: pendingCmd.created_at,
      },
      poll_interval: 10, // Fast poll when command pending
    });
  }

  // No pending command — adaptive polling
  const status = devices[idx].status;
  const pollInterval = status === 'stolen' ? 10 : 300;
  return jsonResponse({
    status,
    poll_interval: pollInterval,
  });
}

/**
 * POST /api/agent/uninstall-auth — Issue a short-lived uninstall token.
 *
 * The agent calls this when a local admin wants to uninstall the agent.
 * The server issues a token valid for 5 minutes. The local uninstall
 * script must present this token to remove tamper protection (ACLs,
 * registry DENY ACEs) before deleting the agent.
 *
 * This prevents a thief from simply running the uninstall script —
 * they'd need server-side authorization, which the admin only grants
 * for legitimate device retirement.
 */
async function handleUninstallAuth(request: Request, env: Env): Promise<Response> {
  // Accept either admin bearer auth or agent API key auth
  const authHeader = request.headers.get('Authorization') || '';
  const apiKey = request.headers.get('X-API-Key') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  let authorized = false;
  if (apiKey) {
    const devices = await listDevices(env);
    const apiKeyHash = await sha256(apiKey);
    authorized = devices.some((d) => d.api_key_hash === apiKeyHash);
  }
  if (!authorized && token) {
    authorized = token === (env.ADMIN_TOKEN || '');
  }
  if (!authorized) {
    return errorResponse('Authentication required', 401);
  }

  // Generate a short-lived token: hash of (timestamp_rounded_to_5min + secret)
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / 300) * 300; // 5-minute window
  const uninstallToken = await sha256(`${window}:${env.ADMIN_TOKEN || 'fallback'}`);

  return jsonResponse({
    uninstall_token: uninstallToken,
    expires_in: 300, // 5 minutes
    issued_at: new Date().toISOString(),
  });
}

/**
 * POST /api/agent/uninstall-auth/verify — Verify an uninstall token.
 *
 * Checks if the token is valid (within the current 5-minute window).
 */
async function handleUninstallAuthVerify(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization') || '';
  const apiKey = request.headers.get('X-API-Key') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  let authorized = false;
  if (apiKey) {
    const devices = await listDevices(env);
    const apiKeyHash = await sha256(apiKey);
    authorized = devices.some((d) => d.api_key_hash === apiKeyHash);
  }
  if (!authorized && token) {
    authorized = token === (env.ADMIN_TOKEN || '');
  }
  if (!authorized) {
    return errorResponse('Authentication required', 401);
  }

  let body: { uninstall_token?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const providedToken = body.uninstall_token || '';
  if (!providedToken) {
    return errorResponse('uninstall_token required', 400);
  }

  // Check current and previous 5-minute windows (allows for clock skew)
  const now = Math.floor(Date.now() / 1000);
  const validWindows = [
    Math.floor(now / 300) * 300,
    Math.floor((now - 300) / 300) * 300,
  ];

  for (const window of validWindows) {
    const expectedToken = await sha256(`${window}:${env.ADMIN_TOKEN || 'fallback'}`);
    if (providedToken === expectedToken) {
      return jsonResponse({ authorized: true, verified: true });
    }
  }

  return jsonResponse({ authorized: false, verified: false });
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
async function handleAgentCheckin(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const device = await verifyAgentAuth(request, env, body);
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const payload = JSON.parse(body);
  const { hostname, mac_address, hardware_uuid, serial_number } = payload;

  // KV-RACE-001: Write checkin metadata to a separate KV key, NOT to the
  // `devices` key. This prevents the checkin handler from overwriting the
  // ACK handler's device status update when KV reads return stale data.
  // The device's status is read from `devices` (which is only written by
  // enroll, ACK, flag-stolen, and recover — never by checkin).
  const devices = await listDevices(env);
  const idx = devices.findIndex((d) => d.id === device.id);
  if (idx < 0) {
    return errorResponse('Device not found', 404);
  }
  // Save checkin metadata to a separate KV key (the fix for KV-RACE-001)
  await saveCheckinMetadata(env, device.id, {
    last_checkin: new Date().toISOString(),
    mac_address: mac_address || devices[idx].mac_address,
    hardware_uuid: hardware_uuid || devices[idx].hardware_uuid,
    serial_number: serial_number || devices[idx].serial_number,
  });
  // Do NOT call saveDevices() here — that would race with the ACK handler.

  // Check for pending commands (oldest first)
  const commands = await listCommands(env);
  const pendingCmds = commands
    .filter((c) => c.device_id === device.id && c.status === 'pending')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const pendingCmd = pendingCmds[0] || null;

  // Adaptive poll interval based on device status
  const status = devices[idx].status;
  const ADAPTIVE_POLL: Record<string, number> = {
    stolen: 30, tracking: 30, recovering: 30, locked: 60, active: 300,
  };
  const pollInterval = ADAPTIVE_POLL[status] ?? 300;

  if (!pendingCmd) {
    return jsonResponse({
      device_id: device.id,
      status,
      poll_interval: pollInterval,
      command: null,
    });
  }

  // For unlock commands, fetch the encryption key + BIOS password.
  // The key is stored in KV when the agent ACKed the lockdown. We return
  // it to the agent so it can decrypt the files. This matches the full
  // server's fetchUnlockMaterials() — the key is not "gated" by a release
  // flag; it's just returned when an unlock command is pending.
  let keyMaterial: string | null = null;
  let biosPassword: string | null = null;
  if (pendingCmd.command_type === 'unlock') {
    const keys = await listKeys(env);
    // Find the most recent key for this device (lockdown ACK key, not
    // deadman key). Match by device_id and exclude the synthetic 'deadman'
    // command_id. Sort by created_at implicitly via array order (most
    // recently pushed is last, but we search all and pick the first match).
    const deviceKey = keys.find(
      (k) => k.device_id === device.id && k.command_id !== 'deadman',
    );
    if (deviceKey) {
      keyMaterial = deviceKey.key_material;
      // Mark as released for tracking purposes (the agent has it now)
      if (!deviceKey.released_at) {
        deviceKey.released_at = new Date().toISOString();
        await saveKeys(env, keys);
      }
    }
    // BIOS password is not stored separately in the serverless KV model;
    // the full server stores it in bios_passwords, but the serverless
    // endpoint doesn't have that table. The agent can operate without it
    // for the serverless path (BIOS password is only needed for UEFI
    // lockdown removal, which requires the full server's encrypted-at-rest
    // password storage).
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
      power_on_password: null,
      enable_pba: false,
      bitlocker_pin: null,
      bitlocker_recovery_password: null,
      // Duress code: forwarded from the queued unlock command so the
      // agent knows to pretend-unlock and silently re-lock.
      duress_code: pendingCmd.duress_code ?? null,
    },
  });
}

/**
 * Agent-compatible deadman report — matches the full server's
 * /api/agent/deadman-report. Stores the encryption key and marks the
 * device as locked.
 */
async function handleDeadmanReport(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const device = await verifyAgentAuth(request, env, body);
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const payload = JSON.parse(body);
  const { key_material } = payload;

  if (!key_material) {
    return errorResponse('key_material required', 400);
  }

  // Store the encryption key (idempotent — replace if exists for this device)
  const keys = await listKeys(env);
  const filtered = keys.filter((k) => !(k.device_id === device.id && k.command_id === 'deadman'));
  filtered.push({
    device_id: device.id,
    command_id: 'deadman',
    key_material,
    released_at: null,
  });
  await saveKeys(env, filtered);

  // Mark device as locked (the deadman switch actually encrypted it)
  const devices = await listDevices(env);
  const idx = devices.findIndex((d) => d.id === device.id);
  if (idx >= 0) {
    devices[idx].status = 'locked';
    await saveDevices(env, devices);
  }

  console.log('Deadman report: device=%s key stored, status=locked', device.hostname);
  return jsonResponse({ ok: true });
}

/**
 * Agent-compatible location report — stores location data in KV.
 */
async function handleAgentLocation(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const device = await verifyAgentAuth(request, env, body);
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const payload = JSON.parse(body);
  const { location } = payload;
  if (!location) {
    return errorResponse('location required', 400);
  }

  const locations = await listLocations(env);
  locations.push({
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
    created_at: new Date().toISOString(),
  });
  await saveLocations(env, locations);

  return jsonResponse({ ok: true });
}

async function handleCommandAck(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const device = await verifyAgentAuth(request, env, body);
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const payload = JSON.parse(body);
  const {
    command_id,
    result_status,
    key_material,
    bios_password,
    boot_lock_status,
    boot_lock_detail,
  } = payload;

  if (!command_id || !result_status) {
    return errorResponse('command_id and result_status required', 400);
  }

  // Update command status
  const commands = await listCommands(env);
  const cmdIdx = commands.findIndex(
    (c) => c.id === command_id && c.device_id === device.id,
  );
  if (cmdIdx < 0) {
    return errorResponse('Command not found', 404);
  }

  // Idempotent: if already executed, return success
  if (commands[cmdIdx].status === 'executed') {
    return jsonResponse({ ok: true, deduplicated: true });
  }

  commands[cmdIdx].status = result_status;
  commands[cmdIdx].executed_at = new Date().toISOString();
  if (payload.command_uuid) {
    commands[cmdIdx].command_uuid = payload.command_uuid;
  }
  await saveCommands(env, commands);

  // Store encryption key if provided
  if (key_material) {
    const keys = await listKeys(env);
    // Remove any existing key for this device+command
    const filtered = keys.filter(
      (k) => !(k.device_id === device.id && k.command_id === command_id),
    );
    filtered.push({
      device_id: device.id,
      command_id,
      key_material,
      released_at: null,
    });
    await saveKeys(env, filtered);
  }

  // Update device status based on command result
  const devices = await listDevices(env);
  const devIdx = devices.findIndex((d) => d.id === device.id);
  if (devIdx >= 0) {
    if (result_status === 'executed') {
      if (commands[cmdIdx].command_type === 'lockdown') {
        devices[devIdx].status = 'locked';
      } else if (commands[cmdIdx].command_type === 'unlock') {
        devices[devIdx].status = 'active';
      }
    }
    await saveDevices(env, devices);
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

async function handleEnroll(request: Request, env: Env): Promise<Response> {
  if (!verifyAdminAuth(request, env)) {
    return errorResponse('Admin authentication required', 401);
  }

  const payload = await request.json() as {
    hostname: string;
    owner_name?: string;
    hardware_uuid?: string;
    mac_address?: string;
    serial_number?: string;
  };

  if (!payload.hostname) {
    return errorResponse('hostname required', 400);
  }

  const apiKey = generateApiKey();
  const apiKeyHash = await sha256(apiKey);

  const devices = await listDevices(env);

  // Re-association by hardware UUID (MDM-style): if a device with the same
  // hardware_uuid already exists, re-issue credentials and update the record
  // instead of creating a duplicate. Same hardware = same device record.
  if (payload.hardware_uuid) {
    const existingIdx = devices.findIndex(
      (d) => d.hardware_uuid === payload.hardware_uuid,
    );
    if (existingIdx >= 0) {
      const existing = devices[existingIdx];
      existing.api_key_hash = apiKeyHash;
      existing.hostname = payload.hostname;
      existing.mac_address = payload.mac_address || existing.mac_address;
      existing.serial_number = payload.serial_number || existing.serial_number;
      existing.status = 'active';
      await saveDevices(env, devices);

      return jsonResponse(
        {
          device: {
            id: existing.id,
            hostname: existing.hostname,
            status: existing.status,
            enrolled_at: existing.enrolled_at,
            hardware_uuid: existing.hardware_uuid,
            serial_number: existing.serial_number,
            mac_address: existing.mac_address,
          },
          api_key: apiKey, // Only returned once — store it securely
          reassociated: true,
        },
        200,
      );
    }
  }

  const device: Device = {
    id: generateId(),
    hostname: payload.hostname,
    owner_name: payload.owner_name || 'Operator',
    status: 'active',
    mac_address: payload.mac_address || null,
    hardware_uuid: payload.hardware_uuid || null,
    serial_number: payload.serial_number || null,
    last_checkin: null,
    enrolled_at: new Date().toISOString(),
    api_key_hash: apiKeyHash,
  };

  devices.push(device);
  await saveDevices(env, devices);

  return jsonResponse(
    {
      device: {
        id: device.id,
        hostname: device.hostname,
        status: device.status,
        enrolled_at: device.enrolled_at,
        hardware_uuid: device.hardware_uuid,
        serial_number: device.serial_number,
        mac_address: device.mac_address,
      },
      api_key: apiKey, // Only returned once — store it securely
    },
    201,
  );
}

/**
 * POST /api/enroll/token — admin creates a short-lived enrollment token.
 *
 * The admin generates a token in the dashboard, then runs a single command
 * on the target machine that uses the token (via POST /api/enroll/claim).
 * This avoids entering the admin password on the target machine.
 *
 * The token is valid for 15 minutes and single-use. Stored in KV as
 * `enroll_token:{token}` with the admin's user ID and expiration timestamp.
 */
async function handleEnrollToken(request: Request, env: Env): Promise<Response> {
  if (!verifyAdminAuth(request, env)) {
    return errorResponse('Admin authentication required', 401);
  }

  const token = generateApiKey(); // 32 random bytes, base64 — high entropy
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = 15 * 60; // 15 minutes
  const expiresAt = now + ttlSeconds;

  // Store token metadata in KV. We store the expiration in the value (not
  // relying on KV TTL) so the MockKV in tests and any KV backend can enforce
  // expiry deterministically.
  const tokenData = {
    created_by: 'admin',
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  };
  await env.LOCKDOWN_KV.put(`enroll_token:${token}`, JSON.stringify(tokenData));

  return jsonResponse({
    token,
    expires_at: new Date(expiresAt * 1000).toISOString(),
    expires_in: ttlSeconds,
  });
}

/**
 * POST /api/enroll/claim — the agent installer uses an enrollment token
 * instead of an admin token to enroll a device.
 *
 * Validates the token (exists, not expired), creates the device (same logic
 * as /api/enroll), then deletes the token (single-use). Returns the same
 * response shape as /api/enroll.
 */
async function handleEnrollClaim(request: Request, env: Env): Promise<Response> {
  let payload: {
    token?: string;
    hostname: string;
    owner_name?: string;
    hardware_uuid?: string;
    mac_address?: string;
    serial_number?: string;
  };
  try {
    payload = await request.json() as {
      token?: string;
      hostname: string;
      owner_name?: string;
      hardware_uuid?: string;
      mac_address?: string;
      serial_number?: string;
    };
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!payload.token) {
    return errorResponse('Enrollment token required', 400);
  }
  if (!payload.hostname) {
    return errorResponse('hostname required', 400);
  }

  // Validate the enrollment token
  const tokenKey = `enroll_token:${payload.token}`;
  const stored = await env.LOCKDOWN_KV.get(tokenKey);
  if (!stored) {
    return errorResponse('Invalid or already-used enrollment token', 401);
  }

  let tokenData: { expires_at: number };
  try {
    tokenData = JSON.parse(stored);
  } catch {
    return errorResponse('Corrupted enrollment token', 500);
  }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (now > tokenData.expires_at) {
    // Clean up expired token
    await env.LOCKDOWN_KV.put(tokenKey, ''); // KV has no delete in MockKV; overwrite
    return errorResponse('Enrollment token has expired', 401);
  }

  // Delete the token (single-use) — use KV.delete if available, otherwise
  // overwrite with empty. The real Cloudflare KV supports delete(); the
  // MockKV in tests does not, so we guard with a typeof check.
  if (typeof (env.LOCKDOWN_KV as unknown as { delete?: (k: string) => Promise<void> }).delete === 'function') {
    await (env.LOCKDOWN_KV as unknown as { delete: (k: string) => Promise<void> }).delete(tokenKey);
  } else {
    await env.LOCKDOWN_KV.put(tokenKey, '');
  }

  // Create the device (same logic as handleEnroll)
  const apiKey = generateApiKey();
  const apiKeyHash = await sha256(apiKey);

  const devices = await listDevices(env);

  // Re-association by hardware UUID (MDM-style): if a device with the same
  // hardware_uuid already exists, re-issue credentials and update the record
  // instead of creating a duplicate. Same hardware = same device record.
  if (payload.hardware_uuid) {
    const existingIdx = devices.findIndex(
      (d) => d.hardware_uuid === payload.hardware_uuid,
    );
    if (existingIdx >= 0) {
      const existing = devices[existingIdx];
      existing.api_key_hash = apiKeyHash;
      existing.hostname = payload.hostname;
      existing.mac_address = payload.mac_address || existing.mac_address;
      existing.serial_number = payload.serial_number || existing.serial_number;
      existing.status = 'active';
      await saveDevices(env, devices);

      return jsonResponse(
        {
          device: {
            id: existing.id,
            hostname: existing.hostname,
            status: existing.status,
            enrolled_at: existing.enrolled_at,
            hardware_uuid: existing.hardware_uuid,
            serial_number: existing.serial_number,
            mac_address: existing.mac_address,
          },
          api_key: apiKey, // Only returned once — store it securely
          reassociated: true,
        },
        200,
      );
    }
  }

  const device: Device = {
    id: generateId(),
    hostname: payload.hostname,
    owner_name: payload.owner_name || 'Operator',
    status: 'active',
    mac_address: payload.mac_address || null,
    hardware_uuid: payload.hardware_uuid || null,
    serial_number: payload.serial_number || null,
    last_checkin: null,
    enrolled_at: new Date().toISOString(),
    api_key_hash: apiKeyHash,
  };

  devices.push(device);
  await saveDevices(env, devices);

  return jsonResponse(
    {
      device: {
        id: device.id,
        hostname: device.hostname,
        status: device.status,
        enrolled_at: device.enrolled_at,
        hardware_uuid: device.hardware_uuid,
        serial_number: device.serial_number,
        mac_address: device.mac_address,
      },
      api_key: apiKey, // Only returned once — store it securely
    },
    201,
  );
}

async function handleListDevices(request: Request, env: Env): Promise<Response> {
  if (!verifyAdminAuth(request, env)) {
    return errorResponse('Admin authentication required', 401);
  }
  const devices = await listDevices(env);
  // Merge checkin metadata from separate KV keys (KV-RACE-001 fix)
  // and strip api_key_hash before returning.
  const merged = await Promise.all(
    devices.map(async (d) => {
      const meta = await getCheckinMetadata(env, d.id);
      return mergeCheckinMetadata(d, meta);
    }),
  );
  const safe = merged.map(({ api_key_hash, ...d }) => d);
  return jsonResponse(safe);
}

async function handleGetDevice(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  if (!verifyAdminAuth(request, env)) {
    return errorResponse('Admin authentication required', 401);
  }
  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) {
    return errorResponse('Device not found', 404);
  }
  // Merge checkin metadata from separate KV key (KV-RACE-001 fix)
  const meta = await getCheckinMetadata(env, device.id);
  const merged = mergeCheckinMetadata(device, meta);
  // Return just the device object — matches the Express server's
  // `res.json(device)` shape (the dashboard expects devRes.data to be
  // the device, not a wrapper object).
  const { api_key_hash, ...safeDevice } = merged;
  return jsonResponse(safeDevice);
}

/**
 * GET /api/devices/by-hardware/:uuid — look up a device by its hardware UUID.
 *
 * This lets the dashboard find a device by its hardware identifier (the same
 * identifier used for MDM-style re-association at enrollment time). Merges
 * checkin metadata so the returned device reflects the latest agent-reported
 * hardware IDs.
 */
async function handleDeviceByHardware(
  request: Request,
  env: Env,
  hardwareUuid: string,
): Promise<Response> {
  if (!verifyAdminAuth(request, env)) {
    return errorResponse('Admin authentication required', 401);
  }
  const devices = await listDevices(env);
  // Search both the device record and merged checkin metadata, since the
  // hardware_uuid may have been reported via checkin after enrollment.
  for (const d of devices) {
    const meta = await getCheckinMetadata(env, d.id);
    const merged = mergeCheckinMetadata(d, meta);
    if (merged.hardware_uuid === hardwareUuid) {
      const { api_key_hash, ...safeDevice } = merged;
      return jsonResponse(safeDevice);
    }
  }
  return errorResponse('Device not found', 404);
}

async function handleFlagStolen(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  if (!verifyAdminAuth(request, env)) {
    return errorResponse('Admin authentication required', 401);
  }

  const payload = await request.json() as { hostname_confirm?: string };

  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) {
    return errorResponse('Device not found', 404);
  }

  if (payload.hostname_confirm !== device.hostname) {
    return errorResponse(
      'Confirmation hostname does not match. Enter the device hostname exactly as it appears in the device list.',
      400,
    );
  }

  if (device.status !== 'active') {
    return errorResponse(
      `Device is not active (current status: ${device.status}). Only active devices can be flagged.`,
      409,
    );
  }

  // Update device status
  device.status = 'stolen';
  await saveDevices(env, devices);

  // Queue lockdown command
  const commands = await listCommands(env);
  const cmd: Command = {
    id: generateId(),
    device_id: deviceId,
    command_type: 'lockdown',
    status: 'pending',
    created_at: new Date().toISOString(),
    executed_at: null,
    command_uuid: null,
  };
  commands.push(cmd);
  await saveCommands(env, commands);

  await addAuditEntry(env, deviceId, 'admin_flag_stolen', '');

  return jsonResponse({
    device: { id: device.id, hostname: device.hostname, status: device.status },
    command: {
      id: cmd.id,
      command_type: cmd.command_type,
      status: cmd.status,
    },
  });
}

async function handleRecover(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  if (!verifyAdminAuth(request, env)) {
    return errorResponse('Admin authentication required', 401);
  }

  const payload = await request.json() as {
    hostname_confirm?: string;
    duress_code?: boolean;
  };

  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) {
    return errorResponse('Device not found', 404);
  }

  if (payload.hostname_confirm !== device.hostname) {
    return errorResponse('Confirmation hostname does not match.', 400);
  }

  if (device.status !== 'stolen' && device.status !== 'locked') {
    return errorResponse(
      `Device is not locked/stolen (current status: ${device.status}).`,
      409,
    );
  }

  // Update device status
  device.status = 'recovering';
  await saveDevices(env, devices);

  // Release encryption key
  const keys = await listKeys(env);
  const deviceKey = keys.find(
    (k) => k.device_id === deviceId && k.released_at === null,
  );
  let releasedKey: string | null = null;
  if (deviceKey) {
    deviceKey.released_at = new Date().toISOString();
    releasedKey = deviceKey.key_material;
    await saveKeys(env, keys);
  }

  // Queue unlock command.
  // duress_code: when truthy, the agent pretends to unlock but silently
  // re-encrypts and re-locks.  Default is a normal (real) unlock.
  const commands = await listCommands(env);
  const cmd: Command = {
    id: generateId(),
    device_id: deviceId,
    command_type: 'unlock',
    status: 'pending',
    created_at: new Date().toISOString(),
    executed_at: null,
    command_uuid: null,
    duress_code: payload.duress_code === true ? true : null,
  };
  commands.push(cmd);
  await saveCommands(env, commands);

  await addAuditEntry(
    env,
    deviceId,
    'admin_recover',
    payload.duress_code ? 'duress' : '',
  );

  return jsonResponse({
    device: { id: device.id, hostname: device.hostname, status: device.status },
    command: {
      id: cmd.id,
      command_type: cmd.command_type,
      status: cmd.status,
    },
    key_material: releasedKey,
    key_released: releasedKey !== null,
  });
}

/**
 * Handle track / stop-track / locate — queue the corresponding command.
 */
async function handleTrackAction(
  request: Request,
  env: Env,
  deviceId: string,
  action: 'track' | 'stop_track' | 'locate',
): Promise<Response> {
  if (!verifyAdminAuth(request, env)) {
    return errorResponse('Admin authentication required', 401);
  }

  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) {
    return errorResponse('Device not found', 404);
  }

  // Update device status for track/stop_track
  if (action === 'track') {
    device.status = 'tracking';
    await saveDevices(env, devices);
  } else if (action === 'stop_track') {
    device.status = 'active';
    await saveDevices(env, devices);
  }
  // 'locate' doesn't change status — it just queues a one-time location report

  // Queue the command
  const commands = await listCommands(env);
  const cmdType = action === 'locate' ? 'track' : action;
  const cmd: Command = {
    id: generateId(),
    device_id: deviceId,
    command_type: cmdType as Command['command_type'],
    status: 'pending',
    created_at: new Date().toISOString(),
    executed_at: null,
    command_uuid: null,
  };
  commands.push(cmd);
  await saveCommands(env, commands);

  await addAuditEntry(env, deviceId, `admin_${action}`, '');

  return jsonResponse({
    device: { id: device.id, hostname: device.hostname, status: device.status },
    command: { id: cmd.id, command_type: cmd.command_type, status: cmd.status },
  });
}

/**
 * GET /api/devices/:id/locations — return location reports for a device.
 */
async function handleGetLocations(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  if (!verifyAdminAuth(request, env)) {
    return errorResponse('Admin authentication required', 401);
  }
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);
  const locations = await listLocations(env);
  const deviceLocs = locations
    .filter((l) => l.device_id === deviceId)
    .slice(-limit)
    // Map created_at → reported_at for dashboard compatibility (the Express
    // server uses `reported_at`, the Worker uses `created_at` internally).
    // Also add a synthetic id (the Worker doesn't store one) and reverse to
    // most-recent-first, matching the Express server's ORDER BY DESC.
    .map((l, idx) => ({
      ...l,
      id: `loc-${deviceId}-${idx}`,
      reported_at: l.created_at,
    }))
    .reverse();
  return jsonResponse(deviceLocs);
}

/**
 * GET /api/audit — return audit log entries (optionally filtered by device_id).
 */
async function handleGetAudit(request: Request, env: Env): Promise<Response> {
  if (!verifyAdminAuth(request, env)) {
    return errorResponse('Admin authentication required', 401);
  }
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const deviceId = url.searchParams.get('device_id');
  const entries = await listAudit(env);
  let filtered = deviceId
    ? entries.filter((e) => e.device_id === deviceId)
    : entries;
  filtered = filtered.slice(-limit).reverse(); // most recent first
  // Map created_at → timestamp for dashboard compatibility (the Express
  // server uses `timestamp`, the Worker uses `created_at` internally)
  const mapped = filtered.map((e) => ({
    ...e,
    timestamp: e.created_at || e.timestamp,
  }));
  return jsonResponse(mapped);
}

/**
 * POST /api/auth/login — accept the admin token and return it as a "token".
 * The dashboard expects a JWT-like response: { token, user: { username, role } }.
 * Since the Worker uses a simple bearer token, we validate it and return it.
 */
async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  let payload: { password?: string; token?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  // The dashboard sends { username, password }. We treat password as the
  // admin token. Alternatively, the client can send { token } directly.
  const token = payload.token || payload.password;
  if (!token) {
    return errorResponse('Token or password required', 400);
  }

  if (token !== env.ADMIN_TOKEN) {
    return errorResponse('Invalid credentials', 401);
  }

  return jsonResponse({
    token: token,
    user: { username: 'admin', role: 'super-admin' },
  });
}

/**
 * GET /api/setup/status — report setup as complete (Worker is always ready).
 */
async function handleSetupStatus(env: Env): Promise<Response> {
  // Dashboard checks data.needsSetup — Worker is always ready (no first-run setup)
  return jsonResponse({ setupComplete: true, needsSetup: false });
}

/**
 * GET /api/health/detailed — detailed health for the dashboard.
 */
async function handleDetailedHealth(env: Env): Promise<Response> {
  const devices = await listDevices(env);
  const commands = await listCommands(env);
  const pending = commands.filter((c) => c.status === 'pending').length;
  return jsonResponse({
    status: 'ok',
    serverless: true,
    devices: devices.length,
    pending_commands: pending,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, X-Agent-Key, X-Timestamp, X-Nonce, X-Signature, X-Sig-Version',
        },
      });
    }

    // Health check (no auth)
    if (path === '/api/health' && method === 'GET') {
      return handleHealth();
    }
    if (path === '/api/health/detailed' && method === 'GET') {
      return handleDetailedHealth(env);
    }

    // Auth + setup (dashboard-compatible)
    if (path === '/api/auth/login' && method === 'POST') {
      return handleAuthLogin(request, env);
    }
    if (path === '/api/setup/status' && method === 'GET') {
      return handleSetupStatus(env);
    }

    // Audit log (admin auth)
    if (path === '/api/audit' && method === 'GET') {
      return handleGetAudit(request, env);
    }

    // Agent endpoints (HMAC auth)
    // Legacy short paths (backward compat with original worker API)
    if (path === '/api/ping' && method === 'POST') {
      return handlePing(request, env);
    }
    if (path === '/api/command-ack' && method === 'POST') {
      return handleCommandAck(request, env);
    }

    // Agent-compatible paths (match the full Express server's routes so the
    // agent can use the Worker as a drop-in fallback without code changes)
    if (path === '/api/agent/checkin' && method === 'POST') {
      return handleAgentCheckin(request, env);
    }
    if (path === '/api/agent/command-ack' && method === 'POST') {
      return handleCommandAck(request, env);
    }
    if (path === '/api/agent/deadman-report' && method === 'POST') {
      return handleDeadmanReport(request, env);
    }
    if (path === '/api/agent/location' && method === 'POST') {
      return handleAgentLocation(request, env);
    }
    if (path === '/api/agent/uninstall-auth' && method === 'POST') {
      return handleUninstallAuth(request, env);
    }
    if (path === '/api/agent/uninstall-auth/verify' && method === 'POST') {
      return handleUninstallAuthVerify(request, env);
    }

    // Admin endpoints (bearer auth)
    if (path === '/api/enroll' && method === 'POST') {
      return handleEnroll(request, env);
    }
    // Enrollment token flow: admin generates a token, installer claims it
    if (path === '/api/enroll/token' && method === 'POST') {
      return handleEnrollToken(request, env);
    }
    if (path === '/api/enroll/claim' && method === 'POST') {
      return handleEnrollClaim(request, env);
    }
    // POST /api/devices — enroll via dashboard (same as /api/enroll but
    // with different request shape: { hostname, owner_name })
    if (path === '/api/devices' && method === 'POST') {
      return handleEnroll(request, env);
    }
    if (path === '/api/devices' && method === 'GET') {
      return handleListDevices(request, env);
    }

    // Device lookup by hardware UUID — must be checked BEFORE the generic
    // /api/devices/:id route, otherwise "by-hardware" would be treated as
    // a device ID.
    if (path.startsWith('/api/devices/by-hardware/') && method === 'GET') {
      const hardwareUuid = decodeURIComponent(path.slice('/api/devices/by-hardware/'.length));
      return handleDeviceByHardware(request, env, hardwareUuid);
    }

    // Device-specific routes: /api/devices/:id[/action]
    const deviceMatch = path.match(/^\/api\/devices\/([^/]+)(\/(.+))?$/);
    if (deviceMatch) {
      const deviceId = deviceMatch[1];
      const action = deviceMatch[3];

      if (!action && method === 'GET') {
        return handleGetDevice(request, env, deviceId);
      }
      // flag-stolen (dashboard) and flag (legacy) — same handler
      if ((action === 'flag' || action === 'flag-stolen') && method === 'POST') {
        return handleFlagStolen(request, env, deviceId);
      }
      if (action === 'recover' && method === 'POST') {
        return handleRecover(request, env, deviceId);
      }
      if (action === 'track' && method === 'POST') {
        return handleTrackAction(request, env, deviceId, 'track');
      }
      if (action === 'stop-track' && method === 'POST') {
        return handleTrackAction(request, env, deviceId, 'stop_track');
      }
      if (action === 'locate' && method === 'POST') {
        return handleTrackAction(request, env, deviceId, 'locate');
      }
      if (action === 'locations' && method === 'GET') {
        return handleGetLocations(request, env, deviceId);
      }
    }

    // Binary download endpoints — serve installer + agent from KV.
    // The binaries are uploaded to KV via:
    //   wrangler kv:key put --binding LOCKDOWN_KV "binary:installer" --path lockdown-setup.exe
    //   wrangler kv:key put --binding LOCKDOWN_KV "binary:agent" --path lockdown-agent.exe
    // No admin auth required — these are public downloads (the enrollment
    // token controls who can enroll, not who can download the installer).
    if (path === '/api/download/installer' && method === 'GET') {
      return handleDownloadBinary(env, 'installer');
    }
    if (path === '/api/download/agent' && method === 'GET') {
      return handleDownloadBinary(env, 'agent');
    }

    if (path === '/api/download/lockscreen' && method === 'GET') {
      return handleDownloadBinary(env, 'lockscreen');
    }

    if (path === '/api/download/deploy.ps1' && method === 'GET') {
      return handleDownloadScript(env, 'deploy');
    }

    return errorResponse('Not found', 404);
  },
};

/**
 * GET /api/download/deploy.ps1
 * Serves a PowerShell script stored in KV (key: script:deploy).
 */
async function handleDownloadScript(env: Env, name: string): Promise<Response> {
  const data = await env.LOCKDOWN_KV.get(`script:${name}`, { type: 'arrayBuffer' });
  if (!data) {
    return errorResponse(`${name} script not available`, 404);
  }
  return new Response(data, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="deploy.ps1"`,
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * GET /api/download/installer or /api/download/agent
 * Serves a binary file stored in KV (key: binary:installer or binary:agent).
 * Returns the raw bytes with appropriate Content-Type and Content-Disposition.
 */
async function handleDownloadBinary(env: Env, name: string): Promise<Response> {
  const data = await env.LOCKDOWN_KV.get(`binary:${name}`, { type: 'arrayBuffer' });
  if (!data) {
    return errorResponse(`${name} binary not available — upload via wrangler kv:key put`, 404);
  }
  const filename =
    name === 'installer' ? 'lockdown-setup.exe' :
    name === 'lockscreen' ? 'lockdown-lockscreen.exe' :
    'lockdown-agent.exe';
  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.microsoft.portable-executable',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(data.byteLength),
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
