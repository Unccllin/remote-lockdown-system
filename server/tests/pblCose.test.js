/**
 * D-208: COSE_Sign1 encoding/verification tests for Express server-side.
 *
 * Tests the COSE_Sign1 encoder, signature verification, algorithm support
 * (ES256 + Ed25519), protected header parsing, and Sig_structure construction.
 * The serverless module has 8 COSE tests in pbl.test.ts; this file provides
 * equivalent coverage for the Express server-side module.
 */

const cose = require('../src/pbl/cose');
const cbor = require('../src/pbl/cbor');

describe('D-208: COSE algorithm constants', () => {
  it('ES256 algorithm ID is -7', () => {
    expect(cose.COSE_ALG_ES256).toBe(-7);
  });

  it('Ed25519 algorithm ID is -8', () => {
    expect(cose.COSE_ALG_ED25519).toBe(-8);
  });

  it('algorithmToCoseAlg maps ES256 to -7', () => {
    expect(cose.algorithmToCoseAlg('ES256')).toBe(-7);
  });

  it('algorithmToCoseAlg maps Ed25519 to -8', () => {
    expect(cose.algorithmToCoseAlg('Ed25519')).toBe(-8);
  });

  it('algorithmToCoseAlg defaults to ES256 for unknown algorithm', () => {
    expect(cose.algorithmToCoseAlg('unknown')).toBe(-7);
  });
});

describe('D-208: ES256 key generation + signing', () => {
  it('generates an ES256 key pair with all required fields', async () => {
    const keys = await cose.generateSigningKey('ES256');
    expect(keys.publicKey).toBeDefined();
    expect(keys.privateKey).toBeDefined();
    expect(keys.spki).toBeInstanceOf(Buffer);
    expect(keys.spki.length).toBeGreaterThan(0);
    expect(keys.pkcs8).toBeInstanceOf(Buffer);
    expect(keys.pkcs8.length).toBeGreaterThan(0);
    expect(keys.kid).toBeInstanceOf(Buffer);
    expect(keys.kid.length).toBe(32); // SHA-256 of SPKI
    expect(keys.algorithm).toBe('ES256');
  });

  it('signs and verifies data with ES256', async () => {
    const keys = await cose.generateSigningKey('ES256');
    const data = Buffer.from('test data to sign');
    const signature = await cose.signData(keys.privateKey, data, 'ES256');
    expect(signature).toBeInstanceOf(Buffer);
    expect(signature.length).toBe(64); // ECDSA P-256 signature = 64 bytes

    const valid = await cose.verifySignature(keys.publicKey, data, signature, 'ES256');
    expect(valid).toBe(true);
  });

  it('rejects tampered data with ES256', async () => {
    const keys = await cose.generateSigningKey('ES256');
    const data = Buffer.from('original data');
    const signature = await cose.signData(keys.privateKey, data, 'ES256');

    const tampered = Buffer.from('tampered data');
    const valid = await cose.verifySignature(keys.publicKey, tampered, signature, 'ES256');
    expect(valid).toBe(false);
  });

  it('rejects signature from wrong key with ES256', async () => {
    const keys1 = await cose.generateSigningKey('ES256');
    const keys2 = await cose.generateSigningKey('ES256');
    const data = Buffer.from('test data');
    const signature = await cose.signData(keys1.privateKey, data, 'ES256');

    const valid = await cose.verifySignature(keys2.publicKey, data, signature, 'ES256');
    expect(valid).toBe(false);
  });
});

