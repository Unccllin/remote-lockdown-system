/**
 * PBL Express route equivalent (D-210).
 *
 * Mirrors the serverless Worker /v1/* PBL routes in an Express app so the
 * same CBOR/COSE wire protocol can be served from a long-running Node
 * process (e.g. behind the existing server or as a standalone service).
 *
 * D-210 also adds WAF/DDoS pre-flight guards that run before route
 * dispatch:
 *   - body-size limit (256 KiB for firmware endpoints, 1 MiB for admin)
 *   - content-type allow-list (application/cbor, application/json)
 *   - method allow-list per path
 *   - path normalization (reject path traversal, enforce leading slash)
 *
 * The Express equivalent delegates the heavy lifting (CBOR encode/decode,
 * COSE signing, KV storage) to the same serverless/pbl modules used by the
 * Worker, but adapts the I/O boundary: Express Request/Response instead of
 * fetch Request/Response, and a KV shim backed by the server's database
 * instead of Cloudflare KV.
 *
 * Close criteria (D-210):
 *   - Express server equivalent for all /v1/* PBL routes.
 *   - WAF/DDoS pre-flight guards (body size, content-type, method).
 *   - Runtime test.
 */

const express = require('express');
const crypto = require('crypto');

const router = express.Router();

// D-200/D-201/D-202: Server-side PBL modules
const cbor = require('../pbl/cbor');
const cose = require('../pbl/cose');
const tpm = require('../pbl/tpm');

// D-210: Server JWT auth middleware — replaces the simplified verifyAdminAuth.
// Firmware endpoints (verdict, policy GET, enroll, attest) are unauthenticated
// (the firmware has no JWT — it uses CBOR + device identity instead).
// Admin endpoints (devices, policy POST, override) require JWT auth.
const { requireAuth, requireRole } = require('../middleware/auth');

// ---------------------------------------------------------------------------
// D-210: WAF / DDoS pre-flight guards
// ---------------------------------------------------------------------------

/** Maximum request body sizes per route class. */
const BODY_LIMITS = {
  firmware: 256 * 1024,   // 256 KiB — verdict/policy/enroll/attest/override
  admin: 1024 * 1024,    // 1 MiB — admin endpoints (cert chain upload, etc.)
};

/** Allowed content types per route class. */
const ALLOWED_CONTENT_TYPES = {
  firmware: ['application/cbor', 'application/json'],
  admin: ['application/json'],
};

/** Allowed HTTP methods per path pattern.
 *  Patterns match against the path WITH the /v1/ prefix when mounted at
 *  the app root, or WITHOUT it when the router is mounted at /v1. The
 *  pblWafGuard normalizes the path before matching. */
const METHOD_RULES = [
  { pattern: /^(\/v1)?\/verdict$/, methods: ['POST'] },
  { pattern: /^(\/v1)?\/policy$/, methods: ['GET', 'POST'] },
  { pattern: /^(\/v1)?\/policy\/create$/, methods: ['POST'] },
  { pattern: /^(\/v1)?\/policy\/[^/]+$/, methods: ['GET'] },
  { pattern: /^(\/v1)?\/enroll$/, methods: ['POST'] },
  { pattern: /^(\/v1)?\/attest$/, methods: ['POST'] },
  { pattern: /^(\/v1)?\/override\/challenge$/, methods: ['POST'] },
  { pattern: /^(\/v1)?\/override\/response$/, methods: ['POST'] },
  { pattern: /^(\/v1)?\/devices$/, methods: ['GET'] },
  { pattern: /^(\/v1)?\/devices\/[^/]+$/, methods: ['GET', 'DELETE'] },
  { pattern: /^(\/v1)?\/devices\/[^/]+\/(lock|unlock|track|stop-track)$/, methods: ['POST'] },
  { pattern: /^(\/v1)?\/health$/, methods: ['GET'] },
  { pattern: /^(\/v1)?\/admin\/(rotate-key|key-info|cert-chain|operator-key)$/, methods: ['GET', 'POST', 'DELETE'] },
];

/** Classify a path as 'firmware', 'admin', or 'unprotected'.
 *  Handles both /v1-prefixed (app root) and unprefixed (router mount) paths. */
function classifyPath(path) {
  const normalized = path.startsWith('/v1/') ? path : `/v1${path.startsWith('/') ? '' : '/'}${path}`;
  if (normalized.startsWith('/v1/admin/')) return 'admin';
  if (normalized === '/v1/health') return 'unprotected';
  if (normalized.startsWith('/v1/devices')) return 'admin';
  return 'firmware';
}

/** WAF pre-flight middleware: method, content-type, and body-size checks. */
function pblWafGuard(req, res, next) {
  const path = req.path;

  // 1. Path normalization — reject path traversal and null bytes
  if (req.originalUrl.includes('..') || path.includes('\0')) {
    return res.status(400).json({ error: 'invalid path' });
  }

  // 2. Method allow-list
  const rule = METHOD_RULES.find((r) => r.pattern.test(path));
  if (rule && !rule.methods.includes(req.method)) {
    res.set('Allow', rule.methods.join(', '));
    return res.status(405).json({ error: 'method not allowed' });
  }

  const routeClass = classifyPath(path);

  // 3. Content-type check (only for methods with a body)
  if (req.method === 'POST' || req.method === 'PUT') {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    const allowed = ALLOWED_CONTENT_TYPES[routeClass];
    if (allowed && !allowed.includes(contentType)) {
      return res.status(415).json({ error: 'unsupported content type' });
    }
  }

  // 4. Body-size check (Content-Length header)
  if (req.method === 'POST' || req.method === 'PUT') {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    const limit = BODY_LIMITS[routeClass] || BODY_LIMITS.firmware;
    if (contentLength > limit) {
      return res.status(413).json({ error: 'request body too large' });
    }
  }

  next();
}

// Apply the WAF guard to all /v1/* routes
router.use(pblWafGuard);

// ---------------------------------------------------------------------------
// KV shim — adapts the server's storage to the Env interface expected by
// the serverless/pbl route handlers.
// ---------------------------------------------------------------------------

/**
 * Create an Env-like object backed by an in-memory Map (for testing) or a
 * persistent store. The serverless route handlers call:
 *   env.LOCKDOWN_KV.get(key) / put(key, value)
 * This shim provides that interface.
 *
 * D-206: When no kvStore is provided, uses the shared KV store singleton
 * from pbl/kvStore.js so that agent routes can sync status to PBL devices.
 */
const { createSharedEnv, getSharedKvStore } = require('../pbl/kvStore');

