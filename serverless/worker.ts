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
interface HwTestArtifact {
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
interface HwTestArtifactUpload {
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

interface HwTestSummary {
  tests?: number;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  errors?: number;
}

interface HwTestEnvironment {
  hostname?: string;
  agent_binary_hash?: string;
  [key: string]: unknown;
}


interface Command {
  id: string;
  device_id: string;
  command_type: 'lockdown' | 'unlock' | 'track' | 'stop_track';
  status: 'pending' | 'executed' | 'failed';
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

// S4-serverless: BIOS/PBA credential store (mirrors server's bios_passwords
// table). The agent ACKs these during lockdown (bios_password → 'setup',
// power_on_password → 'power_on', bitlocker_pin → 'bitlocker_pin',
// bitlocker_recovery_password → 'bitlocker_recovery'). Stored plaintext in
// KV — same threat posture as the encryption_keys store; a KV_KEK envelope
// layer can be added uniformly later.
interface BiosPassword {
  device_id: string;
  password_type: 'setup' | 'power_on' | 'bitlocker_pin' | 'bitlocker_recovery';
  password: string;
  created_at: string;
}

/** Group bios_password rows by type, most recent of each (server parity). */
function groupPbaCredentials(rows: BiosPassword[]): {
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
// Helpers
// ---------------------------------------------------------------------------

async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * SHA-256 of raw bytes, lowercase hex.
 *
 * Used to label binary downloads with x-content-sha256 so a client can prove the
 * body it received is the body this Worker served. It is transport integrity,
 * not authenticity — a hash delivered alongside the bytes is self-certifying
 * (see the same caveat in agent/agent.py's update path). Authenticity needs a
 * signature; the installer binaries are not Authenticode-signed yet.
 */
async function sha256HexBytes(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time string comparison (length + byte-wise). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
      'Access-Control-Allow-Origin': TOKEN_API_CORS_ORIGIN,
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
  // PBKDF2 iteration count used for password_hash. Optional for backward
  // compat — admins created before this field existed used the then-current
  // PBKDF2_ITERATIONS default. Recording it per-admin lets us change the
  // cost without invalidating existing hashes.
  pbkdf2_iterations?: number;
  role: AdminRole;
  created_at: string;
}

const ADMINS_KEY = 'admins';
// Cloudflare Workers' WebCrypto caps PBKDF2 at 100,000 iterations
// (NotSupportedError above that). 210k was the NIST floor we targeted but it
// crashes on the real Workers runtime (error 1101 on create-admin). 100k is
// the platform max and still a strong PBKDF2-SHA256 cost.
const PBKDF2_ITERATIONS = 100_000;
// Iteration count used for admins created before pbkdf2_iterations was
// recorded (they were hashed at the original 210k — which only ever ran in
// Node tests, never on the live Worker, so no live admin uses it).
const LEGACY_PBKDF2_ITERATIONS = 210_000;
const TOKEN_TTL_SECONDS = 8 * 3600; // match server's JWT_EXPIRES_IN default (8h)

const ROLE_HIERARCHY: Record<AdminRole, number> = {
  viewer: 0,
  operator: 1,
  'super-admin': 2,
};

/**
 * Parse a JSON blob read from KV.
 *
 * KV is external storage: a truncated or hand-edited value would otherwise raise
 * a bare SyntaxError from deep inside a handler with no clue which key was bad.
 * This names the key and re-throws. It deliberately does NOT fall back to an empty
 * collection — silently treating corruption as "no data" would make a tampered
 * fleet look empty, which is the wrong direction for an anti-theft system.
 */
function parseKvJson<T>(raw: string, key: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`corrupt KV value at "${key}" — refusing to treat it as empty`);
  }
}

/**
 * Parse a request body that was already read as text (agent HMAC verification
 * needs the raw bytes, so the handlers cannot re-read the stream).
 *
 * Returns null instead of throwing: a malformed body from an authenticated agent
 * is the caller's bug, and the honest answer is 400. Before this, the throw
 * escaped the handler and the runtime turned it into a 500 with no explanation.
 */
function parseJsonBody(text: string): any | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The request's URL.
 *
 * `Request.url` is absolute by construction, so a throw here means the Request
 * itself is malformed and never reached a handler. Centralised so the seven call
 * sites do not each need a try/catch, and so a hypothetical malformed URL
 * degrades to empty route params rather than a 500.
 */
function requestUrl(request: Request): URL {
  try {
    return new URL(request.url);
  } catch {
    return new URL('https://invalid.invalid/');
  }
}

async function listAdmins(env: Env): Promise<Admin[]> {
  const data = await env.LOCKDOWN_KV.get(ADMINS_KEY);
  return data ? parseKvJson<Admin[]>(data, ADMINS_KEY) : [];
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

/** PBKDF2-SHA256 password hash (base64) for a given salt + iteration count. */
async function pbkdf2Hash(password: string, saltB64: string, iterations: number = PBKDF2_ITERATIONS): Promise<string> {
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
      iterations,
    },
    keyMaterial,
    256,
  );
  return b64encode(bits);
}

/** Create an admin record with a fresh random salt + PBKDF2 hash. */
async function makeAdmin(username: string, password: string, role: AdminRole): Promise<Admin> {
  const salt = b64encode(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const password_hash = await pbkdf2Hash(password, salt, PBKDF2_ITERATIONS);
  return {
    id: generateId(),
    username,
    password_hash,
    salt,
    pbkdf2_iterations: PBKDF2_ITERATIONS,
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

// The Worker authenticates with `Authorization: Bearer` and `X-Agent-Key` headers —
// never cookies — so a wildcard origin does not expose credentials: a hostile page
// can send the request but cannot attach a token it does not have. Restricting it
// would break the Electron app, which loads the dashboard from file:// and
// therefore sends a null origin. Named once here so the decision is reviewable
// rather than repeated as a bare literal in three response paths.
const TOKEN_API_CORS_ORIGIN = '*';

const DEVICES_KEY = 'devices';
const COMMANDS_KEY = 'commands';
const KEYS_KEY = 'encryption_keys';
const LOCATIONS_KEY = 'locations';
const AUDIT_KEY = 'audit_log';
const HW_ARTIFACTS_KEY = 'hw_test_artifacts';

// Agent release metadata for GET /api/agent/update, written at release time by
// CI (see serverless/README.md). It holds the version, the binary's sha256/size
// and the detached Ed25519 signature over "v1:{version}:{sha256}" — produced
// wherever the signing key lives, never in the Worker. The Worker only serves it,
// so it cannot drift from the signature's payload.
const AGENT_RELEASE_KEY = 'agent_release';
const BIOS_PASSWORDS_KEY = 'bios_passwords';

// KV-RACE-001: Checkin metadata is stored in a separate KV key from device
// status. This prevents the checkin handler's read-modify-write of the
// `devices` key from racing with the ACK handler's status update.
// The checkin handler writes ONLY to `device_checkin:{id}`, never to
// `devices`. Admin endpoints merge checkin metadata when returning device data.
const CHECKIN_KEY_PREFIX = 'device_checkin:';

async function listDevices(env: Env): Promise<Device[]> {
  const data = await env.LOCKDOWN_KV.get(DEVICES_KEY);
  return data ? parseKvJson<Device[]>(data, DEVICES_KEY) : [];
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
function firmwareAuditModel(audit: unknown): string | null {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return null;
  const model = (audit as Record<string, unknown>)['model'];
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

function normalizeAgentVersion(value: unknown): string | undefined {
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
function normalizeUpdateVerification(
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
function parseDbTimestamp(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const raw = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Longer than the maximum adaptive poll interval (300 s), so a normal cycle never trips it. */
const AGENT_VERSION_STALE_MS = 60 * 60 * 1000;

function isAgentVersionStale(device: Device): boolean {
  const lastCheckin = parseDbTimestamp(device.last_checkin);
  if (lastCheckin === null) return false;
  const reported = parseDbTimestamp(device.agent_version_at);
  if (reported === null) return true;
  return lastCheckin - reported > AGENT_VERSION_STALE_MS;
}

async function getCheckinMetadata(env: Env, deviceId: string): Promise<CheckinMetadata | null> {
  const data = await env.LOCKDOWN_KV.get(`${CHECKIN_KEY_PREFIX}${deviceId}`);
  return data ? parseKvJson<CheckinMetadata>(data, `${CHECKIN_KEY_PREFIX}${deviceId}`) : null;
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

async function listCommands(env: Env): Promise<Command[]> {
  const data = await env.LOCKDOWN_KV.get(COMMANDS_KEY);
  return data ? parseKvJson<Command[]>(data, COMMANDS_KEY) : [];
}

async function saveCommands(env: Env, commands: Command[]): Promise<void> {
  await env.LOCKDOWN_KV.put(COMMANDS_KEY, JSON.stringify(commands));
}

async function listKeys(env: Env): Promise<EncryptionKey[]> {
  const data = await env.LOCKDOWN_KV.get(KEYS_KEY);
  return data ? parseKvJson<EncryptionKey[]>(data, KEYS_KEY) : [];
}

async function saveKeys(env: Env, keys: EncryptionKey[]): Promise<void> {
  await env.LOCKDOWN_KV.put(KEYS_KEY, JSON.stringify(keys));
}

// S4-serverless: secrets envelope for bios_passwords at rest. When KV_KEK
// is provisioned, each credential's `password` is AES-256-GCM-encrypted
// before it lands in KV and decrypted transparently on read. Rows written
// before KV_KEK existed (plaintext `password`) still read back — a row is
// treated as encrypted only when `password_enc` is present.
interface StoredBiosPassword extends Omit<BiosPassword, 'password'> {
  password?: string;      // plaintext (legacy / no KEK)
  password_enc?: string;  // base64(nonce||ciphertext) when KV_KEK set
}

async function getKek(env: Env): Promise<CryptoKey | null> {
  const kek = (env as { KV_KEK?: string }).KV_KEK;
  if (!kek) return null;
  const raw = b64decode(kek);
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encSecret(env: Env, plaintext: string): Promise<{ password_enc?: string; password?: string }> {
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

async function decSecret(env: Env, row: StoredBiosPassword): Promise<string> {
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

async function listBiosPasswords(env: Env): Promise<BiosPassword[]> {
  const data = await env.LOCKDOWN_KV.get(BIOS_PASSWORDS_KEY);
  if (!data) return [];
  const stored = parseKvJson<StoredBiosPassword[]>(data, BIOS_PASSWORDS_KEY);
  // Decrypt each row's password transparently.
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

async function saveBiosPasswords(env: Env, pws: BiosPassword[]): Promise<void> {
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
  await env.LOCKDOWN_KV.put(BIOS_PASSWORDS_KEY, JSON.stringify(stored));
}

async function listLocations(env: Env): Promise<LocationReport[]> {
  const data = await env.LOCKDOWN_KV.get(LOCATIONS_KEY);
  return data ? parseKvJson<LocationReport[]>(data, LOCATIONS_KEY) : [];
}

async function saveHwArtifacts(env: Env, artifacts: HwTestArtifact[]): Promise<void> {
  await env.LOCKDOWN_KV.put(HW_ARTIFACTS_KEY, JSON.stringify(artifacts));
}

async function saveLocations(env: Env, locations: LocationReport[]): Promise<void> {
  // Cap at 1000 most recent to stay within KV value size limits
  const capped = locations.slice(-1000);
  await env.LOCKDOWN_KV.put(LOCATIONS_KEY, JSON.stringify(capped));
}

async function listAudit(env: Env): Promise<AuditEntry[]> {
  const data = await env.LOCKDOWN_KV.get(AUDIT_KEY);
  return data ? parseKvJson<AuditEntry[]>(data, AUDIT_KEY) : [];
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

  const payload = parseJsonBody(body);
  if (!payload) return errorResponse('Invalid JSON body', 400);
  const { mac_address, hardware_uuid, serial_number } = payload;

  // KV-RACE-001: Write checkin metadata to a separate KV key, NOT to
  // the `devices` key. Same fix as handleAgentCheckin.
  const devices = await listDevices(env);
  const idx = devices.findIndex((d) => d.id === device.id);
  if (idx >= 0) {
    // A ping is a partial heartbeat. Spread the stored metadata so fields this
    // payload does not carry — firmware_audit, a previously reported
    // update_verification — survive: replacing the object wholesale dropped the
    // firmware audit until the next full check-in.
    const existing = await getCheckinMetadata(env, device.id);
    await saveCheckinMetadata(env, device.id, {
      ...existing,
      last_checkin: new Date().toISOString(),
      mac_address: mac_address || devices[idx].mac_address,
      hardware_uuid: hardware_uuid || devices[idx].hardware_uuid,
      serial_number: serial_number || devices[idx].serial_number,
      update_verification:
        normalizeUpdateVerification(payload.update_verification)
        ?? existing?.update_verification,
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
// ---------------------------------------------------------------------------
// D-221: the uninstall token scheme
// ---------------------------------------------------------------------------
// Canonical form, shared with the Express routes and pinned by
// `docs/adr/D-221-token-vectors.json`:
//
//   window = floor(unix_seconds / 300) * 300
//   token  = HMAC_SHA256(secret=ADMIN_TOKEN, msg=`${device_id}:${window}`)   # lowercase hex
//
// What this replaced: `SHA256(`${window}:${ADMIN_TOKEN}`)` with no device input and a
// `|| 'fallback'` constant when the secret was unset — and it disagreed with Express, which
// used HMAC over the bare window, so a token from one surface never verified on the other.
const UNINSTALL_TOKEN_WINDOW_SECONDS = 300;

function uninstallWindowFor(seconds: number): number {
  return Math.floor(seconds / UNINSTALL_TOKEN_WINDOW_SECONDS) * UNINSTALL_TOKEN_WINDOW_SECONDS;
}

/** The bound token: only the named device may present it. */
async function deriveUninstallToken(
  secret: string,
  deviceId: string,
  window: number,
): Promise<string> {
  return hmacSha256(secret, `${deviceId}:${window}`);
}

/**
 * The PREVIOUS Worker derivation, kept for one release (ruling Q2-A) so a device whose agent
 * has not taken the update can still uninstall. Verification logs when this path is taken.
 */
async function legacyUninstallToken(secret: string, window: number): Promise<string> {
  return sha256(`${window}:${secret}`);
}

// The date the legacy scheme stops being accepted. docs/adr/D-221-token-vectors.json is the
// authoritative statement; this literal is echoed to caller and operator, and
// serverless/worker.test.ts pins it against `legacy_sunset`. On that date
// scripts/test_cross_surface_contract.py fails with the deletion checklist.
const LEGACY_UNINSTALL_TOKEN_SUNSET = '2027-02-04';

/**
 * Who is calling, and as which device?
 *
 * Returns the device row when a device key authenticated (the only trustworthy source of the id
 * the token is bound to), or `{ device: null }` for the deployment's ADMIN_TOKEN.
 */
async function uninstallAuth(
  request: Request,
  env: Env,
): Promise<{ device: Device | null } | null> {
  const apiKey = request.headers.get('X-API-Key') || '';
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  if (apiKey) {
    const apiKeyHash = await sha256(apiKey);
    const device = (await listDevices(env)).find((d) => d.api_key_hash === apiKeyHash);
    if (device) return { device };
  }
  if (token && env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) {
    return { device: null };
  }
  return null;
}

/**
 * Which device is this token for? A device-key caller is bound to its OWN row and may not name
 * another device; the admin-token caller has no device, so it must name one in the body.
 */
function uninstallSubject(
  auth: { device: Device | null },
  body: { device_id?: string },
): { deviceId: string | null; error: string | null } {
  if (auth.device) return { deviceId: auth.device.id, error: null };
  const claimed = typeof body?.device_id === 'string' ? body.device_id.trim() : '';
  if (!claimed) {
    return {
      deviceId: null,
      error:
        'device_id required: an uninstall token is bound to one device, and an admin-token ' +
        'call has no device of its own to bind to.',
    };
  }
  return { deviceId: claimed, error: null };
}

const NO_ADMIN_TOKEN_MESSAGE =
  'Uninstall tokens are disabled: ADMIN_TOKEN is not set on this worker. Set it and redeploy; ' +
  'an uninstall token is derived from it.';

async function handleUninstallAuth(request: Request, env: Env): Promise<Response> {
  const auth = await uninstallAuth(request, env);
  if (!auth) {
    return errorResponse('Authentication required', 401);
  }

  // Q3-A: no secret, no token — the `|| 'fallback'` constant is gone.
  if (!env.ADMIN_TOKEN) {
    return errorResponse(NO_ADMIN_TOKEN_MESSAGE, 503);
  }

  // The body is optional for a device-key caller (its id comes from the row).
  let body: { device_id?: string } = {};
  try {
    body = (await request.json()) as { device_id?: string };
  } catch {
    body = {};
  }

  const subject = uninstallSubject(auth, body);
  if (subject.error) return errorResponse(subject.error, 400);

  const window = uninstallWindowFor(Math.floor(Date.now() / 1000));
  const uninstallToken = await deriveUninstallToken(
    env.ADMIN_TOKEN,
    subject.deviceId as string,
    window,
  );

  return jsonResponse({
    uninstall_token: uninstallToken,
    expires_in: UNINSTALL_TOKEN_WINDOW_SECONDS,
    issued_at: new Date().toISOString(),
    device_id: subject.deviceId,
  });
}

/**
 * POST /api/agent/uninstall-auth/verify — Verify an uninstall token.
 *
 * Checks if the token is valid (within the current 5-minute window).
 */
async function handleUninstallAuthVerify(request: Request, env: Env): Promise<Response> {
  const auth = await uninstallAuth(request, env);
  if (!auth) {
    return errorResponse('Authentication required', 401);
  }

  if (!env.ADMIN_TOKEN) {
    return errorResponse(NO_ADMIN_TOKEN_MESSAGE, 503);
  }

  let body: { uninstall_token?: string; device_id?: string };
  try {
    body = (await request.json()) as { uninstall_token?: string; device_id?: string };
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const providedToken = body.uninstall_token || '';
  if (!providedToken) {
    return errorResponse('uninstall_token required', 400);
  }

  const subject = uninstallSubject(auth, body);
  if (subject.error) return errorResponse(subject.error, 400);

  // Current and previous 5-minute windows, so ordinary clock skew does not break an uninstall.
  const now = Math.floor(Date.now() / 1000);
  const validWindows = [
    uninstallWindowFor(now),
    uninstallWindowFor(now - UNINSTALL_TOKEN_WINDOW_SECONDS),
  ];

  for (const window of validWindows) {
    const expected = await deriveUninstallToken(
      env.ADMIN_TOKEN,
      subject.deviceId as string,
      window,
    );
    if (timingSafeEqualStr(providedToken, expected)) {
      return jsonResponse({ authorized: true, verified: true });
    }
  }

  // Q2-A migration window: still accept the PREVIOUS Worker scheme so a device whose agent has
  // not taken the update can uninstall. Logged every time, because the acceptance is meant to end.
  for (const window of validWindows) {
    const legacy = await legacyUninstallToken(env.ADMIN_TOKEN, window);
    if (timingSafeEqualStr(providedToken, legacy)) {
      console.warn(
        `[uninstall-auth] accepted a LEGACY deployment-wide uninstall token for device ${subject.deviceId} ` +
          `— D-221 added device binding. It is deleted on ${LEGACY_UNINSTALL_TOKEN_SUNSET}; update the ` +
          'agent on that device before then or it cannot be uninstalled afterwards.',
      );
      return jsonResponse({
        authorized: true,
        verified: true,
        deprecated_scheme: 'legacy-deployment-wide',
        deprecated_scheme_sunset: LEGACY_UNINSTALL_TOKEN_SUNSET,
      });
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
  // update_verification falls back to the stored value when this check-in omits
  // it, mirroring the Express server's `COALESCE($6, update_verification)`: an
  // older agent must not reset a known mode to "unknown" on every check-in.
  const existingMetadata = await getCheckinMetadata(env, device.id);
  await saveCheckinMetadata(env, device.id, {
    last_checkin: new Date().toISOString(),
    mac_address: mac_address || devices[idx].mac_address,
    hardware_uuid: hardware_uuid || devices[idx].hardware_uuid,
    serial_number: serial_number || devices[idx].serial_number,
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
  let powerOnPassword: string | null = null;
  let bitlockerPin: string | null = null;
  let bitlockerRecoveryPassword: string | null = null;
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
    // S4-serverless: fetch the stored BIOS/PBA credentials the agent needs
    // to remove UEFI lockdown (setup + power-on) and that the dashboard
    // shows in the PBA Recovery panel (bitlocker pin + recovery).
    const pws = await listBiosPasswords(env);
    const devicePws = pws
      .filter((p) => p.device_id === device.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
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

  const payload = parseJsonBody(body);
  if (!payload) return errorResponse('Invalid JSON body', 400);
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

  const payload = parseJsonBody(body);
  if (!payload) return errorResponse('Invalid JSON body', 400);
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

  // E-EFFECTIVENESS: a lockdown that reports boot-lock attempted with zero
  // critical controls applied is NOT effective — the device is encrypted-only.
  // The rule is Express's (server/src/routes/agent.js:411-418). This handler used
  // to destructure boot_lock_detail and discard it, so on the serverless backend
  // every silently no-op'd boot-lock was recorded as a plain success.
  const command = commands[cmdIdx];
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

  command.status = result_status;
  command.executed_at = new Date().toISOString();
  command.boot_lock_status = typeof boot_lock_status === 'string' ? boot_lock_status : null;
  command.boot_lock_detail = boot_lock_detail ?? null;
  command.lockdown_effective = lockdownEffective;
  command.encryption_blocked_files = encryption_blocked_files ?? null;
  command.lock_session_context = lock_session_context ?? null;
  if (payload.command_uuid) {
    command.command_uuid = payload.command_uuid;
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
    const pws = await listBiosPasswords(env);
    for (const [value, type] of credsToStore) {
      if (value == null || value === '') continue;
      // Replace any existing credential of this type for the device.
      const idx = pws.findIndex((p) => p.device_id === device.id && p.password_type === type);
      const row: BiosPassword = {
        device_id: device.id,
        password_type: type,
        password: value,
        created_at: new Date().toISOString(),
      };
      if (idx >= 0) pws[idx] = row; else pws.push(row);
    }
    await saveBiosPasswords(env, pws);
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
      } else if (commands[cmdIdx].command_type === 'track') {
        devices[devIdx].status = 'tracking';
      } else if (commands[cmdIdx].command_type === 'stop_track') {
        devices[devIdx].status = 'active';
      }
    }
    await saveDevices(env, devices);
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
        command_uuid: command.command_uuid ?? undefined,
        boot_lock_status: command.boot_lock_status ?? undefined,
        boot_lock_detail: command.boot_lock_detail ?? undefined,
        lockdown_effective: command.lockdown_effective ?? undefined,
        encryption_blocked_files: command.encryption_blocked_files ?? undefined,
        lock_session_context: command.lock_session_context ?? undefined,
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
async function handleEscrowKey(request: Request, env: Env): Promise<Response> {
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
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

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
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

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
  // SAFETY: KV.delete is optional at runtime — real Cloudflare KV has it, the test
  // double does not — so the cast describes a shape that the typeof probe below
  // establishes before the call. Nothing here assumes it exists.
  const kv = env.LOCKDOWN_KV as unknown as { delete?: (k: string) => Promise<void> };
  // SAFETY: narrowed by the typeof probe on this line.
  if (typeof kv.delete === 'function') {
    await kv.delete(tokenKey);
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
  const auth = await requireRole(request, env, 'viewer');
  if (auth instanceof Response) return auth;
  const devices = await listDevices(env);
  // Merge checkin metadata from separate KV keys (KV-RACE-001 fix)
  // and strip api_key_hash before returning.
  const merged = await Promise.all(
    devices.map(async (d) => {
      const meta = await getCheckinMetadata(env, d.id);
      return mergeCheckinMetadata(d, meta);
    }),
  );
  // `api_key_hash` is destructured out so it can never leave the Worker; the `_` prefix is
  // what marks the binding as deliberately unused (the harness treats an unprefixed unused
  // binding as a bug, which it is everywhere else in this file).
  const safe = merged.map(({ api_key_hash: _api_key_hash, ...d }) => d);
  // D-222: a rollout asks "which devices are not on build X?". `unknown` is a distinct
  // query from any literal version — never-reported is not "on some other version".
  const url = new URL(request.url);
  const requestedVersion = (url.searchParams.get('agent_version') || '').trim();
  if (!requestedVersion) return jsonResponse(safe);
  const filtered = requestedVersion === 'unknown'
    ? safe.filter((d) => !d.agent_version)
    : requestedVersion === 'stale'
      ? safe.filter((d) => d.agent_version_stale)
      : safe.filter((d) => d.agent_version === requestedVersion);
  return jsonResponse(filtered);
}

async function handleGetDevice(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'viewer');
  if (auth instanceof Response) return auth;
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
  const { api_key_hash: _api_key_hash, ...safeDevice } = merged;
  return jsonResponse(safeDevice);
}

/**
 * POST /api/rearm — hardware-UUID-bound re-arm for the PblPersistDxe agent.
 *
 * The firmware DXE module drops a universal bootstrap to the ESP on every
 * boot. On a wiped/replaced disk, that bootstrap can't carry a device secret
 * — it identifies the machine by hardware_uuid (the same identifier used
 * for MDM-style re-association at enroll). This endpoint returns a
 * self-contained install.ps1 ONLY when the device is enrolled AND in a
 * non-active state (stolen/locked/recovering/tracking) — i.e. the device
 * was flagged and is re-arming itself. Unknown or active devices get 404 so
 * the endpoint can't be probed for existence.
 *
 * Trust model: hardware_uuid is a stable identifier, not a secret. A
 * random device cannot re-arm another unit unless it already has the right
 * hardware UUID AND the target is flagged — exactly the Computrace model.
 */
async function handleRearm(request: Request, env: Env): Promise<Response> {
  let payload: { hardware_uuid?: string; hostname?: string };
  try {
    payload = await request.json() as { hardware_uuid?: string; hostname?: string };
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  if (!payload.hardware_uuid) {
    return errorResponse('hardware_uuid required', 400);
  }

  const devices = await listDevices(env);
  // hardware_uuid may live on the device record or merged checkin metadata.
  let device: Device | undefined;
  for (const d of devices) {
    const meta = await getCheckinMetadata(env, d.id);
    const merged = mergeCheckinMetadata(d, meta);
    if (merged.hardware_uuid === payload.hardware_uuid) {
      device = d;
      break;
    }
  }
  if (!device) {
    return errorResponse('Device not found', 404);
  }

  // Only re-arm a device that was flagged — an active device re-arming is
  // a no-op (and would let anyone who learns a hardware_uuid re-key it).
  if (device.status === 'active') {
    return errorResponse('Device not found', 404);
  }

  // Re-issue a fresh api_key and return the self-contained installer so the
  // dropped bootstrap can install the real agent on first Windows boot.
  const apiKey = generateApiKey();
  device.api_key_hash = await sha256(apiKey);
  await saveDevices(env, devices);
  await addAuditEntry(env, device.id, 'rearm',
    `hardware_uuid=${payload.hardware_uuid} status=${device.status}`);

  const serverUrl = requestUrl(request).origin;
  const config = {
    server_url: serverUrl,
    device_hostname: device.hostname,
    api_key: apiKey,
    poll_interval: 30,
    sign_requests: true,
    server_supports_ack_dedup: true,
    boot_lock_enabled: true,
    enrolled_at: new Date().toISOString(),
    rearmed: true,
  };

  // Same generator as GET /api/installer/:id — see generateServerlessInstallScript.
  const script = generateServerlessInstallScript({
    device,
    config,
    serverUrl,
    rearmed: true,
  });

  return new Response(script, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
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
  const auth = await requireRole(request, env, 'viewer');
  if (auth instanceof Response) return auth;
  const devices = await listDevices(env);
  // Search both the device record and merged checkin metadata, since the
  // hardware_uuid may have been reported via checkin after enrollment.
  for (const d of devices) {
    const meta = await getCheckinMetadata(env, d.id);
    const merged = mergeCheckinMetadata(d, meta);
    if (merged.hardware_uuid === hardwareUuid) {
      const { api_key_hash: _api_key_hash, ...safeDevice } = merged;
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
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

  const payload = await request.json() as { hostname_confirm?: string; enable_pba?: boolean };

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
    // Only an explicit `true` opts in — anything else (absent, "true", 1) leaves
    // PBA off, matching the Express handler's `enable_pba === true`.
    enable_pba: payload.enable_pba === true,
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
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

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
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

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
  const auth = await requireRole(request, env, 'viewer');
  if (auth instanceof Response) return auth;
  const url = requestUrl(request);
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
  // EFS cert download returns a sensitive secret — super-admin only.
  const auth = await requireRole(request, env, 'super-admin');
  if (auth instanceof Response) return auth;

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

  const cert = parseJsonBody(certData);
  if (!cert) {
    // A cert record we cannot parse must not be handed back as if it were valid.
    return errorResponse('Corrupt EFS certificate backup', 500);
  }
  return jsonResponse(cert);
}

/**
 * GET /api/devices/:id/pba-credentials — PBA recovery credentials for the
 * dashboard (super-admin only, mirrors server's T10).
 *
 * Returns { setup_password, power_on_password, bitlocker_pin,
 * bitlocker_recovery_password } — the most recent credential of each type
 * the agent escrowed during lockdown. Audited as a sensitive disclosure.
 */
async function handleGetPbaCredentials(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'super-admin');
  if (auth instanceof Response) return auth;

  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) return errorResponse('Device not found', 404);

  const pws = await listBiosPasswords(env);
  const devicePws = pws
    .filter((p) => p.device_id === deviceId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const creds = groupPbaCredentials(devicePws);

  await addAuditEntry(
    env, deviceId, 'pba_credentials_accessed',
    `by=${auth.username} types=${Object.values(creds).filter((v) => v !== null).length}`,
  );
  return jsonResponse(creds);
}

/**
 * DELETE /api/devices/:id/release — offboard a device (operator+).
 *
 * Deletes the device and cascades its commands, keys, bios_passwords,
 * locations, and checkin metadata. Audit entries are preserved but
 * anonymized (device_id nulled) for accountability — mirrors the server's
 * release semantics.
 */
async function handleReleaseDevice(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

  let payload: { hostname_confirm?: string } = {};
  try { payload = JSON.parse(await request.text()); } catch { /* empty ok */ }

  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) return errorResponse('Device not found', 404);
  if (device.hostname !== payload.hostname_confirm) {
    return errorResponse('Confirmation hostname does not match.', 400);
  }
  if (['locked', 'stolen', 'recovering'].includes(device.status)) {
    return errorResponse(
      `Cannot release a device in '${device.status}' state. Recover (unlock) the device first.`, 409);
  }

  // Anonymize audit entries for this device (preserve for accountability).
  const audit = await listAudit(env);
  const releasedAt = new Date().toISOString();
  for (const e of audit) {
    if (e.device_id === deviceId) {
      e.detail = `${e.detail || ''} released_at=${releasedAt}`.trim();
    }
  }
  await saveAudit(env, audit);
  await addAuditEntry(env, deviceId, 'device_released', `hostname=${device.hostname} by=${auth.username}`);

  // Cascade-delete the device's data across the KV stores.
  await saveDevices(env, devices.filter((d) => d.id !== deviceId));
  await saveCommands(env, (await listCommands(env)).filter((c) => c.device_id !== deviceId));
  await saveKeys(env, (await listKeys(env)).filter((k) => k.device_id !== deviceId));
  await saveBiosPasswords(env, (await listBiosPasswords(env)).filter((p) => p.device_id !== deviceId));
  await saveLocations(env, (await listLocations(env)).filter((l) => l.device_id !== deviceId));
  await env.LOCKDOWN_KV.delete(`${CHECKIN_KEY_PREFIX}${deviceId}`);

  return jsonResponse({
    ok: true,
    message: `Device '${device.hostname}' has been released. All associated data has been deleted.`,
  });
}

/**
 * Build the self-contained install script returned by GET /api/installer/:id and
 * by POST /api/rearm (which PblPersistDxe runs on first Windows boot after a
 * disk swap).
 *
 * One helper, two call sites: the two responses are the same installer with a
 * different header. They used to be two hand-copied templates that both
 * registered the agent with `sc.exe create` — a mechanism the agent cannot
 * satisfy (no StartServiceCtrlDispatcher), so Windows failed the service with
 * 1053 and terminated the process about 30 seconds after every boot.
 *
 * The script now only stages files: it writes the baked config, fetches the two
 * binaries from KV, and hands off to lockdown-installer.exe --config-file, which
 * is the same installer the generic wrapper and the Express per-device
 * installers use. config.json is normalised by that installer, so nothing here
 * needs to know the state paths, and the device keeps its baked api_key — no
 * enrolment, no token on the target, no duplicate device record.
 */
function generateServerlessInstallScript(options: {
  device: Device;
  config: Record<string, unknown>;
  serverUrl: string;
  rearmed: boolean;
}): string {
  const { device, config, serverUrl, rearmed } = options;
  const configB64 = btoa(JSON.stringify(config, null, 2));
  const host = device.hostname;
  const title = rearmed ? 're-arm installer' : 'per-device installer';
  const tail = rearmed
    ? `Write-Host "Remote Lockdown agent re-armed for ${host}."`
    : `Write-Host "Remote Lockdown agent installed and started for ${host}."`;
  const trigger = rearmed
    ? '# Triggered by PblPersistDxe after disk replacement / OS reinstall.'
    : '# Generated for this device; its credentials are embedded below.';

  return `# Remote Lockdown — ${title} for ${host}
# Generated ${String(config.enrolled_at ?? '')} — run elevated (Administrator) on the target.
${trigger}
$ErrorActionPreference = 'Stop'

# Stock Windows PowerShell 5.1 negotiates TLS 1.0/1.1 on many images; the Worker sits behind
# Cloudflare, which requires TLS 1.2+. Without this, every Invoke-WebRequest below fails with
# "The underlying connection was closed" on a machine that has never been updated.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

# Work in a temp directory: the installer decides the real install location
# (%ProgramData\\LockdownAgent) and copies the agent there itself.
$work = Join-Path $env:TEMP ("remote-lockdown-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null

try {
    # 1. Write config.json (embedded; base64 avoids quoting issues). It carries
    #    this device's own API key, so no token or prompt is needed here.
    $configB64 = @'
${configB64}
'@
    [System.IO.File]::WriteAllBytes("$work\\config.json", [Convert]::FromBase64String($configB64))

    # 2. Download helper. Every /api/download/* response carries
    #    x-content-sha256, the digest of exactly the bytes served; a body that
    #    does not match is deleted and the install stops. This is transport
    #    integrity (truncation, corruption, a meddling proxy), not authenticity —
    #    the binaries are not Authenticode-signed yet.
    function Get-VerifiedFile {
        param([string]$Url, [string]$Dest)
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing
        $expect = [string]$resp.Headers['x-content-sha256']
        if ([string]::IsNullOrWhiteSpace($expect)) {
            throw "No x-content-sha256 returned for $Url — refusing to run an unverifiable binary."
        }
        [System.IO.File]::WriteAllBytes($Dest, $resp.Content)
        $actual = (Get-FileHash -LiteralPath $Dest -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expect.ToLowerInvariant()) {
            Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
            throw "Checksum mismatch for $Url (expected $expect, got $actual). Refusing to install."
        }
    }

    Get-VerifiedFile -Url '${serverUrl}/api/download/agent' -Dest "$work\\lockdown-agent.exe"
    Get-VerifiedFile -Url '${serverUrl}/api/download/agent-installer' -Dest "$work\\lockdown-installer.exe"

    # 3. Hand off. --config-file installs from the baked config: it normalises
    #    the config, creates the lockdown folder, installs the scheduled task and
    #    run key, applies tamper protection and verifies check-in.
    & "$work\\lockdown-installer.exe" --config-file "$work\\config.json" --silent
    if ($LASTEXITCODE -ne 0) {
        throw "Installation failed (exit $LASTEXITCODE)."
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    # The installer has already copied what it needs; the API key in this temp
    # copy must not outlive the run.
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

${tail}
`;
}

/**
 * GET /api/installer/:deviceId — per-device installer (S4-serverless).
 *
 * The Express server builds a per-device ZIP/NSIS on the fly — that needs
 * zip/makensis, which a Worker can't run. The serverless-native answer is a
 * self-contained install.ps1: a fresh api_key + config.json are embedded in the
 * script, and the script (run on the target) writes the config, downloads the
 * agent AND the CLI installer from KV, and hands off to
 * `lockdown-installer.exe --config-file` — the same install path the other
 * installers use. It must not implement installation itself (see
 * generateServerlessInstallScript).
 *
 * Returns a downloadable .ps1. Operator+ required.
 */
async function handleInstaller(request: Request, env: Env, deviceId: string): Promise<Response> {
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) return errorResponse('Device not found', 404);

  // Fresh api_key for this install (re-keys the device; old key is replaced).
  const apiKey = generateApiKey();
  device.api_key_hash = await sha256(apiKey);
  await saveDevices(env, devices);
  await addAuditEntry(env, deviceId, 'installer_generated', `by=${auth.username} host=${device.hostname}`);

  // Base URL the agent should check in against (this Worker's origin).
  const serverUrl = requestUrl(request).origin;
  const config = {
    server_url: serverUrl,
    device_hostname: device.hostname,
    api_key: apiKey,
    poll_interval: 30,
    sign_requests: true,
    server_supports_ack_dedup: true,
    boot_lock_enabled: true,
    enrolled_at: new Date().toISOString(),
  };
  // Delegated install script (shared with the re-arm path below).
  const script = generateServerlessInstallScript({
    device,
    config,
    serverUrl,
    rearmed: false,
  });

  return new Response(script, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="install-${device.hostname}.ps1"`,
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * GET /api/audit — return audit log entries (optionally filtered by device_id).
 */
async function handleGetAudit(request: Request, env: Env): Promise<Response> {
  const auth = await requireRole(request, env, 'viewer');
  if (auth instanceof Response) return auth;
  const url = requestUrl(request);
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
    timestamp: e.created_at,
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

  // Normal path: username + password → look up admin → PBKDF2 verify.
  const { username, password } = payload;
  const admins = await listAdmins(env);
  const admin = username ? admins.find((a) => a.username === username) : undefined;

  // Break-glass: a { token } equal to ADMIN_TOKEN, OR a password equal to
  // ADMIN_TOKEN for a username that is NOT a registered admin. Restricting
  // the password form to non-registered usernames prevents a coincidental
  // admin password from silently escalating to super-admin.
  const breakGlass =
    (payload.token && payload.token === env.ADMIN_TOKEN) ||
    (!admin && password && password === env.ADMIN_TOKEN);
  if (breakGlass) {
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

  if (!username || !password) {
    return errorResponse('username and password required', 400);
  }
  if (typeof username !== 'string' || typeof password !== 'string') {
    return errorResponse('username and password must be strings', 400);
  }
  if (!admin) {
    return errorResponse('Invalid credentials. Check your username and password and try again.', 401);
  }
  // Verify with the admin's recorded iteration count; fall back to the
  // legacy 210k for admins created before the field existed.
  const hash = await pbkdf2Hash(password, admin.salt, admin.pbkdf2_iterations ?? LEGACY_PBKDF2_ITERATIONS);
  // Constant-time compare — don't let timing leak match position.
  if (!timingSafeEqualStr(hash, admin.password_hash)) {
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
    const url = requestUrl(request);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': TOKEN_API_CORS_ORIGIN,
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
    if (
      (path === '/api/integrations' || path.startsWith('/api/integrations/')) &&
      method === 'GET'
    ) {
      return handleIntegrationsUnavailable(request, env);
    }

    if (path === '/api/hw-test-artifact' && method === 'POST') {
      return handleUploadHwArtifact(request, env);
    }

    if (path === '/api/hw-test-artifact' && method === 'GET') {
      return handleListHwArtifacts(request, env);
    }

    if (path.startsWith('/api/hw-test-artifact/') && method === 'GET') {
      return handleGetHwArtifact(
        request,
        env,
        decodeURIComponent(path.substring('/api/hw-test-artifact/'.length)),
      );
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
    if (path === '/api/devices/settings/retention' && method === 'GET') {
      return handleRetentionSettings(request, env);
    }

    if (path.startsWith('/api/devices/by-pbl/') && method === 'GET') {
      const pblId = decodeURIComponent(path.substring('/api/devices/by-pbl/'.length));
      return handleByPbl(request, env, pblId);
    }

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
      if (action === 'location/latest' && method === 'GET') {
        return handleLatestLocation(request, env, deviceId);
      }
      if (action === 'link-pbl' && method === 'POST') {
        return handleLinkPbl(request, env, deviceId);
      }
      if (action === 'unlink-pbl' && method === 'POST') {
        return handleUnlinkPbl(request, env, deviceId);
      }
      if (action === 'rotate-key' && method === 'POST') {
        return handleRotateKey(request, env, deviceId);
      }
      if (action === 'pba-credentials' && method === 'GET') {
        return handleGetPbaCredentials(request, env, deviceId);
      }
      if (action === 'release' && method === 'DELETE') {
        return handleReleaseDevice(request, env, deviceId);
      }
      if (action === 'efs-cert' && method === 'GET') {
        return handleDownloadEfsCert(request, env, deviceId);
      }
    }

    // Device re-arm — PblPersistDxe bootstrap calls this with hardware_uuid.
    // Unauthenticated but bound to an enrolled+flagged device (see handler).
    if (path === '/api/rearm' && method === 'POST') {
      return handleRearm(request, env);
    }

    // Binary download endpoints — serve installer + agent from KV.
    // The binaries are uploaded to KV via:
    //   wrangler kv:key put --binding LOCKDOWN_KV "binary:installer" --path lockdown-setup.exe
    //   wrangler kv:key put --binding LOCKDOWN_KV "binary:agent" --path lockdown-agent.exe
    //   wrangler kv:key put --binding LOCKDOWN_KV "binary:agent-installer" --path lockdown-installer.exe
    // No admin auth required — these are public downloads (the enrollment
    // token controls who can enroll, not who can download the installer).
    // Per-device installer (S4-serverless) — self-contained install.ps1.
    if (path === '/api/installer/agent-version' && method === 'GET') {
      return handleAgentVersion(request, env);
    }

    const installerMatch = path.match(/^\/api\/installer\/([^/]+)$/);
    if (installerMatch && method === 'GET') {
      return handleInstaller(request, env, installerMatch[1]);
    }

    if (path === '/api/download/installer' && method === 'GET') {
      return handleDownloadBinary(env, 'installer');
    }
    if (path === '/api/agent/update' && method === 'GET') {
      return handleAgentUpdate(request, env);
    }

    // The URL /api/agent/update advertises. Without this the Worker told every
    // agent an update was available and then 404'd the download — the serverless
    // deployment could never apply one.
    if (path === '/api/agent/download' && method === 'GET') {
      return handleAgentBinaryDownload(request, env);
    }

    if (path === '/api/download/agent' && method === 'GET') {
      return handleDownloadBinary(env, 'agent');
    }

    // The CLI installer that the generated per-device / re-arm scripts run.
    // Published at release time alongside binary:agent (see serverless/README.md).
    if (path === '/api/download/agent-installer' && method === 'GET') {
      return handleDownloadBinary(env, 'agent-installer');
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
        'Access-Control-Allow-Origin': TOKEN_API_CORS_ORIGIN,
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
 * Compare two dotted version strings ("1.2.3").
 *
 * Returns <0 when a<b, 0 when equal, >0 when a>b. Non-numeric segments count as
 * 0, which is what the Express implementation does — an unparseable client
 * version therefore reads as "older" and the agent is offered an update rather
 * than being silently stranded.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * GET /api/agent/update — auto-update capability check.
 *
 * The agent calls this on its check-in cycle (agent/agent.py:3238) and expects
 * the Express contract: {update_available, latest_version, current_version,
 * sha256, size, download_url, built_at, signature, signature_alg}. It verifies
 * the Ed25519 signature against its pinned update key before applying anything,
 * so an unsigned or mismatched response simply means no update.
 *
 * Before this existed the Worker answered 404 to every update check, and the
 * agent's raise_for_status() turned that into a logged warning — so the default
 * (serverless) deployment could never update the fleet, silently.
 *
 * Auth: agent HMAC (the agent signs the empty body for GET).
 */
async function handleAgentUpdate(request: Request, env: Env): Promise<Response> {
  const device = await verifyAgentAuth(request, env, '');
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const currentVersion = request.headers.get('x-agent-version') || '0.0.0';
  const platform = request.headers.get('x-agent-platform') || 'linux';

  const raw = await env.LOCKDOWN_KV.get(AGENT_RELEASE_KEY);
  if (!raw) {
    // No release published: report "no update" with the version the agent sent,
    // the same shape Express uses when it has no binary on disk.
    return jsonResponse({
      update_available: false,
      latest_version: currentVersion,
      reason: 'no_release_published',
    });
  }

  let release: {
    latest_version?: string;
    sha256?: string;
    size?: number;
    built_at?: string;
    signature?: string | null;
    signature_alg?: string | null;
    // A signature is bound to ONE hash (it signs "v1:{version}:{sha256}"), so a
    // release whose per-platform builds differ needs one signature per platform.
    // A single top-level signature can only ever be valid for one of them.
    platforms?: Record<string, {
      sha256?: string;
      size?: number;
      built_at?: string;
      signature?: string | null;
      signature_alg?: string | null;
    }>;
  };
  try {
    release = JSON.parse(raw);
  } catch {
    return errorResponse('Agent release metadata is corrupt', 500);
  }

  if (!release.latest_version) {
    return errorResponse('Agent release metadata is incomplete', 500);
  }

  const perPlatform = release.platforms?.[platform];
  const sha256 = perPlatform?.sha256 || release.sha256;
  const size = perPlatform?.size ?? release.size;
  if (!sha256 || typeof size !== 'number') {
    // Metadata that cannot be verified must not be offered: the agent would
    // download a binarywhose hash it cannot check.
    return errorResponse('Agent release metadata is incomplete', 500);
  }

  // Per-platform signature first: it is the only one that can be valid for this
  // platform's hash. The top-level fallback keeps metadata published before
  // per-platform signing (a single build, one signature) working.
  const signature = perPlatform?.signature || release.signature || null;
  const signatureAlg = signature
    ? (perPlatform?.signature
        ? perPlatform.signature_alg || 'ed25519'
        : release.signature_alg || 'ed25519')
    : null;

  return jsonResponse({
    update_available: compareVersions(currentVersion, release.latest_version) < 0,
    latest_version: release.latest_version,
    current_version: currentVersion,
    sha256,
    size,
    download_url: `/api/agent/download?platform=${platform}`,
    built_at: perPlatform?.built_at || release.built_at || null,
    signature,
    signature_alg: signatureAlg,
  });
}

/**
 * GET /api/installer/agent-version — the version the dashboard displays.
 *
 * Served from the same `agent_release` metadata as /api/agent/update, so the two
 * can never disagree. (Express hardcodes '1.0.0' here while its update endpoint
 * reads the binary; one source of truth is the improvement this port makes.)
 */
async function handleAgentVersion(request: Request, env: Env): Promise<Response> {
  const auth = await requireRole(request, env, 'viewer');
  if (auth instanceof Response) return auth;

  const platform = requestUrl(request).searchParams.get('platform') || 'linux';
  const raw = await env.LOCKDOWN_KV.get(AGENT_RELEASE_KEY);
  if (!raw) {
    return jsonResponse({ version: null, available: false, platform });
  }

  let release: {
    latest_version?: string;
    sha256?: string;
    size?: number;
    built_at?: string;
    // A signature is bound to ONE hash (it signs "v1:{version}:{sha256}"), so a
    // release whose per-platform builds differ needs one signature per platform.
    // A single top-level signature can only ever be valid for one of them.
    platforms?: Record<string, {
      sha256?: string;
      size?: number;
      built_at?: string;
      signature?: string | null;
      signature_alg?: string | null;
    }>;
  };
  try {
    release = JSON.parse(raw);
  } catch {
    return errorResponse('Agent release metadata is corrupt', 500);
  }

  const perPlatform = release.platforms?.[platform];
  const sha256 = perPlatform?.sha256 || release.sha256;
  const size = perPlatform?.size ?? release.size;

  return jsonResponse({
    version: release.latest_version || null,
    // "available" means the dashboard can show a version *and* verify it.
    available: Boolean(release.latest_version && sha256),
    sha256: sha256 || null,
    size: typeof size === 'number' ? size : null,
    built_at: perPlatform?.built_at || release.built_at || null,
    platform,
    source: 'kv',
  });
}

/**
 * GET /api/devices/:id/location/latest — the dashboard's "last seen" pin.
 *
 * The Worker keeps locations in a single KV list; /locations returns a window,
 * this returns only the newest report. 404 (not an empty object) when the device
 * has never reported, matching the Express message.
 */
async function handleLatestLocation(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'viewer');
  if (auth instanceof Response) return auth;

  const locations = await listLocations(env);
  const deviceLocs = locations
    .filter((l) => l.device_id === deviceId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const latest = deviceLocs[deviceLocs.length - 1];

  if (!latest) {
    return errorResponse(
      'No location data. The device has not reported any location reports yet.',
      404,
    );
  }

  return jsonResponse({
    ...latest,
    id: `loc-${deviceId}-0`,
    reported_at: latest.created_at,
  });
}

async function listHwArtifacts(env: Env): Promise<HwTestArtifact[]> {
  const data = await env.LOCKDOWN_KV.get(HW_ARTIFACTS_KEY);
  return data ? parseKvJson<HwTestArtifact[]>(data, HW_ARTIFACTS_KEY) : [];
}

/**
 * POST /api/hw-test-artifact — receive a hardware-test artifact.
 *
 * This is the D-129 evidence path: the harness uploads a CTRF or legacy artifact
 * and the dashboard displays it. Accepting both shapes matters because the harness
 * emitted the legacy one for months before CTRF support landed, and a rejected
 * artifact on window day is a lost hardware run.
 */
async function handleUploadHwArtifact(request: Request, env: Env): Promise<Response> {
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

  const artifact = await readJsonBody<HwTestArtifactUpload>(request);
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return errorResponse('Artifact must be a JSON object', 400);
  }

  const isCtrf = Boolean(artifact.results?.tool);
  const isLegacy = Boolean(artifact.harness_version);
  if (!isCtrf && !isLegacy) {
    return errorResponse(
      'Invalid artifact format — expected CTRF ({results:{tool,...}}) or legacy ({harness_version,...})',
      400,
    );
  }

  const summary = isCtrf ? artifact.results?.summary : artifact.summary;
  const environment = isCtrf ? artifact.results?.extra?.environment : artifact.environment;
  const harnessVersion = isCtrf ? artifact.results?.tool?.version : artifact.harness_version;
  if (!summary) {
    return errorResponse('Artifact missing summary', 400);
  }

  const hostname = environment?.hostname || null;
  const agentHash = environment?.agent_binary_hash || null;

  // Attach the artifact to the device whose hostname matches, when there is one.
  let deviceId: string | null = null;
  if (hostname) {
    const devices = await listDevices(env);
    deviceId = devices.find((d) => d.hostname === hostname)?.id || null;
  }

  const artifacts = await listHwArtifacts(env);
  const nextId = artifacts.reduce((max, a) => Math.max(max, parseInt(a.id, 10) || 0), 0) + 1;
  const counts = {
    total: summary.tests || summary.total || 0,
    passed: summary.passed || 0,
    failed: summary.failed || 0,
    skipped: summary.skipped || 0,
    errors: summary.errors || 0,
  };

  const record: HwTestArtifact = {
    id: String(nextId),
    device_id: deviceId,
    admin_id: (auth as { id?: string }).id || null,
    hostname,
    harness_version: harnessVersion || null,
    agent_hash: agentHash,
    total_tests: counts.total,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    errors: counts.errors,
    artifact_json: artifact,
    created_at: new Date().toISOString(),
  };

  artifacts.push(record);
  await saveHwArtifacts(env, artifacts);

  await addAuditEntry(
    env,
    deviceId || '',
    'hw_test_artifact_upload',
    `Harness v${harnessVersion}: ${counts.passed}/${counts.total} passed, ${counts.failed} failed, ${counts.skipped} skipped`,
  );

  return jsonResponse(
    { id: record.id, device_id: deviceId, hostname, summary: counts },
    201,
  );
}

/** GET /api/hw-test-artifact — recent artifacts, newest first, optional device filter. */
async function handleListHwArtifacts(request: Request, env: Env): Promise<Response> {
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

  const url = requestUrl(request);
  const deviceId = url.searchParams.get('device_id');
  if (deviceId && !/^[0-9a-f-]{16,36}$/i.test(deviceId)) {
    return errorResponse('Invalid device_id format', 400);
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 100);

  const artifacts = (await listHwArtifacts(env))
    .filter((a) => !deviceId || a.device_id === deviceId)
    // Tie-break on the numeric id: two uploads can land in the same millisecond
    // (the harness uploads a batch), and created_at alone then leaves "newest
    // first" ambiguous. Ids are monotonic, so they order what the timestamp ties.
    .sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) ||
        (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0),
    )
    .slice(0, limit)
    // The list view never returns the full artifact blob — only the summary.
    .map(({ artifact_json: _artifact_json, ...summaryRow }) => summaryRow);

  return jsonResponse(artifacts);
}

/** GET /api/hw-test-artifact/:id — one artifact, including its full JSON. */
async function handleGetHwArtifact(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

  if (!/^\d+$/.test(id)) {
    return errorResponse('Invalid artifact ID', 400);
  }

  const artifacts = await listHwArtifacts(env);
  const artifact = artifacts.find((a) => a.id === id);
  if (!artifact) {
    return errorResponse('Artifact not found', 404);
  }
  return jsonResponse(artifact);
}

/**
 * GET /api/integrations, /api/integrations/:id/devices — declared unavailable.
 *
 * The integrations inventory is a connector subsystem in the self-hosted server
 * (server/src/integrations/: a registry plus connectors that read credentials from
 * process.env and speak to upstream APIs). The Worker has no equivalent, and
 * re-implementing it would mean a second copy of that abstraction to keep in step.
 *
 * It answers 501 rather than 404 on purpose: 404 would be indistinguishable from a
 * typo'd path, while 501 says "this deployment does not implement it", which is the
 * truth. Auth is checked first, so an anonymous caller learns nothing about which
 * backend is behind the URL.
 */
async function handleIntegrationsUnavailable(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

  return errorResponse(
    'The integrations inventory view is only available on the self-hosted server deployment; ' +
      'this serverless deployment does not implement it. See serverless/README.md.',
    501,
  );
}

/** PBL device ids are 32 bytes rendered as lowercase-hex (C1 §4). */
const PBL_DEVICE_ID_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Read a JSON body without letting a malformed one throw a bare SyntaxError. */
async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return JSON.parse(await request.text()) as T;
  } catch {
    return null;
  }
}

/**
 * POST /api/devices/:id/link-pbl — attach a firmware PBL device_id to an agent.
 *
 * A PBL device_id may be linked to at most one agent device: two agents claiming
 * the same firmware identity would make the verdict path ambiguous about which
 * machine a lock applies to, so a collision is 409 with the current owner named.
 */
async function handleLinkPbl(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

  const payload = await readJsonBody<{ pbl_device_id?: string }>(request);
  const pblId = payload?.pbl_device_id;
  if (!pblId || typeof pblId !== 'string') {
    return errorResponse('pbl_device_id is required', 400);
  }
  if (!PBL_DEVICE_ID_PATTERN.test(pblId)) {
    return errorResponse('pbl_device_id must be 64 hex chars (32 bytes)', 400);
  }

  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) return errorResponse('Device not found', 404);

  const collision = devices.find(
    (d) =>
      d.id !== device.id &&
      d.pbl_device_id &&
      d.pbl_device_id.toLowerCase() === pblId.toLowerCase(),
  );
  if (collision) {
    return jsonResponse(
      {
        error: 'PBL device_id already linked to another agent device',
        linked_device_id: collision.id,
      },
      409,
    );
  }

  device.pbl_device_id = pblId;
  await saveDevices(env, devices);
  await addAuditEntry(env, device.id, 'pbl_device_linked', `pbl_device_id=${pblId}`);
  return jsonResponse({ linked: true, device_id: device.id, pbl_device_id: pblId });
}

/**
 * POST /api/devices/:id/unlink-pbl — detach the firmware identity.
 * 400 when nothing is linked, so "unlink succeeded" never means "nothing happened".
 */
async function handleUnlinkPbl(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) return errorResponse('Device not found', 404);
  if (!device.pbl_device_id) {
    return errorResponse('Device has no PBL device_id linked', 400);
  }

  const previous = device.pbl_device_id;
  device.pbl_device_id = null;
  await saveDevices(env, devices);
  await addAuditEntry(env, device.id, 'pbl_device_unlinked', `pbl_device_id=${previous}`);
  return jsonResponse({ unlinked: true, device_id: device.id });
}

/**
 * GET /api/devices/by-pbl/:pblDeviceId — the reverse lookup the dashboard uses to
 * jump from a firmware boot record to the agent that manages it.
 */
async function handleByPbl(
  request: Request,
  env: Env,
  pblDeviceId: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;

  if (!PBL_DEVICE_ID_PATTERN.test(pblDeviceId)) {
    return errorResponse('pbl_device_id must be 64 hex chars', 400);
  }

  const devices = await listDevices(env);
  const device = devices.find(
    (d) => d.pbl_device_id && d.pbl_device_id.toLowerCase() === pblDeviceId.toLowerCase(),
  );
  if (!device) {
    return errorResponse('No agent device linked to this PBL device_id', 404);
  }

  const meta = await getCheckinMetadata(env, device.id);
  const { api_key_hash: _api_key_hash, ...safeDevice } = mergeCheckinMetadata(device, meta);
  return jsonResponse(safeDevice);
}

/**
 * POST /api/devices/:id/rotate-key — issue a new agent API key.
 *
 * The plaintext key is returned exactly once (the server keeps only its hash), so
 * the caller must provision it to the device out-of-band.
 */
async function handleRotateKey(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'super-admin');
  if (auth instanceof Response) return auth;

  const devices = await listDevices(env);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) {
    return errorResponse(
      'Device not found. Verify the device ID is correct and the device is enrolled in the system.',
      404,
    );
  }

  const newApiKey = generateApiKey();
  device.api_key_hash = await sha256(newApiKey);
  await saveDevices(env, devices);
  await addAuditEntry(env, device.id, 'api_key_rotated', '');

  return jsonResponse({
    device_id: device.id,
    hostname: device.hostname,
    api_key: newApiKey,
  });
}

/**
 * GET /api/devices/settings/retention — the retention windows the dashboard shows.
 *
 * Bound from Worker vars when present, otherwise the same defaults Express uses.
 * Note the route must be matched before /api/devices/:id, or "settings" is read as
 * a device id.
 */
async function handleRetentionSettings(request: Request, env: Env): Promise<Response> {
  const auth = await requireRole(request, env, 'viewer');
  if (auth instanceof Response) return auth;

  // SAFETY: wrangler `[vars]` are typed loosely in Env; these two are optional
  // numeric settings, and both call sites below validate with Number.isFinite.
  const vars = env as unknown as {
    LOCATION_RETENTION_DAYS?: string;
    COMMAND_EXPIRY_DAYS?: string;
  };
  const locationDays = parseInt(vars.LOCATION_RETENTION_DAYS || '90', 10);
  const commandDays = parseInt(vars.COMMAND_EXPIRY_DAYS || '30', 10);

  return jsonResponse({
    location_retention_days: Number.isFinite(locationDays) ? locationDays : 90,
    command_expiry_days: Number.isFinite(commandDays) ? commandDays : 30,
    audit_log_retention_days: 365,
    min_location_retention: 7,
    max_location_retention: 180,
  });
}

/**
 * GET /api/agent/download?platform=win|linux — the binary /api/agent/update points at.
 *
 * Agent-authenticated, like the Express route of the same path: the metadata that
 * names it is only handed to an authenticated agent, and the agent already signs
 * its requests.
 *
 * KV key order is per-platform first (`binary:agent:<platform>`), then the shared
 * `binary:agent`. A release whose builds differ publishes one key per platform and
 * one signature per platform; a single-build release keeps the shared key.
 */
async function handleAgentBinaryDownload(request: Request, env: Env): Promise<Response> {
  const device = await verifyAgentAuth(request, env, '');
  if (!device) {
    return errorResponse('Authentication failed', 401);
  }

  const platform = requestUrl(request).searchParams.get('platform') || 'linux';
  const perPlatform = await env.LOCKDOWN_KV.get(`binary:agent:${platform}`, {
    type: 'arrayBuffer',
  });
  const data = perPlatform ?? (await env.LOCKDOWN_KV.get('binary:agent', { type: 'arrayBuffer' }));
  if (!data) {
    return errorResponse(
      'Agent binary not available — publish it with `wrangler kv key put ... binary:agent`',
      404,
    );
  }

  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="lockdown-agent"',
      'Content-Length': String(data.byteLength),
      // Digest of exactly these bytes, so the agent's own SHA-256 check has a
      // second, independent source for the same value.
      'x-content-sha256': await sha256HexBytes(data),
      'Cache-Control': 'no-store',
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
  let filename = 'lockdown-agent.exe';
  if (name === 'installer') {
    filename = 'lockdown-setup.exe';
  } else if (name === 'agent-installer') {
    filename = 'lockdown-installer.exe';
  } else if (name === 'lockscreen') {
    filename = 'lockdown-lockscreen.exe';
  }
  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.microsoft.portable-executable',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(data.byteLength),
      // Digest of exactly these bytes, so a client can refuse a truncated or
      // altered body before executing it. Computed per response rather than
      // stored at publish time: a separately published digest can drift from
      // the artefact, a derived one cannot.
      'x-content-sha256': await sha256HexBytes(data),
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

// ---------------------------------------------------------------------------
// PBL /v1/* routes — CBOR/COSE wire format, no agent auth
// ---------------------------------------------------------------------------

import { loadOrGenerateSigningKey, loadOrGeneratePolicySigningKey, rotateSigningKey, getKidHistory, type SigningKeyPair } from './pbl/signing';
import { loadCertChain, storeCertChain, splitDerCerts } from './pbl/certs';
import { handleVerdict } from './pbl/routes/verdict';
import { handlePolicy, handleStorePolicy } from './pbl/routes/policy';
import { handleEnrollPbl } from './pbl/routes/enroll';
import { handleAttest } from './pbl/routes/attest';
import { handleOverrideChallenge, handleOverrideResponse } from './pbl/routes/override';
import { handleSigningKey } from './pbl/routes/signingKey';
import { handleFirmwareDownload } from './pbl/routes/firmware';
import { listDevices as listPblDevices, deleteDevice as deletePblDevice, getDevice as getPblDevice, setDeviceStatus as setPblDeviceStatus } from './pbl/devices';
import { checkIpRateLimit, rateLimitResponse, IP_RATE_LIMITS } from './pbl/rateLimit';
import type { Env } from './pbl/env';

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
      if (rl.allowed === false) {
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
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'viewer');
      if (__a instanceof Response) return __a;
      const devices = await listPblDevices(env.LOCKDOWN_KV);
      return new Response(
        JSON.stringify({ devices, count: devices.length }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // GET /v1/devices/:id — get a single PBL device (admin only, D-206)
    if (path.startsWith('/v1/devices/') && !path.includes('/lock') && !path.includes('/unlock') && !path.includes('/track') && !path.includes('/agent-mapping') && method === 'GET') {
      const __a = await requireRole(request, env, 'viewer');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'super-admin');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'viewer');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'super-admin');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'viewer');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'super-admin');
      if (__a instanceof Response) return __a;
      await env.LOCKDOWN_KV.delete('pbl_cert_chain:current');
      return new Response(
        JSON.stringify({ deleted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/admin/operator-key — store the operator override public key (D-204, admin only)
    // Body: JSON { spki: "<base64>" } — the ES256 public key SPKI
    if (path === '/v1/admin/operator-key' && method === 'POST') {
      const __a = await requireRole(request, env, 'super-admin');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'viewer');
      if (__a instanceof Response) return __a;
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
      const __a = await requireRole(request, env, 'super-admin');
      if (__a instanceof Response) return __a;
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
