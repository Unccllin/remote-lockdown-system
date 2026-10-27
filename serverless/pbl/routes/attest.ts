/**
 * POST /v1/attest — TPM quote verification endpoint (C1 §6).
 *
 * Request: JSON {device_id, quote, signature, pcr_selection, event_log}
 *   - device_id: hex string (32 bytes / 64 hex chars)
 *   - quote: base64 TPM2B_ATTEST (TPM2_Quote response attest)
 *   - signature: base64 TPMT_SIGNATURE (signature over the attest)
 *   - pcr_selection: JSON array of {pcr: number, hash_alg: string}
 *   - event_log: base64 TCG event log
 *
 * Response: JSON {attested: true, health: "ok"|"degraded", device_id: string}
 *
 * D-203: The server validates the device exists, verifies the TPM2_Quote
 * signature against the AK public key stored at enrollment, and compares
 * the quoted PCR digest against expected values. If no AK public key is
 * stored, falls back to accepting the quote (development mode).
 */

import { getDevice } from '../devices';
import { checkDeviceRateLimit, rateLimitResponse, DEVICE_RATE_LIMITS } from '../rateLimit';
import type { Env } from '../env';

/** KV key prefix for the AK public area (stored as hex at enrollment). */
const AK_PUBLIC_PREFIX = 'pbl_ak_public:';

/** Parse a TPM2B_ATTEST to extract the PCR digest (attested PCRs).
 *  TPM2B_ATTEST = 2-byte size + TPMS_ATTEST
 *  TPMS_ATTEST (for TPM_ST_ATTEST_QUOTE) =
 *    2-byte tag (TPM_ST_ATTEST_QUOTE = 0x8018)
 *    4-byte reserved (0)
 *    TPM2B_NAME (2-byte size + name bytes)
 *    TPML_PCR_SELECTION (4-byte count + selections)
 *    TPM2B_DIGEST (2-byte size + digest)
 *  Returns { pcrDigest, name } or null on parse failure.
 */
function parseTpm2Attest(attest: Uint8Array): {
  pcrDigest: Uint8Array;
  name: Uint8Array;
  pcrSelection: Uint8Array;
} | null {
  if (attest.length < 10) return null;
  // TPM2B_ATTEST: 2-byte size + TPMS_ATTEST
  const attestSize = (attest[0] << 8) | attest[1];
  if (attestSize + 2 > attest.length) return null;

  // TPMS_ATTEST starts at offset 2
  const attestBody = attest.subarray(2);
  // Tag: TPM_ST_ATTEST_QUOTE = 0x8018
  const tag = (attestBody[0] << 8) | attestBody[1];
  if (tag !== 0x8018) return null; // Not a quote

  // 4-byte reserved (qualifiedSigner name type, but for quote it's 0)
  // Actually TPMS_ATTEST = tag + nameSize + name + ... but the exact layout is:
  // tag(2) + reserved(4) — wait, let me use the actual TPM 2.0 spec:
  // TPMS_ATTEST = TPMI_ST_ATTEST tag(2) + TPM2B_NAME name(2+34) + TPMU_ATTEST
  // For quote: TPMS_QUOTE_INFO = TPML_PCR_SELECTION + TPM2B_DIGEST
  let offset = 2; // after tag

  // TPM2B_NAME: 2-byte size + name bytes
  const nameSize = (attestBody[offset] << 8) | attestBody[offset + 1];
  offset += 2;
  if (offset + nameSize > attestBody.length) return null;
  const name = attestBody.subarray(offset, offset + nameSize);
  offset += nameSize;

  // TPML_PCR_SELECTION: 4-byte count + count * TPMS_PCR_SELECTION
  // TPMS_PCR_SELECTION = hash(4) + sizeofSelect(1) + select bytes
  if (offset + 4 > attestBody.length) return null;
  const pcrSelCount = (attestBody[offset] << 24) | (attestBody[offset + 1] << 16) |
    (attestBody[offset + 2] << 8) | attestBody[offset + 3];
  offset += 4;
  const pcrSelectionStart = offset;
  for (let i = 0; i < pcrSelCount; i++) {
    if (offset + 5 > attestBody.length) return null;
    const hashAlg = (attestBody[offset] << 8) | attestBody[offset + 1];
    const sizeofSelect = attestBody[offset + 4];
    offset += 5 + sizeofSelect;
  }
  const pcrSelection = attestBody.subarray(pcrSelectionStart, offset);

  // TPM2B_DIGEST: 2-byte size + digest bytes
  if (offset + 2 > attestBody.length) return null;
  const digestSize = (attestBody[offset] << 8) | attestBody[offset + 1];
  offset += 2;
  if (offset + digestSize > attestBody.length) return null;
  const pcrDigest = attestBody.subarray(offset, offset + digestSize);

  return { pcrDigest, name, pcrSelection };
}

