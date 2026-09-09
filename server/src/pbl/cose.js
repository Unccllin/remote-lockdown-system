/**
 * COSE_Sign1 signing for server-side PBL verdict (D-200, D-205).
 *
 * JavaScript port of the essential signing functions from
 * `serverless/pbl/cose.ts` and `serverless/pbl/signing.ts`.
 * Uses Node.js Web Crypto API (available in Node 20+).
 * Supports both ES256 (ECDSA P-256, alg=-7) and Ed25519 (EdDSA, alg=-8).
 */

const crypto = require('crypto');
const { encodeBstr, encodeArray, encodeMap, encodeUint, encodeNint, encodeTstr } = require('./cbor');

const COSE_ALG_ES256 = -7;
const COSE_ALG_ED25519 = -8;

/** Map algorithm name to COSE algorithm ID. */
function algorithmToCoseAlg(alg) {
  return alg === 'Ed25519' ? COSE_ALG_ED25519 : COSE_ALG_ES256;
}

/** Generate or load an ES256 signing key pair. */
async function generateSigningKey(algorithm = 'ES256') {
  let keyParams, signParams;
  if (algorithm === 'Ed25519') {
    keyParams = { name: 'Ed25519' };
    signParams = 'Ed25519';
  } else {
    keyParams = { name: 'ECDSA', namedCurve: 'P-256' };
    signParams = { name: 'ECDSA', hash: 'SHA-256' };
  }

  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    keyParams,
    true,
    ['sign', 'verify'],
  );
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', publicKey));
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey));
  const kid = Buffer.from(await crypto.subtle.digest('SHA-256', spki));
  return { publicKey, privateKey, spki, pkcs8, kid, algorithm };
}

/** Sign data with ES256 or Ed25519. */
async function signData(privateKey, data, algorithm = 'ES256') {
  const signParams = algorithm === 'Ed25519' ? 'Ed25519' : { name: 'ECDSA', hash: 'SHA-256' };
  const sig = await crypto.subtle.sign(
    signParams,
    privateKey,
    data,
  );
  return Buffer.from(sig);
}

/** Verify a signature with ES256 or Ed25519. */
async function verifySignature(publicKey, data, signature, algorithm = 'ES256') {
  const verifyParams = algorithm === 'Ed25519' ? 'Ed25519' : { name: 'ECDSA', hash: 'SHA-256' };
  return crypto.subtle.verify(verifyParams, publicKey, signature, data);
}

/** Build the COSE protected header: {1: alg, 4: kid}. */
function buildProtectedHeader(alg, kid) {
  return encodeMap([
    [encodeUint(1), encodeNint(alg)],
    [encodeUint(4), encodeBstr(kid)],
  ]);
}

/** Build the Sig_structure for COSE_Sign1. */
function buildSigStructure(protectedHeader, payload) {
  return encodeArray([
    encodeTstr('Signature1'),
    encodeBstr(protectedHeader),
    encodeBstr(Buffer.alloc(0)), // empty external AAD
    encodeBstr(payload),
  ]);
}

/** Encode a complete COSE_Sign1 structure. */
async function encodeCoseSign1(payload, keys) {
  const alg = algorithmToCoseAlg(keys.algorithm);
  const protectedHeader = buildProtectedHeader(alg, keys.kid);
  const sigStructure = buildSigStructure(protectedHeader, payload);
  const signature = await signData(keys.privateKey, sigStructure, keys.algorithm);

  // COSE_Sign1 = [protected, unprotected, payload, signature]
  const unprotectedHeader = encodeMap([]);
  return encodeArray([
    encodeBstr(protectedHeader),
    unprotectedHeader,
    encodeBstr(payload),
    encodeBstr(signature),
  ]);
}

module.exports = {
  COSE_ALG_ES256,
  COSE_ALG_ED25519,
  algorithmToCoseAlg,
  generateSigningKey,
  signData,
  verifySignature,
  encodeCoseSign1,
  buildProtectedHeader,
  buildSigStructure,
};
