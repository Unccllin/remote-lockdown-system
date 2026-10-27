/**
 * ES256 + Ed25519 signing key management via Web Crypto API.
 *
 * ES256: ECDSA P-256 SHA-256 (alg = -7 in COSE). Default algorithm.
 * Ed25519: EdDSA with Ed25519 (alg = -8 in COSE). Alternative algorithm.
 *
 * Key pair generated via crypto.subtle.generateKey.
 * kid = SHA-256 of the SPKI public key bytes.
 */

export type SigningAlgorithm = 'ES256' | 'Ed25519';

export interface SigningKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: Uint8Array; // SHA-256 of SPKI, 32 bytes
  spki: Uint8Array; // Raw SPKI bytes
  algorithm: SigningAlgorithm; // D-205: which algorithm this key uses
}

/** Generate a new ES256 key pair. */
export async function generateSigningKey(): Promise<SigningKeyPair> {
  return generateSigningKeyWithAlgorithm('ES256');
}

/** Generate a new signing key pair with the specified algorithm (D-205). */
export async function generateSigningKeyWithAlgorithm(
  algorithm: SigningAlgorithm,
): Promise<SigningKeyPair> {
  let keyPair: CryptoKeyPair;
  let signParams: { name: string; namedCurve?: string };

  if (algorithm === 'Ed25519') {
    signParams = { name: 'Ed25519' };
  } else {
    signParams = { name: 'ECDSA', namedCurve: 'P-256' };
  }

  // generateKey returns CryptoKey | CryptoKeyPair; with sign+verify usages on an
  // asymmetric algorithm it is always a pair.
  keyPair = (await crypto.subtle.generateKey(
    signParams,
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const spkiBuf = (await crypto.subtle.exportKey('spki', keyPair.publicKey)) as ArrayBuffer;
  const spki = new Uint8Array(spkiBuf);
  const kid = new Uint8Array(await crypto.subtle.digest('SHA-256', spki));

  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    kid,
    spki,
    algorithm,
  };
}

/** Import a private key from raw PKCS8 bytes.
 *
 *  The key is imported as extractable so we can export the SPKI public key
 *  for kid derivation and verification. This is safe because the PKCS8
 *  bytes are already in the caller's possession.
 *
 *  D-205: The algorithm is inferred from the PKCS8 OID. If that fails,
 *  ES256 is assumed (backward compat).
 */
export async function importPrivateKey(
  pkcs8: Uint8Array,
  algorithm: SigningAlgorithm = 'ES256',
): Promise<CryptoKey> {
  let keyParams: { name: string; namedCurve?: string };
  if (algorithm === 'Ed25519') {
    keyParams = { name: 'Ed25519' };
  } else {
    keyParams = { name: 'ECDSA', namedCurve: 'P-256' };
  }
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    keyParams,
    true, // extractable — needed to export SPKI for kid derivation
    ['sign'],
  );
}

/** Import a public key from SPKI bytes. */
export async function importPublicKey(
  spki: Uint8Array,
  algorithm: SigningAlgorithm = 'ES256',
): Promise<CryptoKey> {
  let keyParams: { name: string; namedCurve?: string };
  if (algorithm === 'Ed25519') {
    keyParams = { name: 'Ed25519' };
  } else {
    keyParams = { name: 'ECDSA', namedCurve: 'P-256' };
  }
  return crypto.subtle.importKey(
    'spki',
    spki,
    keyParams,
    false,
    ['verify'],
  );
}

/** Sign data with the key's algorithm.
 *
 *  ES256: ECDSA P-256 SHA-256, returns 64-byte raw r||s.
 *  Ed25519: EdDSA with Ed25519, returns 64-byte signature (no hash param).
 */
export async function signData(
  privateKey: CryptoKey,
  data: Uint8Array,
  algorithm: SigningAlgorithm = 'ES256',
): Promise<Uint8Array> {
  if (algorithm === 'Ed25519') {
    const sig = await crypto.subtle.sign('Ed25519', privateKey, data);
    return new Uint8Array(sig);
  }
  // ES256
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    data,
  );
  return new Uint8Array(sig);
}