function createEnv(kvStore) {
  if (!kvStore) {
    // Use the shared KV store singleton
    return createSharedEnv();
  }
  const store = kvStore;
  return {
    LOCKDOWN_KV: {
      async get(key, type) {
        const val = store.get(key);
        if (val === undefined || val === null) return null;
        if (type === 'text') return String(val);
        return val;
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
      async list({ prefix } = {}) {
        const keys = [];
        for (const key of store.keys()) {
          if (!prefix || key.startsWith(prefix)) {
            keys.push({ name: key });
          }
        }
        return { keys };
      },
    },
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Route handlers — delegate to the same logic as the serverless Worker.
// Each handler converts Express req → fetch Request, calls the serverless
// handler, then converts the fetch Response → Express res.
// ---------------------------------------------------------------------------

/** Convert an Express Request to a fetch Request. */
function expressToFetchRequest(req) {
  const url = `http://${req.headers.host || 'localhost'}${req.originalUrl}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach((v) => headers.append(key, v));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const body = req.method === 'POST' || req.method === 'PUT'
    ? JSON.stringify(req.body)
    : null;
  return new Request(url, {
    method: req.method,
    headers,
    body,
  });
}

/** Convert a fetch Response to an Express response. */
async function fetchResponseToExpress(resp, res) {
  res.status(resp.status);
  resp.headers.forEach((value, key) => {
    res.set(key, value);
  });
  const buf = await resp.arrayBuffer();
  res.send(Buffer.from(buf));
}

// ---------------------------------------------------------------------------
// Health endpoint (no auth, no rate limit)
// ---------------------------------------------------------------------------

router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pbl-express', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// D-200: Verdict endpoint (POST /v1/verdict)
// ---------------------------------------------------------------------------

/** C1 + C5 verdict values. */
const VERDICT_UNLOCKED = 0;
const VERDICT_LOCKED = 1;
const VERDICT_WIPE_PENDING = 2;
const VERDICT_TRACKING = 3;

/** Build the verdict payload CBOR map (C1 §2). */
function buildVerdictPayload(deviceId, nonce, verdict, policyVersion, issuedAt, graceUntil, reason, challengeSeed) {
  const pairs = [
    [cbor.encodeUint(1), cbor.encodeUint(1)], // version = 1
    [cbor.encodeUint(2), cbor.encodeBstr(deviceId)], // device_id
    [cbor.encodeUint(3), cbor.encodeBstr(nonce)], // nonce
    [cbor.encodeUint(4), cbor.encodeUint(verdict)], // verdict
    [cbor.encodeUint(5), cbor.encodeUint(policyVersion)], // policy_version
    [cbor.encodeUint(6), cbor.encodeUint(issuedAt)], // issued_at
    [cbor.encodeUint(7), cbor.encodeUint(graceUntil)], // grace_until
    [cbor.encodeUint(8), cbor.encodeTstr(reason)], // reason
  ];
  // D-204: Bind challenge_seed to verdict (key 9) so the override flow
  // can verify the firmware is responding to the correct verdict.
  if (challengeSeed) {
    pairs.push([cbor.encodeUint(9), cbor.encodeBstr(challengeSeed)]);
  }
  return cbor.encodeMap(pairs);
}

/** Map device status to verdict value. */
function statusToVerdict(status) {
  switch (status) {
    case 'locked': return { verdict: VERDICT_LOCKED, reason: 'admin_lock' };
    case 'tracking': return { verdict: VERDICT_TRACKING, reason: 'reported_stolen' };
    case 'recovering': return { verdict: VERDICT_UNLOCKED, reason: 'recovered' };
    case 'active':
    default: return { verdict: VERDICT_UNLOCKED, reason: 'enrolment' };
  }
}

/** Bytes to hex string. */
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** In-memory signing key cache (generated on first request). */
let signingKeysCache = null;
let policySigningKeysCache = null;

/** Get or generate the ES256 verdict signing key pair. */
async function getSigningKeys(env) {
  if (signingKeysCache) return signingKeysCache;
  // Check if keys are stored in KV
  const storedPkcs8 = await env.LOCKDOWN_KV.get('pbl_signing_key:current', 'text');
  const storedKid = await env.LOCKDOWN_KV.get('pbl_signing_key:kid', 'text');
  if (storedPkcs8 && storedKid) {
    const privateKey = await crypto.subtle.importKey(
      'pkcs8', Buffer.from(storedPkcs8, 'base64'),
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'],
    );
    signingKeysCache = { privateKey, kid: Buffer.from(storedKid, 'hex') };
    return signingKeysCache;
  }
  // Generate new keys
  signingKeysCache = await cose.generateSigningKey();
  await env.LOCKDOWN_KV.put('pbl_signing_key:current', signingKeysCache.pkcs8.toString('base64'));
  await env.LOCKDOWN_KV.put('pbl_signing_key:kid', signingKeysCache.kid.toString('hex'));
  return signingKeysCache;
}

/** D-209: Get or generate the separate ES256 policy signing key pair.
 *  Distinct from the verdict signing key — policy and verdict have
 *  different trust boundaries and key rotation cycles. */
async function getPolicySigningKeys(env) {
  if (policySigningKeysCache) return policySigningKeysCache;
  const storedPkcs8 = await env.LOCKDOWN_KV.get('pbl_policy_signing_key:current', 'text');
  const storedKid = await env.LOCKDOWN_KV.get('pbl_policy_signing_key:kid', 'text');
  if (storedPkcs8 && storedKid) {
    const privateKey = await crypto.subtle.importKey(
      'pkcs8', Buffer.from(storedPkcs8, 'base64'),
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'],
    );
    policySigningKeysCache = { privateKey, kid: Buffer.from(storedKid, 'hex') };
    return policySigningKeysCache;
  }
  policySigningKeysCache = await cose.generateSigningKey();
  await env.LOCKDOWN_KV.put('pbl_policy_signing_key:current', policySigningKeysCache.pkcs8.toString('base64'));
  await env.LOCKDOWN_KV.put('pbl_policy_signing_key:kid', policySigningKeysCache.kid.toString('hex'));
  return policySigningKeysCache;
}

router.post('/verdict', async (req, res) => {
  const env = req._pblEnv || createEnv();
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const reqMap = cbor.decodeFirst(body);

    // Extract fields: {1: device_id, 2: nonce, 3: platform_state_digest, 4: policy_version}
    const deviceId = reqMap.get(1) || reqMap.get(cbor.decodeFirst(Buffer.from([0x01])));
    const nonce = reqMap.get(2);
    const policyVersion = reqMap.get(4) || 0;

    if (!deviceId || deviceId.length !== 32) {
      return res.status(400).json({ error: 'device_id must be 32 bytes' });
    }
    if (!nonce || nonce.length !== 32) {
      return res.status(400).json({ error: 'nonce must be 32 bytes' });
    }

    const deviceIdHex = bytesToHex(deviceId);
    const deviceData = await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text');
    const device = deviceData ? JSON.parse(deviceData) : null;

    const keys = await getSigningKeys(env);
    const now = Math.floor(Date.now() / 1000);

    let verdict, reason, graceUntil;
    let challengeSeed = null;
    if (!device) {
      verdict = VERDICT_UNLOCKED;
      reason = 'enrolment';
      graceUntil = now + 900; // 15 min
    } else {
      const result = statusToVerdict(device.status);
      verdict = result.verdict;
      reason = result.reason;
      graceUntil = now + 604800; // 7 days
      // D-204: For LOCKED verdicts, generate a challenge_seed and store it
      // so the override flow can verify the firmware is responding to the
      // correct verdict. The challenge_seed is 16 random bytes (32 hex chars).
      if (verdict === VERDICT_LOCKED) {
        challengeSeed = crypto.randomBytes(16);
        await env.LOCKDOWN_KV.put(`pbl_challenge_seed:${deviceIdHex}`, challengeSeed.toString('hex'));
      }
    }

    const payload = buildVerdictPayload(deviceId, nonce, verdict, policyVersion, now, graceUntil, reason, challengeSeed);
    const coseBuf = await cose.encodeCoseSign1(payload, keys);

    res.set('Content-Type', 'application/cose');
    return res.send(coseBuf);
  } catch (err) {
    return res.status(400).json({ error: 'invalid CBOR request', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// D-201: Policy endpoint (GET /v1/policy/:version, POST /v1/policy)
// ---------------------------------------------------------------------------

router.get('/policy/:version', async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { version } = req.params;

  // D-209: Policy version negotiation — firmware sends its current policy
  // version via the If-None-Match header. If it matches the latest, respond
  // 304 Not Modified (firmware keeps its cached policy).
  const clientVersion = req.headers['if-none-match'];
  if (clientVersion && version === 'latest') {
    const latest = await env.LOCKDOWN_KV.get('pbl_policy:latest_version', 'text');
    if (latest && latest === clientVersion) {
      res.set('ETag', latest);
      return res.status(304).end();
    }
  }

  let policyKey;
  if (version === 'latest') {
    const latest = await env.LOCKDOWN_KV.get('pbl_policy:latest_version', 'text');
    policyKey = latest ? `pbl_policy:${latest}` : null;
  } else {
    policyKey = `pbl_policy:${version}`;
  }

  let policyBlob = null;
  let policyVersion = version;
  if (policyKey) {
    const stored = await env.LOCKDOWN_KV.get(policyKey, 'text');
    if (stored) policyBlob = Buffer.from(stored, 'base64');
  }

  if (!policyBlob) {
    // Generate default policy on the fly (bootstrapping)
    policyVersion = '1';
    const defaultPolicy = cbor.encodeMap([
      [cbor.encodeUint(1), cbor.encodeUint(1)], // version = 1
      [cbor.encodeUint(2), cbor.encodeTstr('default')], // name
      [cbor.encodeUint(3), cbor.encodeUint(0)], // min_pcr0_match
    ]);
    // D-209: Use the separate policy signing key (not the verdict signing key)
    const keys = await getPolicySigningKeys(env);
    policyBlob = await cose.encodeCoseSign1(defaultPolicy, keys);
  }

  // D-209: Set ETag header with the policy version for future negotiation
  res.set('ETag', policyVersion);
  res.set('Content-Type', 'application/cose');
  res.set('Cache-Control', 'max-age=300');
  res.send(policyBlob);
});

router.post('/policy', requireAuth, requireRole('super-admin'), async (req, res) => {
  const env = req._pblEnv || createEnv();

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  if (body.length === 0) {
    return res.status(400).json({ error: 'policy blob required' });
  }

  // Store the policy blob in KV
  const version = req.body.version || String(Date.now());
  await env.LOCKDOWN_KV.put(`pbl_policy:${version}`, body.toString('base64'));
  await env.LOCKDOWN_KV.put('pbl_policy:latest_version', version);

  res.json({ stored: true, version });
});

// D-209: POST /v1/policy/create — form-based policy creation.
// Accepts JSON with policy fields, encodes as CBOR, signs with the policy
// signing key, and stores the resulting COSE_Sign1 blob. This replaces the
// upload-only flow for operators who don't have an HSM-connected signing tool.
router.post('/policy/create', requireAuth, requireRole('super-admin'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const f = req.body || {};

  // Validate required metadata fields
  if (typeof f.version !== 'number' || f.version < 1) {
    return res.status(400).json({ error: 'version (uint >= 1) is required' });
  }
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = f.issued_at || now;
  const expiresAt = f.expires_at || (issuedAt + 90 * 24 * 3600); // default 90 days
  const minPblVersion = f.min_pbl_version || 1;

  // Helper: encode a hex string to bstr, or return empty bstr
  const hexToBstr = (hex) => {
    if (!hex || typeof hex !== 'string') return cbor.encodeBstr(Buffer.alloc(0));
    return cbor.encodeBstr(Buffer.from(hex.replace(/^0x/i, ''), 'hex'));
  };

  // Helper: encode an array of {fingerprint, label} objects
  const encodeFingerprintArray = (arr) => {
    if (!Array.isArray(arr)) return cbor.encodeArray([]);
    return cbor.encodeArray(arr.map((item) => cbor.encodeMap([
      [cbor.encodeUint(1), hexToBstr(item.fingerprint)], // fingerprint
      [cbor.encodeUint(2), cbor.encodeTstr(item.label || '')], // label
    ])));
  };

  // Build the CBOR PolicyBlob map per C4 §2
  const policyPayload = cbor.encodeMap([
    // 2.1 Metadata
    [cbor.encodeUint(1), cbor.encodeUint(f.version)],
    [cbor.encodeUint(2), cbor.encodeUint(issuedAt)],
    [cbor.encodeUint(3), cbor.encodeUint(expiresAt)],
    [cbor.encodeUint(4), cbor.encodeUint(minPblVersion)],
    // 2.2 Secure Boot (keys 10-14)
    [cbor.encodeUint(10), cbor.encodeArray(
      (f.oem_pk_allowlist || []).map((e) => cbor.encodeMap([
        [cbor.encodeUint(1), cbor.encodeTstr(e.subject || '')],
        [cbor.encodeUint(2), cbor.encodeTstr(e.issuer || '')],
        [cbor.encodeUint(3), hexToBstr(e.fingerprint)],
      ]))
    )],
    [cbor.encodeUint(11), cbor.encodeArray(
      (f.pkfail_denylist || []).map((h) => hexToBstr(h))
    )],
    [cbor.encodeUint(12), encodeFingerprintArray(f.db_expectations)],
    [cbor.encodeUint(13), encodeFingerprintArray(f.dbx_expectations)],
    [cbor.encodeUint(14), cbor.encodeUint(f.bootmgr_svn_floor || 0)],
    // 2.3 SPI protections (keys 20-21)
    [cbor.encodeUint(20), cbor.encodeBool(f.spi_protection_required ?? true)],
    [cbor.encodeUint(21), cbor.encodeArray(
      (f.spi_oem_matrix || []).map((e) => cbor.encodeMap([
        [cbor.encodeUint(1), cbor.encodeTstr(e.vendor || '')],
        [cbor.encodeUint(2), cbor.encodeTstr(e.product || '')],
        [cbor.encodeUint(3), cbor.encodeTstr(e.protocol || 'none')],
        [cbor.encodeUint(4), cbor.encodeTstr(e.status || 'unknown')],
      ]))
    )],
    // 2.4 Firmware floors (keys 30-32)
    [cbor.encodeUint(30), cbor.encodeArray(
      (f.firmware_floors || []).map((e) => cbor.encodeMap([
        [cbor.encodeUint(1), cbor.encodeTstr(e.vendor || '')],
        [cbor.encodeUint(2), cbor.encodeTstr(e.product || '')],
        [cbor.encodeUint(3), cbor.encodeTstr(e.min_version || '')],
        [cbor.encodeUint(4), cbor.encodeArray((e.advisories || []).map((a) => cbor.encodeTstr(a)))],
      ]))
    )],
    [cbor.encodeUint(31), cbor.encodeArray(
      (f.amt_allowlist || []).map((e) => cbor.encodeMap([
        [cbor.encodeUint(1), hexToBstr(e.device_id)],
        [cbor.encodeUint(2), cbor.encodeTstr(e.reason || '')],
      ]))
    )],
    [cbor.encodeUint(32), cbor.encodeTstr(f.usb_dci_policy || 'disabled')],
    // 2.5 TPM policy (keys 40-44)
    [cbor.encodeUint(40), cbor.encodeMap([
      [cbor.encodeUint(1), cbor.encodeBool((f.tpm_session_requirements || {}).hmac ?? true)],
      [cbor.encodeUint(2), cbor.encodeBool((f.tpm_session_requirements || {}).param_encrypt ?? true)],
      [cbor.encodeUint(3), cbor.encodeBool((f.tpm_session_requirements || {}).salted ?? true)],
      [cbor.encodeUint(4), cbor.encodeBool((f.tpm_session_requirements || {}).bound ?? true)],
    ])],
    [cbor.encodeUint(41), cbor.encodeArray(
      (f.tpm_firmware_floors || []).map((e) => cbor.encodeMap([
        [cbor.encodeUint(1), cbor.encodeTstr(e.vendor || '')],
        [cbor.encodeUint(2), cbor.encodeTstr(e.model || '')],
        [cbor.encodeUint(3), cbor.encodeTstr(e.min_version || 'none')],
        [cbor.encodeUint(4), cbor.encodeTstr(e.risk || '')],
      ]))
    )],
    [cbor.encodeUint(42), cbor.encodeArray(
      (f.tpm_pin_policy || []).map((e) => cbor.encodeMap([
        [cbor.encodeUint(1), cbor.encodeTstr(e.tpm_type || 'dtpm')],
        [cbor.encodeUint(2), cbor.encodeBool(e.pin_required ?? true)],
      ]))
    )],
    [cbor.encodeUint(43), cbor.encodeUint(f.nv_index_base || 0x01C00000)],
    [cbor.encodeUint(44), cbor.encodeTstr(f.bitlocker_sealing_tier || 'standard')],
    // 2.6 Boot config (keys 50-57)
    [cbor.encodeUint(50), cbor.encodeTstr(f.s3_policy || 'disabled')],
    [cbor.encodeUint(51), cbor.encodeBool(f.kernel_dma_protection_required ?? true)],
    [cbor.encodeUint(52), cbor.encodeBool(f.mor_required ?? true)],
    [cbor.encodeUint(53), cbor.encodeTstr(f.network_boot_policy || 'absent')],
    [cbor.encodeUint(54), hexToBstr(f.bcd_hash)],
    [cbor.encodeUint(55), hexToBstr(f.winre_wim_hash)],
    [cbor.encodeUint(56), cbor.encodeTstr(f.recoverysequence_target || '{default}')],
    [cbor.encodeUint(57), cbor.encodeBool(f.bitlocker_required ?? true)],
    // 2.7 Recovery (key 60)
    [cbor.encodeUint(60), cbor.encodeTstr(f.firmware_recovery_expectation || 'none')],
    // 2.8 Pins and endpoints (keys 70-77)
    [cbor.encodeUint(70), cbor.encodeTstr(f.lock_service_uri || '')],
    [cbor.encodeUint(71), hexToBstr(f.lock_service_cert_pin)],
    [cbor.encodeUint(72), cbor.encodeArray((f.lock_service_cert_pin_history || []).map((h) => hexToBstr(h)))],
    [cbor.encodeUint(73), hexToBstr(f.tls_ca_pin)],
    [cbor.encodeUint(74), cbor.encodeTstr(f.attestation_uri || '')],
    [cbor.encodeUint(75), cbor.encodeTstr(f.policy_uri || '')],
    [cbor.encodeUint(76), hexToBstr(f.verdict_signing_key_spki)],
    [cbor.encodeUint(77), cbor.encodeArray((f.signing_cert_chain || []).map((c) => hexToBstr(c)))],
    // 2.9 Verdict cache and override (keys 80-84)
    [cbor.encodeUint(80), cbor.encodeUint(f.verdict_freshness_seconds || 900)],
    [cbor.encodeUint(81), cbor.encodeUint(f.grace_period_seconds || 604800)],
    [cbor.encodeUint(82), cbor.encodeUint(f.wipe_deadline_seconds || 86400)],
    [cbor.encodeUint(83), cbor.encodeMap([
      [cbor.encodeUint(1), cbor.encodeUint((f.override_rate_limit || {}).max_attempts || 5)],
      [cbor.encodeUint(2), cbor.encodeUint((f.override_rate_limit || {}).window_seconds || 3600)],
    ])],
    [cbor.encodeUint(84), cbor.encodeTstr(f.override_challenge_uri || '')],
  ]);

  // Sign with the policy signing key
  const keys = await getPolicySigningKeys(env);
  const policyBlob = await cose.encodeCoseSign1(policyPayload, keys);

  // Store in KV
  const version = String(f.version);
  await env.LOCKDOWN_KV.put(`pbl_policy:${version}`, policyBlob.toString('base64'));
  await env.LOCKDOWN_KV.put('pbl_policy:latest_version', version);

  res.json({ stored: true, version, size: policyBlob.length });
});

// D-209: GET /v1/policy — list all policy versions (admin only)
router.get('/policy', requireAuth, requireRole('operator'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const latest = await env.LOCKDOWN_KV.get('pbl_policy:latest_version', 'text');
  // List all policy versions from KV (using list with prefix)
  const versions = [];
  // Note: KV list() may not be available in all environments.
  // Fall back to returning just the latest version.
  if (env.LOCKDOWN_KV.list) {
    const listed = await env.LOCKDOWN_KV.list({ prefix: 'pbl_policy:' });
    for (const entry of listed.keys || []) {
      if (entry.name !== 'pbl_policy:latest_version' && !entry.name.startsWith('pbl_policy:history:')) {
        versions.push(entry.name.replace('pbl_policy:', ''));
      }
    }
  } else {
    // Fallback: just return the latest
    if (latest) versions.push(latest);
  }
  res.json({ latest_version: latest, versions });
});

// ---------------------------------------------------------------------------
// D-202: Enrollment endpoint (POST /v1/enroll)
// ---------------------------------------------------------------------------

router.post('/enroll', async (req, res) => {
  const env = req._pblEnv || createEnv();
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const reqMap = cbor.decodeFirst(body);

    // Extract fields: {1: device_id(bstr32), 2: ek_cert(bstr), 3: ak_public(bstr)}
    const deviceId = reqMap.get(1);
    const ekCert = reqMap.get(2);
    const akPublic = reqMap.get(3);

    if (!deviceId || deviceId.length !== 32) {
      return res.status(400).json({ error: 'device_id must be 32 bytes' });
    }
    if (!ekCert) {
      return res.status(400).json({ error: 'ek_cert required' });
    }
    if (!akPublic) {
      return res.status(400).json({ error: 'ak_public required' });
    }

    const deviceIdHex = bytesToHex(deviceId);

    // Check if device already exists
    const existing = await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text');
    const alreadyEnrolled = !!existing;

    if (!alreadyEnrolled) {
      // Store device record
      const device = {
        device_id: deviceIdHex,
        status: 'active',
        enrolled_at: new Date().toISOString(),
      };
      await env.LOCKDOWN_KV.put(`pbl_devices:${deviceIdHex}`, JSON.stringify(device));
      await env.LOCKDOWN_KV.put(`pbl_ek_cert:${deviceIdHex}`, ekCert.toString('base64'));
      await env.LOCKDOWN_KV.put(`pbl_ak_public:${deviceIdHex}`, akPublic.toString('hex'));

      // D-206: Auto-link to existing agent device by hardware_uuid if available.
      // The firmware sends SMBIOS Type 1 UUID as key 4 in the enrollment CBOR.
      // If the agent has already enrolled with the same hardware_uuid, link them.
      const smbiosUuid = reqMap.get(4);
      if (smbiosUuid && typeof smbiosUuid === 'string') {
        try {
          const { getDeviceByHardwareIdentity, setPblDeviceId } = require('../db/deviceQueries');
          const agentDevice = await getDeviceByHardwareIdentity(null, null, smbiosUuid);
          if (agentDevice && !agentDevice.pbl_device_id) {
            await setPblDeviceId(agentDevice.id, deviceIdHex);
          }
        } catch (linkErr) {
          // Auto-link is best-effort — don't fail enrollment if it fails
        }
      }
    }

    // Return CBOR map: {1: status(0=success, 1=already), 2: policy_version}
    const latestPolicy = await env.LOCKDOWN_KV.get('pbl_policy:latest_version', 'text');
    const policyVersion = latestPolicy ? parseInt(latestPolicy, 10) || 1 : 1;
    const responseCbor = cbor.encodeMap([
      [cbor.encodeUint(1), cbor.encodeUint(alreadyEnrolled ? 1 : 0)],
      [cbor.encodeUint(2), cbor.encodeUint(policyVersion)],
    ]);

    res.set('Content-Type', 'application/cbor');
    res.send(responseCbor);
  } catch (err) {
    return res.status(400).json({ error: 'invalid CBOR request', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// D-203: Attest endpoint (POST /v1/attest)
// Accepts JSON {device_id, quote, signature, pcr_selection, event_log}
// Verifies TPM2_Quote signature against the enrolled AK public key.
// ---------------------------------------------------------------------------

router.post('/attest', async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { device_id, quote, signature, pcr_selection, event_log } = req.body || {};

  if (!device_id || typeof device_id !== 'string') {
    return res.status(400).json({ error: 'device_id is required' });
  }
  if (device_id.length !== 64 || !/^[0-9a-fA-F]+$/.test(device_id)) {
    return res.status(400).json({ error: 'device_id must be 64 hex chars (32 bytes)' });
  }
  if (!quote || typeof quote !== 'string') {
    return res.status(400).json({ error: 'quote is required' });
  }

  // Lookup device
  const deviceData = await env.LOCKDOWN_KV.get(`pbl_devices:${device_id}`, 'text');
  const device = deviceData ? JSON.parse(deviceData) : null;
  if (!device) {
    return res.status(404).json({ error: 'device not enrolled' });
  }

  // D-203: Parse TPM2B_ATTEST for PCR digest and verify signature
  let pcrDigest = null;
  let quoteVerified = false;
  let signatureProvided = false;
  let akNameValid = false;
  let pcrDigestValid = false;
  try {
    const attest = Buffer.from(quote, 'base64');
    const parsed = tpm.parseTpm2Attest(attest);
    if (parsed) pcrDigest = parsed.pcrDigest;

    // D-203: Verify the TPM2_Quote signature against the AK public key
    const akPublicHex = await env.LOCKDOWN_KV.get(`pbl_ak_public:${device_id}`, 'text');
    if (akPublicHex && signature) {
      signatureProvided = true;
      const sigBytes = Buffer.from(signature, 'base64');
      quoteVerified = await tpm.verifyTpmQuoteSignature(akPublicHex, attest, sigBytes);

      // D-203: Validate AK Name binding — the name in the TPM2B_ATTEST
      // must match the TPM Name computed from the enrolled AK public key.
      if (quoteVerified && parsed && parsed.name) {
        const expectedAkName = tpm.computeAkName(akPublicHex);
        akNameValid = expectedAkName.equals(parsed.name);
      }

      // D-203: Compare PCR digest against expected values (if stored)
      if (quoteVerified && pcrDigest) {
        const expectedPcrHex = await env.LOCKDOWN_KV.get(`pbl_expected_pcr:${device_id}`, 'text');
        if (expectedPcrHex) {
          try {
            const expectedPcrValues = JSON.parse(expectedPcrHex);
            pcrDigestValid = tpm.comparePcrDigest(pcrDigest, expectedPcrValues);
          } catch {
            // Invalid JSON — skip comparison
          }
        }
      }
    }
  } catch {
    quoteVerified = false;
  }

  // Record attestation in KV (audit trail)
  const attestKey = `pbl_attest:${device_id}:${Date.now()}`;
  await env.LOCKDOWN_KV.put(attestKey, JSON.stringify({
    device_id,
    timestamp: new Date().toISOString(),
    quote_present: true,
    quote_verified: quoteVerified,
    ak_name_valid: akNameValid,
    pcr_digest: pcrDigest ? pcrDigest.toString('hex') : null,
    pcr_digest_valid: pcrDigestValid,
    pcr_selection,
    event_log_present: !!event_log,
  }));

  // Determine health
  let health;
  switch (device.status) {
    case 'active': health = (signatureProvided && !quoteVerified) ? 'degraded' : 'ok'; break;
    case 'locked': health = 'degraded'; break;
    case 'recovering': health = 'ok'; break;
    default: health = 'ok';
  }

  res.set('Cache-Control', 'no-store');
  res.json({
    attested: true,
    quote_verified: quoteVerified,
    ak_name_valid: akNameValid,
    pcr_digest: pcrDigest ? pcrDigest.toString('hex') : null,
    pcr_digest_valid: pcrDigestValid,
    health,
    device_id,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// D-204: Override endpoints (POST /v1/override/challenge, POST /v1/override/response)
// ---------------------------------------------------------------------------

const OVERRIDE_MAX_ATTEMPTS = 5;
const OVERRIDE_WINDOW_SECONDS = 3600;

/** D-204: Write an override audit record to KV.
 *  Records each override attempt (challenge or response) for later review. */
async function logOverrideAudit(env, deviceId, phase, success, reason) {
  const auditKey = `pbl_override_audit:${deviceId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await env.LOCKDOWN_KV.put(auditKey, JSON.stringify({
    device_id: deviceId,
    phase, // 'challenge' or 'response'
    success,
    reason,
    timestamp: new Date().toISOString(),
  }));
}

router.post('/override/challenge', async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { device_id, challenge_seed } = req.body || {};

  if (!device_id || typeof device_id !== 'string') {
    return res.status(400).json({ error: 'device_id is required' });
  }
  if (device_id.length !== 64 || !/^[0-9a-fA-F]+$/.test(device_id)) {
    return res.status(400).json({ error: 'device_id must be 64 hex chars' });
  }
  if (!challenge_seed || typeof challenge_seed !== 'string') {
    return res.status(400).json({ error: 'challenge_seed is required' });
  }
  if (challenge_seed.length !== 32 || !/^[0-9a-fA-F]+$/.test(challenge_seed)) {
    return res.status(400).json({ error: 'challenge_seed must be 32 hex chars (16 bytes)' });
  }

  // Rate limit check
  const rlKey = `pbl_override_rl:${device_id}`;
  const rlData = await env.LOCKDOWN_KV.get(rlKey, 'text');
  const count = rlData ? parseInt(rlData, 10) : 0;
  if (count >= OVERRIDE_MAX_ATTEMPTS) {
    return res.status(429).json({
      error: 'rate limit exceeded',
      max_attempts: OVERRIDE_MAX_ATTEMPTS,
      window_seconds: OVERRIDE_WINDOW_SECONDS,
    });
  }

  // Lookup device
  const deviceData = await env.LOCKDOWN_KV.get(`pbl_devices:${device_id}`, 'text');
  const device = deviceData ? JSON.parse(deviceData) : null;
  if (!device) {
    return res.status(404).json({ error: 'device not enrolled' });
  }
  if (device.status !== 'locked') {
    return res.status(409).json({ error: 'device is not locked', status: device.status });
  }

  // D-204: Verify challenge_seed matches the one bound to the verdict.
  // The verdict endpoint stores the challenge_seed at
  // pbl_challenge_seed:{device_id} when issuing a LOCKED verdict.
  const storedSeed = await env.LOCKDOWN_KV.get(`pbl_challenge_seed:${device_id}`, 'text');
  if (storedSeed && storedSeed !== challenge_seed) {
    // D-204: Audit trail — log the failed attempt
    await logOverrideAudit(env, device_id, 'challenge', false, 'challenge_seed mismatch');
    return res.status(403).json({ error: 'challenge_seed does not match the verdict' });
  }

  // Generate challenge (32 random bytes)
  const challenge = crypto.randomBytes(32);
  const challengeBase64 = challenge.toString('base64');

  // Store challenge in KV (5 min expiry)
  const challengeKey = `pbl_override_challenge:${device_id}`;
  await env.LOCKDOWN_KV.put(challengeKey, JSON.stringify({
    challenge: challengeBase64,
    challenge_seed,
    created_at: Date.now(),
    expires_at: Date.now() + 300000,
  }));

  // Increment rate limit
  await env.LOCKDOWN_KV.put(rlKey, String(count + 1));

  // D-204: Audit trail — log the challenge request
  await logOverrideAudit(env, device_id, 'challenge', true, 'challenge issued');

  res.set('Cache-Control', 'no-store');
  res.json({
    challenge: challengeBase64,
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
});

router.post('/override/response', async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { device_id, challenge, response } = req.body || {};

  if (!device_id || typeof device_id !== 'string') {
    return res.status(400).json({ error: 'device_id is required' });
  }
  if (device_id.length !== 64 || !/^[0-9a-fA-F]+$/.test(device_id)) {
    return res.status(400).json({ error: 'device_id must be 64 hex chars' });
  }
  if (!challenge || typeof challenge !== 'string') {
    return res.status(400).json({ error: 'challenge is required' });
  }
  if (!response || typeof response !== 'string') {
    return res.status(400).json({ error: 'response is required' });
  }

  // Lookup device
  const deviceData = await env.LOCKDOWN_KV.get(`pbl_devices:${device_id}`, 'text');
  const device = deviceData ? JSON.parse(deviceData) : null;
  if (!device) {
    return res.status(404).json({ error: 'device not enrolled' });
  }
  if (device.status !== 'locked') {
    return res.status(409).json({ error: 'device is not locked' });
  }

  // Verify challenge matches stored challenge
  const challengeKey = `pbl_override_challenge:${device_id}`;
  const storedChallengeData = await env.LOCKDOWN_KV.get(challengeKey, 'text');
  if (!storedChallengeData) {
    return res.status(400).json({ error: 'no challenge found — request a challenge first' });
  }
  const storedChallenge = JSON.parse(storedChallengeData);

  if (Date.now() > storedChallenge.expires_at) {
    await logOverrideAudit(env, device_id, 'response', false, 'challenge expired');
    return res.status(400).json({ error: 'challenge expired' });
  }
  if (storedChallenge.challenge !== challenge) {
    await logOverrideAudit(env, device_id, 'response', false, 'challenge mismatch');
    return res.status(400).json({ error: 'challenge mismatch' });
  }

  // D-204: Verify operator response signature against the provisioned
  // operator public key. If no operator key is provisioned, fall back to
  // accepting any non-empty response (development mode).
  const operatorSpkiB64 = await env.LOCKDOWN_KV.get('pbl_operator_key:current', 'text');
  if (operatorSpkiB64) {
    const challengeBytes = Buffer.from(storedChallenge.challenge, 'base64');
    const spki = Buffer.from(operatorSpkiB64, 'base64');
    const valid = await tpm.verifyOperatorSignature(challengeBytes, response, spki);
    if (!valid) {
      await logOverrideAudit(env, device_id, 'response', false, 'invalid operator signature');
      return res.status(403).json({ error: 'invalid operator signature' });
    }
  }
  // If no operator key is provisioned, accept any non-empty response
  // (development mode — production MUST provision an operator key).

  // Delete challenge (single-use)
  await env.LOCKDOWN_KV.delete(challengeKey);

  // Set device to recovering
  const updatedDevice = { ...device, status: 'recovering' };
  await env.LOCKDOWN_KV.put(`pbl_devices:${device_id}`, JSON.stringify(updatedDevice));

  // D-204: Clear the stored challenge_seed (verdict is now UNLOCKED)
  await env.LOCKDOWN_KV.delete(`pbl_challenge_seed:${device_id}`);

  // Issue UNLOCKED verdict (COSE_Sign1)
  const deviceIdBytes = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) {
    deviceIdBytes[i] = parseInt(device_id.substring(i * 2, i * 2 + 2), 16);
  }
  const nonce = Buffer.alloc(32);
  const now = Math.floor(Date.now() / 1000);
  const graceUntil = now + 3600;

  const keys = await getSigningKeys(env);
  const payload = buildVerdictPayload(
    deviceIdBytes, nonce, VERDICT_UNLOCKED, 0, now, graceUntil, 'override_granted',
  );
  const coseBuf = await cose.encodeCoseSign1(payload, keys);

  // D-204: Audit trail — log the successful override
  await logOverrideAudit(env, device_id, 'response', true, 'override granted');

  res.set('Content-Type', 'application/cose');
  res.send(coseBuf);
});

// ---------------------------------------------------------------------------
// D-206: Device admin endpoints (list, get, lock, unlock, track, stop-track, delete, agent-mapping)
// All require JWT auth (requireAuth) + operator role (requireRole('operator')).
// ---------------------------------------------------------------------------

router.get('/devices', requireAuth, requireRole('operator'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  // List all PBL devices from KV (prefix scan)
  const devices = [];
  // The KV shim uses a Map, so we iterate keys
  const store = env._store;
  if (store) {
    for (const [key, value] of store.entries()) {
      if (key.startsWith('pbl_devices:') && !key.includes('pbl_device_mapping:')) {
        try {
          devices.push(JSON.parse(value));
        } catch { /* skip non-JSON */ }
      }
    }
  }
  res.json({ devices });
});

router.get('/devices/:id', requireAuth, requireRole('operator'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { id } = req.params;
  const deviceData = await env.LOCKDOWN_KV.get(`pbl_devices:${id}`, 'text');
  if (!deviceData) {
    return res.status(404).json({ error: 'Device not found' });
  }
  res.json({ device: JSON.parse(deviceData) });
});

// ---------------------------------------------------------------------------
// D-206: PBL device admin endpoints (lock/unlock/track/stop-track/delete)
// ---------------------------------------------------------------------------

/** D-206: Sync PBL device status to the linked agent device.
 *  Best-effort — does not fail the PBL operation if the agent DB is unavailable.
 *  @param {string} pblDeviceId  PBL device ID (hex)
 *  @param {string} pblStatus     New PBL status ('locked'|'active'|'tracking')
 */
async function syncPblStatusToAgent(pblDeviceId, pblStatus) {
  try {
    const { getDeviceByPblDeviceId } = require('../db/deviceQueries');
    const agentDevice = await getDeviceByPblDeviceId(pblDeviceId);
    if (!agentDevice) return;  // No linked agent device

    // Map PBL status to agent status
    let agentStatus;
    switch (pblStatus) {
      case 'locked':   agentStatus = 'locked'; break;
      case 'tracking': agentStatus = 'stolen'; break;
      case 'active':   agentStatus = 'active'; break;
      default: return;
    }

    const pool = require('../db/pool');
    await pool.query(
      'UPDATE devices SET status = $2 WHERE id = $1 AND status != $2',
      [agentDevice.id, agentStatus],
    );
  } catch (syncErr) {
    // Best-effort — don't fail the PBL operation
  }
}

router.post('/devices/:id/lock', requireAuth, requireRole('operator'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { id } = req.params;
  const deviceData = await env.LOCKDOWN_KV.get(`pbl_devices:${id}`, 'text');
  if (!deviceData) {
    return res.status(404).json({ error: 'Device not found' });
  }
  const device = JSON.parse(deviceData);
  device.status = 'locked';
  device.lock_reason = 'admin_lock';
  await env.LOCKDOWN_KV.put(`pbl_devices:${id}`, JSON.stringify(device));
  // D-206: Bidirectional status sync — PBL lock → agent device status
  await syncPblStatusToAgent(id, 'locked');
  res.json({ device });
});

router.post('/devices/:id/unlock', requireAuth, requireRole('operator'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { id } = req.params;
  const deviceData = await env.LOCKDOWN_KV.get(`pbl_devices:${id}`, 'text');
  if (!deviceData) {
    return res.status(404).json({ error: 'Device not found' });
  }
  const device = JSON.parse(deviceData);
  device.status = 'active';
  delete device.lock_reason;
  await env.LOCKDOWN_KV.put(`pbl_devices:${id}`, JSON.stringify(device));
  // D-206: Bidirectional status sync — PBL unlock → agent device status
  await syncPblStatusToAgent(id, 'active');
  res.json({ device });
});

router.post('/devices/:id/track', requireAuth, requireRole('operator'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { id } = req.params;
  const deviceData = await env.LOCKDOWN_KV.get(`pbl_devices:${id}`, 'text');
  if (!deviceData) {
    return res.status(404).json({ error: 'Device not found' });
  }
  const device = JSON.parse(deviceData);
  device.status = 'tracking';
  device.lock_reason = 'reported_stolen';
  await env.LOCKDOWN_KV.put(`pbl_devices:${id}`, JSON.stringify(device));
  // D-206: Bidirectional status sync — PBL tracking → agent device status
  await syncPblStatusToAgent(id, 'tracking');
  res.json({ device });
});

router.post('/devices/:id/stop-track', requireAuth, requireRole('operator'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { id } = req.params;
  const deviceData = await env.LOCKDOWN_KV.get(`pbl_devices:${id}`, 'text');
  if (!deviceData) {
    return res.status(404).json({ error: 'Device not found' });
  }
  const device = JSON.parse(deviceData);
  device.status = 'active';
  delete device.lock_reason;
  await env.LOCKDOWN_KV.put(`pbl_devices:${id}`, JSON.stringify(device));
  // D-206: Bidirectional status sync — PBL stop-track → agent device status
  await syncPblStatusToAgent(id, 'active');
  res.json({ device });
});

router.delete('/devices/:id', requireAuth, requireRole('operator'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { id } = req.params;
  const deviceData = await env.LOCKDOWN_KV.get(`pbl_devices:${id}`, 'text');
  if (!deviceData) {
    return res.status(404).json({ error: 'Device not found' });
  }
  await env.LOCKDOWN_KV.delete(`pbl_devices:${id}`);
  res.json({ deleted: true });
});

// D-206: Agent mapping endpoints
router.get('/devices/:id/agent-mapping', requireAuth, requireRole('operator'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { id } = req.params;
  const mapping = await env.LOCKDOWN_KV.get(`pbl_device_mapping:${id}`, 'text');
  if (!mapping) {
    return res.json({ mapped: false, pbl_device_id: id });
  }
  res.json({ mapped: true, pbl_device_id: id, agent_device_id: mapping });
});

router.post('/devices/:id/agent-mapping', requireAuth, requireRole('operator'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { id } = req.params;
  const deviceData = await env.LOCKDOWN_KV.get(`pbl_devices:${id}`, 'text');
  if (!deviceData) {
    return res.status(404).json({ error: 'PBL device not found' });
  }
  const { agent_device_id } = req.body || {};
  if (!agent_device_id || typeof agent_device_id !== 'string') {
    return res.status(400).json({ error: 'agent_device_id is required' });
  }
  await env.LOCKDOWN_KV.put(`pbl_device_mapping:${id}`, agent_device_id);
  res.json({ mapped: true, pbl_device_id: id, agent_device_id });
});

router.delete('/devices/:id/agent-mapping', requireAuth, requireRole('operator'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { id } = req.params;
  const existing = await env.LOCKDOWN_KV.get(`pbl_device_mapping:${id}`, 'text');
  if (!existing) {
    return res.status(404).json({ error: 'No agent device mapping found' });
  }
  await env.LOCKDOWN_KV.delete(`pbl_device_mapping:${id}`);
  res.json({ unmapped: true, pbl_device_id: id });
});

// ---------------------------------------------------------------------------
// D-209: Admin key info endpoints (GET /v1/admin/key-info)
// Returns the KID (hex) of the verdict and policy signing keys.
// ---------------------------------------------------------------------------

router.get('/admin/key-info', requireAuth, requireRole('super-admin'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const verdictKid = await env.LOCKDOWN_KV.get('pbl_signing_key:kid', 'text');
  const policyKid = await env.LOCKDOWN_KV.get('pbl_policy_signing_key:kid', 'text');
  res.json({
    verdict_signing_key: verdictKid ? { kid: verdictKid, algorithm: 'ES256' } : null,
    policy_signing_key: policyKid ? { kid: policyKid, algorithm: 'ES256' } : null,
  });
});

// ---------------------------------------------------------------------------
// D-205: Admin key rotation, cert chain, and operator key endpoints
// ---------------------------------------------------------------------------

/** Split concatenated DER certs into individual cert Buffers. */
function splitDerCerts(der) {
  const certs = [];
  let offset = 0;
  while (offset < der.length) {
    if (der[offset] !== 0x30) break;
    if (offset + 2 > der.length) break;
    let len;
    let headerLen;
    if (der[offset + 1] & 0x80) {
      const numBytes = der[offset + 1] & 0x7f;
      headerLen = 2 + numBytes;
      if (offset + headerLen > der.length) break;
      len = 0;
      for (let i = 0; i < numBytes; i++) {
        len = (len << 8) | der[offset + 2 + i];
      }
    } else {
      len = der[offset + 1];
      headerLen = 2;
    }
    const totalLen = headerLen + len;
    if (offset + totalLen > der.length) break;
    certs.push(der.subarray(offset, offset + totalLen));
    offset += totalLen;
  }
  return certs;
}

// POST /v1/admin/rotate-key — rotate the verdict signing key (D-205)
router.post('/admin/rotate-key', requireAuth, requireRole('super-admin'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  // Store old key in history
  const oldKid = await env.LOCKDOWN_KV.get('pbl_signing_key:kid', 'text');
  const oldPkcs8 = await env.LOCKDOWN_KV.get('pbl_signing_key:current', 'text');
  if (oldKid && oldPkcs8) {
    const historyKey = `pbl_signing_key:history:${oldKid}`;
    await env.LOCKDOWN_KV.put(historyKey, JSON.stringify({ kid: oldKid, pkcs8: oldPkcs8, retired_at: new Date().toISOString() }));
  }
  // Generate new key
  signingKeysCache = null; // clear cache
  const newKeys = await cose.generateSigningKey();
  await env.LOCKDOWN_KV.put('pbl_signing_key:current', newKeys.pkcs8.toString('base64'));
  await env.LOCKDOWN_KV.put('pbl_signing_key:kid', newKeys.kid.toString('hex'));
  res.json({ rotated: true, new_kid: newKeys.kid.toString('hex'), algorithm: 'ES256' });
});

// POST /v1/admin/cert-chain — store X.509 cert chain (D-205)
router.post('/admin/cert-chain', requireAuth, requireRole('super-admin'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  let chainB64;
  if (req.body && req.body.chain) {
    chainB64 = req.body.chain;
  } else {
    // Raw DER body
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (body.length === 0) {
      return res.status(400).json({ error: 'cert chain required (JSON {chain: base64} or raw DER)' });
    }
    chainB64 = body.toString('base64');
  }
  const der = Buffer.from(chainB64, 'base64');
  const certs = splitDerCerts(der);
  if (certs.length < 2) {
    return res.status(400).json({ error: 'cert chain must contain at least 2 certificates' });
  }
  await env.LOCKDOWN_KV.put('pbl_cert_chain:current', chainB64);
  res.json({ stored: true, cert_count: certs.length, cert_sizes: certs.map((c) => c.length) });
});

// GET /v1/admin/cert-chain — get cert chain info (D-205)
router.get('/admin/cert-chain', requireAuth, requireRole('super-admin'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const chainB64 = await env.LOCKDOWN_KV.get('pbl_cert_chain:current', 'text');
  if (!chainB64) {
    return res.json({ provisioned: false });
  }
  const der = Buffer.from(chainB64, 'base64');
  const certs = splitDerCerts(der);
  res.json({ provisioned: true, cert_count: certs.length, cert_sizes: certs.map((c) => c.length) });
});

// DELETE /v1/admin/cert-chain — remove cert chain (D-205)
router.delete('/admin/cert-chain', requireAuth, requireRole('super-admin'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  await env.LOCKDOWN_KV.delete('pbl_cert_chain:current');
  res.json({ deleted: true });
});

// POST /v1/admin/operator-key — store operator override public key (D-204)
router.post('/admin/operator-key', requireAuth, requireRole('super-admin'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const { spki } = req.body || {};
  if (!spki || typeof spki !== 'string') {
    return res.status(400).json({ error: 'spki (base64) is required' });
  }
  await env.LOCKDOWN_KV.put('pbl_operator_key:current', spki);
  res.json({ stored: true });
});

// GET /v1/admin/operator-key — get operator key info (D-204)
router.get('/admin/operator-key', requireAuth, requireRole('super-admin'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  const spki = await env.LOCKDOWN_KV.get('pbl_operator_key:current', 'text');
  if (!spki) {
    return res.json({ provisioned: false });
  }
  res.json({ provisioned: true, spki_length: spki.length });
});

// DELETE /v1/admin/operator-key — remove operator key (D-204)
router.delete('/admin/operator-key', requireAuth, requireRole('super-admin'), async (req, res) => {
  const env = req._pblEnv || createEnv();
  await env.LOCKDOWN_KV.delete('pbl_operator_key:current');
  res.json({ deleted: true });
});

// Catch-all for unmatched routes — must be after all route handlers.
// Ensures the WAF guard (router.use) runs even when no specific route
// handler matches (e.g. wrong method on a known path returns 405 from
// the WAF guard, not 404 from Express's default handler).
router.all('*', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  router,
  pblWafGuard,
  classifyPath,
  BODY_LIMITS,
  ALLOWED_CONTENT_TYPES,
  METHOD_RULES,
  createEnv,
  syncPblStatusToAgent,
  getPolicySigningKeys,
};