describe('D-208: Ed25519 key generation + signing', () => {
  it('generates an Ed25519 key pair with all required fields', async () => {
    const keys = await cose.generateSigningKey('Ed25519');
    expect(keys.publicKey).toBeDefined();
    expect(keys.privateKey).toBeDefined();
    expect(keys.spki).toBeInstanceOf(Buffer);
    expect(keys.spki.length).toBeGreaterThan(0);
    expect(keys.pkcs8).toBeInstanceOf(Buffer);
    expect(keys.pkcs8.length).toBeGreaterThan(0);
    expect(keys.kid).toBeInstanceOf(Buffer);
    expect(keys.kid.length).toBe(32); // SHA-256 of SPKI
    expect(keys.algorithm).toBe('Ed25519');
  });

  it('signs and verifies data with Ed25519', async () => {
    const keys = await cose.generateSigningKey('Ed25519');
    const data = Buffer.from('test data to sign');
    const signature = await cose.signData(keys.privateKey, data, 'Ed25519');
    expect(signature).toBeInstanceOf(Buffer);
    expect(signature.length).toBe(64); // Ed25519 signature = 64 bytes

    const valid = await cose.verifySignature(keys.publicKey, data, signature, 'Ed25519');
    expect(valid).toBe(true);
  });

  it('rejects tampered data with Ed25519', async () => {
    const keys = await cose.generateSigningKey('Ed25519');
    const data = Buffer.from('original data');
    const signature = await cose.signData(keys.privateKey, data, 'Ed25519');

    const tampered = Buffer.from('tampered data');
    const valid = await cose.verifySignature(keys.publicKey, tampered, signature, 'Ed25519');
    expect(valid).toBe(false);
  });

  it('rejects signature from wrong key with Ed25519', async () => {
    const keys1 = await cose.generateSigningKey('Ed25519');
    const keys2 = await cose.generateSigningKey('Ed25519');
    const data = Buffer.from('test data');
    const signature = await cose.signData(keys1.privateKey, data, 'Ed25519');

    const valid = await cose.verifySignature(keys2.publicKey, data, signature, 'Ed25519');
    expect(valid).toBe(false);
  });
});

describe('D-208: COSE_Sign1 encoding', () => {
  it('encodes a COSE_Sign1 with ES256', async () => {
    const keys = await cose.generateSigningKey('ES256');
    const payload = Buffer.from('verdict payload');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    expect(coseBlob).toBeInstanceOf(Buffer);
    expect(coseBlob.length).toBeGreaterThan(0);

    // COSE_Sign1 = [protected, unprotected, payload, signature]
    const decoded = cbor.decodeFirst(coseBlob);
    expect(decoded).toBeInstanceOf(Array);
    expect(decoded).toHaveLength(4);
  });

  it('encodes a COSE_Sign1 with Ed25519', async () => {
    const keys = await cose.generateSigningKey('Ed25519');
    const payload = Buffer.from('verdict payload');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    expect(coseBlob).toBeInstanceOf(Buffer);
    expect(coseBlob.length).toBeGreaterThan(0);

    const decoded = cbor.decodeFirst(coseBlob);
    expect(decoded).toBeInstanceOf(Array);
    expect(decoded).toHaveLength(4);
  });

  it('protected header contains alg=-7 for ES256', async () => {
    const keys = await cose.generateSigningKey('ES256');
    const payload = Buffer.from('test');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    const decoded = cbor.decodeFirst(coseBlob);
    const protectedHeader = cbor.decodeFirst(decoded[0]);
    expect(protectedHeader.get(1)).toBe(-7); // COSE_ALG_ES256
  });

  it('protected header contains alg=-8 for Ed25519', async () => {
    const keys = await cose.generateSigningKey('Ed25519');
    const payload = Buffer.from('test');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    const decoded = cbor.decodeFirst(coseBlob);
    const protectedHeader = cbor.decodeFirst(decoded[0]);
    expect(protectedHeader.get(1)).toBe(-8); // COSE_ALG_ED25519
  });

  it('protected header contains kid (key ID)', async () => {
    const keys = await cose.generateSigningKey('ES256');
    const payload = Buffer.from('test');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    const decoded = cbor.decodeFirst(coseBlob);
    const protectedHeader = cbor.decodeFirst(decoded[0]);
    const kid = protectedHeader.get(4);
    expect(kid).toBeInstanceOf(Buffer);
    expect(kid).toEqual(keys.kid);
  });

  it('unprotected header is empty map', async () => {
    const keys = await cose.generateSigningKey('ES256');
    const payload = Buffer.from('test');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    const decoded = cbor.decodeFirst(coseBlob);
    const unprotectedHeader = decoded[1];
    expect(unprotectedHeader).toBeInstanceOf(Map);
    expect(unprotectedHeader.size).toBe(0);
  });

  it('payload matches input', async () => {
    const keys = await cose.generateSigningKey('ES256');
    const payload = Buffer.from('the verdict payload');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    const decoded = cbor.decodeFirst(coseBlob);
    expect(decoded[2]).toEqual(payload);
  });

  it('signature is non-empty and 64 bytes', async () => {
    const keys = await cose.generateSigningKey('ES256');
    const payload = Buffer.from('test');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    const decoded = cbor.decodeFirst(coseBlob);
    const signature = decoded[3];
    expect(signature).toBeInstanceOf(Buffer);
    expect(signature.length).toBe(64);
  });
});

