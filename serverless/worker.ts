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
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Newest-first with a deterministic tie-break (S340).
 *
 * `created_at` is an ISO string with millisecond precision, so two records created inside the same
 * millisecond compare equal — and a stable sort then keeps their INSERTION order, which puts the OLDER
 * one first while the caller asked for the newest. That is not theoretical: the device-commands list was
 * returning the flag-stolen command ahead of the unlock queued a millisecond later, so the agent ACKed the
 * wrong command, the device stayed `recovering`, and `DELETE /api/devices/:id/release` answered 409
 * (worker.test.ts "release deletes both per-device keys", intermittent only on fast runners).
 *
 * The secondary key is the array index, which is the KV index order — the order records were appended in.
 * `=== undefined` (rather than a falsy check) keeps a legitimate index 0 meaningful.
 */
function newestFirst<T extends { created_at?: string | null }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        String(b.row.created_at ?? '').localeCompare(String(a.row.created_at ?? '')) ||
        b.index - a.index,
    )
    .map(({ row }) => row);
}

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

  // KV-RACE-001: write check-in metadata to a separate KV key, NOT to the device record. Same
  // fix as handleAgentCheckin; ADR-003 means `device` is already loaded, so there is neither an
  // index to find nor a fleet to read.
  {
    // A ping is a partial heartbeat. Spread the stored metadata so fields this
    // payload does not carry — firmware_audit, a previously reported
    // update_verification — survive: replacing the object wholesale dropped the
    // firmware audit until the next full check-in.
    const existing = await getCheckinMetadata(env, device.id);
    await saveCheckinMetadata(env, device.id, {
      ...existing,
      last_checkin: new Date().toISOString(),
      mac_address: mac_address || device.mac_address,
      hardware_uuid: hardware_uuid || device.hardware_uuid,
      serial_number: serial_number || device.serial_number,
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
      status: device.status,
      command: {
        id: pendingCmd.id,
        command_type: pendingCmd.command_type,
        created_at: pendingCmd.created_at,
      },
      poll_interval: 10, // Fast poll when command pending
    });
  }

  // No pending command — adaptive polling
  const status = device.status;
  const pollInterval = status === 'stolen' ? 10 : activePollSeconds(env);
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
    // ADR-003: one read through the `agent_key:` pointer, not a scan of the fleet.
    const apiKeyHash = await sha256(apiKey);
    const device = await getDeviceByApiKeyHash(env, apiKeyHash);
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
 * Serialize state mutations inside this isolate.
 *
 * This was the first fix for the class of defect that whole-list KV records cause: every
 * handler that changed device or command state loaded a whole JSON list, edited it and wrote
 * it back, so a check-in and a command-ACK arriving together raced. The agent ACKed
 * `unlock … status=executed`, the audit recorded the confirmation, and a read one second later
 * still showed the command `pending` with the device `locked` (S269).
 *
 * ADR-002 and ADR-003 removed the cause for commands and devices — they are per-entity records
 * now, so two writers touch different keys. What remains here is the multi-key paths
 * (an enrolment writes a record, an index entry and an API-key pointer) and the two small lists
 * that are still single values: `admins`, `hw_test_artifacts`.
 *
 * A promise chain serialises requests served by the same isolate, which is the only case that
 * can be fixed without Durable Objects. Cross-isolate races remain for those stores; the fix is
 * the same one, applied store by store.
 */
