/**
 * POST /v1/override/challenge and POST /v1/override/response —
 * REQ-14 offline override challenge/response endpoints (C1 §6).
 *
 * Challenge:
 *   Request: JSON {device_id, challenge_seed}
 *     - device_id: hex string (32 bytes / 64 hex chars)
 *     - challenge_seed: hex string (16 bytes / 32 hex chars, from verdict)
 *   Response: JSON {challenge: base64, expires_at: number}
 *     - challenge: server-generated challenge for the device to sign
 *
 * Response:
 *   Request: JSON {device_id, challenge, response}
 *     - device_id: hex string (32 bytes / 64 hex chars)
 *     - challenge: base64 challenge from the challenge endpoint
 *     - response: base64 signature over the challenge
 *   Response: COSE_Sign1 LockVerdict (UNLOCKED) — application/cose
 *
 * Rate limited: 5 attempts per 3600 seconds per device (C4 §2.9 key 83).
 */

import { encodeMap, encodeUint, encodeBstr, encodeTstr } from '../cbor';
import { encodeCoseSign1 } from '../cose';
import { getDevice, setDeviceStatus } from '../devices';
import { type SigningKeyPair } from '../signing';
import type { Env } from '../env';

const VERDICT_UNLOCKED = 0;
const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 3600;

/** KV key for the operator override public key (SPKI, base64). */
const OPERATOR_KEY_KV_KEY = 'pbl_operator_key:current';

/** Rate limit key prefix. */
const RATE_LIMIT_PREFIX = 'pbl_override_rl:';

/** Load the operator override public key from KV.
 *  Returns null if not provisioned (override verification disabled). */