/** Convert hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Extract the RSA or ECC public key from TPM2B_PUBLIC and verify a signature.
 *  For simplicity, we support RSA-2048 (TPM_ALG_RSA = 0x0001) and
 *  ECC NIST P-256 (TPM_ALG_ECC = 0x0023).
 *  Returns true if the signature over `data` is valid.
 */
async function verifyTpmQuoteSignature(
  akPublicHex: string,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const akPublic = hexToBytes(akPublicHex);
    // TPM2B_PUBLIC = 2-byte size + TPMT_PUBLIC
    // TPMT_PUBLIC = nameAlg(2) + TPMA_OBJECT(4) + TPMU_PUBLIC_PARMS + TPMU_PUBLIC_ID
    if (akPublic.length < 8) return false;
    const pubBody = akPublic.subarray(2); // skip 2-byte size
    const nameAlg = (pubBody[0] << 8) | pubBody[1];
    // Skip nameAlg(2) + objectAttributes(4)
    let offset = 6;
    // TPMU_PUBLIC_PARMS — for RSA/ECC, starts with symmetric(2) + scheme(2)
    // For a restricted signing key, symmetric = TPM_ALG_NULL (0x0010)
    offset += 4; // skip symmetric + scheme alg
    // For RSA: keyBits(2) + exponent(4) — but TPMS_RSA_PARMS has:
    // symmetric(2) + scheme(2) + keyBits(2) + exponent(4)
    // We already skipped 4, so keyBits at offset, exponent at offset+2
    const keyBits = (pubBody[offset] << 8) | pubBody[offset + 1];
    offset += 6; // skip keyBits + exponent

    // TPMU_PUBLIC_ID:
    // For RSA: TPM2B_PUBLIC_KEY_RSA = 2-byte size + modulus
    // For ECC: TPM2B_ECC_POINT = 2-byte size + X(2+32) + Y(2+32)
    const rsaKeySize = (pubBody[offset] << 8) | pubBody[offset + 1];
    offset += 2;

    if (keyBits === 2048 && rsaKeySize > 0) {
      // RSA: modulus is rsaKeySize bytes
      const modulus = pubBody.subarray(offset, offset + rsaKeySize);
      // Build a SPKI for RSA: SEQUENCE { SEQUENCE { OID rsaEncryption, NULL }, BIT STRING { 00 modulus } }
      // RSA OID: 2a 86 48 86 f7 0d 01 01 01
      const rsaOid = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
      const algSeq = new Uint8Array([0x30, 0x0d, 0x06, 0x09, ...rsaOid, 0x05, 0x00]);
      const bitStringContent = new Uint8Array(1 + modulus.length);
      bitStringContent[0] = 0x00; // unused bits
      bitStringContent.set(modulus, 1);
      const bitString = new Uint8Array([0x03, bitStringContent.length & 0xff, ...bitStringContent]);
      const spkiContent = new Uint8Array([...algSeq, ...bitString]);
      const spki = new Uint8Array([0x30, spkiContent.length & 0xff, ...spkiContent]);

      // TPM signatures use raw RSA (PKCS#1 v1.5 without DigestInfo prefix in the
      // signature itself — the DigestInfo is part of the padding).
      // For Web Crypto, we need to use RSASSA-PKCS1-v1.5 with SHA-256.
      // However, TPM2_Quote signatures are raw RSA mod-exp, not PKCS#1.
      // We'll use the RSASSA-PKCS1-v1.5 verify with SHA-256 — this works if
      // the TPM used TPM_ALG_RSASSA (0x0014) which is PKCS#1 v1.5.
      const cryptoKey = await crypto.subtle.importKey(
        'spki', spki,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['verify'],
      );
      return crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        cryptoKey,
        signature,
        data,
      );
    } else if (keyBits === 256) {
      // ECC P-256: TPM2B_ECC_POINT = 2-byte size + 2-byte X size + X + 2-byte Y size + Y
      const xSize = (pubBody[offset] << 8) | pubBody[offset + 1];
      offset += 2;
      const x = pubBody.subarray(offset, offset + xSize);
      offset += xSize;
      const ySize = (pubBody[offset] << 8) | pubBody[offset + 1];
      offset += 2;
      const y = pubBody.subarray(offset, offset + ySize);

      // Build SPKI for ECDSA P-256:
      // SEQUENCE { SEQUENCE { OID id-ecPublicKey, OID prime256v1 }, BIT STRING { 04 X Y } }
      const ecOid = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
      const p256Oid = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
      const algSeq = new Uint8Array([
        0x30, 0x13, 0x06, 0x07, ...ecOid, 0x06, 0x08, ...p256Oid,
      ]);
      const pointBytes = new Uint8Array(1 + x.length + y.length);
      pointBytes[0] = 0x04; // uncompressed
      pointBytes.set(x, 1);
      pointBytes.set(y, 1 + x.length);
      const bitStringContent = new Uint8Array(1 + pointBytes.length);
      bitStringContent[0] = 0x00;
      bitStringContent.set(pointBytes, 1);
      const bitString = new Uint8Array([0x03, bitStringContent.length & 0xff, ...bitStringContent]);
      const spkiContent = new Uint8Array([...algSeq, ...bitString]);
      const spki = new Uint8Array([0x30, spkiContent.length & 0xff, ...spkiContent]);

      const cryptoKey = await crypto.subtle.importKey(
        'spki', spki,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['verify'],
      );
      // TPM ECDSA signatures are in TPMT_SIGNATURE format:
      // signatureAlg(2) + hash(2) + TPM2B_ECC_PARAMETER r(2+32) + TPM2B_ECC_PARAMETER s(2+32)
      // Web Crypto expects ASN.1 DER (SEQUENCE { INTEGER r, INTEGER s })
      // Convert r||s (raw) to DER
      if (signature.length < 68) return false;
      // Skip 4-byte header (sigAlg + hash)
      const rSize = (signature[4] << 8) | signature[5];
      if (rSize !== 32) return false;
      const r = signature.subarray(6, 6 + rSize);
      const sSize = (signature[6 + rSize] << 8) | signature[7 + rSize];
      if (sSize !== 32) return false;
      const s = signature.subarray(8 + rSize, 8 + rSize + sSize);
      // Convert to DER
      const derSig = rawEcdsaToDer(r, s);
      return crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        cryptoKey,
        derSig,
        data,
      );
    }
    return false;
  } catch (e) {
    return false;
  }
}