let mutationChain: Promise<unknown> = Promise.resolve();
function serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
      await putDevice(env, existing);

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
          ...(env.GOOGLE_API_KEY ? { google_api_key: env.GOOGLE_API_KEY } : {}),
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

  await putDevice(env, device);

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
      ...(env.GOOGLE_API_KEY ? { google_api_key: env.GOOGLE_API_KEY } : {}),
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
      await putDevice(env, existing);

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
          ...(env.GOOGLE_API_KEY ? { google_api_key: env.GOOGLE_API_KEY } : {}),
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

  await putDevice(env, device);

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
      ...(env.GOOGLE_API_KEY ? { google_api_key: env.GOOGLE_API_KEY } : {}),
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
  const commands = await listCommands(env);
  const safe = merged.map(({ api_key_hash: _api_key_hash, ...d }) => ({
    ...d,
    lock_state: lockStateFor(commands, d),
  }));
  // D-222: a rollout asks "which devices are not on build X?". `unknown` is a distinct
  // query from any literal version — never-reported is not "on some other version".
  const url = requestUrl(request);
  const requestedVersion = (url.searchParams.get('agent_version') || '').trim();
  if (!requestedVersion) return jsonResponse(safe);
  if (requestedVersion === 'unknown') {
    return jsonResponse(safe.filter((d) => !d.agent_version));
  }
  if (requestedVersion === 'stale') {
    return jsonResponse(safe.filter((d) => d.agent_version_stale));
  }
  return jsonResponse(safe.filter((d) => d.agent_version === requestedVersion));
}

async function handleGetDevice(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'viewer');
  if (auth instanceof Response) return auth;
  // ADR-003: one record read, not a fleet scan to find one device.
  const device = await getDeviceRecord(env, deviceId);
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
  const commands = await listCommands(env);
  return jsonResponse({ ...safeDevice, lock_state: lockStateFor(commands, merged) });
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
  await putDevice(env, device);
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

  // ADR-003: one record read, not a fleet scan to find one device.
  const device = await getDeviceRecord(env, deviceId);
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
  await putDevice(env, device);

  // Queue lockdown command
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
  await createCommand(env, cmd);

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

  // A bodyless POST used to throw here and surface as a 500 with a stack trace.
  // The confirmation is a safety check, not a body requirement: treat a missing or
  // malformed body as "no confirmation given" and let the check below answer 400.
  let payload: { hostname_confirm?: string; duress_code?: boolean } = {};
  try {
    const text = await request.text();
    if (text.trim()) payload = JSON.parse(text);
  } catch {
    payload = {};
  }

  // ADR-003: one record read, not a fleet scan to find one device.
  const device = await getDeviceRecord(env, deviceId);
  if (!device) {
    return errorResponse('Device not found', 404);
  }

  if (payload.hostname_confirm !== device.hostname) {
    return errorResponse('Confirmation hostname does not match.', 400);
  }

  // `active` is allowed on purpose: the agent reports its status on check-in, but a
  // lock sentinel applied earlier survives locally while the server already reads
  // active. Refusing here left an operator with a machine that re-locked every few
  // seconds and no command that could stop it (S269). Unlocking an unlocked device
  // is a no-op, so the wider guard is safe.
  // Idempotent in every state that can hold a lock: a FAILED unlock leaves the
  // device at `recovering`, and refusing to recover from there wedged it — the
  // dashboard offered no action the state machine would accept (S269).
  const recoverable = ['stolen', 'locked', 'active', 'recovering', 'tracking'];
  if (!recoverable.includes(device.status)) {
    return errorResponse(
      `Device is not locked/stolen (current status: ${device.status}).`,
      409,
    );
  }

  // Update device status
  device.status = 'recovering';
  await putDevice(env, device);

  // Release encryption key
  const keys = await listKeysForDevice(env, deviceId);
  // Newest unreleased key, for the same reason as the check-in path: the first
  // match is the oldest, and an older key cannot decrypt the current lockdown's
  // files.
  const unreleased = keys
    .filter((k) => k.released_at === null)
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  const deviceKey = unreleased.length ? unreleased[unreleased.length - 1] : undefined;
  let releasedKey: string | null = null;
  if (deviceKey) {
    deviceKey.released_at = new Date().toISOString();
    releasedKey = deviceKey.key_material;
    await saveKeysForDevice(env, deviceId, keys);
  }

  // Cancel any other pending command for this device. A stale queued `track` firing
  // one poll after an unlock is a real observed failure (S269): recovery must leave
  // the device with exactly one instruction, the unlock.
  const pending = await listCommandsForDevice(env, deviceId);
  for (const c of pending) {
    if (c.status === 'pending') {
      // Per-entity update: cancelling one command must not rewrite the rest (ADR-002).
      await updateCommand(env, c.id, { status: 'cancelled' });
    }
  }

  // Queue unlock command.
  // duress_code: when truthy, the agent pretends to unlock but silently
  // re-encrypts and re-locks.  Default is a normal (real) unlock.
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
  await createCommand(env, cmd);

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

  // ADR-003: one record read, not a fleet scan to find one device.
  const device = await getDeviceRecord(env, deviceId);
  if (!device) {
    return errorResponse('Device not found', 404);
  }

  // A track command puts the device into covert tracking mode: the account is
  // disabled, a decoy is created and the profile is EFS-encrypted. Queuing that on a
  // device an operator is still using — or is actively recovering — is how a lab box
  // ended up in tracking mode one poll after a recover (S269). Refuse unless the
  // device is already in a stolen/tracking posture.
  // `locked` counts too: a lockdown ACK moves the device to locked, and tracking a
  // device that is already locked down is the normal sequence.
  const trackable = ['stolen', 'locked', 'tracking'];
  if ((action === 'track' || action === 'locate') && !trackable.includes(device.status)) {
    return errorResponse(
      `Refusing to start tracking: device is '${device.status}'. Flag it stolen first — ` +
        'tracking disables the signed-in account and EFS-encrypts its profile.',
      409,
    );
  }

  // Update device status for track/stop_track
  // ADR-003: the transition writes this device, not the fleet.
  if (action === 'track') {
    device.status = 'tracking';
    await putDevice(env, device);
  } else if (action === 'stop_track') {
    device.status = 'active';
    await putDevice(env, device);
  }
  // 'locate' doesn't change status — it just queues a one-time location report

  // Queue the command
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
  await createCommand(env, cmd);

  await addAuditEntry(env, deviceId, `admin_${action}`, '');

  return jsonResponse({
    device: { id: device.id, hostname: device.hostname, status: device.status },
    command: { id: cmd.id, command_type: cmd.command_type, status: cmd.status },
  });
}