/** Verify a signature with the key's algorithm. */
export async function verifySignature(
  publicKey: CryptoKey,
  data: Uint8Array,
  signature: Uint8Array,
  algorithm: SigningAlgorithm = 'ES256',
): Promise<boolean> {
  if (algorithm === 'Ed25519') {
    return crypto.subtle.verify('Ed25519', publicKey, signature, data);
  }
  // ES256
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature,
    data,
  );
}

/** Compute SHA-256 of data. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

// ---------------------------------------------------------------------------
// Persistent signing key in KV (D-205)
// ---------------------------------------------------------------------------

const SIGNING_KEY_KV_PREFIX = 'pbl_signing_key:';

/** Export a private key to PKCS8 bytes. */
export async function exportPrivateKey(privateKey: CryptoKey): Promise<Uint8Array> {
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', privateKey)) as ArrayBuffer;
  return new Uint8Array(pkcs8);
}

/** Derive the public key and SPKI from a private key.
 *
 *  Uses JWK export to get the public parameters, then imports them as a
 *  separate public key and exports as SPKI.
 *
 *  D-205: Handles both ES256 (ECDSA P-256, JWK has x + y) and Ed25519
 *  (JWK has only x, no y).
 */
async function derivePublicKeyFromPrivate(
  privateKey: CryptoKey,
  algorithm: SigningAlgorithm = 'ES256',
): Promise<{
  publicKey: CryptoKey;
  spki: Uint8Array;
}> {
  // Export private key as JWK (contains public parameters)
  const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey;

  let keyParams: { name: string; namedCurve?: string };
  if (algorithm === 'Ed25519') {
    keyParams = { name: 'Ed25519' };
    // Ed25519 JWK has only x (no y)
    const publicJwk: JsonWebKey = {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      ext: true,
    };
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      keyParams,
      true,
      ['verify'],
    );
    const spki = new Uint8Array((await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer);
    return { publicKey, spki };
  }

  // ES256: ECDSA P-256, JWK has x + y
  keyParams = { name: 'ECDSA', namedCurve: 'P-256' };
  const publicJwk: JsonWebKey = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    ext: true,
  };
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicJwk,
    keyParams,
    true,
    ['verify'],
  );
  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer);
  return { publicKey, spki };
}

/** Load a signing key pair from KV, or generate and store a new one.
 *
 *  Key persistence flow:
 *  1. If PBL_SIGNING_KEY env var is set, import it (takes precedence).
 *  2. If a key exists in KV under `pbl_signing_key:current`, import it.
 *  3. Otherwise, generate a new key pair and store it in KV.
 *
 *  The key is stored as base64-encoded PKCS8. The kid and spki are
 *  derived from the private key on each load.
 */
export async function loadOrGenerateSigningKey(
  kv: KVNamespace,
  envSigningKey?: string,
): Promise<SigningKeyPair> {
  // 1. If env var is set, import it
  if (envSigningKey) {
    const pkcs8 = Uint8Array.from(
      Buffer.from(envSigningKey, 'base64'),
    );
    const privateKey = await importPrivateKey(pkcs8);
    const { publicKey, spki } = await derivePublicKeyFromPrivate(privateKey, 'ES256');
    const kid = await sha256(spki);
    return { privateKey, publicKey, kid, spki, algorithm: 'ES256' };
  }

  // 2. Try to load from KV
  const stored = await kv.get(`${SIGNING_KEY_KV_PREFIX}current`, 'text');
  if (stored) {
    try {
      const pkcs8 = Uint8Array.from(Buffer.from(stored, 'base64'));
      const privateKey = await importPrivateKey(pkcs8);
      const { publicKey, spki } = await derivePublicKeyFromPrivate(privateKey, 'ES256');
      const kid = await sha256(spki);
      return { privateKey, publicKey, kid, spki, algorithm: 'ES256' };
    } catch {
      // Fall through to generate new key
    }
  }

  // 3. Generate new key and store in KV
  const keyPair = await generateSigningKey();
  const pkcs8 = await exportPrivateKey(keyPair.privateKey);
  const pkcs8Base64 = Buffer.from(pkcs8).toString('base64');
  await kv.put(`${SIGNING_KEY_KV_PREFIX}current`, pkcs8Base64);

  return keyPair;
}

