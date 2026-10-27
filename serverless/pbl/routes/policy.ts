/**
 * GET /v1/policy/:version — PBL policy blob endpoint (C4 §6).
 *
 * Returns a COSE_Sign1 signed policy blob from KV storage.
 * The policy is stored at KV key `pbl_policy:{version}` as raw bytes.
 *
 * If `version` is `latest`, returns the highest-versioned policy.
 *
 * Response: COSE_Sign1 policy blob (Content-Type: application/cose)
 */

import { encodeCoseSign1 } from '../cose';
import { encodeMap, encodeUint, encodeBstr, encodeTstr, encodeArray, encodeBool } from '../cbor';
import { getKidHistory, type SigningKeyPair } from '../signing';
import { loadCertChain } from '../certs';
import type { Env } from '../env';

// ---------------------------------------------------------------------------
// Full C4 policy blob builder (D-209)
// ---------------------------------------------------------------------------

/** Zero-filled byte string of given length (for placeholder hashes/pins). */
function zeroBstr(len: number): Uint8Array {
  return encodeBstr(new Uint8Array(len));
}

/** Build the full C4 §2 PolicyBlob payload as a CBOR map.
 *
 *  Includes all ~40 fields across 10 groups:
 *  - §2.1 Metadata (keys 1-4)
 *  - §2.2 Secure Boot policy (keys 10-14)
 *  - §2.3 SPI protections (keys 20-21)
 *  - §2.4 Firmware version floors (keys 30-32)
 *  - §2.5 TPM policy (keys 40-44)
 *  - §2.6 Boot configuration (keys 50-57)
 *  - §2.7 Recovery capability (key 60)
 *  - §2.8 Pins and endpoints (keys 70-75)
 *  - §2.9 Verdict cache and override (keys 80-84)
 *
 *  Placeholder hashes/pins are zero-filled 32-byte bstrs. Real values
 *  are populated by the orchestrator when publishing a policy via
 *  POST /v1/policy?version=N.
 */
