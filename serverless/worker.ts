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
// Admin auth — resolves a Bearer credential to an admin record.
//
// Accepts either a signed session token (issued by /api/auth/login) or the
// break-glass ADMIN_TOKEN env secret (which maps to a synthetic super-admin).
// Returns the authenticated admin claims (id, username, role) or null.
// ---------------------------------------------------------------------------

interface AdminClaims {
  id: string;
  username: string;
  role: AdminRole;
}

async function resolveAdminAuth(request: Request, env: Env): Promise<AdminClaims | null> {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  const token = auth.slice(7);

  // Break-glass: the env ADMIN_TOKEN maps to a synthetic super-admin so the
  // Worker is usable before any admin is created (bootstrap / recovery).
  if (token === env.ADMIN_TOKEN) {
    return { id: 'admin-token', username: 'admin', role: 'super-admin' };
  }

  // Otherwise verify a signed session token.
  return verifyAdminToken(env, token);
}

// Back-compat boolean form used by existing handlers.
async function verifyAdminAuth(request: Request, env: Env): Promise<boolean> {
  return (await resolveAdminAuth(request, env)) !== null;
}

/**
 * Role gate — mirrors the Express server's requireRole(minRole).
 * Returns the admin claims if authorized, or a Response (401/403) to return.
 */
async function requireRole(
  request: Request,
  env: Env,
  minRole: AdminRole,
): Promise<AdminClaims | Response> {
  const admin = await resolveAdminAuth(request, env);
  if (!admin) {
    return errorResponse('Admin authentication required', 401);
  }
  const level = ROLE_HIERARCHY[admin.role] ?? 0;
  if (level < ROLE_HIERARCHY[minRole]) {
    return errorResponse(
      `Insufficient permissions. This endpoint requires the '${minRole}' role.`,
      403,
    );
  }
  return admin;
}

// ---------------------------------------------------------------------------
// KV storage helpers
// ---------------------------------------------------------------------------

interface Env {
  ADMIN_TOKEN: string;
  LOCKDOWN_KV: KVNamespace;
  PBL_SIGNING_KEY?: string; // PKCS8 base64 of ES256 private key for PBL verdict signing
  PBL_POLICY_SIGNING_KEY?: string; // D-205: PKCS8 base64 of ES256 private key for policy signing (separate from verdict)
  JWT_SECRET?: string; // S4-serverless: HMAC secret for admin session tokens
}

// ---------------------------------------------------------------------------
// S4-serverless: multi-admin RBAC on KV (end-state serverless auth).
//
// The end goal is a fully-serverless system; the Worker is the deployed
// authority. This layer ports the Express server's admin model (username +
// password + role) onto KV so the dashboard and admin-plane endpoints work
// without Postgres.
//
// - admins[] stored in a single KV key (low-cardinality, mirrors devices).
// - Passwords hashed with PBKDF2-SHA256 (native WebCrypto, NIST floor).
// - Sessions are stateless HMAC-signed tokens ({id, username, role, exp}).
// - ADMIN_TOKEN remains as a break-glass super-admin fallback so the Worker
//   still works before any admin is created (bootstrap / recovery).
// ---------------------------------------------------------------------------

type AdminRole = 'viewer' | 'operator' | 'super-admin';

interface Admin {
  id: string;
  username: string;
  password_hash: string; // base64 PBKDF2
  salt: string;          // base64
  role: AdminRole;
  created_at: string;
}

const ADMINS_KEY = 'admins';
const PBKDF2_ITERATIONS = 210_000; // NIST-recommended floor for PBKDF2-SHA256
const TOKEN_TTL_SECONDS = 8 * 3600; // match server's JWT_EXPIRES_IN default (8h)

const ROLE_HIERARCHY: Record<AdminRole, number> = {
  viewer: 0,
  operator: 1,
  'super-admin': 2,
};

async function listAdmins(env: Env): Promise<Admin[]> {
  const data = await env.LOCKDOWN_KV.get(ADMINS_KEY);
  return data ? JSON.parse(data) : [];
}

async function saveAdmins(env: Env, admins: Admin[]): Promise<void> {
  await env.LOCKDOWN_KV.put(ADMINS_KEY, JSON.stringify(admins));
}

function b64encode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** PBKDF2-SHA256 password hash (base64) for a given salt. */
async function pbkdf2Hash(password: string, saltB64: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: b64decode(saltB64) as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    256,
  );
  return b64encode(bits);
}