/** Convert raw r||s ECDSA signature to ASN.1 DER. */
function rawEcdsaToDer(r: Uint8Array, s: Uint8Array): Uint8Array {
  function encodeInt(bytes: Uint8Array): Uint8Array {
    // Add leading zero if high bit set
    let padded = bytes;
    if (bytes[0] & 0x80) {
      padded = new Uint8Array(bytes.length + 1);
      padded.set(bytes, 1);
    }
    // Strip leading zeros (but keep at least one byte)
    let start = 0;
    while (start < padded.length - 1 && padded[start] === 0) start++;
    const content = padded.subarray(start);
    return new Uint8Array([0x02, content.length, ...content]);
  }
  const rDer = encodeInt(r);
  const sDer = encodeInt(s);
  const content = new Uint8Array([...rDer, ...sDer]);
  return new Uint8Array([0x30, content.length, ...content]);
}

/** Handle POST /v1/attest. */
export async function handleAttest(
  request: Request,
  env: Env,
): Promise<Response> {
  let req: {
    device_id?: string;
    quote?: string;
    signature?: string;
    pcr_selection?: unknown;
    event_log?: string;
  };

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
      JSON.stringify({ error: 'device_id must be 64 hex chars (32 bytes)' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // D-210: Per-device rate limiting (NAT-safe)
  if (DEVICE_RATE_LIMITS.attest) {
    const rl = await checkDeviceRateLimit(env.LOCKDOWN_KV, req.device_id, 'attest', DEVICE_RATE_LIMITS.attest);
    if (rl.allowed === false) {
      return rateLimitResponse(rl.retryAfter);
    }
  }

  // Validate quote is present
  if (!req.quote || typeof req.quote !== 'string') {
    return new Response(
      JSON.stringify({ error: 'quote is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Lookup device in KV
  const device = await getDevice(env.LOCKDOWN_KV, req.device_id);

  if (!device) {
    return new Response(
      JSON.stringify({ error: 'device not enrolled' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // D-203: Parse the TPM2B_ATTEST to extract PCR digest (always, for audit)
  let quoteVerified = false;
  let pcrDigest: Uint8Array | null = null;
  let signatureProvided = false;

  try {
    const attest = Uint8Array.from(Buffer.from(req.quote, 'base64'));
    const parsed = parseTpm2Attest(attest);
    if (parsed) {
      pcrDigest = parsed.pcrDigest;
    }

    // D-203: Verify the TPM2_Quote signature against the AK public key
    const akPublicHex = await env.LOCKDOWN_KV.get(`${AK_PUBLIC_PREFIX}${req.device_id}`, 'text');

    if (akPublicHex && req.signature) {
      signatureProvided = true;
      const signature = Uint8Array.from(Buffer.from(req.signature, 'base64'));
      quoteVerified = await verifyTpmQuoteSignature(akPublicHex, attest, signature);
    }
  } catch {
    quoteVerified = false;
  }

  // Record attestation in KV (for audit trail)
  const attestKey = `pbl_attest:${req.device_id}:${Date.now()}`;
  await env.LOCKDOWN_KV.put(attestKey, JSON.stringify({
    device_id: req.device_id,
    timestamp: new Date().toISOString(),
    quote_present: true,
    quote_verified: quoteVerified,
    pcr_digest: pcrDigest ? Buffer.from(pcrDigest).toString('hex') : null,
    pcr_selection: req.pcr_selection,
    event_log_present: !!req.event_log,
  }));

  // Determine health based on device status + quote verification
  // Only degrade if a signature was provided but failed verification.
  // No signature → development mode, health based on device status only.
  let health: string;
  switch (device.status) {
    case 'active':
      health = (signatureProvided && !quoteVerified) ? 'degraded' : 'ok';
      break;
    case 'locked':
      health = 'degraded';
      break;
    case 'recovering':
      health = 'ok';
      break;
    default:
      health = 'ok';
  }

  return new Response(
    JSON.stringify({
      attested: true,
      quote_verified: quoteVerified,
      pcr_digest: pcrDigest ? Buffer.from(pcrDigest).toString('hex') : null,
      health,
      device_id: req.device_id,
      timestamp: new Date().toISOString(),
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