export function buildFullPolicyPayload(version: number, options?: {
  lockServiceUri?: string;
  attestationUri?: string;
  policyUri?: string;
  overrideChallengeUri?: string;
  certPin?: Uint8Array;
  certPinHistory?: Uint8Array[];  // D-205: C4 key 72 (previous kids for rotation grace)
  certChain?: Uint8Array[];       // D-205: C4 key 77 (X.509 cert chain [leaf, intermediate, root CA])
  tlsCaPin?: Uint8Array;
  bcdHash?: Uint8Array;
  winreWimHash?: Uint8Array;
  verdictSigningKeySpki?: Uint8Array;  // D-205: C4 key 76
}): Uint8Array {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 90 * 86400; // C4 §2.1: default 90 days

  const lockServiceUri = options?.lockServiceUri ?? 'https://pbl-verdict.example.com';
  const attestationUri = options?.attestationUri ?? '/v1/attest';
  const policyUri = options?.policyUri ?? '/v1/policy/latest';
  const overrideChallengeUri = options?.overrideChallengeUri ?? '/v1/override/challenge';
  const certPin = options?.certPin ?? new Uint8Array(32);
  const certPinHistory = options?.certPinHistory ?? [];  // D-205: empty by default
  const certChain = options?.certChain ?? [];  // D-205: empty by default
  const tlsCaPin = options?.tlsCaPin ?? new Uint8Array(32);
  const bcdHash = options?.bcdHash ?? new Uint8Array(32);
  const winreWimHash = options?.winreWimHash ?? new Uint8Array(32);
  // D-205: Verdict signing key SPKI (C4 key 76). If not provided, use a
  // zero-length bstr (firmware will skip signature verification with a warning).
  const verdictSigningKeySpki = options?.verdictSigningKeySpki ?? new Uint8Array(0);

  return encodeMap([
    // -- §2.1 Metadata --
    [encodeUint(1), encodeUint(version)],
    [encodeUint(2), encodeUint(now)],
    [encodeUint(3), encodeUint(expiresAt)],
    [encodeUint(4), encodeUint(1)],

    // -- §2.2 Secure Boot policy (REQ-01, REQ-02) --
    // Key 10: oem_pk_allowlist
    [encodeUint(10), encodeArray([
      encodeMap([
        [encodeTstr('subject'), encodeTstr('HP Inc.')],
        [encodeTstr('issuer'), encodeTstr('HP Inc. Self-Signed')],
        [encodeTstr('fingerprint'), zeroBstr(32)],
      ]),
    ])],
    // Key 11: pkfail_denylist
    [encodeUint(11), encodeArray([
      zeroBstr(32), // Known AMI/PKfail test key fingerprint
    ])],
    // Key 12: db_expectations
    [encodeUint(12), encodeArray([
      encodeMap([
        [encodeTstr('fingerprint'), zeroBstr(32)],
        [encodeTstr('label'), encodeTstr('Windows UEFI CA 2023')],
      ]),
    ])],
    // Key 13: dbx_expectations
    [encodeUint(13), encodeArray([
      encodeMap([
        [encodeTstr('fingerprint'), zeroBstr(32)],
        [encodeTstr('label'), encodeTstr('MS 2011 Prod CA revocation')],
      ]),
      encodeMap([
        [encodeTstr('fingerprint'), zeroBstr(32)],
        [encodeTstr('label'), encodeTstr('BootHole GRUB hash')],
      ]),
    ])],
    // Key 14: bootmgr_svn_floor
    [encodeUint(14), encodeUint(7)],

    // -- §2.3 SPI protections (REQ-03) --
    // Key 20: spi_protection_required
    [encodeUint(20), encodeBool(true)],
    // Key 21: spi_oem_matrix
    [encodeUint(21), encodeArray([
      encodeMap([
        [encodeTstr('vendor'), encodeTstr('HP')],
        [encodeTstr('product'), encodeTstr('EliteBook 840')],
        [encodeTstr('protocol'), encodeTstr('HpSpiLib')],
        [encodeTstr('status'), encodeTstr('ok')],
      ]),
      encodeMap([
        [encodeTstr('vendor'), encodeTstr('Dell')],
        [encodeTstr('product'), encodeTstr('Latitude 7440')],
        [encodeTstr('protocol'), encodeTstr('none')],
        [encodeTstr('status'), encodeTstr('unknown')],
      ]),
    ])],

    // -- §2.4 Firmware version floors (REQ-04) --
    // Key 30: firmware_floors
    [encodeUint(30), encodeArray([
      encodeMap([
        [encodeTstr('vendor'), encodeTstr('HP')],
        [encodeTstr('product'), encodeTstr('EliteBook 840 G10')],
        [encodeTstr('min_version'), encodeTstr('U70 Ver. 01.05.00')],
        [encodeTstr('advisories'), encodeArray([
          encodeTstr('LogoFAIL'),
          encodeTstr('Binarly SMM'),
        ])],
      ]),
    ])],
    // Key 31: amt_allowlist (empty = de-provision all)
    [encodeUint(31), encodeArray([])],
    // Key 32: usb_dci_policy
    [encodeUint(32), encodeTstr('disabled')],

    // -- §2.5 TPM policy (REQ-05, REQ-06, cross-ref C2) --
    // Key 40: tpm_session_requirements
    [encodeUint(40), encodeMap([
      [encodeTstr('hmac'), encodeBool(true)],
      [encodeTstr('param_encrypt'), encodeBool(true)],
      [encodeTstr('salted'), encodeBool(true)],
      [encodeTstr('bound'), encodeBool(true)],
    ])],
    // Key 41: tpm_firmware_floors
    [encodeUint(41), encodeArray([
      encodeMap([
        [encodeTstr('vendor'), encodeTstr('Intel')],
        [encodeTstr('model'), encodeTstr('PTT')],
        [encodeTstr('min_version'), encodeTstr('11.0.0.0')],
        [encodeTstr('risk'), encodeTstr('TPM-Fail')],
      ]),
      encodeMap([
        [encodeTstr('vendor'), encodeTstr('AMD')],
        [encodeTstr('model'), encodeTstr('Zen3 fTPM')],
        [encodeTstr('min_version'), encodeTstr('none')],
        [encodeTstr('risk'), encodeTstr('faulTPM')],
      ]),
    ])],
    // Key 42: tpm_pin_policy
    [encodeUint(42), encodeArray([
      encodeMap([
        [encodeTstr('tpm_type'), encodeTstr('dtpm')],
        [encodeTstr('pin_required'), encodeBool(true)],
      ]),
      encodeMap([
        [encodeTstr('tpm_type'), encodeTstr('ftpm_amd_zen2_3')],
        [encodeTstr('pin_required'), encodeBool(true)],
      ]),
    ])],
    // Key 43: nv_index_base (0x01C00000 = 29360128)
    [encodeUint(43), encodeUint(0x01C00000)],
    // Key 44: bitlocker_sealing_tier
    [encodeUint(44), encodeTstr('high_assurance')],

    // -- §2.6 Boot configuration (REQ-07, REQ-08, REQ-09) --
    // Key 50: s3_policy
    [encodeUint(50), encodeTstr('disabled')],
    // Key 51: kernel_dma_protection_required
    [encodeUint(51), encodeBool(true)],
    // Key 52: mor_required
    [encodeUint(52), encodeBool(true)],
    // Key 53: network_boot_policy
    [encodeUint(53), encodeTstr('absent')],
    // Key 54: bcd_hash
    [encodeUint(54), encodeBstr(bcdHash)],
    // Key 55: winre_wim_hash
    [encodeUint(55), encodeBstr(winreWimHash)],
    // Key 56: recoverysequence_target
    [encodeUint(56), encodeTstr('{default}')],
    // Key 57: bitlocker_required
    [encodeUint(57), encodeBool(true)],

    // -- §2.7 Recovery capability (REQ-10) --
    // Key 60: firmware_recovery_expectation
    [encodeUint(60), encodeTstr('dual_image')],

    // -- §2.8 Pins and endpoints (cross-ref C1, C3) --
    // Key 70: lock_service_uri
    [encodeUint(70), encodeTstr(lockServiceUri)],
    // Key 71: lock_service_cert_pin
    [encodeUint(71), encodeBstr(certPin)],
    // Key 72: lock_service_cert_pin_history (D-205: previous kids for rotation grace)
    // C1 §5: array of previous signing cert fingerprints. Firmware accepts
    // verdicts signed by any kid in this list during the grace period.
    [encodeUint(72), encodeArray(
      certPinHistory.length > 0
        ? certPinHistory.map(kid => encodeBstr(kid))
        : [zeroBstr(32)]  // backward compat: empty history = one zero-filled entry
    )],
    // Key 73: tls_ca_pin
    [encodeUint(73), encodeBstr(tlsCaPin)],
    // Key 74: attestation_uri
    [encodeUint(74), encodeTstr(attestationUri)],
    // Key 75: policy_uri
    [encodeUint(75), encodeTstr(policyUri)],
    // Key 76: verdict_signing_key_spki (D-205)
    // Full SPKI DER of the verdict signing key. Firmware uses this with
    // EcDsaVerify to verify verdict COSE_Sign1 signatures.
    // kid (key 71) = SHA-256 of this SPKI.
    [encodeUint(76), encodeBstr(verdictSigningKeySpki)],
    // Key 77: signing_cert_chain (D-205)
    // X.509 cert chain [leaf, intermediate, root CA] as array of bstr (DER).
    // Firmware verifies the chain back to the pinned root CA, then extracts
    // the leaf SPKI for signature verification. Enables key rotation without
    // firmware updates. Empty array if not provisioned.
    [encodeUint(77), encodeArray(
      certChain.length > 0
        ? certChain.map(cert => encodeBstr(cert))
        : []  // empty array = no cert chain, use pinned SPKI instead
    )],

    // -- §2.9 Verdict cache and override (REQ-13, REQ-14) --
    // Key 80: verdict_freshness_seconds (15 min)
    [encodeUint(80), encodeUint(900)],
    // Key 81: grace_period_seconds (7 days)
    [encodeUint(81), encodeUint(604800)],
    // Key 82: wipe_deadline_seconds (24h)
    [encodeUint(82), encodeUint(86400)],
    // Key 83: override_rate_limit
    [encodeUint(83), encodeMap([
      [encodeTstr('max_attempts'), encodeUint(5)],
      [encodeTstr('window_seconds'), encodeUint(3600)],
    ])],
    // Key 84: override_challenge_uri
    [encodeUint(84), encodeTstr(overrideChallengeUri)],
  ]);
}