/**
 * GET /api/devices/:id/locations — return location reports for a device.
 */
/**
 * GET /api/devices/:id/commands — the command ledger for one device, newest first.
 *
 * The ACK's evidence lands on the command record — `status`, `executed_at`,
 * `lockdown_effective`, `boot_lock_status`, `encryption_blocked_files` — and until this
 * route existed no surface returned it: the POST that queues a command replies with the
 * record it just created, and nothing read it back afterwards. So an operator could see
 * `status: locked` and not the `lockdown_effective: false` that accompanies it, which is
 * the one pair that must never be conflated (S270: the field was added to the ACK and
 * remained unreadable).
 */
async function handleListDeviceCommands(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'viewer');
  if (auth instanceof Response) return auth;

  const devices = await listDevices(env);
  if (!devices.some((d) => d.id === deviceId)) {
    return errorResponse('Device not found', 404);
  }

  // Clamped rather than trusted: this is a read path an operator drives from a browser,
  // and the list is a single KV value in serverless mode.
  const requested = Number.parseInt(requestUrl(request).searchParams.get('limit') || '20', 10);
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 20, 1), 100);

  const allCommands = await listCommandsForDevice(env, deviceId);
  const commands = newestFirst(allCommands).slice(0, limit);

  return jsonResponse(commands);
}

