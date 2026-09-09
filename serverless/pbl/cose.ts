/**
 * COSE_Sign1 encoder (RFC 8152 §4.2).
 *
 * COSE_Sign1 = [
 *   protected: bstr .cbor {1: alg_id, 4: kid},
 *   unprotected: {},
 *   payload: bstr,
 *   signature: bstr
 * ]
 *
 * Sig_structure = [
 *   "Signature1",
 *   protected: bstr,
 *   external_aad: bstr'',
 *   payload: bstr
 * ]
 */

import {
  encodeBstr,
  encodeArray,
  encodeMap,
  encodeUint,
  encodeTstr,
  encodeNull,
  CborDecoder,
} from './cbor';
import { signData, verifySignature, type SigningKeyPair, type SigningAlgorithm } from './signing';

/** COSE algorithm IDs. */
export const COSE_ALG_ES256 = -7;
export const COSE_ALG_ED25519 = -8;

/** Map SigningAlgorithm to COSE algorithm ID. */
export function algorithmToCoseAlg(alg: SigningAlgorithm): number {
  return alg === 'Ed25519' ? COSE_ALG_ED25519 : COSE_ALG_ES256;
}

/** Encode a negative integer (CBOR major type 1). */
function encodeNint(value: number): Uint8Array {
  const abs = -value - 1;
  if (abs < 24) {
    return new Uint8Array([0x20 | abs]);
  }
  if (abs < 0x100) {
    return new Uint8Array([0x38, abs]);
  }
  if (abs < 0x10000) {
    return new Uint8Array([0x39, (abs >> 8) & 0xff, abs & 0xff]);
  }
  return new Uint8Array([
    0x3a,
    (abs >>> 24) & 0xff,
    (abs >>> 16) & 0xff,
    (abs >>> 8) & 0xff,
    abs & 0xff,
  ]);
}

/** Build the COSE protected header: CBOR map {1: alg, 4: kid}. */
function buildProtectedHeader(alg: number, kid: Uint8Array): Uint8Array {
  return encodeMap([
    [encodeUint(1), encodeNint(alg)], // alg
    [encodeUint(4), encodeBstr(kid)], // kid
  ]);
}

/** Build the Sig_structure for COSE_Sign1. */
function buildSigStructure(
  protectedHeader: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  const externalAad = new Uint8Array(0); // empty
  return encodeArray([
    encodeTstr('Signature1'),
    encodeBstr(protectedHeader),
    encodeBstr(externalAad),
    encodeBstr(payload),
  ]);
}

/** Encode a complete COSE_Sign1 structure.
 *
 * @param payload - The raw payload bytes (already CBOR-encoded if needed)
 * @param keys - The signing key pair
 * @returns COSE_Sign1 bytes (CBOR array of 4 elements)
 */
export async function encodeCoseSign1(
  payload: Uint8Array,
  keys: SigningKeyPair,
): Promise<Uint8Array> {
  // D-205: Use the key's algorithm (ES256 or Ed25519)
  const alg = algorithmToCoseAlg(keys.algorithm);
  const protectedHeader = buildProtectedHeader(alg, keys.kid);
  const sigStructure = buildSigStructure(protectedHeader, payload);
  const signature = await signData(keys.privateKey, sigStructure, keys.algorithm);

  // COSE_Sign1 = [protected, unprotected, payload, signature]
  const unprotectedHeader = encodeMap([]); // empty map
  return encodeArray([
    encodeBstr(protectedHeader),
    unprotectedHeader,
    encodeBstr(payload),
    encodeBstr(signature),
  ]);
}

/** Extract the payload from a COSE_Sign1 structure (for verification). */
export function extractCosePayload(coseData: Uint8Array): Uint8Array {
  const dec = new CborDecoder(coseData);
  const elements = dec.readArray();
  if (elements.length !== 4) {
    throw new Error('COSE_Sign1: expected array of 4 elements');
  }
  // Element 2 is the payload bstr
  const payloadDec = new CborDecoder(elements[2]);
  return payloadDec.readBstr();
}

/** Extract the protected header from a COSE_Sign1 structure. */
export function extractCoseProtectedHeader(coseData: Uint8Array): Uint8Array {
  const dec = new CborDecoder(coseData);
  const elements = dec.readArray();
  if (elements.length !== 4) {
    throw new Error('COSE_Sign1: expected array of 4 elements');
  }
  // Element 0 is the protected header bstr
  const headerDec = new CborDecoder(elements[0]);
  return headerDec.readBstr();
}

/** Extract the signature from a COSE_Sign1 structure. */
export function extractCoseSignature(coseData: Uint8Array): Uint8Array {
  const dec = new CborDecoder(coseData);
  const elements = dec.readArray();
  if (elements.length !== 4) {
    throw new Error('COSE_Sign1: expected array of 4 elements');
  }
  // Element 3 is the signature bstr
  const sigDec = new CborDecoder(elements[3]);
  return sigDec.readBstr();
}

/** Reconstruct the Sig_structure for signature verification. */
export function reconstructSigStructure(
  coseData: Uint8Array,
): { sigStructure: Uint8Array; payload: Uint8Array } {
  const protectedHeader = extractCoseProtectedHeader(coseData);
  const payload = extractCosePayload(coseData);
  const sigStructure = buildSigStructure(protectedHeader, payload);
  return { sigStructure, payload };
}

/** Parse the protected header to extract the algorithm ID.
 *  Returns the COSE algorithm ID (e.g., -7 for ES256, -8 for Ed25519)
 *  or null if the header is malformed. */
export function extractCoseAlgorithm(coseData: Uint8Array): number | null {
  try {
    const protectedHeader = extractCoseProtectedHeader(coseData);
    const dec = new CborDecoder(protectedHeader);
    const map = dec.readIntKeyedMap();
    if (!map.has(1)) return null;
    // Key 1 is the algorithm — it's a negative int
    const algDec = new CborDecoder(map.get(1)!);
    return algDec.readNegativeInt();
  } catch {
    return null;
  }
}

/** Parse the protected header to extract the kid.
 *  Returns the kid bytes or null if not present. */
export function extractCoseKid(coseData: Uint8Array): Uint8Array | null {
  try {
    const protectedHeader = extractCoseProtectedHeader(coseData);
    const dec = new CborDecoder(protectedHeader);
    const map = dec.readIntKeyedMap();
    if (!map.has(4)) return null;
    const kidDec = new CborDecoder(map.get(4)!);
    return kidDec.readBstr();
  } catch {
    return null;
  }
}

/** Verify a COSE_Sign1 structure against a public key.
 *  D-208: Server-side COSE_Sign1 verification.
 *
 *  @param coseData   The COSE_Sign1 bytes (CBOR array of 4)
 *  @param publicKey  The CryptoKey to verify against
 *  @param algorithm  The signing algorithm ('ES256' or 'Ed25519')
 *  @returns true if the signature is valid
 */
export async function verifyCoseSign1(
  coseData: Uint8Array,
  publicKey: CryptoKey,
  algorithm: SigningAlgorithm = 'ES256',
): Promise<boolean> {
  try {
    const { sigStructure } = reconstructSigStructure(coseData);
    const signature = extractCoseSignature(coseData);
    return await verifySignature(publicKey, sigStructure, signature, algorithm);
  } catch {
    return false;
  }
}