/** Create an admin record with a fresh random salt + PBKDF2 hash. */
async function makeAdmin(username: string, password: string, role: AdminRole): Promise<Admin> {
  const salt = b64encode(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const password_hash = await pbkdf2Hash(password, salt);
  return {
    id: generateId(),
    username,
    password_hash,
    salt,
    role,
    created_at: new Date().toISOString(),
  };
}

function b64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

/** Issue a stateless HMAC-signed session token (JWT-shape: header.payload.sig). */
async function signAdminToken(env: Env, admin: Admin): Promise<string> {
  const secret = env.JWT_SECRET || env.ADMIN_TOKEN || 'dev-secret';
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64urlEncode(
    JSON.stringify({
      id: admin.id,
      username: admin.username,
      role: admin.role,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    }),
  );
  const sig = await hmacSha256(secret, `${header}.${payload}`);
  return `${header}.${payload}.${b64urlEncode(sig)}`;
}

/** Verify a signed token; returns the embedded admin claims or null. */
async function verifyAdminToken(
  env: Env,
  token: string,
): Promise<{ id: string; username: string; role: AdminRole } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const secret = env.JWT_SECRET || env.ADMIN_TOKEN || 'dev-secret';
  const expected = await hmacSha256(secret, `${parts[0]}.${parts[1]}`);
  const sig = b64urlDecode(parts[2]);
  // Constant-time comparison.
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(b64urlDecode(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
    if (!payload.id || !payload.role) return null;
    return { id: payload.id, username: payload.username, role: payload.role };
  } catch {
    return null;
  }
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
async function handleEscrowKey(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const device = await verifyAgentAuth(request, env, body);
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const payload = JSON.parse(body);
  const { command_id, key_material } = payload;
  if (!command_id || !key_material) {
    return errorResponse('command_id and key_material required', 400);
  }
  if (typeof key_material !== 'string') {
    return errorResponse('key_material must be a string', 400);
  }

  // The command must exist and belong to this device.
  const commands = await listCommands(env);
  const cmd = commands.find(
    (c) => c.id === command_id && c.device_id === device.id,
  );
  if (!cmd) {
    return errorResponse('Command not found for this device', 404);
  }

  // Idempotent: keep the first escrowed key for this device+command.
  const keys = await listKeys(env);
  const exists = keys.some(
    (k) => k.device_id === device.id && k.command_id === command_id,
  );
  if (!exists) {
    keys.push({
      device_id: device.id,
      command_id,
      key_material,
      released_at: null,
    });
    await saveKeys(env, keys);
  }

  return jsonResponse({ escrowed: true, command_id });
}

async function handleEnroll(request: Request, env: Env): Promise<Response> {
  if (!(await verifyAdminAuth(request, env))) {
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
  if (!(await verifyAdminAuth(request, env))) {
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
  if (!(await verifyAdminAuth(request, env))) {
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
  if (!(await verifyAdminAuth(request, env))) {
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
  if (!(await verifyAdminAuth(request, env))) {
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
  if (!(await verifyAdminAuth(request, env))) {
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
  if (!(await verifyAdminAuth(request, env))) {
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
  if (!(await verifyAdminAuth(request, env))) {
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
  if (!(await verifyAdminAuth(request, env))) {
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
 * POST /api/agent/efs-cert — agent uploads its EFS certificate backup.
 * The cert is stored in KV as `efs_cert:{deviceId}` (base64-encoded .pfx).
 * Agent auth required — the device is identified by its API key.
 */
async function handleUploadEfsCert(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.text();
  const device = await verifyAgentAuth(request, env, body);
  if (!device) {
    return errorResponse('Agent authentication required', 401);
  }

  let payload: { cert_base64?: string; cert_password?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!payload.cert_base64) {
    return errorResponse('Missing cert_base64 field', 400);
  }

  // Store the cert in KV, keyed by device ID
  const certKey = `efs_cert:${device.id}`;
  const certData = JSON.stringify({
    cert_base64: payload.cert_base64,
    cert_password: payload.cert_password || '',
    uploaded_at: new Date().toISOString(),
    device_id: device.id,
  });
  await env.LOCKDOWN_KV.put(certKey, certData);

  await addAuditEntry(env, device.id, 'efs_cert_uploaded', '');

  return jsonResponse({
    device: { id: device.id, hostname: device.hostname },
    stored: true,
  });
}

/**
 * GET /api/devices/:id/efs-cert — admin downloads a device's EFS cert backup.
 * Returns the base64-encoded .pfx and its password as JSON.
 */
async function handleDownloadEfsCert(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  if (!(await verifyAdminAuth(request, env))) {
    return errorResponse('Admin authentication required', 401);
  }

  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) {
    return errorResponse('Device not found', 404);
  }

  const certKey = `efs_cert:${deviceId}`;
  const certData = await env.LOCKDOWN_KV.get(certKey);
  if (!certData) {
    return errorResponse('No EFS certificate backup for this device', 404);
  }

  return jsonResponse(JSON.parse(certData));
}

/**
 * GET /api/audit — return audit log entries (optionally filtered by device_id).
 */
async function handleGetAudit(request: Request, env: Env): Promise<Response> {
  if (!(await verifyAdminAuth(request, env))) {
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
 * POST /api/auth/login — username+password → signed session token.
 *
 * Mirrors the Express server's contract: the dashboard sends
 * { username, password } and expects { token, user: { username, role } }.
 * The returned token is an HMAC-signed JWT-shape token the dashboard stores
 * in localStorage and sends as a Bearer credential.
 *
 * Break-glass: if { token } (or a password equal to ADMIN_TOKEN) is sent and
 * matches the env ADMIN_TOKEN, issue a super-admin session — keeps the
 * pre-multi-admin behavior working for bootstrap / recovery.
 */
async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  let payload: { username?: string; password?: string; token?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  // Break-glass: direct ADMIN_TOKEN, or a password equal to ADMIN_TOKEN, →
  // super-admin. The dashboard may send { username, password } where the
  // password is the break-glass token, so check the password field too.
  const direct = payload.token || payload.password;
  if (direct && direct === env.ADMIN_TOKEN) {
    const sa: Admin = {
      id: 'admin-token', username: 'admin', password_hash: '', salt: '',
      role: 'super-admin', created_at: new Date().toISOString(),
    };
    return jsonResponse({
      token: await signAdminToken(env, sa),
      user: { username: 'admin', role: 'super-admin' },
      admin: { id: sa.id, username: 'admin', role: 'super-admin' },
    });
  }

  // Normal path: username + password → look up admin → PBKDF2 verify.
  const { username, password } = payload;
  if (!username || !password) {
    return errorResponse('username and password required', 400);
  }
  if (typeof username !== 'string' || typeof password !== 'string') {
    return errorResponse('username and password must be strings', 400);
  }

  const admins = await listAdmins(env);
  const admin = admins.find((a) => a.username === username);
  if (!admin) {
    return errorResponse('Invalid credentials. Check your username and password and try again.', 401);
  }
  const hash = await pbkdf2Hash(password, admin.salt);
  if (hash !== admin.password_hash) {
    return errorResponse('Invalid credentials. Check your username and password and try again.', 401);
  }

  return jsonResponse({
    token: await signAdminToken(env, admin),
    user: { username: admin.username, role: admin.role },
    admin: { id: admin.id, username: admin.username, role: admin.role },
  });
}

/**
 * GET /api/setup/status — report setup as complete (Worker is always ready).
 */
async function handleSetupStatus(env: Env): Promise<Response> {
  // First-run setup is needed only when no admin exists yet. Once an admin
  // is created (or the break-glass ADMIN_TOKEN is relied on), setup is done.
  const admins = await listAdmins(env);
  const needsSetup = admins.length === 0;
  return jsonResponse({ setupComplete: !needsSetup, needsSetup, admins: admins.length });
}

const VALID_ADMIN_ROLES: AdminRole[] = ['viewer', 'operator', 'super-admin'];

/**
 * POST /api/setup/create-admin — create the first admin (first-run setup).
 * Open only while no admin exists; after that, creating admins requires
 * super-admin auth via /api/admins.
 */
async function handleCreateFirstAdmin(request: Request, env: Env): Promise<Response> {
  const existing = await listAdmins(env);
  if (existing.length > 0) {
    return errorResponse('Setup already complete. Use /api/admins to manage admins.', 409);
  }
  let payload: { username?: string; password?: string; role?: string };
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  const { username, password } = payload;
  if (!username || !password) {
    return errorResponse('username and password required', 400);
  }
  if (typeof password !== 'string' || password.length < 8) {
    return errorResponse('Password must be at least 8 characters.', 400);
  }
  if (!/^[a-zA-Z0-9_@.\-]+$/.test(username)) {
    return errorResponse('username contains invalid characters.', 400);
  }
  // First admin is always super-admin.
  const admin = await makeAdmin(username, password, 'super-admin');
  await saveAdmins(env, [admin]);
  return jsonResponse({
    admin: { id: admin.id, username: admin.username, role: admin.role },
    token: await signAdminToken(env, admin),
  });
}

/**
 * GET /api/admins — list admins (super-admin only).
 */
async function handleListAdmins(request: Request, env: Env): Promise<Response> {
  const auth = await requireRole(request, env, 'super-admin');
  if (auth instanceof Response) return auth;
  const admins = await listAdmins(env);
  return jsonResponse(
    admins.map((a) => ({ id: a.id, username: a.username, role: a.role, created_at: a.created_at })),
  );
}

/**
 * POST /api/admins — create an admin (super-admin only).
 */
async function handleCreateAdmin(request: Request, env: Env): Promise<Response> {
  const auth = await requireRole(request, env, 'super-admin');
  if (auth instanceof Response) return auth;
  let payload: { username?: string; password?: string; role?: AdminRole };
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  const { username, password, role } = payload;
  if (!username || !password || !role) {
    return errorResponse('username, password, and role are required.', 400);
  }
  if (typeof password !== 'string' || password.length < 8) {
    return errorResponse('Password must be at least 8 characters.', 400);
  }
  if (!VALID_ADMIN_ROLES.includes(role)) {
    return errorResponse(`role must be one of: ${VALID_ADMIN_ROLES.join(', ')}.`, 400);
  }
  if (!/^[a-zA-Z0-9_@.\-]+$/.test(username)) {
    return errorResponse('username contains invalid characters.', 400);
  }
  const admins = await listAdmins(env);
  if (admins.some((a) => a.username === username)) {
    return errorResponse('An admin with that username already exists.', 409);
  }
  const admin = await makeAdmin(username, password, role);
  admins.push(admin);
  await saveAdmins(env, admins);
  await addAuditEntry(env, '', 'admin_created', `username=${username} role=${role} by=${auth.username}`);
  return jsonResponse({ id: admin.id, username: admin.username, role: admin.role, created_at: admin.created_at }, 201);
}

/**
 * PATCH /api/admins/:id — change an admin's role (super-admin only).
 */
async function handleUpdateAdmin(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireRole(request, env, 'super-admin');
  if (auth instanceof Response) return auth;
  let payload: { role?: AdminRole };
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  if (!payload.role || !VALID_ADMIN_ROLES.includes(payload.role)) {
    return errorResponse(`role must be one of: ${VALID_ADMIN_ROLES.join(', ')}.`, 400);
  }
  const admins = await listAdmins(env);
  const target = admins.find((a) => a.id === id);
  if (!target) return errorResponse('Admin not found', 404);
  // Guard: can't demote the last super-admin.
  const superAdmins = admins.filter((a) => a.role === 'super-admin');
  if (target.role === 'super-admin' && payload.role !== 'super-admin' && superAdmins.length === 1) {
    return errorResponse('Cannot demote the last super-admin.', 400);
  }
  target.role = payload.role;
  await saveAdmins(env, admins);
  await addAuditEntry(env, '', 'admin_role_changed', `username=${target.username} role=${payload.role} by=${auth.username}`);
  return jsonResponse({ id: target.id, username: target.username, role: target.role });
}

/**
 * DELETE /api/admins/:id — delete an admin (super-admin only).
 * Cannot delete self or the last super-admin.
 */
async function handleDeleteAdmin(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireRole(request, env, 'super-admin');
  if (auth instanceof Response) return auth;
  const admins = await listAdmins(env);
  const target = admins.find((a) => a.id === id);
  if (!target) return errorResponse('Admin not found', 404);
  if (target.id === auth.id) {
    return errorResponse('Cannot delete your own admin account.', 400);
  }
  const superAdmins = admins.filter((a) => a.role === 'super-admin');
  if (target.role === 'super-admin' && superAdmins.length === 1) {
    return errorResponse('Cannot delete the last super-admin.', 400);
  }
  await saveAdmins(env, admins.filter((a) => a.id !== id));
  await addAuditEntry(env, '', 'admin_deleted', `username=${target.username} by=${auth.username}`);
  return jsonResponse({ deleted: true, id });
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
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
    if (path === '/api/setup/create-admin' && method === 'POST') {
      return handleCreateFirstAdmin(request, env);
    }

    // Multi-admin management (S4-serverless RBAC on KV)
    if (path === '/api/admins' && method === 'GET') {
      return handleListAdmins(request, env);
    }
    if (path === '/api/admins' && method === 'POST') {
      return handleCreateAdmin(request, env);
    }
    const adminMatch = path.match(/^\/api\/admins\/([^/]+)$/);
    if (adminMatch && method === 'PATCH') {
      return handleUpdateAdmin(request, env, adminMatch[1]);
    }
    if (adminMatch && method === 'DELETE') {
      return handleDeleteAdmin(request, env, adminMatch[1]);
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
    if (path === '/api/agent/escrow-key' && method === 'POST') {
      return handleEscrowKey(request, env);
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
    if (path === '/api/agent/efs-cert' && method === 'POST') {
      return handleUploadEfsCert(request, env);
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
      if (action === 'efs-cert' && method === 'GET') {
        return handleDownloadEfsCert(request, env, deviceId);
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

    if (path === '/api/download/quick.ps1' && method === 'GET') {
      return handleDownloadScript(env, 'quick');
    }

    if (path === '/api/download/reenroll.ps1' && method === 'GET') {
      return handleDownloadScript(env, 'reenroll');
    }

    // PBL endpoints (/v1/* — no agent auth, CBOR/COSE wire format)
    if (path.startsWith('/v1/')) {
      const resp = await handlePblRoute(request, env, path, method);
      // Add CORS headers to all PBL responses (D-210)
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };
      const newHeaders = new Headers(resp.headers);
      for (const [k, v] of Object.entries(corsHeaders)) {
        newHeaders.set(k, v);
      }
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: newHeaders,
      });
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

// ---------------------------------------------------------------------------
// PBL /v1/* routes — CBOR/COSE wire format, no agent auth
// ---------------------------------------------------------------------------

import { generateSigningKey, importPrivateKey, loadOrGenerateSigningKey, loadOrGeneratePolicySigningKey, rotateSigningKey, getKidHistory, type SigningKeyPair } from './pbl/signing';
import { loadCertChain, storeCertChain, splitDerCerts } from './pbl/certs';
import { handleVerdict } from './pbl/routes/verdict';
import { handlePolicy, handleStorePolicy } from './pbl/routes/policy';
import { handleEnrollPbl } from './pbl/routes/enroll';
import { handleAttest } from './pbl/routes/attest';
import { handleOverrideChallenge, handleOverrideResponse } from './pbl/routes/override';
import { handleSigningKey } from './pbl/routes/signingKey';
import { handleFirmwareDownload } from './pbl/routes/firmware';
import { listDevices as listPblDevices, deleteDevice as deletePblDevice, getDevice as getPblDevice, setDeviceStatus as setPblDeviceStatus } from './pbl/devices';
import { checkDeviceRateLimit, checkIpRateLimit, rateLimitResponse, DEVICE_RATE_LIMITS, IP_RATE_LIMITS } from './pbl/rateLimit';

// Cache the signing key pair across requests within the same isolate.
let cachedKeys: SigningKeyPair | null = null;
let cachedPolicyKeys: SigningKeyPair | null = null;

/** Reset the signing key cache (D-205: used by key rotation and tests). */
export function resetKeyCache(): void {
  cachedKeys = null;
  cachedPolicyKeys = null;
}

async function getSigningKeys(env: Env): Promise<SigningKeyPair> {
  if (cachedKeys) return cachedKeys;
  cachedKeys = await loadOrGenerateSigningKey(env.LOCKDOWN_KV, env.PBL_SIGNING_KEY);
  return cachedKeys;
}

// D-205: Separate policy signing key (C4 §1 — different from verdict key)
async function getPolicySigningKeys(env: Env): Promise<SigningKeyPair> {
  if (cachedPolicyKeys) return cachedPolicyKeys;

  cachedPolicyKeys = await loadOrGeneratePolicySigningKey(env.LOCKDOWN_KV, env.PBL_POLICY_SIGNING_KEY);

  return cachedPolicyKeys;
}

async function handlePblRoute(
  request: Request,
  env: Env,
  path: string,
  method: string,
): Promise<Response> {
  try {
    // D-210: Rate limiting
    // - Per-device for firmware endpoints (verdict, attest, enroll) — NAT-safe
    // - IP-based for admin endpoints (devices) — no device_id in request
    // - No rate limiting for policy GET (edge-cached) or health (trivial)
    // - Override challenge/response already has per-device limiting in override.ts

    // IP-based rate limiting for admin device management endpoints
    if (path.startsWith('/v1/devices') && IP_RATE_LIMITS.devices) {
      const rl = await checkIpRateLimit(env.LOCKDOWN_KV, request, 'devices', IP_RATE_LIMITS.devices);
      if (!rl.allowed) {
        return rateLimitResponse(rl.retryAfter);
      }
    }

    if (path === '/v1/verdict' && method === 'POST') {
      const keys = await getSigningKeys(env);
      return handleVerdict(request, env, keys);
    }

    // GET /v1/policy/:version — return signed policy blob (C4 §6)
    if (path.startsWith('/v1/policy/') && method === 'GET') {
      const versionParam = path.substring('/v1/policy/'.length);
      // D-205: Policy blobs are signed by the policy signing key (C4 §1),
      // separate from the verdict signing key.
      const policyKeys = await getPolicySigningKeys(env);
      const verdictKeys = await getSigningKeys(env);
      return handlePolicy(request, env, policyKeys, verdictKeys, versionParam);
    }

    // POST /v1/policy — store a policy blob (admin only)
    if (path === '/v1/policy' && method === 'POST') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const policyKeys = await getPolicySigningKeys(env);
      const verdictKeys = await getSigningKeys(env);
      return handleStorePolicy(request, env, policyKeys, verdictKeys);
    }

    // POST /v1/enroll — PBL TPM-based enrollment (C1 §6)
    if (path === '/v1/enroll' && method === 'POST') {
      return handleEnrollPbl(request, env);
    }

    // POST /v1/attest — TPM quote verification (C1 §6, D-203)
    if (path === '/v1/attest' && method === 'POST') {
      return handleAttest(request, env);
    }

    // POST /v1/override/challenge — REQ-14 offline override challenge (D-204)
    if (path === '/v1/override/challenge' && method === 'POST') {
      return handleOverrideChallenge(request, env);
    }

    // POST /v1/override/response — REQ-14 offline override response (D-204)
    if (path === '/v1/override/response' && method === 'POST') {
      const keys = await getSigningKeys(env);
      return handleOverrideResponse(request, env, keys);
    }

    // GET /v1/signing-key — return server's verdict signing key info (D-205)
    // Public endpoint — returns kid + SPKI for policy blob construction
    if (path === '/v1/signing-key' && method === 'GET') {
      return handleSigningKey(request, env);
    }

    // GET /v1/firmware — download PblApp.efi from KV (D-130)
    // Public endpoint — firmware binary is not secret
    if (path === '/v1/firmware' && method === 'GET') {
      return handleFirmwareDownload(request, env);
    }

    // GET /v1/devices — list all PBL devices (admin only, D-206)
    if (path === '/v1/devices' && method === 'GET') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const devices = await listPblDevices(env.LOCKDOWN_KV);
      return new Response(
        JSON.stringify({ devices, count: devices.length }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // GET /v1/devices/:id — get a single PBL device (admin only, D-206)
    if (path.startsWith('/v1/devices/') && !path.includes('/lock') && !path.includes('/unlock') && !path.includes('/track') && !path.includes('/agent-mapping') && method === 'GET') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const deviceId = path.substring('/v1/devices/'.length);
      const device = await getPblDevice(env.LOCKDOWN_KV, deviceId);
      if (!device) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ device }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/devices/:id/lock — admin lock device (D-206)
    if (path.startsWith('/v1/devices/') && path.endsWith('/lock') && method === 'POST') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/lock'.length);
      const device = await setPblDeviceStatus(env.LOCKDOWN_KV, deviceId, 'locked', 'admin_lock');
      if (!device) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ device }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/devices/:id/unlock — admin unlock device (D-206)
    if (path.startsWith('/v1/devices/') && path.endsWith('/unlock') && method === 'POST') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/unlock'.length);
      const device = await setPblDeviceStatus(env.LOCKDOWN_KV, deviceId, 'active');
      if (!device) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ device }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/devices/:id/track — admin track device (C5 covert tracking, D-211)
    if (path.startsWith('/v1/devices/') && path.endsWith('/track') && method === 'POST') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/track'.length);
      const device = await setPblDeviceStatus(env.LOCKDOWN_KV, deviceId, 'tracking', 'reported_stolen');
      if (!device) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ device }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/devices/:id/stop-track — admin stop tracking device (C5, D-211)
    if (path.startsWith('/v1/devices/') && path.endsWith('/stop-track') && method === 'POST') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/stop-track'.length);
      const device = await setPblDeviceStatus(env.LOCKDOWN_KV, deviceId, 'active');
      if (!device) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ device }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // GET /v1/devices/:id/agent-mapping — look up agent device by PBL device_id (D-206)
    // Returns the agent device record linked to this PBL device, if any.
    // The agent device data is stored in the server's PostgreSQL/SQLite DB,
    // not in KV. The serverless Worker stores the mapping in KV as
    // `pbl_device_mapping:{pbl_device_id}` → { agent_device_id }.
    // NOTE: Must come before the general DELETE /v1/devices/:id route.
    if (path.startsWith('/v1/devices/') && path.endsWith('/agent-mapping') && method === 'GET') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/agent-mapping'.length);
      const mappingKey = `pbl_device_mapping:${deviceId}`;
      const mapping = await env.LOCKDOWN_KV.get(mappingKey, 'text');
      if (!mapping) {
        return new Response(
          JSON.stringify({ mapped: false, pbl_device_id: deviceId }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ mapped: true, pbl_device_id: deviceId, agent_device_id: mapping }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/devices/:id/agent-mapping — link a PBL device to an agent device (D-206)
    // Body: { agent_device_id: string } — the UUID of the agent device record.
    if (path.startsWith('/v1/devices/') && path.endsWith('/agent-mapping') && method === 'POST') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/agent-mapping'.length);
      const pblDevice = await getPblDevice(env.LOCKDOWN_KV, deviceId);
      if (!pblDevice) {
        return errorResponse('PBL device not found', 404);
      }
      let body: { agent_device_id?: string };
      try {
        body = await request.json();
      } catch {
        return errorResponse('invalid JSON body', 400);
      }
      if (!body.agent_device_id || typeof body.agent_device_id !== 'string') {
        return errorResponse('agent_device_id is required', 400);
      }
      const mappingKey = `pbl_device_mapping:${deviceId}`;
      await env.LOCKDOWN_KV.put(mappingKey, body.agent_device_id);
      return new Response(
        JSON.stringify({ mapped: true, pbl_device_id: deviceId, agent_device_id: body.agent_device_id }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // DELETE /v1/devices/:id/agent-mapping — unlink a PBL device from an agent device (D-206)
    if (path.startsWith('/v1/devices/') && path.endsWith('/agent-mapping') && method === 'DELETE') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/agent-mapping'.length);
      const mappingKey = `pbl_device_mapping:${deviceId}`;
      const existing = await env.LOCKDOWN_KV.get(mappingKey, 'text');
      if (!existing) {
        return errorResponse('No agent device mapping found', 404);
      }
      await env.LOCKDOWN_KV.delete(mappingKey);
      return new Response(
        JSON.stringify({ unmapped: true, pbl_device_id: deviceId }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // DELETE /v1/devices/:id — admin delete device (D-206)
    if (path.startsWith('/v1/devices/') && method === 'DELETE') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const deviceId = path.substring('/v1/devices/'.length);
      const deleted = await deletePblDevice(env.LOCKDOWN_KV, deviceId);
      if (!deleted) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ deleted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/admin/rotate-key — rotate the verdict signing key (D-205, admin only)
    if (path === '/v1/admin/rotate-key' && method === 'POST') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      try {
        const { keys: newKeys, kidHistory } = await rotateSigningKey(env.LOCKDOWN_KV);
        // Invalidate the cached key so subsequent requests use the new key
        resetKeyCache();
        const kidHex = Array.from(newKeys.kid)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        return new Response(
          JSON.stringify({
            rotated: true,
            new_kid: kidHex,
            kid_history_count: kidHistory.length,
            kid_history: kidHistory.map(k =>
              Array.from(k).map(b => b.toString(16).padStart(2, '0')).join('')
            ),
            spki_size: newKeys.spki.length,
            algorithm: newKeys.algorithm,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'rotation failed';
        return errorResponse(msg, 500);
      }
    }

    // GET /v1/admin/key-info — get current signing key info (D-205, admin only)
    if (path === '/v1/admin/key-info' && method === 'GET') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const keys = await getSigningKeys(env);
      const policyKeys = await getPolicySigningKeys(env);
      const kidHistory = await getKidHistory(env.LOCKDOWN_KV);
      return new Response(
        JSON.stringify({
          verdict_key: {
            kid: Array.from(keys.kid).map(b => b.toString(16).padStart(2, '0')).join(''),
            spki_size: keys.spki.length,
            algorithm: keys.algorithm,
          },
          policy_key: {
            kid: Array.from(policyKeys.kid).map(b => b.toString(16).padStart(2, '0')).join(''),
            spki_size: policyKeys.spki.length,
            algorithm: policyKeys.algorithm,
          },
          kid_history: kidHistory.map(k =>
            Array.from(k).map(b => b.toString(16).padStart(2, '0')).join('')
          ),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/admin/cert-chain — store the X.509 cert chain in KV (D-205, admin only)
    // Body: raw DER bytes (concatenated certs) or JSON { chain: "<base64>" }
    if (path === '/v1/admin/cert-chain' && method === 'POST') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      try {
        const contentType = request.headers.get('Content-Type') || '';
        let chainBytes: Uint8Array;

        if (contentType.includes('application/json')) {
          const body = await request.json() as { chain?: string };
          if (!body.chain) {
            return errorResponse('chain (base64) required in JSON body', 400);
          }
          chainBytes = Uint8Array.from(Buffer.from(body.chain, 'base64'));
        } else {
          // Raw DER bytes
          chainBytes = new Uint8Array(await request.arrayBuffer());
        }

        if (chainBytes.length === 0) {
          return errorResponse('cert chain cannot be empty', 400);
        }

        // Validate: must be valid DER SEQUENCEs
        const certs = splitDerCerts(chainBytes);
        if (certs.length === 0) {
          return errorResponse('no valid DER certificates found', 400);
        }
        if (certs.length < 2) {
          return errorResponse('cert chain must have at least 2 certs (leaf + CA)', 400);
        }

        await storeCertChain(env.LOCKDOWN_KV, chainBytes);

        return new Response(
          JSON.stringify({
            stored: true,
            cert_count: certs.length,
            total_size: chainBytes.length,
            cert_sizes: certs.map(c => c.length),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'store failed';
        return errorResponse(msg, 500);
      }
    }

    // GET /v1/admin/cert-chain — get cert chain info (D-205, admin only)
    if (path === '/v1/admin/cert-chain' && method === 'GET') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const certs = await loadCertChain(env.LOCKDOWN_KV);
      return new Response(
        JSON.stringify({
          provisioned: certs.length > 0,
          cert_count: certs.length,
          cert_sizes: certs.map(c => c.length),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // DELETE /v1/admin/cert-chain — remove cert chain from KV (D-205, admin only)
    if (path === '/v1/admin/cert-chain' && method === 'DELETE') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      await env.LOCKDOWN_KV.delete('pbl_cert_chain:current');
      return new Response(
        JSON.stringify({ deleted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/admin/operator-key — store the operator override public key (D-204, admin only)
    // Body: JSON { spki: "<base64>" } — the ES256 public key SPKI
    if (path === '/v1/admin/operator-key' && method === 'POST') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      try {
        const body = await request.json() as { spki?: string };
        if (!body.spki) {
          return errorResponse('spki (base64) required in JSON body', 400);
        }
        const spkiBytes = Uint8Array.from(Buffer.from(body.spki, 'base64'));
        if (spkiBytes.length === 0) {
          return errorResponse('spki cannot be empty', 400);
        }
        // Validate: try to import as ES256 public key
        try {
          await crypto.subtle.importKey(
            'spki', spkiBytes,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false, ['verify'],
          );
        } catch {
          return errorResponse('spki is not a valid ES256 public key', 400);
        }
        await env.LOCKDOWN_KV.put('pbl_operator_key:current', body.spki);
        return new Response(
          JSON.stringify({ stored: true, spki_size: spkiBytes.length }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'store failed';
        return errorResponse(msg, 500);
      }
    }

    // GET /v1/admin/operator-key — get operator key info (D-204, admin only)
    if (path === '/v1/admin/operator-key' && method === 'GET') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      const stored = await env.LOCKDOWN_KV.get('pbl_operator_key:current', 'text');
      return new Response(
        JSON.stringify({
          provisioned: !!stored,
          spki_size: stored ? Uint8Array.from(Buffer.from(stored, 'base64')).length : 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // DELETE /v1/admin/operator-key — remove operator key (D-204, admin only)
    if (path === '/v1/admin/operator-key' && method === 'DELETE') {
      if (!(await verifyAdminAuth(request, env))) {
        return errorResponse('Admin authentication required', 401);
      }
      await env.LOCKDOWN_KV.delete('pbl_operator_key:current');
      return new Response(
        JSON.stringify({ deleted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (path === '/v1/health' && method === 'GET') {
      return new Response(
        JSON.stringify({ status: 'ok', pbl: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ error: 'not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'internal error';
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
