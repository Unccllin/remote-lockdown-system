/**
 * POST /v1/enroll — PBL TPM-based enrollment (C1 §6).
 *
 * Request: CBOR map {
 *   1: device_id (bstr32) — SHA-256(AK public area),
 *   2: ek_cert (bstr)     — Endorsement Key certificate (DER),
 *   3: ak_public (bstr)   — Attestation Key public area (TPM2B_PUBLIC),
 *   4: smbios (map)       — optional SMBIOS info for inventory
 * }
 *
 * Response: CBOR map {
 *   1: status (uint)      — 0=success, 1=already_enrolled,
 *   2: policy_version (uint) — current policy version to use,
 *   3: pinned_cert (bstr) — server's signing cert (DER) for TLS pinning
 * }
 *
 * The device is stored in KV as `pbl_devices:{device_id_hex}`.
 */

import { CborDecoder, encodeMap, encodeUint, encodeBstr } from '../cbor';
import { putDevice, getDevice, type PblDevice } from '../devices';
import { checkDeviceRateLimit, rateLimitResponse, DEVICE_RATE_LIMITS } from '../rateLimit';
import type { Env } from '../env';

/** Enroll request parsed from CBOR. */
interface EnrollRequest {
  device_id: Uint8Array;
  ek_cert?: Uint8Array;
  ak_public?: Uint8Array;
  smbios?: Map<number, unknown>;
}

/** Parse the CBOR enroll request body. */
function parseEnrollRequest(body: Uint8Array): EnrollRequest {
  const dec = new CborDecoder(body);
  const map = dec.readIntKeyedMap();

  const req: EnrollRequest = {
    device_id: new Uint8Array(0),
  };

  // Each value in the map is raw CBOR — decode it with a new decoder
  if (map.has(1)) {
    req.device_id = new CborDecoder(map.get(1)!).readBstr();
  }
  if (map.has(2)) {
    req.ek_cert = new CborDecoder(map.get(2)!).readBstr();
  }
  if (map.has(3)) {
    req.ak_public = new CborDecoder(map.get(3)!).readBstr();
  }

  return req;
}

/** Convert bytes to hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Handle POST /v1/enroll. */
export async function handleEnrollPbl(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());

  let req: EnrollRequest;
  try {
    req = parseEnrollRequest(body);
  } catch {
    return new Response(
      JSON.stringify({ error: 'invalid CBOR request' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Validate device_id
  if (req.device_id.length !== 32) {
    return new Response(
      JSON.stringify({ error: 'device_id must be 32 bytes' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const deviceIdHex = bytesToHex(req.device_id);

  // D-210: Per-device rate limiting (NAT-safe)
  if (DEVICE_RATE_LIMITS.enroll) {
    const rl = await checkDeviceRateLimit(env.LOCKDOWN_KV, deviceIdHex, 'enroll', DEVICE_RATE_LIMITS.enroll);
    if (rl.allowed === false) {
      return rateLimitResponse(rl.retryAfter);
    }
  }

  // Check if already enrolled
  const existing = await getDevice(env.LOCKDOWN_KV, deviceIdHex);
  if (existing) {
    // Already enrolled — return success with current policy version
    const latestVer = await env.LOCKDOWN_KV.get('pbl_policy:latest_version');
    const policyVersion = latestVer ? parseInt(latestVer, 10) : 1;

    const payload = encodeMap([
      [encodeUint(1), encodeUint(1)],                    // status = already_enrolled
      [encodeUint(2), encodeUint(policyVersion)],        // policy_version
    ]);

    return new Response(payload, {
      status: 200,
      headers: { 'Content-Type': 'application/cbor' },
    });
  }

  // Create new device record
  const device: PblDevice = {
    device_id: deviceIdHex,
    status: 'active',
    enrolled_at: new Date().toISOString(),
  };

  // Store EK cert and AK public in separate KV keys for attestation
  if (req.ek_cert) {
    await env.LOCKDOWN_KV.put(`pbl_ek_cert:${deviceIdHex}`, bytesToHex(req.ek_cert));
  }
  if (req.ak_public) {
    await env.LOCKDOWN_KV.put(`pbl_ak_public:${deviceIdHex}`, bytesToHex(req.ak_public));
  }

  await putDevice(env.LOCKDOWN_KV, device);

  // Get current policy version
  const latestVer = await env.LOCKDOWN_KV.get('pbl_policy:latest_version');
  const policyVersion = latestVer ? parseInt(latestVer, 10) : 1;

  // Build response: CBOR map {1: status, 2: policy_version}
  const payload = encodeMap([
    [encodeUint(1), encodeUint(0)],                    // status = success
    [encodeUint(2), encodeUint(policyVersion)],        // policy_version
  ]);

  return new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'application/cbor' },
  });
}