async function handleGetLocations(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  const auth = await requireRole(request, env, 'viewer');
  if (auth instanceof Response) return auth;
  const url = requestUrl(request);
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);
  const reports = await listLocationsForDevice(env, deviceId);
  const deviceLocs = reports
    // Order by when each fix was TAKEN, then slice: ordering by insertion alone drops the newest
    // rows once a backfilled report arrives with an older scan time than what is stored.
    .sort((a, b) => locationTime(a).localeCompare(locationTime(b)))
    .slice(-limit)
    // Map created_at → reported_at for dashboard compatibility (the Express server uses
    // `reported_at`). `id` is the stored record id (ADR-004) — the old synthetic
    // `loc-<deviceId>-<idx>` changed whenever the window shifted.
    .map((l) => ({ ...l, reported_at: l.created_at }))
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

  // ADR-003: one record read, not a fleet scan to find one device.
  const device = await getDeviceRecord(env, deviceId);
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

  // ADR-003: one record read, not a fleet scan to find one device.
  const device = await getDeviceRecord(env, deviceId);
  if (!device) return errorResponse('Device not found', 404);

  const devicePws = newestFirst(await listBiosPasswordsForDevice(env, deviceId));
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

  // ADR-003: one record read, not a fleet scan to find one device.
  const device = await getDeviceRecord(env, deviceId);
  if (!device) return errorResponse('Device not found', 404);
  if (device.hostname !== payload.hostname_confirm) {
    return errorResponse('Confirmation hostname does not match.', 400);
  }
  if (['locked', 'stolen', 'recovering'].includes(device.status)) {
    return errorResponse(
      `Cannot release a device in '${device.status}' state. Recover (unlock) the device first.`, 409);
  }

  // Anonymize audit entries for this device (preserve for accountability).
  //
  // ADR-005: amend this device's entries only. The old shape rewrote the whole trail to touch a
  // few lines — and dropped whatever fell off the 500-entry cap mid-rewrite.
  const releasedAt = new Date().toISOString();
  const auditIndex = await listAuditIndex(env);
  for (const indexed of auditIndex) {
    if (indexed.device_id !== deviceId) continue;
    const entry = await getAuditEntry(env, indexed.id);
    if (!entry) continue;
    entry.detail = `${entry.detail || ''} released_at=${releasedAt}`.trim();
    await env.LOCKDOWN_KV.put(auditKey(entry.id), JSON.stringify(entry));
  }
  await addAuditEntry(env, deviceId, 'device_released', `hostname=${device.hostname} by=${auth.username}`);

  // Cascade-delete the device's data across the KV stores.
  await deleteDevice(env, deviceId);
  await deleteCommandsForDevice(env, deviceId);
  await deleteKeysForDevice(env, deviceId);
  await deleteBiosPasswordsForDevice(env, deviceId);
  await deleteLocationsForDevice(env, deviceId);
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

  // ADR-003: one record read, not a fleet scan to find one device.
  const device = await getDeviceRecord(env, deviceId);
  if (!device) return errorResponse('Device not found', 404);

  // Fresh api_key for this install (re-keys the device; old key is replaced).
  const apiKey = generateApiKey();
  device.api_key_hash = await sha256(apiKey);
  await putDevice(env, device);
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
  // ADR-005: the index carries the device id, so a scoped read selects its own ids instead of
  // loading the whole trail and discarding most of it.
  const auditIndex = await listAuditIndex(env);
  const selected = (deviceId ? auditIndex.filter((e) => e.device_id === deviceId) : auditIndex)
    .slice(-limit)
    .reverse(); // most recent first
  const loaded = await Promise.all(selected.map((e) => getAuditEntry(env, e.id)));
  const filtered = loaded.filter((e): e is AuditEntry => e !== null);
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

import { runAlertTick } from './alerts';
import { backupFailed, listBackups, readBackup, restoreBackup, writeBackup } from './backup';

/** The backup hour, UTC. Retention/alerts are hourly; the full export is daily. */
export const BACKUP_HOUR_UTC = 3;

/**
 * True when this tick should write a backup.
 *
 * Unknown or malformed `scheduledTime` means run: a backup that silently stops because a
 * timestamp was missing is worse than one taken more often than intended.
 */
export function shouldRunBackup(controller: ScheduledEvent | { scheduledTime?: number } | undefined): boolean {
  const when = controller?.scheduledTime;
  if (typeof when !== 'number' || !Number.isFinite(when)) return true;
  return new Date(when).getUTCHours() === BACKUP_HOUR_UTC;
}

/**
 * Record a scheduled-pass failure in the audit trail.
 *
 * The swallow is deliberate and narrow: `scheduled()` has no caller to return an error to, so
 * rethrowing only produces an unhandled rejection with no record. This is the one place where
 * swallowing is strictly better than propagating.
 */
