/**
 * POST /v1/verdict — Stateless verdict endpoint.
 *
 * Request: CBOR map {1: device_id(bstr32), 2: nonce(bstr32),
 *   3: platform_state_digest(bstr32), 4: policy_version(uint)}
 * Response: COSE_Sign1 LockVerdict (Content-Type: application/cose)
 */

import { decodeVerdictRequest, encodeMap, encodeUint, encodeBstr, encodeTstr } from '../cbor';
import { encodeCoseSign1 } from '../cose';
import { getDevice, type PblDevice } from '../devices';
import { checkDeviceRateLimit, rateLimitResponse, DEVICE_RATE_LIMITS } from '../rateLimit';
import type { SigningKeyPair } from '../signing';
import type { Env } from '../env';

/** C1 + C5 verdict values. */
const VERDICT_UNLOCKED = 0;
const VERDICT_LOCKED = 1;
const VERDICT_WIPE_PENDING = 2;
const VERDICT_TRACKING = 3;

/** Build the verdict payload CBOR map (C1 §2). */
function buildVerdictPayload(
  deviceId: Uint8Array,
  nonce: Uint8Array,
  verdict: number,
  policyVersion: number,
  issuedAt: number,
  graceUntil: number,
  reason: string,
): Uint8Array {
  return encodeMap([
    [encodeUint(1), encodeUint(1)], // version = 1
    [encodeUint(2), encodeBstr(deviceId)], // device_id
    [encodeUint(3), encodeBstr(nonce)], // nonce
    [encodeUint(4), encodeUint(verdict)], // verdict
    [encodeUint(5), encodeUint(policyVersion)], // policy_version
    [encodeUint(6), encodeUint(issuedAt)], // issued_at
    [encodeUint(7), encodeUint(graceUntil)], // grace_until
    [encodeUint(8), encodeTstr(reason)], // reason
  ]);
}

/** Map device status to verdict value. */
function statusToVerdict(status: string): { verdict: number; reason: string } {
  switch (status) {
    case 'locked':
      return { verdict: VERDICT_LOCKED, reason: 'admin_lock' };
    case 'tracking':
      // C5: Covert tracking — boot normally, agent reports location
      return { verdict: VERDICT_TRACKING, reason: 'reported_stolen' };
    case 'recovering':
      return { verdict: VERDICT_UNLOCKED, reason: 'recovered' };
    case 'active':
    default:
      return { verdict: VERDICT_UNLOCKED, reason: 'enrolment' };
  }
}

/** Handle POST /v1/verdict. */
export async function handleVerdict(
  request: Request,
  env: Env,
  keys: SigningKeyPair,
): Promise<Response> {
  // Parse CBOR body
  const body = new Uint8Array(await request.arrayBuffer());
  let req;
  try {
    req = decodeVerdictRequest(body);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'invalid CBOR request' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Validate device_id length
  if (req.device_id.length !== 32) {
    return new Response(
      JSON.stringify({ error: 'device_id must be 32 bytes' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // D-210: Per-device rate limiting (NAT-safe)
  const deviceIdHex = bytesToHex(req.device_id);
  if (DEVICE_RATE_LIMITS.verdict) {
    const rl = await checkDeviceRateLimit(env.LOCKDOWN_KV, deviceIdHex, 'verdict', DEVICE_RATE_LIMITS.verdict);
    if (rl.allowed === false) {
      return rateLimitResponse(rl.retryAfter);
    }
  }

  // Validate nonce length
  if (req.nonce.length !== 32) {
    return new Response(
      JSON.stringify({ error: 'nonce must be 32 bytes' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Lookup device in KV
  const device = await getDevice(env.LOCKDOWN_KV, deviceIdHex);

  if (!device) {
    // Unknown device — return UNLOCKED with "enrolment" reason
    // (PBL should enroll first, but we don't block boot)
    const now = Math.floor(Date.now() / 1000);
    const graceUntil = now + 900; // 15 min
    const payload = buildVerdictPayload(
      req.device_id,
      req.nonce,
      VERDICT_UNLOCKED,
      req.policy_version,
      now,
      graceUntil,
      'enrolment',
    );
    const cose = await encodeCoseSign1(payload, keys);
    return new Response(cose, {
      status: 200,
      headers: { 'Content-Type': 'application/cose' },
    });
  }

  // Build verdict based on device status
  const { verdict, reason } = statusToVerdict(device.status);
  const now = Math.floor(Date.now() / 1000);
  const graceUntil = now + 604800; // 7 days

  const payload = buildVerdictPayload(
    req.device_id,
    req.nonce,
    verdict,
    req.policy_version,
    now,
    graceUntil,
    reason,
  );

  const cose = await encodeCoseSign1(payload, keys);
  return new Response(cose, {
    status: 200,
    headers: { 'Content-Type': 'application/cose' },
  });
}

/** Convert bytes to hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