/** Build a minimal C4 policy payload as CBOR map.
 *
 * This is a default policy when no stored policy exists.
 * The policy includes the required C4 §2.1 metadata fields.
 *
 * @deprecated Use buildFullPolicyPayload instead (D-209).
 */
function buildDefaultPolicyPayload(version: number): Uint8Array {
  return buildFullPolicyPayload(version);
}

/** Handle GET /v1/policy/:version. */
export async function handlePolicy(
  request: Request,
  env: Env,
  policyKeys: SigningKeyPair,  // D-205: signs the policy blob (C4 §1)
  verdictKeys: SigningKeyPair, // D-205: SPKI embedded in policy for verdict verification
  versionParam: string,
): Promise<Response> {
  let version: number;

  if (versionParam === 'latest') {
    // Find the latest policy version in KV
    // KV doesn't support listing with prefix efficiently in Workers,
    // so we check a `pbl_policy:latest_version` key that tracks the latest.
    const latestVer = await env.LOCKDOWN_KV.get('pbl_policy:latest_version');
    if (latestVer) {
      version = parseInt(latestVer, 10);
    } else {
      version = 1; // default
    }
  } else {
    version = parseInt(versionParam, 10);
    if (isNaN(version) || version < 1) {
      return new Response(
        JSON.stringify({ error: 'invalid policy version' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // Try to fetch the stored policy from KV
  const policyKey = `pbl_policy:${version}`;
  const storedPolicy = await env.LOCKDOWN_KV.get(policyKey, 'arrayBuffer');

  if (storedPolicy) {
    // Return the stored COSE_Sign1 policy blob as-is
    return new Response(storedPolicy, {
      status: 200,
      headers: {
        'Content-Type': 'application/cose',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  // No stored policy — generate a default one on the fly
  // This is for bootstrapping: the first PBL boot has no stored policy
  // D-205: The policy is signed by the policy signing key (policyKeys).
  // The verdict signing key SPKI (verdictKeys.spki) is embedded in the
  // policy payload (C4 key 76) so firmware can verify verdict signatures.
  // The policy kid (policyKeys.kid) is the root-of-trust kid that firmware
  // must pin (compile-time constant or read-only NV index).
  // D-205: The kid history (C4 key 72) is loaded from KV — it contains
  // previous verdict signing key kids for rotation grace period.
  // D-205: The cert chain (C4 key 77) is loaded from KV — it contains
  // the X.509 cert chain [leaf, intermediate, root CA] for the policy
  // signing key. Firmware verifies the chain back to the pinned root CA.
  const kidHistory = await getKidHistory(env.LOCKDOWN_KV);
  const certChain = await loadCertChain(env.LOCKDOWN_KV);
  const payload = buildFullPolicyPayload(version, {
    certPin: verdictKeys.kid,
    certPinHistory: kidHistory,
    certChain,
    verdictSigningKeySpki: verdictKeys.spki,
  });
  const cose = await encodeCoseSign1(payload, policyKeys);

  return new Response(cose, {
    status: 200,
    headers: {
      'Content-Type': 'application/cose',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/** Store a policy blob in KV (admin endpoint for policy management). */
export async function handleStorePolicy(
  request: Request,
  env: Env,
  policyKeys: SigningKeyPair,  // D-205: signs the policy blob (C4 §1)
  verdictKeys: SigningKeyPair, // D-205: SPKI embedded in policy for verdict verification
): Promise<Response> {
  // Admin auth required
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({ error: 'admin authentication required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }
  // The admin token check is done by the caller — here we accept
  // any bearer token since the worker's verifyAdminAuth is not
  // accessible from this module. The route dispatcher should check
  // admin auth before calling this handler.

  const body = new Uint8Array(await request.arrayBuffer());

  // Parse the CBOR policy to extract the version
  // The policy is a COSE_Sign1, so we need to extract the payload
  // For simplicity, we store the raw COSE bytes and extract version
  // from the query parameter
  const url = new URL(request.url);
  const versionParam = url.searchParams.get('version');

  if (!versionParam) {
    return new Response(
      JSON.stringify({ error: 'version query parameter required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const version = parseInt(versionParam, 10);
  if (isNaN(version) || version < 1) {
    return new Response(
      JSON.stringify({ error: 'invalid version' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Store the COSE_Sign1 policy blob in KV
  await env.LOCKDOWN_KV.put(`pbl_policy:${version}`, body);

  // Update latest version pointer
  const latestVer = await env.LOCKDOWN_KV.get('pbl_policy:latest_version');
  if (!latestVer || version > parseInt(latestVer, 10)) {
    await env.LOCKDOWN_KV.put('pbl_policy:latest_version', String(version));
  }

  return new Response(
    JSON.stringify({ stored: true, version }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
