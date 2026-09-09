/**
 * D-203: TPM2_Quote signature verification (server-side).
 *
 * JavaScript port of `serverless/pbl/routes/attest.ts` verification logic.
 * Parses TPM2B_PUBLIC to extract RSA-2048 or ECC P-256 public keys,
 * builds SPKI on the fly, and verifies TPM2_Quote signatures using
 * Web Crypto API (available in Node 20+).
 */

const crypto = require('crypto');

/** Convert hex string to Buffer. */
function hexToBuffer(hex) {
  return Buffer.from(hex, 'hex');
}

/** Convert raw r||s ECDSA signature to ASN.1 DER. */
function rawEcdsaToDer(r, s) {
  function encodeInt(bytes) {
    let padded = bytes;
    if (bytes[0] & 0x80) {
      padded = Buffer.alloc(bytes.length + 1);
      bytes.copy(padded, 1);
    }
    let start = 0;
    while (start < padded.length - 1 && padded[start] === 0) start++;
    const content = padded.subarray(start);
    return Buffer.concat([Buffer.from([0x02, content.length]), content]);
  }
  const rDer = encodeInt(r);
  const sDer = encodeInt(s);
  const content = Buffer.concat([rDer, sDer]);
  return Buffer.concat([Buffer.from([0x30, content.length]), content]);
}

/**
 * Parse TPM2B_ATTEST to extract PCR digest, AK name, and PCR selection.
 * TPM2B_ATTEST = 2-byte size + TPMS_ATTEST
 * TPMS_ATTEST (for TPM_ST_ATTEST_QUOTE) =
 *   2-byte tag (0x8018) + TPM2B_NAME + TPML_PCR_SELECTION + TPM2B_DIGEST
 */
function parseTpm2Attest(attest) {
  if (attest.length < 10) return null;
  const attestSize = (attest[0] << 8) | attest[1];
  if (attestSize + 2 > attest.length) return null;
  const body = attest.subarray(2);
  const tag = (body[0] << 8) | body[1];
  if (tag !== 0x8018) return null; // TPM_ST_ATTEST_QUOTE

  let offset = 2;
  // TPM2B_NAME: 2-byte size + name bytes
  const nameSize = (body[offset] << 8) | body[offset + 1];
  offset += 2;
  if (offset + nameSize > body.length) return null;
  const name = body.subarray(offset, offset + nameSize);
  offset += nameSize;

  // TPML_PCR_SELECTION: 4-byte count + count * TPMS_PCR_SELECTION
  if (offset + 4 > body.length) return null;
  const pcrSelCount = (body[offset] << 24) | (body[offset + 1] << 16)
    | (body[offset + 2] << 8) | body[offset + 3];
  offset += 4;
  const pcrSelectionStart = offset;
  for (let i = 0; i < pcrSelCount; i++) {
    if (offset + 5 > body.length) return null;
    const sizeofSelect = body[offset + 4];
    offset += 5 + sizeofSelect;
  }
  const pcrSelection = body.subarray(pcrSelectionStart, offset);

  // TPM2B_DIGEST: 2-byte size + digest bytes
  if (offset + 2 > body.length) return null;
  const digestSize = (body[offset] << 8) | body[offset + 1];
  offset += 2;
  if (offset + digestSize > body.length) return null;
  const pcrDigest = body.subarray(offset, offset + digestSize);

  return { pcrDigest, name, pcrSelection };
}

/**
 * Extract the RSA or ECC public key from TPM2B_PUBLIC and verify a signature.
 * Supports RSA-2048 (RSASSA-PKCS1-v1_5 + SHA-256) and ECC P-256 (ECDSA + SHA-256).
 * @param {string} akPublicHex - Hex-encoded TPM2B_PUBLIC
 * @param {Buffer} data - Data that was signed (the TPM2B_ATTEST)
 * @param {Buffer} signature - TPMT_SIGNATURE
 * @returns {Promise<boolean>}
 */