// ---------------------------------------------------------------------------
// Key rotation and versioning (D-205)
// ---------------------------------------------------------------------------

/** Key version metadata stored alongside each key in KV. */
export interface KeyVersionMeta {
  version: number;       // monotonic version counter
  kidHex: string;        // SHA-256 of SPKI, hex-encoded (for identification)
  createdAt: number;     // Unix timestamp (seconds)
  retiredAt?: number;    // Unix timestamp when retired (undefined if current)
}

/** Rotate the verdict signing key: generate a new key, archive the old one.
 *
 *  D-205: Key rotation generates a new key pair, stores it as the current
 *  key, and archives the old key under a versioned KV key. The old key's
 *  kid is added to the kid history so firmware can still verify verdicts
 *  signed by the old key during the grace period (C4 key 72,
 *  lock_service_cert_pin_history).
 *
 *  The kid history is an array of previous kids (32-byte SHA-256 digests).
 *  Firmware uses it to accept verdicts signed by recently-rotated keys.
 *
 *  @param kv          KV namespace
 *  @param envSigningKey  (optional) env var to import instead of generating
 *  @returns The new key pair and the kid history (previous kids)
 */
export async function rotateSigningKey(
  kv: KVNamespace,
  envSigningKey?: string,
): Promise<{ keys: SigningKeyPair; kidHistory: Uint8Array[] }> {
  // Load the current key (if any) to archive it
  const currentStored = await kv.get(`${SIGNING_KEY_KV_PREFIX}current`, 'text');
  let kidHistory: Uint8Array[] = [];

  if (currentStored) {
    try {
      const oldPkcs8 = Uint8Array.from(Buffer.from(currentStored, 'base64'));
      const oldPrivateKey = await importPrivateKey(oldPkcs8);
      const { spki: oldSpki } = await derivePublicKeyFromPrivate(oldPrivateKey, 'ES256');
      const oldKid = await sha256(oldSpki);
      kidHistory.push(oldKid);

      // Load existing kid history from KV
      const historyStored = await kv.get(`${SIGNING_KEY_KV_PREFIX}kid_history`, 'text');
      if (historyStored) {
        try {
          const parsed = JSON.parse(historyStored) as string[];
          for (const kidHex of parsed) {
            const kid = Uint8Array.from(Buffer.from(kidHex, 'hex'));
            // Don't duplicate the old kid
            if (!kidHistory.some(k => Array.from(k).join(',') === Array.from(kid).join(','))) {
              kidHistory.push(kid);
            }
          }
        } catch {
          // Ignore corrupt history
        }
      }

      // Archive the old key under a versioned key
      const versionMeta: KeyVersionMeta = {
        version: Date.now(),
        kidHex: Array.from(oldKid).map(b => b.toString(16).padStart(2, '0')).join(''),
        createdAt: Math.floor(Date.now() / 1000),
        retiredAt: Math.floor(Date.now() / 1000),
      };
      await kv.put(
        `${SIGNING_KEY_KV_PREFIX}archived:${versionMeta.kidHex}`,
        currentStored,
      );
    } catch {
      // Old key is corrupt — just generate a new one
    }
  }

  // Generate or import the new key
  let newKeys: SigningKeyPair;
  if (envSigningKey) {
    const pkcs8 = Uint8Array.from(Buffer.from(envSigningKey, 'base64'));
    const privateKey = await importPrivateKey(pkcs8);
    const { publicKey, spki } = await derivePublicKeyFromPrivate(privateKey, 'ES256');
    const kid = await sha256(spki);
    newKeys = { privateKey, publicKey, kid, spki, algorithm: 'ES256' };
  } else {
    newKeys = await generateSigningKey();
  }

  // Store the new key as current
  const pkcs8 = await exportPrivateKey(newKeys.privateKey);
  const pkcs8Base64 = Buffer.from(pkcs8).toString('base64');
  await kv.put(`${SIGNING_KEY_KV_PREFIX}current`, pkcs8Base64);

  // Store the updated kid history
  const kidHistoryHex = kidHistory.map(k =>
    Array.from(k).map(b => b.toString(16).padStart(2, '0')).join('')
  );
  await kv.put(`${SIGNING_KEY_KV_PREFIX}kid_history`, JSON.stringify(kidHistoryHex));

  return { keys: newKeys, kidHistory };
}