async function recordScheduledFailure(env: Env, pass: string, error: unknown): Promise<void> {
  try {
    await addAuditEntry(env, 'system', 'scheduled_failure', `${pass}: ${String(error)}`);
  } catch {
    // Nothing further to try: no audit store, no cron caller, no output channel.
  }
}

export default {
  /**
   * Cron trigger: retention purge, then the alert tick.
   *
   * The Node server runs both as in-process loops. A Worker has no process to host a loop, so
   * the policy is carried by a cron trigger and each pass runs once here. Without the first
   * pass, location reports are only bounded by the per-device history cap (a size limit, not a
   * retention promise). Without the second, a device that goes silent is visible in the
   * dashboard and nowhere else — nobody is told.
   *
   * Each pass is isolated: they share one cron slot, and a failure in one must not silently
   * stop the other. A failure is recorded rather than rethrown because a cron has no caller to
   * return it to — a swallowed error with an audit entry is recoverable, a silent stop is not.
   */
  async scheduled(controller: ScheduledEvent, env: Env): Promise<void> {
    try {
      const retention = await purgeExpiredLocations(env);
      if (retention.deleted > 0) {
        await addAuditEntry(
          env,
          'system',
          'location_retention_purge',
          `removed ${retention.deleted} location report(s) older than ${retention.retentionDays} days `
            + `across ${retention.devices} device(s)`,
        );
      }
      // Expired nonces: no-op without a relational binding, and a range delete with one.
      const nonces = await purgeExpiredNonces(env);
      if (nonces > 0) {
        await addAuditEntry(env, 'system', 'nonce_purge', `removed ${nonces} expired nonce(s)`);
      }
    } catch (error) {
      await recordScheduledFailure(env, 'location retention', error);
    }

    try {
      const alerts = await runAlertTick(env);
      if (alerts.alerted > 0 || alerts.failed > 0) {
        await addAuditEntry(env, 'system', 'alert_tick', JSON.stringify(alerts));
      }
    } catch (error) {
      await recordScheduledFailure(env, 'alert tick', error);
    }

    // Backup last: it reads the whole store, so running it after the passes above means a
    // backup taken today reflects today's purge. A refusal (no bucket, no key) is recorded,
    // not thrown — and "no key" is a refusal on purpose rather than an unencrypted fallback.
    //
    // Only on the 03:00 UTC tick: the cron now fires hourly so a stale device is noticed within
    // the hour, but a backup walks every device, command and report, so it stays daily. Manual
    // backups go through POST /api/admin/backups, which is also the restore drill.
    if (!shouldRunBackup(controller)) {
      return;
    }
    try {
      const backup = await writeBackup(env);
      if (backupFailed(backup)) {
        await addAuditEntry(env, 'system', 'backup_skipped', backup.reason);
      } else {
        await addAuditEntry(
          env,
          'system',
          'backup_written',
          `${backup.key} (${backup.bytes} bytes, ${backup.counts.devices} device(s), `
            + `${backup.counts.commands} command(s), pruned ${backup.pruned})`,
        );
      }
    } catch (error) {
      await recordScheduledFailure(env, 'backup', error);
    }
  },

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

    // Backup and restore. The cron writes one a day; these exist so that a restore drill can be
    // run on demand instead of waiting for 03:00 UTC — a backup nobody has restored is a
    // hypothesis, and the drill is the only thing that turns it into a fact.
    if (path === '/api/admin/backups' && method === 'GET') {
      return handleListBackups(request, env);
    }
    if (path === '/api/admin/backups' && method === 'POST') {
      return handleCreateBackup(request, env);
    }
    if (path === '/api/admin/restore' && method === 'POST') {
      return handleRestore(request, env);
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
      return serializeMutation(() => handleCommandAck(request, env));
    }

    // Agent-compatible paths (match the full Express server's routes so the
    // agent can use the Worker as a drop-in fallback without code changes)
    if (path === '/api/agent/checkin' && method === 'POST') {
      return serializeMutation(() => handleAgentCheckin(request, env));
    }
    if (path === '/api/agent/command-ack' && method === 'POST') {
      return serializeMutation(() => handleCommandAck(request, env));
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

function handleEnrollSetupPs1(request: Request, env: Env): Response {
  const gui = String(env.INSTALLER_GUI ?? '') === 'true';
  let script: string;
  try {
    script = composeEnrollSetupScript(requestUrl(request), gui);
  } catch {
    return new Response(
      'ERROR: the request origin is not a valid absolute URL (use scheme://host[:port]).\n',
      { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }
  return new Response(script, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** GET /api/enroll/setup.cmd — the same thing as a double-clickable file. */
function handleEnrollSetupCmd(request: Request, _env: Env): Response {
  const serverUrl = requestUrl(request).origin;
  const body = [
    '@echo off',
    'setlocal',
    'REM Lockdown agent setup — generated by the dashboard.',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; iex (irm '${serverUrl}/api/enroll/setup.ps1')"`,
    'if errorlevel 1 pause',
    'endlocal',
    '',
  ].join('\r\n');
  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="lockdown-setup.cmd"',
      'Cache-Control': 'no-store',
    },
  });
}

/** GET /api/enroll/setup-command — operator-only: the command to paste on a target. */
async function handleEnrollSetupCommand(request: Request, env: Env): Promise<Response> {
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;
  const serverUrl = requestUrl(request).origin;
  const gui = String(env.INSTALLER_GUI ?? '') === 'true';
  return jsonResponse({
    server_url: serverUrl,
    mode: gui ? 'gui' : 'silent',
    // `iex (irm '…')`, not `powershell -Command "irm … | iex"`: the nested form breaks
    // when pasted into an existing prompt (S216).
    one_liner: `iex (irm '${serverUrl}/api/enroll/setup.ps1')`,
    ps1_url: `${serverUrl}/api/enroll/setup.ps1`,
    cmd_url: `${serverUrl}/api/enroll/setup.cmd`,
    notes: [
      'The enrollment token is single use and expires in 15 minutes.',
      ...(serverUrl.startsWith('http://')
        ? ['Plain HTTP server: the agent needs verify_tls=false in its config (lab only).']
        : []),
    ],
  });
}

    if (path === '/api/enroll/setup.ps1' && method === 'GET') {
      return handleEnrollSetupPs1(request, env);
    }

    if (path === '/api/enroll/setup.cmd' && method === 'GET') {
      return handleEnrollSetupCmd(request, env);
    }

    if (path === '/api/enroll/setup-command' && method === 'GET') {
      return handleEnrollSetupCommand(request, env);
    }

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
        return serializeMutation(() => handleFlagStolen(request, env, deviceId));
      }
      if (action === 'recover' && method === 'POST') {
        return serializeMutation(() => handleRecover(request, env, deviceId));
      }
      if (action === 'track' && method === 'POST') {
        return serializeMutation(() => handleTrackAction(request, env, deviceId, 'track'));
      }
      if (action === 'stop-track' && method === 'POST') {
        return serializeMutation(() => handleTrackAction(request, env, deviceId, 'stop_track'));
      }
      if (action === 'locate' && method === 'POST') {
        return serializeMutation(() => handleTrackAction(request, env, deviceId, 'locate'));
      }
      if (action === 'locations' && method === 'GET') {
        return handleGetLocations(request, env, deviceId);
      }
      if (action === 'commands' && method === 'GET') {
        return handleListDeviceCommands(request, env, deviceId);
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
    if (path === '/api/download/service' && method === 'GET') {
      // The frozen service binary: the installer needs it in the install directory to
      // register the SCM service (service_installer._service_bin_path). Without a
      // route for it the enrolment script could not stage the one file that makes the
      // difference between "installed" and "checking in" (S269).
      return handleDownloadBinary(env, 'service');
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
  let signatureAlg: string | null = null;
  if (signature) {
    signatureAlg = perPlatform?.signature
      ? perPlatform.signature_alg || 'ed25519'
      : release.signature_alg || 'ed25519';
  }

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

  // Same source and same key as the history route, so "latest" and "first row of the history"
  // cannot disagree about which fix is the newest.
  const deviceLocs = (await listLocationsForDevice(env, deviceId)).sort((a, b) =>
    locationTime(a).localeCompare(locationTime(b)));
  const latest = deviceLocs[deviceLocs.length - 1];

  if (!latest) {
    return errorResponse(
      'No location data. The device has not reported any location reports yet.',
      404,
    );
  }

  return jsonResponse({ ...latest, reported_at: latest.created_at });
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

  // ADR-003: one record read, not a fleet scan to find one device.
  const device = await getDeviceRecord(env, deviceId);
  if (!device) return errorResponse('Device not found', 404);

  // The collision check is the one read in this handler that genuinely needs the fleet: a
  // pbl_device_id must be unique across every device.
  const devices = await listDevices(env);
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
  await putDevice(env, device);
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

  // ADR-003: one record read, not a fleet scan to find one device.
  const device = await getDeviceRecord(env, deviceId);
  if (!device) return errorResponse('Device not found', 404);
  if (!device.pbl_device_id) {
    return errorResponse('Device has no PBL device_id linked', 400);
  }

  const previous = device.pbl_device_id;
  device.pbl_device_id = null;
  await putDevice(env, device);
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

  // ADR-003: one record read, not a fleet scan to find one device.
  const device = await getDeviceRecord(env, deviceId);
  if (!device) {
    return errorResponse(
      'Device not found. Verify the device ID is correct and the device is enrolled in the system.',
      404,
    );
  }

  const newApiKey = generateApiKey();
  device.api_key_hash = await sha256(newApiKey);
  await putDevice(env, device);
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
  const data =
    (await readBinary(env, `binary:agent:${platform}`)) ??
    (await readBinary(env, 'binary:agent'));
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
/**
 * Bytes for a `binary:*` key: KV first, then R2 under the same key name.
 *
 * Cloudflare caps a KV value at 27 MiB, and the generic NSIS installer — which embeds
 * `lockdown-agent.exe` plus `lockdown-installer.exe` — crossed it at 33 MB of payload (S291:
 * "content size of 41203591 bytes exceeds maximum allowed size of 27MiB"). R2 has no such
 * ceiling, so anything too large for KV is published there under the identical key and served
 * by the same route. KV stays first so a deployment with no R2 binding behaves exactly as
 * before, and so an artifact that still fits stays where the existing tooling puts it.
 */
async function readBinary(env: Env, key: string): Promise<ArrayBuffer | null> {
  const fromKv = await env.LOCKDOWN_KV.get(key, { type: 'arrayBuffer' });
  if (fromKv) return fromKv;
  if (!env.BINARIES) return null;
  const object = await env.BINARIES.get(key);
  return object ? object.arrayBuffer() : null;
}

async function handleDownloadBinary(env: Env, name: string): Promise<Response> {
  const data = await readBinary(env, `binary:${name}`);
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
      // Five minutes, not an hour. These URLs carry no version, so a republished
      // artifact is served stale by anything that cached the old body — and an
      // installer a week old looks exactly like a fresh one to a user clicking
      // "download". Bounded staleness keeps the bandwidth win without letting a
      // release take an hour to reach a browser (S298).
      'Cache-Control': 'public, max-age=300',
    },
  });
}


// ---------------------------------------------------------------------------
// Backup and restore routes
// ---------------------------------------------------------------------------

/** GET /api/admin/backups — stored backups, newest first. */
async function handleListBackups(request: Request, env: Env): Promise<Response> {
  const auth = await requireRole(request, env, 'operator');
  if (auth instanceof Response) return auth;
  return jsonResponse({ backups: await listBackups(env) });
}

/** POST /api/admin/backups — take a backup now. */
async function handleCreateBackup(request: Request, env: Env): Promise<Response> {
  const auth = await requireRole(request, env, 'super-admin');
  if (auth instanceof Response) return auth;
  const result = await writeBackup(env);
  if (backupFailed(result)) {
    // 503 rather than 400: nothing about the request was wrong, the deployment is not
    // configured to hold an encrypted backup.
    return errorResponse(result.reason, 503);
  }
  return jsonResponse({
    backup: { key: result.key, bytes: result.bytes, counts: result.counts, pruned: result.pruned },
  }, 201);
}

/**
 * POST /api/admin/restore — restore from a stored backup (`{"key": "backups/..."}`) or from an
 * uploaded envelope (raw body). Authenticated as super-admin, and never partial: a payload that
 * fails authentication decrypts to nothing and writes nothing.
 */
async function handleRestore(request: Request, env: Env): Promise<Response> {
  const auth = await requireRole(request, env, 'super-admin');
  if (auth instanceof Response) return auth;

  const contentType = request.headers.get('Content-Type') || '';
  let blob: Uint8Array | null = null;

  if (contentType.includes('application/json')) {
    const body = parseJsonBody(await request.text());
    const key = body && typeof (body as Record<string, unknown>).key === 'string'
      ? String((body as Record<string, unknown>).key)
      : '';
    if (!key) return errorResponse('key required when restoring from a stored backup', 400);
    blob = await readBackup(env, key);
    if (!blob) return errorResponse(`backup not found: ${key}`, 404);
  } else {
    blob = new Uint8Array(await request.arrayBuffer());
    if (blob.length === 0) return errorResponse('empty backup body', 400);
  }

  try {
    const restored = await restoreBackup(env, blob);
    await addAuditEntry(
      env,
      'system',
      'backup_restored',
      `${restored.createdAt}: ${restored.counts.devices} device(s), `
        + `${restored.counts.commands} command(s), ${restored.counts.locations} location report(s)`,
    );
    return jsonResponse({ restored: true, createdAt: restored.createdAt, counts: restored.counts });
  } catch (error) {
    // A tampered or wrong-key payload lands here: AES-GCM refuses it, so nothing was written.
    return errorResponse(`restore failed: ${String((error as Error).message ?? error)}`, 400);
  }
}

// ---------------------------------------------------------------------------
// PBL /v1/* routes — CBOR/COSE wire format, no agent auth
// ---------------------------------------------------------------------------

import type { Env } from './pbl/env';
import {
  TOKEN_API_CORS_ORIGIN, errorResponse, generateApiKey, generateId, hmacSha256, jsonResponse,
  parseJsonBody, parseKvJson, requestUrl, sha256, sha256HexBytes, timingSafeEqualStr,
} from './http';
import {
  Admin, AdminRole, LEGACY_PBKDF2_ITERATIONS, listAdmins, makeAdmin, pbkdf2Hash, requireRole,
  saveAdmins, signAdminToken,
} from './admin-auth';
import { composeEnrollSetupScript } from './installer-scripts';
import { handlePblRoute } from './pbl/routes';
import {
  handleAgentCheckin, handleAgentLocation, handleCommandAck, handleDeadmanReport,
  handleEscrowKey, locationTime, verifyAgentAuth,
} from './agent-routes';
// Re-exported for the test harness, which resets the cache between cases.
export { resetKeyCache } from './pbl/keys';
import {
  AGENT_RELEASE_KEY, AuditEntry, CHECKIN_KEY_PREFIX, Command, Device, HW_ARTIFACTS_KEY, HwTestArtifact, HwTestArtifactUpload, activePollSeconds, addAuditEntry, auditKey, createCommand, deleteBiosPasswordsForDevice, deleteCommandsForDevice, deleteDevice, deleteKeysForDevice, deleteLocationsForDevice, getAuditEntry, getCheckinMetadata, getDeviceByApiKeyHash, getDeviceRecord, groupPbaCredentials, listAuditIndex, listBiosPasswordsForDevice, listCommands, listCommandsForDevice, listDevices, listKeysForDevice, listLocationsForDevice, lockStateFor, mergeCheckinMetadata, normalizeUpdateVerification, putDevice, purgeExpiredLocations, purgeExpiredNonces, saveCheckinMetadata, saveHwArtifacts,
  saveKeysForDevice, updateCommand,
} from './kv-store';