async function verifyTpmQuoteSignature(akPublicHex, data, signature) {
  try {
    const akPublic = hexToBuffer(akPublicHex);
    if (akPublic.length < 8) return false;
    const pubBody = akPublic.subarray(2); // skip 2-byte size
    // Skip nameAlg(2) + objectAttributes(4)
    let offset = 6;
    // Skip symmetric(2) + scheme(2)
    offset += 4;
    // keyBits(2) + exponent(4)
    const keyBits = (pubBody[offset] << 8) | pubBody[offset + 1];
    offset += 6;

    // TPMU_PUBLIC_ID
    const rsaKeySize = (pubBody[offset] << 8) | pubBody[offset + 1];
    offset += 2;

    if (keyBits === 2048 && rsaKeySize > 0) {
      // RSA: modulus is rsaKeySize bytes
      const modulus = pubBody.subarray(offset, offset + rsaKeySize);
      // Build SPKI for RSA
      const rsaOid = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
      const algSeq = Buffer.concat([
        Buffer.from([0x30, 0x0d, 0x06, 0x09]), rsaOid, Buffer.from([0x05, 0x00]),
      ]);
      const bitStringContent = Buffer.alloc(1 + modulus.length);
      bitStringContent[0] = 0x00;
      modulus.copy(bitStringContent, 1);
      const bitString = Buffer.concat([
        Buffer.from([0x03, bitStringContent.length & 0xff]), bitStringContent,
      ]);
      const spkiContent = Buffer.concat([algSeq, bitString]);
      const spki = Buffer.concat([
        Buffer.from([0x30, spkiContent.length & 0xff]), spkiContent,
      ]);

      const cryptoKey = await crypto.subtle.importKey(
        'spki', spki,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['verify'],
      );
      return crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        cryptoKey, signature, data,
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

      // Build SPKI for ECDSA P-256
      const ecOid = Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
      const p256Oid = Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
      const algSeq = Buffer.concat([
        Buffer.from([0x30, 0x13, 0x06, 0x07]), ecOid,
        Buffer.from([0x06, 0x08]), p256Oid,
      ]);
      const pointBytes = Buffer.alloc(1 + x.length + y.length);
      pointBytes[0] = 0x04; // uncompressed
      x.copy(pointBytes, 1);
      y.copy(pointBytes, 1 + x.length);
      const bitStringContent = Buffer.alloc(1 + pointBytes.length);
      bitStringContent[0] = 0x00;
      pointBytes.copy(bitStringContent, 1);
      const bitString = Buffer.concat([
        Buffer.from([0x03, bitStringContent.length & 0xff]), bitStringContent,
      ]);
      const spkiContent = Buffer.concat([algSeq, bitString]);
      const spki = Buffer.concat([
        Buffer.from([0x30, spkiContent.length & 0xff]), spkiContent,
      ]);

      const cryptoKey = await crypto.subtle.importKey(
        'spki', spki,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['verify'],
      );

      // TPM ECDSA signatures: sigAlg(2) + hash(2) + r(2+32) + s(2+32)
      if (signature.length < 68) return false;
      const rSize = (signature[4] << 8) | signature[5];
      if (rSize !== 32) return false;
      const r = signature.subarray(6, 6 + rSize);
      const sSize = (signature[6 + rSize] << 8) | signature[7 + rSize];
      if (sSize !== 32) return false;
      const s = signature.subarray(8 + rSize, 8 + rSize + sSize);
      const derSig = rawEcdsaToDer(r, s);
      return crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        cryptoKey, derSig, data,
      );
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * D-204: Verify an operator's ES256 signature over challenge bytes.
 * @param {Buffer} challenge - Challenge bytes
 * @param {string} responseB64 - Base64-encoded signature
 * @param {Buffer} spki - Operator public key SPKI
 * @returns {Promise<boolean>}
 */
async function verifyOperatorSignature(challenge, responseB64, spki) {
  try {
    const signature = Buffer.from(responseB64, 'base64');
    const cryptoKey = await crypto.subtle.importKey(
      'spki', spki,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['verify'],
    );
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey, signature, challenge,
    );
  } catch {
    return false;
  }
}

/**
 * D-203: Compute the TPM Name of an AK from its TPM2B_PUBLIC.
 * TPM Name = 2-byte hash alg (0x000B = SHA-256) + SHA-256(public area).
 * The public area is the TPM2B_PUBLIC body (after the 2-byte size prefix).
 * @param {string} akPublicHex - Hex-encoded TPM2B_PUBLIC
 * @returns {Buffer} The TPM Name (34 bytes for SHA-256)
 */
function computeAkName(akPublicHex) {
  const akPublic = hexToBuffer(akPublicHex);
  if (akPublic.length < 4) return Buffer.alloc(0);
  const pubBody = akPublic.subarray(2); // skip 2-byte size
  const hash = crypto.createHash('sha256').update(pubBody).digest();
  // TPM2B_NAME = 2-byte alg (0x000B = SHA-256) + 32-byte hash
  return Buffer.concat([Buffer.from([0x00, 0x0b]), hash]);
}

/**
 * D-203: Compare a PCR digest from a TPM2_Quote against expected PCR values.
 * The expected_pcr_values is an array of hex strings. The comparison is:
 *   SHA-256(concat(expected_pcr_values)) == pcrDigest
 * Each PCR value is a 32-byte hex string (64 hex chars).
 * @param {Buffer} pcrDigest - The digest from the TPM2_Quote
 * @param {string[]} expectedPcrValues - Array of hex-encoded PCR values
 * @returns {boolean} True if the digest matches
 */
function comparePcrDigest(pcrDigest, expectedPcrValues) {
  if (!pcrDigest || !Array.isArray(expectedPcrValues) || expectedPcrValues.length === 0) {
    return false;
  }
  const hash = crypto.createHash('sha256');
  for (const pcrHex of expectedPcrValues) {
    const pcrBuf = Buffer.from(pcrHex, 'hex');
    if (pcrBuf.length !== 32) return false;
    hash.update(pcrBuf);
  }
  const computed = hash.digest();
  return computed.equals(pcrDigest);
}

module.exports = {
  parseTpm2Attest,
  verifyTpmQuoteSignature,
  verifyOperatorSignature,
  rawEcdsaToDer,
  computeAkName,
  comparePcrDigest,
};