describe('D-208: COSE_Sign1 verification (round-trip)', () => {
  it('verifies a valid ES256 COSE_Sign1', async () => {
    const keys = await cose.generateSigningKey('ES256');
    const payload = Buffer.from('verdict payload');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    // Decode the COSE_Sign1
    const decoded = cbor.decodeFirst(coseBlob);
    const protectedHeader = decoded[0];
    const signature = decoded[3];

    // Reconstruct Sig_structure
    const sigStructure = cose.buildSigStructure(protectedHeader, payload);
    const valid = await cose.verifySignature(keys.publicKey, sigStructure, signature, 'ES256');
    expect(valid).toBe(true);
  });

  it('verifies a valid Ed25519 COSE_Sign1', async () => {
    const keys = await cose.generateSigningKey('Ed25519');
    const payload = Buffer.from('verdict payload');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    const decoded = cbor.decodeFirst(coseBlob);
    const protectedHeader = decoded[0];
    const signature = decoded[3];

    const sigStructure = cose.buildSigStructure(protectedHeader, payload);
    const valid = await cose.verifySignature(keys.publicKey, sigStructure, signature, 'Ed25519');
    expect(valid).toBe(true);
  });

  it('rejects tampered payload in COSE_Sign1', async () => {
    const keys = await cose.generateSigningKey('ES256');
    const payload = Buffer.from('original payload');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    const decoded = cbor.decodeFirst(coseBlob);
    const protectedHeader = decoded[0];
    const signature = decoded[3];

    // Tamper with payload
    const tamperedPayload = Buffer.from('tampered payload');
    const sigStructure = cose.buildSigStructure(protectedHeader, tamperedPayload);
    const valid = await cose.verifySignature(keys.publicKey, sigStructure, signature, 'ES256');
    expect(valid).toBe(false);
  });

  it('rejects signature verified with wrong algorithm', async () => {
    const keys = await cose.generateSigningKey('ES256');
    const payload = Buffer.from('test');
    const coseBlob = await cose.encodeCoseSign1(payload, keys);

    const decoded = cbor.decodeFirst(coseBlob);
    const protectedHeader = decoded[0];
    const signature = decoded[3];

    // Try to verify ES256 signature with Ed25519
    const sigStructure = cose.buildSigStructure(protectedHeader, payload);
    await expect(
      cose.verifySignature(keys.publicKey, sigStructure, signature, 'Ed25519'),
    ).rejects.toThrow();
  });
});

describe('D-208: buildProtectedHeader', () => {
  it('builds a protected header with alg and kid', () => {
    const kid = Buffer.from('test-key-id-32-bytes-long-123456'.padEnd(32, '0'));
    const header = cose.buildProtectedHeader(-7, kid);
    const decoded = cbor.decodeFirst(header);
    expect(decoded.get(1)).toBe(-7);
    expect(decoded.get(4)).toEqual(kid);
  });

  it('builds a protected header with Ed25519 alg', () => {
    const kid = Buffer.alloc(32, 0xab);
    const header = cose.buildProtectedHeader(-8, kid);
    const decoded = cbor.decodeFirst(header);
    expect(decoded.get(1)).toBe(-8);
    expect(decoded.get(4)).toEqual(kid);
  });
});

describe('D-208: buildSigStructure', () => {
  it('builds a valid Sig_structure (4-element array)', () => {
    const protectedHeader = Buffer.from([0xa2, 0x01, 0x26, 0x04, 0x58, 0x20]);
    const payload = Buffer.from('test payload');
    const sigStructure = cose.buildSigStructure(protectedHeader, payload);

    const decoded = cbor.decodeFirst(sigStructure);
    expect(decoded).toBeInstanceOf(Array);
    expect(decoded).toHaveLength(4);
    expect(decoded[0]).toBe('Signature1');
    expect(decoded[1]).toEqual(protectedHeader);
    expect(decoded[2]).toEqual(Buffer.alloc(0)); // empty external AAD
    expect(decoded[3]).toEqual(payload);
  });
});