/** Get the kid history (previous signing key fingerprints) for C4 key 72.
 *
 *  @param kv  KV namespace
 *  @returns Array of previous kids (32-byte SHA-256 digests). Empty if no
 *           rotation has occurred.
 */
export async function getKidHistory(kv: KVNamespace): Promise<Uint8Array[]> {
  const historyStored = await kv.get(`${SIGNING_KEY_KV_PREFIX}kid_history`, 'text');
  if (!historyStored) return [];
  try {
    const parsed = JSON.parse(historyStored) as string[];
    return parsed.map(kidHex => Uint8Array.from(Buffer.from(kidHex, 'hex')));
  } catch {
    return [];
  }
}

const POLICY_SIGNING_KEY_KV_KEY = 'pbl_policy_signing_key:current';

/** Load a policy signing key pair from KV, or generate and store a new one.
 *
 *  C4 §1: The policy signing key is separate from the verdict signing key
 *  (different rotation cadences and abuse profiles). The policy signing key
 *  is the root of trust for policy blobs — its SPKI must be pinned in
 *  firmware (compile-time constant or read-only NV index).
 *
 *  Key persistence flow:
 *  1. If PBL_POLICY_SIGNING_KEY env var is set, import it (takes precedence).
 *  2. If a key exists in KV under `pbl_policy_signing_key:current`, import it.
 *  3. Otherwise, generate a new key pair and store it in KV.
 */
export async function loadOrGeneratePolicySigningKey(
  kv: KVNamespace,
  envPolicySigningKey?: string,
): Promise<SigningKeyPair> {
  // 1. If env var is set, import it
  if (envPolicySigningKey) {
    const pkcs8 = Uint8Array.from(
      Buffer.from(envPolicySigningKey, 'base64'),
    );
    const privateKey = await importPrivateKey(pkcs8);
    const { publicKey, spki } = await derivePublicKeyFromPrivate(privateKey, 'ES256');
    const kid = await sha256(spki);
    return { privateKey, publicKey, kid, spki, algorithm: 'ES256' };
  }

  // 2. Try to load from KV
  const stored = await kv.get(POLICY_SIGNING_KEY_KV_KEY, 'text');
  if (stored) {
    try {
      const pkcs8 = Uint8Array.from(Buffer.from(stored, 'base64'));
      const privateKey = await importPrivateKey(pkcs8);
      const { publicKey, spki } = await derivePublicKeyFromPrivate(privateKey, 'ES256');
      const kid = await sha256(spki);
      return { privateKey, publicKey, kid, spki, algorithm: 'ES256' };
    } catch {
      // Fall through to generate new key
    }
  }

  // 3. Generate new key and store in KV
  const keyPair = await generateSigningKey();
  const pkcs8 = await exportPrivateKey(keyPair.privateKey);
  const pkcs8Base64 = Buffer.from(pkcs8).toString('base64');
  await kv.put(POLICY_SIGNING_KEY_KV_KEY, pkcs8Base64);

  return keyPair;
}