async function loadOperatorKey(kv: KVNamespace): Promise<Uint8Array | null> {
  const stored = await kv.get(OPERATOR_KEY_KV_KEY, 'text');
  if (!stored) return null;
  try {
    return Uint8Array.from(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

/** Verify the operator's signature over the challenge.
 *  @param challenge    The challenge bytes (from the challenge endpoint)
 *  @param responseB64  Base64-encoded signature
 *  @param spki         Operator public key SPKI
 *  @returns true if the signature is valid
 */
async function verifyOperatorSignature(
  challenge: Uint8Array,
  responseB64: string,
  spki: Uint8Array,
): Promise<boolean> {
  try {
    const signature = Uint8Array.from(Buffer.from(responseB64, 'base64'));
    // Import the public key from SPKI
    const cryptoKey = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    // Verify the signature (Web Crypto uses ASN.1 DER format for ECDSA)
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      signature,
      challenge,
    );
  } catch {
    return false;
  }
}

/** Get current rate limit count for a device. */
async function getRateLimitCount(
  kv: KVNamespace,
  deviceId: string,
): Promise<number> {
  const key = `${RATE_LIMIT_PREFIX}${deviceId}`;
  const data = await kv.get(key, 'json') as { count: number; window_start: number } | null;
  if (!data) return 0;
  const now = Date.now();
  const windowMs = WINDOW_SECONDS * 1000;
  if (now - data.window_start > windowMs) {
    return 0; // Window expired
  }
  return data.count;
}

/** Increment rate limit count for a device. */
async function incrementRateLimit(
  kv: KVNamespace,
  deviceId: string,
): Promise<void> {
  const key = `${RATE_LIMIT_PREFIX}${deviceId}`;
  const now = Date.now();
  const data = await kv.get(key, 'json') as { count: number; window_start: number } | null;
  if (!data || (now - data.window_start > WINDOW_SECONDS * 1000)) {
    await kv.put(key, JSON.stringify({ count: 1, window_start: now }));
  } else {
    await kv.put(key, JSON.stringify({ count: data.count + 1, window_start: data.window_start }));
  }
}

/** Generate a random challenge (32 bytes). */
function generateChallenge(): Uint8Array {
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  return challenge;
}

/** Handle POST /v1/override/challenge. */
export async function handleOverrideChallenge(
  request: Request,
  env: Env,
): Promise<Response> {
  let req: { device_id?: string; challenge_seed?: string };

  try {
    req = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'invalid JSON body' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Validate device_id
  if (!req.device_id || typeof req.device_id !== 'string') {
    return new Response(
      JSON.stringify({ error: 'device_id is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (req.device_id.length !== 64 || !/^[0-9a-fA-F]+$/.test(req.device_id)) {
    return new Response(
      JSON.stringify({ error: 'device_id must be 64 hex chars' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Validate challenge_seed
  if (!req.challenge_seed || typeof req.challenge_seed !== 'string') {
    return new Response(
      JSON.stringify({ error: 'challenge_seed is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (req.challenge_seed.length !== 32 || !/^[0-9a-fA-F]+$/.test(req.challenge_seed)) {
    return new Response(
      JSON.stringify({ error: 'challenge_seed must be 32 hex chars (16 bytes)' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Check rate limit
  const count = await getRateLimitCount(env.LOCKDOWN_KV, req.device_id);
  if (count >= MAX_ATTEMPTS) {
    return new Response(
      JSON.stringify({ error: 'rate limit exceeded', max_attempts: MAX_ATTEMPTS, window_seconds: WINDOW_SECONDS }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Lookup device
  const device = await getDevice(env.LOCKDOWN_KV, req.device_id);
  if (!device) {
    return new Response(
      JSON.stringify({ error: 'device not enrolled' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Only locked devices can request override
  if (device.status !== 'locked') {
    return new Response(
      JSON.stringify({ error: 'device is not locked', status: device.status }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Generate challenge
  const challenge = generateChallenge();
  const challengeBase64 = btoa(String.fromCharCode(...challenge));

  // Store challenge in KV (expires in 5 minutes)
  const challengeKey = `pbl_override_challenge:${req.device_id}`;
  await env.LOCKDOWN_KV.put(challengeKey, JSON.stringify({
    challenge: challengeBase64,
    challenge_seed: req.challenge_seed,
    created_at: Date.now(),
    expires_at: Date.now() + 300000, // 5 minutes
  }));

  await incrementRateLimit(env.LOCKDOWN_KV, req.device_id);

  return new Response(
    JSON.stringify({
      challenge: challengeBase64,
      expires_at: Math.floor(Date.now() / 1000) + 300, // 5 minutes
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    },
  );
}

/** Handle POST /v1/override/response. */
export async function handleOverrideResponse(
  request: Request,
  env: Env,
  keys: SigningKeyPair,
): Promise<Response> {
  let req: { device_id?: string; challenge?: string; response?: string };

  try {
    req = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'invalid JSON body' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Validate device_id
  if (!req.device_id || typeof req.device_id !== 'string') {
    return new Response(
      JSON.stringify({ error: 'device_id is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (req.device_id.length !== 64 || !/^[0-9a-fA-F]+$/.test(req.device_id)) {
    return new Response(
      JSON.stringify({ error: 'device_id must be 64 hex chars' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Validate challenge and response
  if (!req.challenge || typeof req.challenge !== 'string') {
    return new Response(
      JSON.stringify({ error: 'challenge is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (!req.response || typeof req.response !== 'string') {
    return new Response(
      JSON.stringify({ error: 'response is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Check rate limit
  const count = await getRateLimitCount(env.LOCKDOWN_KV, req.device_id);
  if (count >= MAX_ATTEMPTS) {
    return new Response(
      JSON.stringify({ error: 'rate limit exceeded' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Lookup device
  const device = await getDevice(env.LOCKDOWN_KV, req.device_id);
  if (!device) {
    return new Response(
      JSON.stringify({ error: 'device not enrolled' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Only locked devices can override
  if (device.status !== 'locked') {
    return new Response(
      JSON.stringify({ error: 'device is not locked' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Verify challenge matches stored challenge
  const challengeKey = `pbl_override_challenge:${req.device_id}`;
  const storedChallenge = await env.LOCKDOWN_KV.get(challengeKey, 'json') as {
    challenge: string;
    expires_at: number;
  } | null;

  if (!storedChallenge) {
    return new Response(
      JSON.stringify({ error: 'no challenge found — request a challenge first' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (Date.now() > storedChallenge.expires_at) {
    return new Response(
      JSON.stringify({ error: 'challenge expired' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (storedChallenge.challenge !== req.challenge) {
    return new Response(
      JSON.stringify({ error: 'challenge mismatch' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // D-204: Verify the operator response signature against the provisioned
  // operator public key. If no operator key is provisioned, fall back to
  // accepting any non-empty response (development mode) with a warning.
  const operatorSpki = await loadOperatorKey(env.LOCKDOWN_KV);
  if (operatorSpki) {
    const challengeBytes = Uint8Array.from(Buffer.from(storedChallenge.challenge, 'base64'));
    const valid = await verifyOperatorSignature(challengeBytes, req.response, operatorSpki);
    if (!valid) {
      return new Response(
        JSON.stringify({ error: 'invalid operator signature' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }
  // If no operator key is provisioned, accept any non-empty response
  // (development mode — production MUST provision an operator key).

  // Delete the challenge (single-use)
  await env.LOCKDOWN_KV.delete(challengeKey);

  // Set device status to recovering (will be fully unlocked by admin)
  await setDeviceStatus(env.LOCKDOWN_KV, req.device_id, 'recovering');

  await incrementRateLimit(env.LOCKDOWN_KV, req.device_id);

  // Issue UNLOCKED verdict (COSE_Sign1)
  const deviceIdBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    deviceIdBytes[i] = parseInt(req.device_id.substring(i * 2, i * 2 + 2), 16);
  }

  // Pad to 32 bytes
  const deviceId32 = new Uint8Array(32);
  deviceId32.set(deviceIdBytes, 0);

  const nonce = new Uint8Array(32); // Override verdicts don't echo nonce
  const now = Math.floor(Date.now() / 1000);
  const graceUntil = now + 3600; // 1 hour grace

  const payload = encodeMap([
    [encodeUint(1), encodeUint(1)], // version = 1
    [encodeUint(2), encodeBstr(deviceId32)], // device_id
    [encodeUint(3), encodeBstr(nonce)], // nonce (zero for override)
    [encodeUint(4), encodeUint(VERDICT_UNLOCKED)], // verdict = UNLOCKED
    [encodeUint(5), encodeUint(0)], // policy_version = 0 (override)
    [encodeUint(6), encodeUint(now)], // issued_at
    [encodeUint(7), encodeUint(graceUntil)], // grace_until
    [encodeUint(8), encodeTstr('override_granted')], // reason
  ]);

  const cose = await encodeCoseSign1(payload, keys);
  return new Response(cose, {
    status: 200,
    headers: { 'Content-Type': 'application/cose' },
  });
}
