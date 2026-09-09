/**
 * Tests for PBL server-side CBOR + COSE + signing + verdict endpoint.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  encodeUint,
  encodeBstr,
  encodeTstr,
  encodeMap,
  encodeArray,
  encodeBool,
  encodeNull,
  encodeUndefined,
  encodeNegativeInt,
  encodeTag,
  CborDecoder,
  decodeVerdictRequest,
} from './pbl/cbor';
import {
  generateSigningKey,
  generateSigningKeyWithAlgorithm,
  signData,
  verifySignature,
  sha256,
  importPrivateKey,
  importPublicKey,
  rotateSigningKey,
  getKidHistory,
} from './pbl/signing';
import {
  encodeCoseSign1,
  extractCosePayload,
  extractCoseSignature,
  extractCoseProtectedHeader,
  reconstructSigStructure,
  extractCoseAlgorithm,
  extractCoseKid,
  verifyCoseSign1,
  COSE_ALG_ES256,
} from './pbl/cose';
import { handleVerdict } from './pbl/routes/verdict';
import { handlePolicy } from './pbl/routes/policy';
import { buildFullPolicyPayload } from './pbl/routes/policy';
import { handleEnrollPbl } from './pbl/routes/enroll';
import { handleAttest } from './pbl/routes/attest';
import { handleOverrideChallenge, handleOverrideResponse } from './pbl/routes/override';
import { putDevice, getDevice, setDeviceStatus, listDevices, deleteDevice, type PblDevice } from './pbl/devices';
import * as fs from 'fs';
import * as path from 'path';
import {
  loadOrGenerateSigningKey,
  exportPrivateKey,
} from './pbl/signing';
import {
  splitDerCerts,
  loadCertChain,
  storeCertChain,
} from './pbl/certs';
import { checkDeviceRateLimit, checkIpRateLimit, rateLimitResponse, DEVICE_RATE_LIMITS, IP_RATE_LIMITS } from './pbl/rateLimit';

// ---------------------------------------------------------------------------
// Mock KV namespace
// ---------------------------------------------------------------------------

class MockKV {
  private store = new Map<string, string>();

  async get(key: string, type?: 'json' | 'text'): Promise<string | null> {
    const val = this.store.get(key);
    if (val === undefined) return null;
    if (type === 'json') {
      return JSON.parse(val);
    }
    return val;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? '';
    const keys: { name: string }[] = [];
    for (const key of this.store.keys()) {
      if (!prefix || key.startsWith(prefix)) {
        keys.push({ name: key });
      }
    }
    return { keys, list_complete: true };
  }
}

// ---------------------------------------------------------------------------
// CBOR tests
// ---------------------------------------------------------------------------

describe('CBOR encoder/decoder', () => {
  it('encodes and decodes unsigned integers', () => {
    for (const value of [0, 1, 23, 24, 100, 255, 256, 1000, 65535, 100000]) {
      const encoded = encodeUint(value);
      const dec = new CborDecoder(encoded);
      expect(dec.readUint()).toBe(value);
    }
  });

  it('encodes and decodes byte strings', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const encoded = encodeBstr(data);
    const dec = new CborDecoder(encoded);
    const result = dec.readBstr();
    expect(Array.from(result)).toEqual(Array.from(data));
  });

  it('encodes and decodes text strings', () => {
    const str = 'Hello, PBL!';
    const encoded = encodeTstr(str);
    const dec = new CborDecoder(encoded);
    expect(dec.readTstr()).toBe(str);
  });

  it('encodes and decodes booleans', () => {
    const encTrue = encodeBool(true);
    const encFalse = encodeBool(false);
    expect(new CborDecoder(encTrue).readBool()).toBe(true);
    expect(new CborDecoder(encFalse).readBool()).toBe(false);
  });

  it('encodes and decodes maps with integer keys', () => {
    const map = encodeMap([
      [encodeUint(1), encodeUint(42)],
      [encodeUint(2), encodeTstr('hello')],
      [encodeUint(3), encodeBstr(new Uint8Array([0xab, 0xcd]))],
    ]);
    const dec = new CborDecoder(map);
    const result = dec.readIntKeyedMap();
    expect(result.size).toBe(3);
    expect(new CborDecoder(result.get(1)!).readUint()).toBe(42);
    expect(new CborDecoder(result.get(2)!).readTstr()).toBe('hello');
  });

  it('encodes and decodes arrays', () => {
    const arr = encodeArray([
      encodeUint(1),
      encodeUint(2),
      encodeTstr('three'),
    ]);
    const dec = new CborDecoder(arr);
    const result = dec.readArray();
    expect(result.length).toBe(3);
    expect(new CborDecoder(result[0]).readUint()).toBe(1);
    expect(new CborDecoder(result[2]).readTstr()).toBe('three');
  });

  it('decodes a verdict request', () => {
    const deviceId = new Uint8Array(32).fill(0xaa);
    const nonce = new Uint8Array(32).fill(0xbb);
    const digest = new Uint8Array(32).fill(0xcc);
    const policyVersion = 7;

    const req = encodeMap([
      [encodeUint(1), encodeBstr(deviceId)],
      [encodeUint(2), encodeBstr(nonce)],
      [encodeUint(3), encodeBstr(digest)],
      [encodeUint(4), encodeUint(policyVersion)],
    ]);

    const decoded = decodeVerdictRequest(req);
    expect(Array.from(decoded.device_id)).toEqual(Array.from(deviceId));
    expect(Array.from(decoded.nonce)).toEqual(Array.from(nonce));
    expect(Array.from(decoded.platform_state_digest)).toEqual(Array.from(digest));
    expect(decoded.policy_version).toBe(policyVersion);
  });
});

// ---------------------------------------------------------------------------
// D-115: RFC 8949 Appendix A test vectors
// Tests the server-side CBOR encoder/decoder against the canonical
// test vectors from RFC 8949 (Appendix A). Only vectors for major types
// we support (0, 2, 3, 4, 5, 7) are included — no negative ints, tags,
// or floats.
// ---------------------------------------------------------------------------

describe('D-115: RFC 8949 Appendix A test vectors', () => {
  // Helper: hex string → Uint8Array
  function hex(s: string): Uint8Array {
    return Uint8Array.from(Buffer.from(s, 'hex'));
  }

  // Helper: Uint8Array → hex string
  function toHex(buf: Uint8Array): string {
    return Buffer.from(buf).toString('hex');
  }

  describe('unsigned integers (major type 0)', () => {
    const vectors: [string, number][] = [
      ['00', 0],
      ['01', 1],
      ['0a', 10],
      ['17', 23],
      ['1818', 24],
      ['1819', 25],
      ['1864', 100],
      ['1903e8', 1000],
      ['1a000f4240', 1000000],
    ];

    for (const [hexStr, value] of vectors) {
      it(`encodes ${value} as 0x${hexStr}`, () => {
        const encoded = encodeUint(value);
        expect(toHex(encoded)).toBe(hexStr);
      });

      it(`decodes 0x${hexStr} as ${value}`, () => {
        const dec = new CborDecoder(hex(hexStr));
        expect(dec.readUint()).toBe(value);
      });
    }
  });

  describe('byte strings (major type 2)', () => {
    it('encodes empty bstr as 0x40', () => {
      expect(toHex(encodeBstr(new Uint8Array()))).toBe('40');
    });

    it('decodes 0x40 as empty bstr', () => {
      const dec = new CborDecoder(hex('40'));
      expect(dec.readBstr().length).toBe(0);
    });

    it('encodes h\'01020304\' as 0x4401020304', () => {
      expect(toHex(encodeBstr(hex('01020304')))).toBe('4401020304');
    });

    it('decodes 0x4401020304 as h\'01020304\'', () => {
      const dec = new CborDecoder(hex('4401020304'));
      expect(toHex(dec.readBstr())).toBe('01020304');
    });

    it('encodes single byte h\'01\' as 0x4101', () => {
      expect(toHex(encodeBstr(hex('01')))).toBe('4101');
    });

    it('decodes 0x4101 as h\'01\'', () => {
      const dec = new CborDecoder(hex('4101'));
      expect(toHex(dec.readBstr())).toBe('01');
    });
  });

  describe('text strings (major type 3)', () => {
    it('encodes empty tstr as 0x60', () => {
      expect(toHex(encodeTstr(''))).toBe('60');
    });

    it('decodes 0x60 as empty tstr', () => {
      const dec = new CborDecoder(hex('60'));
      expect(dec.readTstr()).toBe('');
    });

    it('encodes "a" as 0x6161', () => {
      expect(toHex(encodeTstr('a'))).toBe('6161');
    });

    it('decodes 0x6161 as "a"', () => {
      const dec = new CborDecoder(hex('6161'));
      expect(dec.readTstr()).toBe('a');
    });

    it('encodes "hello" as 0x6568656c6c6f', () => {
      expect(toHex(encodeTstr('hello'))).toBe('6568656c6c6f');
    });

    it('decodes 0x6568656c6c6f as "hello"', () => {
      const dec = new CborDecoder(hex('6568656c6c6f'));
      expect(dec.readTstr()).toBe('hello');
    });

    it('round-trips UTF-8 text', () => {
      const text = 'PBL \u00a9 lockdown \u2713';
      const encoded = encodeTstr(text);
      const dec = new CborDecoder(encoded);
      expect(dec.readTstr()).toBe(text);
    });
  });

  describe('arrays (major type 4)', () => {
    it('encodes empty array as 0x80', () => {
      expect(toHex(encodeArray([]))).toBe('80');
    });

    it('decodes 0x80 as empty array', () => {
      const dec = new CborDecoder(hex('80'));
      const arr = dec.readArray();
      expect(arr.length).toBe(0);
    });

    it('encodes [1, 2] as 0x820102', () => {
      const arr = encodeArray([encodeUint(1), encodeUint(2)]);
      expect(toHex(arr)).toBe('820102');
    });

    it('decodes 0x820102 as [1, 2]', () => {
      const dec = new CborDecoder(hex('820102'));
      const arr = dec.readArray();
      expect(arr.length).toBe(2);
      expect(new CborDecoder(arr[0]).readUint()).toBe(1);
      expect(new CborDecoder(arr[1]).readUint()).toBe(2);
    });

    it('encodes [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25] correctly', () => {
      const items: Uint8Array[] = [];
      for (let i = 1; i <= 25; i++) items.push(encodeUint(i));
      const encoded = encodeArray(items);
      // 0x98 0x19 = array of 25 items (25 > 24, so 1-byte length)
      expect(encoded[0]).toBe(0x98);
      expect(encoded[1]).toBe(0x19);
    });
  });

  describe('maps (major type 5)', () => {
    it('encodes empty map as 0xa0', () => {
      expect(toHex(encodeMap([]))).toBe('a0');
    });

    it('decodes 0xa0 as empty map', () => {
      const dec = new CborDecoder(hex('a0'));
      const map = dec.readIntKeyedMap();
      expect(map.size).toBe(0);
    });

    it('encodes {1: 2, 3: 4} as 0xa201020304', () => {
      const m = encodeMap([
        [encodeUint(1), encodeUint(2)],
        [encodeUint(3), encodeUint(4)],
      ]);
      expect(toHex(m)).toBe('a201020304');
    });

    it('decodes 0xa201020304 as {1: 2, 3: 4}', () => {
      const dec = new CborDecoder(hex('a201020304'));
      const map = dec.readIntKeyedMap();
      expect(map.size).toBe(2);
      expect(new CborDecoder(map.get(1)!).readUint()).toBe(2);
      expect(new CborDecoder(map.get(3)!).readUint()).toBe(4);
    });

    it('encodes string-keyed map {"a": 1, "b": 2}', () => {
      const m = encodeMap([
        [encodeTstr('a'), encodeUint(1)],
        [encodeTstr('b'), encodeUint(2)],
      ]);
      // 0xa2 = map with 2 entries
      expect(m[0]).toBe(0xa2);
      const dec = new CborDecoder(m);
      const map = dec.readStringKeyedMap();
      expect(map.size).toBe(2);
      expect(new CborDecoder(map.get('a')!).readUint()).toBe(1);
      expect(new CborDecoder(map.get('b')!).readUint()).toBe(2);
    });
  });

  describe('simple values (major type 7)', () => {
    it('encodes false as 0xf4', () => {
      expect(toHex(encodeBool(false))).toBe('f4');
    });

    it('decodes 0xf4 as false', () => {
      const dec = new CborDecoder(hex('f4'));
      expect(dec.readBool()).toBe(false);
    });

    it('encodes true as 0xf5', () => {
      expect(toHex(encodeBool(true))).toBe('f5');
    });

    it('decodes 0xf5 as true', () => {
      const dec = new CborDecoder(hex('f5'));
      expect(dec.readBool()).toBe(true);
    });

    it('encodes null as 0xf6', () => {
      expect(toHex(encodeNull())).toBe('f6');
    });

    it('decodes 0xf6 as null', () => {
      const dec = new CborDecoder(hex('f6'));
      expect(dec.readNull()).toBe(null);
    });

    it('encodes undefined as 0xf7', () => {
      expect(toHex(encodeUndefined())).toBe('f7');
    });

    it('decodes 0xf7 as undefined', () => {
      const dec = new CborDecoder(hex('f7'));
      expect(dec.readUndefined()).toBe(undefined);
    });
  });

  describe('negative integers (major type 1)', () => {
    const vectors: [string, number][] = [
      ['20', -1],
      ['29', -10],
      ['3863', -100],
      ['3903e7', -1000],
    ];

    for (const [hexStr, value] of vectors) {
      it(`encodes ${value} as 0x${hexStr}`, () => {
        expect(toHex(encodeNegativeInt(value))).toBe(hexStr);
      });

      it(`decodes 0x${hexStr} as ${value}`, () => {
        const dec = new CborDecoder(hex(hexStr));
        expect(dec.readNegativeInt()).toBe(value);
      });
    }
  });

  describe('tags (major type 6)', () => {
    it('encodes tag 0("2026-01-01T00:00:00Z") correctly', () => {
      const content = encodeTstr('2026-01-01T00:00:00Z');
      const tagged = encodeTag(0, content);
      // 0xc0 = tag 0, then tstr
      expect(tagged[0]).toBe(0xc0);
      const dec = new CborDecoder(tagged);
      const [tag, tagContent] = dec.readTag();
      expect(tag).toBe(0);
      expect(new CborDecoder(tagContent).readTstr()).toBe('2026-01-01T00:00:00Z');
    });

    it('encodes tag 1(1735689600) correctly (epoch time)', () => {
      const content = encodeUint(1735689600);
      const tagged = encodeTag(1, content);
      // 0xc1 = tag 1, then uint
      expect(tagged[0]).toBe(0xc1);
      const dec = new CborDecoder(tagged);
      const [tag, tagContent] = dec.readTag();
      expect(tag).toBe(1);
      expect(new CborDecoder(tagContent).readUint()).toBe(1735689600);
    });

    it('encodes tag 24(h\'...\') (embedded CBOR)', () => {
      const innerCbor = encodeUint(42);
      const tagged = encodeTag(24, encodeBstr(innerCbor));
      const dec = new CborDecoder(tagged);
      const [tag, tagContent] = dec.readTag();
      expect(tag).toBe(24);
      const innerBstr = new CborDecoder(tagContent).readBstr();
      expect(new CborDecoder(innerBstr).readUint()).toBe(42);
    });

    it('skipItem handles tagged values', () => {
      const tagged = encodeTag(0, encodeTstr('test'));
      const dec = new CborDecoder(tagged);
      dec.skipItem();
      expect(dec.remaining).toBe(0);
    });
  });

  describe('round-trip: complex nested structure', () => {
    it('round-trips a map with nested array and bstr values', () => {
      // Build: {1: [h'aa', h'bb'], 2: "test", 3: true}
      const encoded = encodeMap([
        [encodeUint(1), encodeArray([encodeBstr(hex('aa')), encodeBstr(hex('bb'))])],
        [encodeUint(2), encodeTstr('test')],
        [encodeUint(3), encodeBool(true)],
      ]);

      const dec = new CborDecoder(encoded);
      const map = dec.readIntKeyedMap();
      expect(map.size).toBe(3);

      // Key 1: array of 2 bstrs
      const arr = new CborDecoder(map.get(1)!).readArray();
      expect(arr.length).toBe(2);
      expect(toHex(new CborDecoder(arr[0]).readBstr())).toBe('aa');
      expect(toHex(new CborDecoder(arr[1]).readBstr())).toBe('bb');

      // Key 2: text string
      expect(new CborDecoder(map.get(2)!).readTstr()).toBe('test');

      // Key 3: boolean
      expect(new CborDecoder(map.get(3)!).readBool()).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws on truncated uint (1-byte length missing)', () => {
      expect(() => new CborDecoder(hex('18')).readUint()).toThrow();
    });

    it('throws on truncated bstr (length exceeds buffer)', () => {
      expect(() => new CborDecoder(hex('44')).readBstr()).toThrow();
    });

    it('throws when reading bstr but got uint', () => {
      expect(() => new CborDecoder(hex('01')).readBstr()).toThrow();
    });

    it('throws when reading uint but got bstr', () => {
      expect(() => new CborDecoder(hex('40')).readUint()).toThrow();
    });

    it('throws on unsupported info 27 (8-byte length)', () => {
      // 0x1b = uint with 8-byte length — our decoder only supports up to 4-byte
      expect(() => new CborDecoder(hex('1b0000000000000000')).readUint()).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Signing tests
// ---------------------------------------------------------------------------

describe('ES256 signing', () => {
  it('generates a key pair', async () => {
    const keys = await generateSigningKey();
    expect(keys.kid.length).toBe(32);
    expect(keys.spki.length).toBe(91); // P-256 SPKI is 91 bytes
  });

  it('signs and verifies data', async () => {
    const keys = await generateSigningKey();
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const sig = await signData(keys.privateKey, data);
    expect(sig.length).toBe(64); // ECDSA P-256 signature is 64 bytes
    const valid = await verifySignature(keys.publicKey, data, sig);
    expect(valid).toBe(true);
  });

  it('rejects wrong signature', async () => {
    const keys = await generateSigningKey();
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const wrongSig = new Uint8Array(64).fill(0);
    const valid = await verifySignature(keys.publicKey, data, wrongSig);
    expect(valid).toBe(false);
  });

  it('computes SHA-256', async () => {
    const data = new Uint8Array([0x61, 0x62, 0x63]); // "abc"
    const hash = await sha256(data);
    expect(hash.length).toBe(32);
    // Known SHA-256 of "abc"
    const expected = [
      0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
      0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
      0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
      0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
    ];
    expect(Array.from(hash)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// COSE_Sign1 tests
// ---------------------------------------------------------------------------

describe('COSE_Sign1 encoder', () => {
  it('encodes and extracts payload', async () => {
    const keys = await generateSigningKey();
    const payload = encodeMap([
      [encodeUint(1), encodeUint(1)],
      [encodeUint(4), encodeUint(1)], // LOCKED
    ]);

    const cose = await encodeCoseSign1(payload, keys);
    expect(cose.length).toBeLessThan(512); // C1 §2.2 size budget

    const extractedPayload = extractCosePayload(cose);
    expect(Array.from(extractedPayload)).toEqual(Array.from(payload));
  });

  it('produces a verifiable signature', async () => {
    const keys = await generateSigningKey();
    const payload = encodeMap([
      [encodeUint(1), encodeUint(1)],
      [encodeUint(4), encodeUint(0)], // UNLOCKED
    ]);

    const cose = await encodeCoseSign1(payload, keys);
    const { sigStructure } = reconstructSigStructure(cose);
    const signature = extractCoseSignature(cose);

    const valid = await verifySignature(keys.publicKey, sigStructure, signature);
    expect(valid).toBe(true);
  });

  it('detects tampered payload', async () => {
    const keys = await generateSigningKey();
    const payload = encodeMap([
      [encodeUint(1), encodeUint(1)],
      [encodeUint(4), encodeUint(0)], // UNLOCKED
    ]);

    const cose = await encodeCoseSign1(payload, keys);

    // Tamper: change verdict from 0 (UNLOCKED) to 1 (LOCKED)
    // Find the payload in the COSE array and modify it
    const tamperedCose = cose.slice();
    // Find the byte 0x00 that represents verdict=0 and flip it
    // This is a rough tamper — the exact position depends on encoding
    for (let i = tamperedCose.length - 70; i < tamperedCose.length - 64; i++) {
      if (tamperedCose[i] === 0x00) {
        tamperedCose[i] = 0x01;
        break;
      }
    }

    const { sigStructure } = reconstructSigStructure(tamperedCose);
    const signature = extractCoseSignature(cose); // original signature
    const valid = await verifySignature(keys.publicKey, sigStructure, signature);
    expect(valid).toBe(false);
  });

  // D-109/D-110: Validate Sig_structure CBOR structure matches firmware expectations.
  // The firmware's PblBuildSigStructure in CoseVerify.c must produce identical bytes.
  // Sig_structure = ["Signature1", protected_bstr, empty_bstr, payload_bstr]
  it('D-109: Sig_structure has correct CBOR structure for firmware verification', async () => {
    const keys = await generateSigningKey();
    const payload = encodeMap([
      [encodeUint(1), encodeUint(1)],
      [encodeUint(4), encodeUint(0)],
    ]);

    const cose = await encodeCoseSign1(payload, keys);
    const { sigStructure } = reconstructSigStructure(cose);

    // Decode the Sig_structure as CBOR
    const dec = new CborDecoder(sigStructure);
    const elements = dec.readArray();

    // Must be an array of exactly 4 elements
    expect(elements.length).toBe(4);

    // Element 0: "Signature1" (text string)
    const elem0Dec = new CborDecoder(elements[0]);
    const sig1 = elem0Dec.readTstr();
    expect(sig1).toBe('Signature1');

    // Element 1: protected header (byte string)
    const elem1Dec = new CborDecoder(elements[1]);
    const protectedHdr = elem1Dec.readBstr();
    expect(protectedHdr.length).toBeGreaterThan(0);

    // Element 2: external_aad (empty byte string)
    const elem2Dec = new CborDecoder(elements[2]);
    const externalAad = elem2Dec.readBstr();
    expect(externalAad.length).toBe(0);

    // Element 3: payload (byte string)
    const elem3Dec = new CborDecoder(elements[3]);
    const sigPayload = elem3Dec.readBstr();
    expect(Array.from(sigPayload)).toEqual(Array.from(payload));
  });

  // D-109: Validate that the protected header contains alg and kid
  it('D-109: protected header contains alg=-7 and kid=SHA-256(SPKI)', async () => {
    const keys = await generateSigningKey();
    const payload = encodeMap([
      [encodeUint(1), encodeUint(1)],
    ]);

    const cose = await encodeCoseSign1(payload, keys);

    // Extract the protected header from the COSE_Sign1
    const coseDec = new CborDecoder(cose);
    const coseElements = coseDec.readArray();
    expect(coseElements.length).toBe(4);

    const hdrDec = new CborDecoder(coseElements[0]);
    const protectedHdr = hdrDec.readBstr();

    // Parse the protected header as a CBOR map with integer keys
    const mapDec = new CborDecoder(protectedHdr);
    const mapEntries = mapDec.readIntKeyedMap();

    // Key 1: alg (negative integer, CBOR major type 1)
    // Key 4: kid (byte string)
    expect(mapEntries.has(1)).toBe(true);
    expect(mapEntries.has(4)).toBe(true);

    // Decode alg: CBOR negative integer (major type 1)
    // -7 is encoded as 0x26 (major=1, info=6, value = -(6+1) = -7)
    const algBytes = mapEntries.get(1)!;
    const firstByte = algBytes[0];
    const algMajorType = (firstByte & 0xe0) >> 5;
    const algInfo = firstByte & 0x1f;
    expect(algMajorType).toBe(1); // negative integer
    const algValue = -(algInfo + 1);
    expect(algValue).toBe(COSE_ALG_ES256); // -7

    // Decode kid: byte string
    const kidBytes = mapEntries.get(4)!;
    const kidDec = new CborDecoder(kidBytes);
    const kid = kidDec.readBstr();
    expect(kid.length).toBe(32); // SHA-256 of SPKI

    // Verify kid matches SHA-256 of the SPKI
    const expectedKid = await sha256(keys.spki);
    expect(Array.from(kid)).toEqual(Array.from(expectedKid));
  });
});

// ---------------------------------------------------------------------------
// D-208: Server-side COSE_Sign1 verification
// ---------------------------------------------------------------------------

describe('D-208: COSE_Sign1 verification', () => {
  it('verifies a valid ES256 COSE_Sign1', async () => {
    const keys = await generateSigningKey();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const cose = await encodeCoseSign1(payload, keys);

    // Import the public key
    const pubKey = await importPublicKey(keys.spki, 'ES256');

    // Verify
    const valid = await verifyCoseSign1(cose, pubKey, 'ES256');
    expect(valid).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const keys = await generateSigningKey();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const cose = await encodeCoseSign1(payload, keys);

    // Tamper with the payload (flip a bit in the COSE structure)
    const tampered = new Uint8Array(cose);
    // Find the payload area and flip a byte (offset ~10-15 should be in payload)
    tampered[15] ^= 0x01;

    const pubKey = await importPublicKey(keys.spki, 'ES256');
    const valid = await verifyCoseSign1(tampered, pubKey, 'ES256');
    expect(valid).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const keys1 = await generateSigningKey();
    const keys2 = await generateSigningKey();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const cose = await encodeCoseSign1(payload, keys1);

    // Try to verify with a different public key
    const pubKey2 = await importPublicKey(keys2.spki, 'ES256');
    const valid = await verifyCoseSign1(cose, pubKey2, 'ES256');
    expect(valid).toBe(false);
  });

  it('extracts the algorithm from the protected header', async () => {
    const keys = await generateSigningKey();
    const payload = new Uint8Array([1, 2, 3]);
    const cose = await encodeCoseSign1(payload, keys);

    const alg = extractCoseAlgorithm(cose);
    expect(alg).toBe(COSE_ALG_ES256); // -7
  });

  it('extracts the kid from the protected header', async () => {
    const keys = await generateSigningKey();
    const payload = new Uint8Array([1, 2, 3]);
    const cose = await encodeCoseSign1(payload, keys);

    const kid = extractCoseKid(cose);
    expect(kid).not.toBeNull();
    expect(kid!.length).toBe(32); // SHA-256 of SPKI
    expect(Array.from(kid!)).toEqual(Array.from(keys.kid));
  });

  it('verifies an Ed25519 COSE_Sign1', async () => {
    const keys = await generateSigningKeyWithAlgorithm('Ed25519');
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const cose = await encodeCoseSign1(payload, keys);

    const pubKey = await importPublicKey(keys.spki, 'Ed25519');
    const valid = await verifyCoseSign1(cose, pubKey, 'Ed25519');
    expect(valid).toBe(true);
  });

  it('rejects Ed25519 COSE_Sign1 verified with ES256', async () => {
    const keys = await generateSigningKeyWithAlgorithm('Ed25519');
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const cose = await encodeCoseSign1(payload, keys);

    // Try to verify with ES256 — should fail
    const pubKey = await importPublicKey(keys.spki, 'Ed25519');
    const valid = await verifyCoseSign1(cose, pubKey, 'ES256');
    expect(valid).toBe(false);
  });

  it('returns false for malformed COSE data', async () => {
    const keys = await generateSigningKey();
    const pubKey = await importPublicKey(keys.spki, 'ES256');
    const malformed = new Uint8Array([0x00, 0x01, 0x02]);
    const valid = await verifyCoseSign1(malformed, pubKey, 'ES256');
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verdict endpoint tests
// ---------------------------------------------------------------------------

describe('POST /v1/verdict', () => {
  let keys: Awaited<ReturnType<typeof generateSigningKey>>;
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: KVNamespace; PBL_SIGNING_KEY?: string };

  beforeAll(async () => {
    keys = await generateSigningKey();
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-token',
      LOCKDOWN_KV: kv as unknown as KVNamespace,
    };
  });

  it('returns a signed COSE_Sign1 verdict for unknown device', async () => {
    const deviceId = new Uint8Array(32).fill(0xaa);
    const nonce = new Uint8Array(32).fill(0xbb);
    const digest = new Uint8Array(32).fill(0xcc);

    const reqBody = encodeMap([
      [encodeUint(1), encodeBstr(deviceId)],
      [encodeUint(2), encodeBstr(nonce)],
      [encodeUint(3), encodeBstr(digest)],
      [encodeUint(4), encodeUint(1)],
    ]);

    const request = new Request('https://example.com/v1/verdict', {
      method: 'POST',
      body: reqBody,
    });

    const response = await handleVerdict(request, env, keys);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/cose');

    const coseBody = new Uint8Array(await response.arrayBuffer());
    expect(coseBody.length).toBeLessThan(512);

    // Verify the payload contains the echoed nonce and device_id
    const payload = extractCosePayload(coseBody);
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();

    // key 2 = device_id
    const gotDeviceId = new CborDecoder(map.get(2)!).readBstr();
    expect(Array.from(gotDeviceId)).toEqual(Array.from(deviceId));

    // key 3 = nonce
    const gotNonce = new CborDecoder(map.get(3)!).readBstr();
    expect(Array.from(gotNonce)).toEqual(Array.from(nonce));

    // key 4 = verdict (should be UNLOCKED=0 for unknown device)
    const gotVerdict = new CborDecoder(map.get(4)!).readUint();
    expect(gotVerdict).toBe(0);
  });

  it('returns LOCKED verdict for locked device', async () => {
    const deviceId = new Uint8Array(32).fill(0xdd);
    const deviceIdHex = Array.from(deviceId)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Enroll a locked device
    const device: PblDevice = {
      device_id: deviceIdHex,
      status: 'locked',
      enrolled_at: new Date().toISOString(),
      lock_reason: 'reported_stolen',
    };
    await putDevice(kv as unknown as KVNamespace, device);

    const nonce = new Uint8Array(32).fill(0xee);
    const digest = new Uint8Array(32).fill(0xff);

    const reqBody = encodeMap([
      [encodeUint(1), encodeBstr(deviceId)],
      [encodeUint(2), encodeBstr(nonce)],
      [encodeUint(3), encodeBstr(digest)],
      [encodeUint(4), encodeUint(1)],
    ]);

    const request = new Request('https://example.com/v1/verdict', {
      method: 'POST',
      body: reqBody,
    });

    const response = await handleVerdict(request, env, keys);
    expect(response.status).toBe(200);

    const coseBody = new Uint8Array(await response.arrayBuffer());
    const payload = extractCosePayload(coseBody);
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();

    const gotVerdict = new CborDecoder(map.get(4)!).readUint();
    expect(gotVerdict).toBe(1); // LOCKED

    const gotReason = new CborDecoder(map.get(8)!).readTstr();
    expect(gotReason).toBe('admin_lock');
  });

  it('returns TRACKING verdict for tracking device (C5 covert mode)', async () => {
    const deviceId = new Uint8Array(32).fill(0xbb);
    const deviceIdHex = Array.from(deviceId)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Enroll a tracking device
    const device: PblDevice = {
      device_id: deviceIdHex,
      status: 'tracking',
      enrolled_at: new Date().toISOString(),
      lock_reason: 'reported_stolen',
    };
    await putDevice(kv as unknown as KVNamespace, device);

    const nonce = new Uint8Array(32).fill(0xcc);
    const digest = new Uint8Array(32).fill(0x11);

    const reqBody = encodeMap([
      [encodeUint(1), encodeBstr(deviceId)],
      [encodeUint(2), encodeBstr(nonce)],
      [encodeUint(3), encodeBstr(digest)],
      [encodeUint(4), encodeUint(1)],
    ]);

    const request = new Request('https://example.com/v1/verdict', {
      method: 'POST',
      body: reqBody,
    });

    const response = await handleVerdict(request, env, keys);
    expect(response.status).toBe(200);

    const coseBody = new Uint8Array(await response.arrayBuffer());
    const payload = extractCosePayload(coseBody);
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();

    const gotVerdict = new CborDecoder(map.get(4)!).readUint();
    expect(gotVerdict).toBe(3); // TRACKING

    const gotReason = new CborDecoder(map.get(8)!).readTstr();
    expect(gotReason).toBe('reported_stolen');
  });

  it('rejects invalid CBOR', async () => {
    const request = new Request('https://example.com/v1/verdict', {
      method: 'POST',
      body: new Uint8Array([0xff, 0xff, 0xff]), // invalid CBOR
    });

    const response = await handleVerdict(request, env, keys);
    expect(response.status).toBe(400);
  });

  it('rejects short device_id', async () => {
    const reqBody = encodeMap([
      [encodeUint(1), encodeBstr(new Uint8Array(16))], // too short
      [encodeUint(2), encodeBstr(new Uint8Array(32))],
      [encodeUint(3), encodeBstr(new Uint8Array(32))],
      [encodeUint(4), encodeUint(1)],
    ]);

    const request = new Request('https://example.com/v1/verdict', {
      method: 'POST',
      body: reqBody,
    });

    const response = await handleVerdict(request, env, keys);
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Policy endpoint tests (D-201)
// ---------------------------------------------------------------------------

describe('GET /v1/policy/:version', () => {
  let keys: Awaited<ReturnType<typeof generateSigningKey>>;
  let policyKeys: Awaited<ReturnType<typeof generateSigningKey>>;
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: KVNamespace; PBL_SIGNING_KEY?: string };

  beforeAll(async () => {
    keys = await generateSigningKey();
    policyKeys = await generateSigningKey();
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-token',
      LOCKDOWN_KV: kv as unknown as KVNamespace,
    };
  });

  it('returns a signed COSE_Sign1 policy for version 1 (default)', async () => {
    const request = new Request('https://example.com/v1/policy/1');
    const response = await handlePolicy(request, env, policyKeys, keys, '1');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/cose');

    const coseBody = new Uint8Array(await response.arrayBuffer());
    expect(coseBody.length).toBeGreaterThan(0);

    // Verify it's a valid COSE_Sign1 with extractable payload
    const payload = extractCosePayload(coseBody);
    expect(payload.length).toBeGreaterThan(0);
  });

  it('returns a policy for latest version', async () => {
    // Store a policy at version 3
    const fakePolicy = new Uint8Array([0x84, 0x40, 0xa0, 0x44, 0x01, 0x02, 0x03, 0x04]);
    await kv.put('pbl_policy:3', fakePolicy);
    await kv.put('pbl_policy:latest_version', '3');

    const request = new Request('https://example.com/v1/policy/latest');
    const response = await handlePolicy(request, env, policyKeys, keys, 'latest');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/cose');

    const body = new Uint8Array(await response.arrayBuffer());
    // Should return the stored policy blob as-is
    expect(Array.from(body)).toEqual(Array.from(fakePolicy));
  });

  it('rejects invalid version', async () => {
    const request = new Request('https://example.com/v1/policy/abc');
    const response = await handlePolicy(request, env, policyKeys, keys, 'abc');
    expect(response.status).toBe(400);
  });

  it('returns stored policy when available', async () => {
    const storedPolicy = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await kv.put('pbl_policy:5', storedPolicy);

    const request = new Request('https://example.com/v1/policy/5');
    const response = await handlePolicy(request, env, policyKeys, keys, '5');
    expect(response.status).toBe(200);

    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(storedPolicy));
  });
});

// ---------------------------------------------------------------------------
// D-209: Full C4 policy blob tests
// ---------------------------------------------------------------------------

describe('D-209: buildFullPolicyPayload', () => {
  it('encodes all ~40 C4 policy fields', async () => {
    const payload = buildFullPolicyPayload(7);
    expect(payload.length).toBeGreaterThan(100);

    // Decode the CBOR map and verify all top-level keys exist
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();

    // §2.1 Metadata (keys 1-4)
    expect(map.has(1)).toBe(true);  // version
    expect(map.has(2)).toBe(true);  // issued_at
    expect(map.has(3)).toBe(true);  // expires_at
    expect(map.has(4)).toBe(true);  // min_pbl_version

    // §2.2 Secure Boot (keys 10-14)
    expect(map.has(10)).toBe(true);  // oem_pk_allowlist
    expect(map.has(11)).toBe(true);  // pkfail_denylist
    expect(map.has(12)).toBe(true);  // db_expectations
    expect(map.has(13)).toBe(true);  // dbx_expectations
    expect(map.has(14)).toBe(true);  // bootmgr_svn_floor

    // §2.3 SPI protections (keys 20-21)
    expect(map.has(20)).toBe(true);  // spi_protection_required
    expect(map.has(21)).toBe(true);  // spi_oem_matrix

    // §2.4 Firmware floors (keys 30-32)
    expect(map.has(30)).toBe(true);  // firmware_floors
    expect(map.has(31)).toBe(true);  // amt_allowlist
    expect(map.has(32)).toBe(true);  // usb_dci_policy

    // §2.5 TPM policy (keys 40-44)
    expect(map.has(40)).toBe(true);  // tpm_session_requirements
    expect(map.has(41)).toBe(true);  // tpm_firmware_floors
    expect(map.has(42)).toBe(true);  // tpm_pin_policy
    expect(map.has(43)).toBe(true);  // nv_index_base
    expect(map.has(44)).toBe(true);  // bitlocker_sealing_tier

    // §2.6 Boot config (keys 50-57)
    expect(map.has(50)).toBe(true);  // s3_policy
    expect(map.has(51)).toBe(true);  // kernel_dma_protection_required
    expect(map.has(52)).toBe(true);  // mor_required
    expect(map.has(53)).toBe(true);  // network_boot_policy
    expect(map.has(54)).toBe(true);  // bcd_hash
    expect(map.has(55)).toBe(true);  // winre_wim_hash
    expect(map.has(56)).toBe(true);  // recoverysequence_target
    expect(map.has(57)).toBe(true);  // bitlocker_required

    // §2.7 Recovery (key 60)
    expect(map.has(60)).toBe(true);  // firmware_recovery_expectation

    // §2.8 Pins and endpoints (keys 70-76)
    expect(map.has(70)).toBe(true);  // lock_service_uri
    expect(map.has(71)).toBe(true);  // lock_service_cert_pin
    expect(map.has(72)).toBe(true);  // lock_service_cert_pin_history
    expect(map.has(73)).toBe(true);  // tls_ca_pin
    expect(map.has(74)).toBe(true);  // attestation_uri
    expect(map.has(75)).toBe(true);  // policy_uri
    expect(map.has(76)).toBe(true);  // verdict_signing_key_spki (D-205)

    // §2.9 Verdict cache and override (keys 80-84)
    expect(map.has(80)).toBe(true);  // verdict_freshness_seconds
    expect(map.has(81)).toBe(true);  // grace_period_seconds
    expect(map.has(82)).toBe(true);  // wipe_deadline_seconds
    expect(map.has(83)).toBe(true);  // override_rate_limit
    expect(map.has(84)).toBe(true);  // override_challenge_uri
  });

  it('sets version correctly', () => {
    const payload = buildFullPolicyPayload(42);
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();
    const version = new CborDecoder(map.get(1)!).readUint();
    expect(version).toBe(42);
  });

  it('accepts custom options for URIs and pins', () => {
    const customCertPin = new Uint8Array(32).fill(0xAB);
    const customBcdHash = new Uint8Array(32).fill(0xCD);
    const payload = buildFullPolicyPayload(1, {
      lockServiceUri: 'https://custom.example.com',
      certPin: customCertPin,
      bcdHash: customBcdHash,
    });
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();

    // Check custom URI
    const uri = new CborDecoder(map.get(70)!).readTstr();
    expect(uri).toBe('https://custom.example.com');

    // Check custom cert pin
    const pin = new CborDecoder(map.get(71)!).readBstr();
    expect(Array.from(pin)).toEqual(Array.from(customCertPin));

    // Check custom BCD hash
    const bcdHash = new CborDecoder(map.get(54)!).readBstr();
    expect(Array.from(bcdHash)).toEqual(Array.from(customBcdHash));
  });

  it('encodes s3_policy as "disabled"', () => {
    const payload = buildFullPolicyPayload(1);
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();
    const s3 = new CborDecoder(map.get(50)!).readTstr();
    expect(s3).toBe('disabled');
  });

  it('encodes override_rate_limit with max_attempts and window_seconds', () => {
    const payload = buildFullPolicyPayload(1);
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();
    const rlMap = new CborDecoder(map.get(83)!).readStringKeyedMap();
    const maxAttempts = new CborDecoder(rlMap.get('max_attempts')!).readUint();
    const windowSeconds = new CborDecoder(rlMap.get('window_seconds')!).readUint();
    expect(maxAttempts).toBe(5);
    expect(windowSeconds).toBe(3600);
  });

  it('policy fits within 64 KiB size budget (C4 §1.1)', () => {
    const payload = buildFullPolicyPayload(1);
    expect(payload.length).toBeLessThanOrEqual(65536);
  });

  // D-205: Verdict signing key SPKI (C4 key 76)
  it('D-205: includes verdict_signing_key_spki (key 76) when provided', async () => {
    const keys = await generateSigningKey();
    const payload = buildFullPolicyPayload(1, {
      certPin: keys.kid,
      verdictSigningKeySpki: keys.spki,
    });
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();

    // Key 76 must be present
    expect(map.has(76)).toBe(true);

    // The SPKI bytes must match what was passed in
    const spkiBytes = new CborDecoder(map.get(76)!).readBstr();
    expect(Array.from(spkiBytes)).toEqual(Array.from(keys.spki));

    // The cert_pin (key 71) must be SHA-256 of the SPKI (key 76)
    const certPin = new CborDecoder(map.get(71)!).readBstr();
    const expectedKid = await sha256(keys.spki);
    expect(Array.from(certPin)).toEqual(Array.from(expectedKid));
  });

  it('D-205: handlePolicy includes SPKI in default policy blob', async () => {
    const verdictKeys = await generateSigningKey();
    const policyKeys = await generateSigningKey();
    const kv = new MockKV();
    const env = { ADMIN_TOKEN: 'test', LOCKDOWN_KV: kv as unknown as KVNamespace };

    // No stored policy — handlePolicy generates a default
    const request = new Request('https://example.com/v1/policy/1');
    const response = await handlePolicy(request, env, policyKeys, verdictKeys, '1');
    expect(response.status).toBe(200);

    const body = new Uint8Array(await response.arrayBuffer());

    // Extract the payload from the COSE_Sign1
    const coseDec = new CborDecoder(body);
    const coseElements = coseDec.readArray();
    expect(coseElements.length).toBe(4);

    const payloadDec = new CborDecoder(coseElements[2]);
    const payload = payloadDec.readBstr();

    // Parse the policy payload map
    const mapDec = new CborDecoder(payload);
    const map = mapDec.readIntKeyedMap();

    // Key 76 (verdict_signing_key_spki) must be present and match verdictKeys.spki
    expect(map.has(76)).toBe(true);
    const spkiBytes = new CborDecoder(map.get(76)!).readBstr();
    expect(Array.from(spkiBytes)).toEqual(Array.from(verdictKeys.spki));

    // Key 71 (cert_pin) must be SHA-256 of the verdict SPKI (not policy SPKI)
    const certPin = new CborDecoder(map.get(71)!).readBstr();
    const expectedKid = await sha256(verdictKeys.spki);
    expect(Array.from(certPin)).toEqual(Array.from(expectedKid));

    // D-205: The policy must be signed by the policy signing key, NOT the verdict key.
    // Verify the COSE kid matches policyKeys.kid (not verdictKeys.kid).
    const hdrDec = new CborDecoder(coseElements[0]);
    const protectedHdr = hdrDec.readBstr();
    const hdrMapDec = new CborDecoder(protectedHdr);
    const hdrMap = hdrMapDec.readIntKeyedMap();
    const coseKid = new CborDecoder(hdrMap.get(4)!).readBstr();
    expect(Array.from(coseKid)).toEqual(Array.from(policyKeys.kid));
    expect(Array.from(coseKid)).not.toEqual(Array.from(verdictKeys.kid));
  });

  // D-205: Verify that the policy signature is valid under the policy key
  it('D-205: policy signature is valid under policy signing key, not verdict key', async () => {
    const verdictKeys = await generateSigningKey();
    const policyKeys = await generateSigningKey();
    const kv = new MockKV();
    const env = { ADMIN_TOKEN: 'test', LOCKDOWN_KV: kv as unknown as KVNamespace };

    const request = new Request('https://example.com/v1/policy/1');
    const response = await handlePolicy(request, env, policyKeys, verdictKeys, '1');
    expect(response.status).toBe(200);

    const body = new Uint8Array(await response.arrayBuffer());
    const { sigStructure } = reconstructSigStructure(body);
    const signature = extractCoseSignature(body);

    // Verify under policy key — should be valid
    const validUnderPolicy = await verifySignature(policyKeys.publicKey, sigStructure, signature);
    expect(validUnderPolicy).toBe(true);

    // Verify under verdict key — should be INVALID (key separation)
    const validUnderVerdict = await verifySignature(verdictKeys.publicKey, sigStructure, signature);
    expect(validUnderVerdict).toBe(false);
  });

  // D-205: Verify that the generated root-of-trust key matches the generated header
  it('D-205: generated policy signing key matches PolicyRootOfTrust.generated.h', async () => {
    const keyPath = path.resolve(__dirname, '..', '.pbl_policy_signing_key');
    const headerPath = path.resolve(__dirname, '..', 'firmware/PblPkg/PblApp/PolicyRootOfTrust.generated.h');

    // Skip if not provisioned
    if (!fs.existsSync(keyPath) || !fs.existsSync(headerPath)) {
      console.log('  [SKIP] Policy signing key not provisioned — run: node scripts/generate-policy-root-of-trust.js');
      return;
    }

    // Load the private key from file
    const pkcs8Base64 = fs.readFileSync(keyPath, 'utf8').trim();
    const pkcs8 = Uint8Array.from(Buffer.from(pkcs8Base64, 'base64'));
    const privateKey = await importPrivateKey(pkcs8);

    // Derive the public key + SPKI from the private key
    const jwk = await crypto.subtle.exportKey('jwk', privateKey);
    const publicJwk: JsonWebKey = {
      kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true,
    };
    const publicKey = await crypto.subtle.importKey(
      'jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'],
    );
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
    const kid = await sha256(spki);

    // Parse the generated header to extract the SPKI + kid
    const header = fs.readFileSync(headerPath, 'utf8');

    // Extract SPKI bytes from the C array
    const spkiMatch = header.match(/gPblPolicySigningKeySpki\[\d+\]\s*=\s*\{([^}]+)\}/);
    expect(spkiMatch).not.toBeNull();
    const spkiHexValues = spkiMatch![1].match(/0x[0-9a-fA-F]{2}/g);
    expect(spkiHexValues).not.toBeNull();
    const headerSpki = new Uint8Array(spkiHexValues!.map(h => parseInt(h, 16)));

    // Extract kid bytes from the C array
    const kidMatch = header.match(/gPblPolicySigningKeyKid\[32\]\s*=\s*\{([^}]+)\}/);
    expect(kidMatch).not.toBeNull();
    const kidHexValues = kidMatch![1].match(/0x[0-9a-fA-F]{2}/g);
    expect(kidHexValues).not.toBeNull();
    const headerKid = new Uint8Array(kidHexValues!.map(h => parseInt(h, 16)));

    // The SPKI in the header must match the SPKI derived from the private key
    expect(Array.from(headerSpki)).toEqual(Array.from(spki));

    // The kid in the header must match SHA-256(SPKI)
    expect(Array.from(headerKid)).toEqual(Array.from(kid));

    // Verify a policy signed by this key validates under the header's SPKI
    const policyKeys = {
      privateKey,
      publicKey,
      kid,
      spki,
      algorithm: 'ES256' as const,
    };
    const payload = buildFullPolicyPayload(1, {
      certPin: kid,
      verdictSigningKeySpki: spki,
    });
    const cose = await encodeCoseSign1(payload, policyKeys);
    const { sigStructure } = reconstructSigStructure(cose);
    const signature = extractCoseSignature(cose);
    const valid = await verifySignature(publicKey, sigStructure, signature);
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-205: Ed25519 signing support (alg = -8 in COSE)
// ---------------------------------------------------------------------------

describe('D-205: Ed25519 signing', () => {
  it('generates a valid Ed25519 key pair', async () => {
    const keys = await generateSigningKeyWithAlgorithm('Ed25519');
    expect(keys.algorithm).toBe('Ed25519');
    expect(keys.spki.length).toBe(44); // Ed25519 SPKI is 44 bytes
    expect(keys.kid.length).toBe(32); // SHA-256 of SPKI
  });

  it('signs and verifies data with Ed25519', async () => {
    const keys = await generateSigningKeyWithAlgorithm('Ed25519');
    const data = new TextEncoder().encode('test message');
    const signature = await signData(keys.privateKey, data, 'Ed25519');
    expect(signature.length).toBe(64); // Ed25519 signatures are 64 bytes

    const valid = await verifySignature(keys.publicKey, data, signature, 'Ed25519');
    expect(valid).toBe(true);

    // Tampered data should fail
    const tampered = new TextEncoder().encode('wrong message');
    const invalid = await verifySignature(keys.publicKey, tampered, signature, 'Ed25519');
    expect(invalid).toBe(false);
  });

  it('encodes COSE_Sign1 with alg = -8 for Ed25519 keys', async () => {
    const keys = await generateSigningKeyWithAlgorithm('Ed25519');
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const cose = await encodeCoseSign1(payload, keys);

    // Extract protected header and verify alg = -8
    const hdrBytes = extractCoseProtectedHeader(cose);
    const dec = new CborDecoder(hdrBytes);
    const map = dec.readIntKeyedMap();

    // Key 1 is alg, should be -8 (Ed25519)
    const algFirstByte = map.get(1)![0];
    // CBOR negative int: major type 1 (0x20 | value)
    // -8 → abs = 7 → 0x20 | 7 = 0x27
    expect(algFirstByte).toBe(0x27); // -8 in CBOR

    // Key 4 is kid, should match keys.kid
    const kid = new CborDecoder(map.get(4)!).readBstr();
    expect(Array.from(kid)).toEqual(Array.from(keys.kid));

    // Signature should verify
    const { sigStructure } = reconstructSigStructure(cose);
    const signature = extractCoseSignature(cose);
    const valid = await verifySignature(keys.publicKey, sigStructure, signature, 'Ed25519');
    expect(valid).toBe(true);
  });

  it('Ed25519 key separation: different from ES256', async () => {
    const es256Keys = await generateSigningKey();
    const ed25519Keys = await generateSigningKeyWithAlgorithm('Ed25519');

    // SPKI sizes differ
    expect(es256Keys.spki.length).toBe(91); // P-256 SPKI
    expect(ed25519Keys.spki.length).toBe(44); // Ed25519 SPKI

    // Kids differ
    expect(Array.from(es256Keys.kid)).not.toEqual(Array.from(ed25519Keys.kid));

    // Algorithms differ
    expect(es256Keys.algorithm).toBe('ES256');
    expect(ed25519Keys.algorithm).toBe('Ed25519');

    // ES256 signature should NOT verify under Ed25519 key (and vice versa)
    const data = new TextEncoder().encode('test');
    const es256Sig = await signData(es256Keys.privateKey, data, 'ES256');
    const ed25519Sig = await signData(ed25519Keys.privateKey, data, 'Ed25519');

    // Cross-verification should fail
    const cross1 = await verifySignature(ed25519Keys.publicKey, data, es256Sig, 'Ed25519');
    expect(cross1).toBe(false);
    const cross2 = await verifySignature(es256Keys.publicKey, data, ed25519Sig, 'ES256');
    expect(cross2).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D-205: Key rotation and versioning
// ---------------------------------------------------------------------------

describe('D-205: Key rotation', () => {
  it('rotates the signing key and archives the old kid', async () => {
    const kv = new MockKV();

    // Generate an initial key and store it
    const initialKeys = await loadOrGenerateSigningKey(kv);
    const initialKid = initialKeys.kid;

    // Verify it's the current key
    const stored = await kv.get('pbl_signing_key:current', 'text');
    expect(stored).not.toBeNull();

    // Rotate
    const { keys: newKeys, kidHistory } = await rotateSigningKey(kv);

    // New key should be different from initial
    expect(Array.from(newKeys.kid)).not.toEqual(Array.from(initialKid));

    // Kid history should contain the old kid
    expect(kidHistory.length).toBe(1);
    expect(Array.from(kidHistory[0])).toEqual(Array.from(initialKid));

    // The new key should be stored as current
    const newStored = await kv.get('pbl_signing_key:current', 'text');
    expect(newStored).not.toBeNull();
    const newPkcs8 = Uint8Array.from(Buffer.from(newStored!, 'base64'));
    const newPrivateKey = await importPrivateKey(newPkcs8);
    // The new key should be able to sign
    const data = new TextEncoder().encode('test');
    const sig = await signData(newPrivateKey, data);
    expect(sig.length).toBe(64);

    // The old key should be archived
    const oldKidHex = Array.from(initialKid).map(b => b.toString(16).padStart(2, '0')).join('');
    const archived = await kv.get(`pbl_signing_key:archived:${oldKidHex}`, 'text');
    expect(archived).not.toBeNull();
  });

  it('getKidHistory returns empty array before any rotation', async () => {
    const kv = new MockKV();
    const history = await getKidHistory(kv);
    expect(history).toEqual([]);
  });

  it('getKidHistory returns previous kids after rotation', async () => {
    const kv = new MockKV();

    // Generate initial key
    await loadOrGenerateSigningKey(kv);

    // Rotate
    const { kidHistory } = await rotateSigningKey(kv);
    expect(kidHistory.length).toBe(1);

    // getKidHistory should return the same kids
    const history = await getKidHistory(kv);
    expect(history.length).toBe(1);
    expect(Array.from(history[0])).toEqual(Array.from(kidHistory[0]));
  });

  it('multiple rotations accumulate kid history', async () => {
    const kv = new MockKV();

    // Generate initial key
    const k1 = await loadOrGenerateSigningKey(kv);

    // First rotation
    const { keys: k2, kidHistory: h1 } = await rotateSigningKey(kv);
    expect(h1.length).toBe(1);
    expect(Array.from(h1[0])).toEqual(Array.from(k1.kid));

    // Second rotation — history is [k2.kid (newest old), k1.kid (oldest old)]
    const { kidHistory: h2 } = await rotateSigningKey(kv);
    expect(h2.length).toBe(2);
    expect(Array.from(h2[0])).toEqual(Array.from(k2.kid));
    expect(Array.from(h2[1])).toEqual(Array.from(k1.kid));
  });

  it('policy blob includes kid history in key 72 after rotation', async () => {
    const kv = new MockKV();
    const verdictKeys = await generateSigningKey();
    const policyKeys = await generateSigningKey();
    const env = { ADMIN_TOKEN: 'test', LOCKDOWN_KV: kv as unknown as KVNamespace };

    // No rotation yet — key 72 should have a zero-filled placeholder
    const req1 = new Request('https://example.com/v1/policy/1');
    const res1 = await handlePolicy(req1, env, policyKeys, verdictKeys, '1');
    expect(res1.status).toBe(200);
    const body1 = new Uint8Array(await res1.arrayBuffer());
    const payload1 = extractCosePayload(body1);
    const dec1 = new CborDecoder(payload1);
    const map1 = dec1.readIntKeyedMap();
    const key72_1 = new CborDecoder(map1.get(72)!).readArray();
    expect(key72_1.length).toBe(1); // placeholder

    // Generate a verdict key and store it so rotation has something to archive
    await loadOrGenerateSigningKey(kv);
    await rotateSigningKey(kv);

    // After rotation — key 72 should contain the old kid
    const req2 = new Request('https://example.com/v1/policy/1');
    const res2 = await handlePolicy(req2, env, policyKeys, verdictKeys, '1');
    expect(res2.status).toBe(200);
    const body2 = new Uint8Array(await res2.arrayBuffer());
    const payload2 = extractCosePayload(body2);
    const dec2 = new CborDecoder(payload2);
    const map2 = dec2.readIntKeyedMap();
    const key72_2 = new CborDecoder(map2.get(72)!).readArray();
    expect(key72_2.length).toBe(1); // one old kid
    const oldKid = new CborDecoder(key72_2[0]).readBstr();
    expect(oldKid.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// D-205: X.509 certificate chain support (C4 key 77)
// ---------------------------------------------------------------------------

describe('D-205: Certificate chain', () => {
  it('splitDerCerts splits concatenated DER certs', () => {
    // Create 3 fake DER SEQUENCEs
    const cert1 = new Uint8Array([0x30, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const cert2 = new Uint8Array([0x30, 0x03, 0x01, 0x02, 0x03]);
    const cert3 = new Uint8Array([0x30, 0x04, 0x01, 0x02, 0x03, 0x04]);
    const chain = new Uint8Array([...cert1, ...cert2, ...cert3]);

    const certs = splitDerCerts(chain);
    expect(certs.length).toBe(3);
    expect(Array.from(certs[0])).toEqual(Array.from(cert1));
    expect(Array.from(certs[1])).toEqual(Array.from(cert2));
    expect(Array.from(certs[2])).toEqual(Array.from(cert3));
  });

  it('splitDerCerts handles long-form length encoding', () => {
    // DER SEQUENCE with long-form length: 0x30 0x82 0x01 0x00 = 256 bytes
    const content = new Uint8Array(256);
    const cert = new Uint8Array([0x30, 0x82, 0x01, 0x00, ...content]);
    const certs = splitDerCerts(cert);
    expect(certs.length).toBe(1);
    expect(certs[0].length).toBe(260); // 4 header + 256 content
  });

  it('splitDerCerts returns empty for non-SEQUENCE input', () => {
    const notCert = new Uint8Array([0x01, 0x02, 0x03]);
    const certs = splitDerCerts(notCert);
    expect(certs.length).toBe(0);
  });

  it('loadCertChain returns empty when not provisioned', async () => {
    const kv = new MockKV();
    const chain = await loadCertChain(kv as unknown as KVNamespace);
    expect(chain).toEqual([]);
  });

  it('storeCertChain + loadCertChain round-trip', async () => {
    const kv = new MockKV();
    const cert1 = new Uint8Array([0x30, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const cert2 = new Uint8Array([0x30, 0x03, 0x01, 0x02, 0x03]);
    const chain = new Uint8Array([...cert1, ...cert2]);

    await storeCertChain(kv as unknown as KVNamespace, chain);
    const loaded = await loadCertChain(kv as unknown as KVNamespace);
    expect(loaded.length).toBe(2);
    expect(Array.from(loaded[0])).toEqual(Array.from(cert1));
    expect(Array.from(loaded[1])).toEqual(Array.from(cert2));
  });

  it('policy blob includes key 77 as empty array when no cert chain', async () => {
    const kv = new MockKV();
    const verdictKeys = await generateSigningKey();
    const policyKeys = await generateSigningKey();
    const env = { ADMIN_TOKEN: 'test', LOCKDOWN_KV: kv as unknown as KVNamespace };

    const req = new Request('https://example.com/v1/policy/1');
    const res = await handlePolicy(req, env, policyKeys, verdictKeys, '1');
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    const payload = extractCosePayload(body);
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();

    // Key 77 should be present and be an empty array
    expect(map.has(77)).toBe(true);
    const key77 = new CborDecoder(map.get(77)!).readArray();
    expect(key77.length).toBe(0);
  });

  it('policy blob includes cert chain in key 77 when provisioned', async () => {
    const kv = new MockKV();
    const verdictKeys = await generateSigningKey();
    const policyKeys = await generateSigningKey();
    const env = { ADMIN_TOKEN: 'test', LOCKDOWN_KV: kv as unknown as KVNamespace };

    // Store a fake cert chain in KV
    const cert1 = new Uint8Array([0x30, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const cert2 = new Uint8Array([0x30, 0x03, 0x01, 0x02, 0x03]);
    const cert3 = new Uint8Array([0x30, 0x04, 0x01, 0x02, 0x03, 0x04]);
    const chain = new Uint8Array([...cert1, ...cert2, ...cert3]);
    await storeCertChain(kv as unknown as KVNamespace, chain);

    const req = new Request('https://example.com/v1/policy/1');
    const res = await handlePolicy(req, env, policyKeys, verdictKeys, '1');
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    const payload = extractCosePayload(body);
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();

    // Key 77 should contain 3 certs
    const key77 = new CborDecoder(map.get(77)!).readArray();
    expect(key77.length).toBe(3);

    // Each cert should be a bstr matching the original
    const loadedCert1 = new CborDecoder(key77[0]).readBstr();
    const loadedCert2 = new CborDecoder(key77[1]).readBstr();
    const loadedCert3 = new CborDecoder(key77[2]).readBstr();
    expect(Array.from(loadedCert1)).toEqual(Array.from(cert1));
    expect(Array.from(loadedCert2)).toEqual(Array.from(cert2));
    expect(Array.from(loadedCert3)).toEqual(Array.from(cert3));
  });

  it('generated cert chain from scripts/generate-cert-chain.sh is valid', async () => {
    // This test validates the cert chain generated by the provisioning script.
    // Skip if not provisioned.
    const chainPath = path.resolve(__dirname, '..', '.pbl_cert_chain', 'chain.der');
    if (!fs.existsSync(chainPath)) {
      console.log('  [SKIP] Cert chain not provisioned — run: bash scripts/generate-cert-chain.sh --force');
      return;
    }

    const chainBytes = new Uint8Array(fs.readFileSync(chainPath));
    const certs = splitDerCerts(chainBytes);

    // Should have 3 certs: leaf, intermediate, root CA
    expect(certs.length).toBe(3);

    // Each cert should start with 0x30 (DER SEQUENCE)
    for (const cert of certs) {
      expect(cert[0]).toBe(0x30);
      expect(cert.length).toBeGreaterThan(100); // certs are not tiny
    }
  });
});

// ---------------------------------------------------------------------------
// Enrollment endpoint tests (D-202)
// ---------------------------------------------------------------------------

describe('POST /v1/enroll', () => {
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: KVNamespace; PBL_SIGNING_KEY?: string };

  beforeAll(() => {
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-token',
      LOCKDOWN_KV: kv as unknown as KVNamespace,
    };
  });

  it('enrolls a new PBL device with TPM identity', async () => {
    const deviceId = new Uint8Array(32).fill(0x42);
    const ekCert = new Uint8Array(64).fill(0x11);
    const akPublic = new Uint8Array(256).fill(0x22);

    const reqBody = encodeMap([
      [encodeUint(1), encodeBstr(deviceId)],
      [encodeUint(2), encodeBstr(ekCert)],
      [encodeUint(3), encodeBstr(akPublic)],
    ]);

    const request = new Request('https://example.com/v1/enroll', {
      method: 'POST',
      body: reqBody,
    });

    const response = await handleEnrollPbl(request, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/cbor');

    // Verify response is CBOR map with status=0 (success)
    const body = new Uint8Array(await response.arrayBuffer());
    const dec = new CborDecoder(body);
    const map = dec.readIntKeyedMap();
    const status = new CborDecoder(map.get(1)!).readUint();
    expect(status).toBe(0); // success

    // Verify device was stored in KV
    const deviceIdHex = Array.from(deviceId).map((b) => b.toString(16).padStart(2, '0')).join('');
    const stored = await getDevice(env.LOCKDOWN_KV, deviceIdHex);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('active');
  });

  it('returns already_enrolled for existing device', async () => {
    const deviceId = new Uint8Array(32).fill(0x99);

    // Pre-enroll the device
    const deviceIdHex = Array.from(deviceId).map((b) => b.toString(16).padStart(2, '0')).join('');
    await putDevice(env.LOCKDOWN_KV, {
      device_id: deviceIdHex,
      status: 'active',
      enrolled_at: '2026-01-01T00:00:00Z',
    });

    const reqBody = encodeMap([
      [encodeUint(1), encodeBstr(deviceId)],
    ]);

    const request = new Request('https://example.com/v1/enroll', {
      method: 'POST',
      body: reqBody,
    });

    const response = await handleEnrollPbl(request, env);
    expect(response.status).toBe(200);

    const body = new Uint8Array(await response.arrayBuffer());
    const dec = new CborDecoder(body);
    const map = dec.readIntKeyedMap();
    const status = new CborDecoder(map.get(1)!).readUint();
    expect(status).toBe(1); // already_enrolled
  });

  it('rejects invalid CBOR', async () => {
    const request = new Request('https://example.com/v1/enroll', {
      method: 'POST',
      body: new Uint8Array([0xff, 0xff]), // invalid CBOR
    });

    const response = await handleEnrollPbl(request, env);
    expect(response.status).toBe(400);
  });

  it('rejects short device_id', async () => {
    const reqBody = encodeMap([
      [encodeUint(1), encodeBstr(new Uint8Array(16))], // too short
    ]);

    const request = new Request('https://example.com/v1/enroll', {
      method: 'POST',
      body: reqBody,
    });

    const response = await handleEnrollPbl(request, env);
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/attest tests (D-203)
// ---------------------------------------------------------------------------

describe('POST /v1/attest', () => {
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: KVNamespace; PBL_SIGNING_KEY?: string };

  beforeAll(() => {
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-token',
      LOCKDOWN_KV: kv as unknown as KVNamespace,
    };
  });

  const deviceIdHex = 'aabbccdd'.repeat(8); // 64 hex chars = 32 bytes

  it('rejects missing device_id', async () => {
    const request = new Request('https://example.com/v1/attest', {
      method: 'POST',
      body: JSON.stringify({ quote: 'dGVzdA==' }),
    });
    const response = await handleAttest(request, env);
    expect(response.status).toBe(400);
  });

  it('rejects invalid device_id format', async () => {
    const request = new Request('https://example.com/v1/attest', {
      method: 'POST',
      body: JSON.stringify({ device_id: 'short', quote: 'dGVzdA==' }),
    });
    const response = await handleAttest(request, env);
    expect(response.status).toBe(400);
  });

  it('rejects missing quote', async () => {
    const request = new Request('https://example.com/v1/attest', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceIdHex }),
    });
    const response = await handleAttest(request, env);
    expect(response.status).toBe(400);
  });

  it('returns 404 for unenrolled device', async () => {
    const request = new Request('https://example.com/v1/attest', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceIdHex, quote: 'dGVzdA==' }),
    });
    const response = await handleAttest(request, env);
    expect(response.status).toBe(404);
  });

  it('returns attested=true for enrolled active device', async () => {
    await putDevice(env.LOCKDOWN_KV, {
      device_id: deviceIdHex,
      status: 'active',
      enrolled_at: '2026-01-01T00:00:00Z',
    });

    const request = new Request('https://example.com/v1/attest', {
      method: 'POST',
      body: JSON.stringify({
        device_id: deviceIdHex,
        quote: 'dGVzdA==',
        pcr_selection: [{ pcr: 0, hash_alg: 'sha256' }],
      }),
    });
    const response = await handleAttest(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attested).toBe(true);
    expect(body.health).toBe('ok');
    expect(body.device_id).toBe(deviceIdHex);
  });

  it('returns health=degraded for locked device', async () => {
    await setDeviceStatus(env.LOCKDOWN_KV, deviceIdHex, 'locked');

    const request = new Request('https://example.com/v1/attest', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceIdHex, quote: 'dGVzdA==' }),
    });
    const response = await handleAttest(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attested).toBe(true);
    expect(body.health).toBe('degraded');
  });

  it('rejects invalid JSON', async () => {
    const request = new Request('https://example.com/v1/attest', {
      method: 'POST',
      body: 'not json',
    });
    const response = await handleAttest(request, env);
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/override/challenge and /v1/override/response tests (D-204)
// ---------------------------------------------------------------------------

describe('POST /v1/override/challenge', () => {
  let keys: Awaited<ReturnType<typeof generateSigningKey>>;
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: KVNamespace; PBL_SIGNING_KEY?: string };

  beforeAll(async () => {
    keys = await generateSigningKey();
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-token',
      LOCKDOWN_KV: kv as unknown as KVNamespace,
    };
  });

  const deviceIdHex = '11223344'.repeat(8); // 64 hex chars
  const challengeSeed = 'aabbccdd'.repeat(4); // 32 hex chars = 16 bytes

  it('rejects missing device_id', async () => {
    const request = new Request('https://example.com/v1/override/challenge', {
      method: 'POST',
      body: JSON.stringify({ challenge_seed: challengeSeed }),
    });
    const response = await handleOverrideChallenge(request, env);
    expect(response.status).toBe(400);
  });

  it('rejects missing challenge_seed', async () => {
    const request = new Request('https://example.com/v1/override/challenge', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceIdHex }),
    });
    const response = await handleOverrideChallenge(request, env);
    expect(response.status).toBe(400);
  });

  it('returns 404 for unenrolled device', async () => {
    const request = new Request('https://example.com/v1/override/challenge', {
      method: 'POST',
      body: JSON.stringify({ device_id: 'ff'.repeat(32), challenge_seed: challengeSeed }),
    });
    const response = await handleOverrideChallenge(request, env);
    expect(response.status).toBe(404);
  });

  it('returns 409 for non-locked device', async () => {
    await putDevice(env.LOCKDOWN_KV, {
      device_id: deviceIdHex,
      status: 'active',
      enrolled_at: '2026-01-01T00:00:00Z',
    });

    const request = new Request('https://example.com/v1/override/challenge', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceIdHex, challenge_seed: challengeSeed }),
    });
    const response = await handleOverrideChallenge(request, env);
    expect(response.status).toBe(409);
  });

  it('returns challenge for locked device', async () => {
    await setDeviceStatus(env.LOCKDOWN_KV, deviceIdHex, 'locked');

    const request = new Request('https://example.com/v1/override/challenge', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceIdHex, challenge_seed: challengeSeed }),
    });
    const response = await handleOverrideChallenge(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.challenge).toBeTruthy();
    expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe('POST /v1/override/response', () => {
  let keys: Awaited<ReturnType<typeof generateSigningKey>>;
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: KVNamespace; PBL_SIGNING_KEY?: string };

  beforeAll(async () => {
    keys = await generateSigningKey();
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-token',
      LOCKDOWN_KV: kv as unknown as KVNamespace,
    };
  });

  const deviceIdHex = '55667788'.repeat(8); // 64 hex chars

  it('rejects missing device_id', async () => {
    const request = new Request('https://example.com/v1/override/response', {
      method: 'POST',
      body: JSON.stringify({ challenge: 'dGVzdA==', response: 'dGVzdA==' }),
    });
    const response = await handleOverrideResponse(request, env, keys);
    expect(response.status).toBe(400);
  });

  it('rejects missing challenge or response', async () => {
    const request = new Request('https://example.com/v1/override/response', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceIdHex }),
    });
    const response = await handleOverrideResponse(request, env, keys);
    expect(response.status).toBe(400);
  });

  it('returns 404 for unenrolled device', async () => {
    const request = new Request('https://example.com/v1/override/response', {
      method: 'POST',
      body: JSON.stringify({
        device_id: 'ff'.repeat(32),
        challenge: 'dGVzdA==',
        response: 'dGVzdA==',
      }),
    });
    const response = await handleOverrideResponse(request, env, keys);
    expect(response.status).toBe(404);
  });

  it('returns 400 when no challenge was requested', async () => {
    await putDevice(env.LOCKDOWN_KV, {
      device_id: deviceIdHex,
      status: 'locked',
      enrolled_at: '2026-01-01T00:00:00Z',
    });

    const request = new Request('https://example.com/v1/override/response', {
      method: 'POST',
      body: JSON.stringify({
        device_id: deviceIdHex,
        challenge: 'dGVzdA==',
        response: 'dGVzdA==',
      }),
    });
    const response = await handleOverrideResponse(request, env, keys);
    expect(response.status).toBe(400);
  });

  it('returns UNLOCKED COSE_Sign1 after valid challenge/response', async () => {
    // First request a challenge
    const challengeSeed = 'aabbccdd'.repeat(4);
    const challengeReq = new Request('https://example.com/v1/override/challenge', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceIdHex, challenge_seed: challengeSeed }),
    });
    const challengeResp = await handleOverrideChallenge(challengeReq, env);
    expect(challengeResp.status).toBe(200);
    const challengeBody = await challengeResp.json();
    const challenge = challengeBody.challenge;

    // Now submit the response
    const responseReq = new Request('https://example.com/v1/override/response', {
      method: 'POST',
      body: JSON.stringify({
        device_id: deviceIdHex,
        challenge: challenge,
        response: 'dGVzdA==', // dummy response — full sig verification is future work
      }),
    });
    const response = await handleOverrideResponse(responseReq, env, keys);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/cose');

    // Verify the COSE payload contains UNLOCKED verdict
    const coseBody = new Uint8Array(await response.arrayBuffer());
    const payload = extractCosePayload(coseBody);
    const dec = new CborDecoder(payload);
    const map = dec.readIntKeyedMap();

    // key 4 = verdict (should be UNLOCKED=0)
    const gotVerdict = new CborDecoder(map.get(4)!).readUint();
    expect(gotVerdict).toBe(0);

    // key 8 = reason
    const gotReason = new CborDecoder(map.get(8)!).readTstr();
    expect(gotReason).toBe('override_granted');
  });
});

// ---------------------------------------------------------------------------
// D-205: Persistent signing key in KV
// ---------------------------------------------------------------------------

describe('D-205: Persistent signing key in KV', () => {
  let kv: MockKV;

  beforeEach(() => {
    kv = new MockKV();
  });

  it('generates and stores a new key when KV is empty', async () => {
    const keys = await loadOrGenerateSigningKey(kv as unknown as KVNamespace);
    expect(keys.privateKey).toBeDefined();
    expect(keys.publicKey).toBeDefined();
    expect(keys.kid.length).toBe(32);
    expect(keys.spki.length).toBeGreaterThan(0);

    // Verify the key was stored in KV
    const stored = await kv.get('pbl_signing_key:current', 'text');
    expect(stored).toBeTruthy();
    expect(stored!.length).toBeGreaterThan(0);
  });

  it('loads the same key from KV on subsequent calls', async () => {
    // First call generates and stores
    const keys1 = await loadOrGenerateSigningKey(kv as unknown as KVNamespace);

    // Second call should load from KV
    const keys2 = await loadOrGenerateSigningKey(kv as unknown as KVNamespace);

    // Both should have the same kid (same key)
    expect(Array.from(keys2.kid)).toEqual(Array.from(keys1.kid));
    expect(Array.from(keys2.spki)).toEqual(Array.from(keys1.spki));
  });

  it('uses env PBL_SIGNING_KEY when provided (takes precedence over KV)', async () => {
    // Generate a key to get its PKCS8
    const genKeys = await generateSigningKey();
    const pkcs8 = await exportPrivateKey(genKeys.privateKey);
    const envKey = Buffer.from(pkcs8).toString('base64');

    // Store a different key in KV first
    await loadOrGenerateSigningKey(kv as unknown as KVNamespace);

    // Now load with env key — should use env key, not KV
    const keys = await loadOrGenerateSigningKey(
      kv as unknown as KVNamespace,
      envKey,
    );

    // The kid should match the env key, not the KV key
    expect(Array.from(keys.kid)).toEqual(Array.from(genKeys.kid));
  });

  it('produces consistent signatures across KV loads', async () => {
    // First call generates and stores
    const keys1 = await loadOrGenerateSigningKey(kv as unknown as KVNamespace);

    // Sign data with first key
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const sig1 = await signData(keys1.privateKey, data);

    // Second call loads from KV
    const keys2 = await loadOrGenerateSigningKey(kv as unknown as KVNamespace);

    // Verify the signature from keys1 is valid with keys2's public key
    const valid = await verifySignature(keys2.publicKey, data, sig1);
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-206: Device list and admin management
// ---------------------------------------------------------------------------

describe('D-206: listDevices', () => {
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: KVNamespace; PBL_SIGNING_KEY?: string };

  beforeAll(() => {
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-token',
      LOCKDOWN_KV: kv as unknown as KVNamespace,
    };
  });

  it('returns empty list when no devices exist', async () => {
    const devices = await listDevices(env.LOCKDOWN_KV);
    expect(devices).toEqual([]);
  });

  it('returns all stored devices', async () => {
    await putDevice(env.LOCKDOWN_KV, {
      device_id: 'aabb'.repeat(16),
      status: 'active',
      enrolled_at: '2026-01-01T00:00:00Z',
    });
    await putDevice(env.LOCKDOWN_KV, {
      device_id: 'ccdd'.repeat(16),
      status: 'locked',
      enrolled_at: '2026-01-02T00:00:00Z',
      lock_reason: 'admin_lock',
    });

    const devices = await listDevices(env.LOCKDOWN_KV);
    expect(devices.length).toBe(2);
    const ids = devices.map((d) => d.device_id);
    expect(ids).toContain('aabb'.repeat(16));
    expect(ids).toContain('ccdd'.repeat(16));
  });
});

describe('D-206: deleteDevice', () => {
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: KVNamespace; PBL_SIGNING_KEY?: string };

  beforeAll(() => {
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-token',
      LOCKDOWN_KV: kv as unknown as KVNamespace,
    };
  });

  it('returns false for non-existent device', async () => {
    const result = await deleteDevice(env.LOCKDOWN_KV, 'ff'.repeat(32));
    expect(result).toBe(false);
  });

  it('deletes an existing device', async () => {
    const deviceId = 'eeff'.repeat(16);
    await putDevice(env.LOCKDOWN_KV, {
      device_id: deviceId,
      status: 'active',
      enrolled_at: '2026-01-01T00:00:00Z',
    });

    const result = await deleteDevice(env.LOCKDOWN_KV, deviceId);
    expect(result).toBe(true);

    // Verify device is gone
    const device = await getDevice(env.LOCKDOWN_KV, deviceId);
    expect(device).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D-206: getDevice (single device lookup)
// ---------------------------------------------------------------------------

describe('D-206: getDevice', () => {
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: KVNamespace; PBL_SIGNING_KEY?: string };

  beforeAll(() => {
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-token',
      LOCKDOWN_KV: kv as unknown as KVNamespace,
    };
  });

  it('returns null for non-existent device', async () => {
    const device = await getDevice(env.LOCKDOWN_KV, 'ff'.repeat(32));
    expect(device).toBeNull();
  });

  it('returns device for existing device_id', async () => {
    const deviceId = 'a1b2'.repeat(16);
    await putDevice(env.LOCKDOWN_KV, {
      device_id: deviceId,
      status: 'locked',
      enrolled_at: '2026-01-01T00:00:00Z',
      hostname: 'test-host',
      lock_reason: 'admin_lock',
    });

    const device = await getDevice(env.LOCKDOWN_KV, deviceId);
    expect(device).not.toBeNull();
    expect(device!.device_id).toBe(deviceId);
    expect(device!.status).toBe('locked');
    expect(device!.hostname).toBe('test-host');
    expect(device!.lock_reason).toBe('admin_lock');
  });
});

// ---------------------------------------------------------------------------
// D-210: Rate limiting tests
// ---------------------------------------------------------------------------

describe('D-210: Rate limiting (per-device + per-IP)', () => {
  let kv: MockKV;
  let env: { ADMIN_TOKEN: string; LOCKDOWN_KV: KVNamespace; PBL_SIGNING_KEY?: string };

  beforeEach(() => {
    kv = new MockKV();
    env = {
      ADMIN_TOKEN: 'test-token',
      LOCKDOWN_KV: kv as unknown as KVNamespace,
    };
  });

  it('checkDeviceRateLimit allows requests under the limit', async () => {
    const config = { maxRequests: 5, windowSeconds: 60 };
    for (let i = 0; i < 5; i++) {
      const result = await checkDeviceRateLimit(env.LOCKDOWN_KV, 'a1b2c3d4'.repeat(8), 'verdict', config);
      expect(result.allowed).toBe(true);
    }
  });

  it('checkDeviceRateLimit blocks requests over the limit', async () => {
    const config = { maxRequests: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i++) {
      const result = await checkDeviceRateLimit(env.LOCKDOWN_KV, 'a1b2c3d4'.repeat(8), 'verdict', config);
      expect(result.allowed).toBe(true);
    }
    const result = await checkDeviceRateLimit(env.LOCKDOWN_KV, 'a1b2c3d4'.repeat(8), 'verdict', config);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfter).toBeGreaterThan(0);
    }
  });

  it('checkDeviceRateLimit tracks per device independently', async () => {
    const config = { maxRequests: 2, windowSeconds: 60 };
    const dev1 = 'a1b2c3d4'.repeat(8);
    const dev2 = 'e5f6a7b8'.repeat(8);

    // dev1 uses both slots
    await checkDeviceRateLimit(env.LOCKDOWN_KV, dev1, 'verdict', config);
    await checkDeviceRateLimit(env.LOCKDOWN_KV, dev1, 'verdict', config);

    // dev2 should still have both slots
    const r2a = await checkDeviceRateLimit(env.LOCKDOWN_KV, dev2, 'verdict', config);
    expect(r2a.allowed).toBe(true);
    const r2b = await checkDeviceRateLimit(env.LOCKDOWN_KV, dev2, 'verdict', config);
    expect(r2b.allowed).toBe(true);

    // dev1 should be blocked
    const r1c = await checkDeviceRateLimit(env.LOCKDOWN_KV, dev1, 'verdict', config);
    expect(r1c.allowed).toBe(false);
  });

  it('checkDeviceRateLimit tracks per endpoint independently', async () => {
    const config = { maxRequests: 2, windowSeconds: 60 };
    const dev = 'a1b2c3d4'.repeat(8);

    // Use both verdict slots
    await checkDeviceRateLimit(env.LOCKDOWN_KV, dev, 'verdict', config);
    await checkDeviceRateLimit(env.LOCKDOWN_KV, dev, 'verdict', config);

    // attest should still have slots
    const result = await checkDeviceRateLimit(env.LOCKDOWN_KV, dev, 'attest', config);
    expect(result.allowed).toBe(true);
  });

  it('checkIpRateLimit tracks per IP independently', async () => {
    const config = { maxRequests: 2, windowSeconds: 60 };
    const req1 = new Request('https://example.com/v1/devices', {
      headers: { 'CF-Connecting-IP': '10.0.0.1' },
    });
    const req2 = new Request('https://example.com/v1/devices', {
      headers: { 'CF-Connecting-IP': '10.0.0.2' },
    });

    // IP1 uses both slots
    await checkIpRateLimit(env.LOCKDOWN_KV, req1, 'devices', config);
    await checkIpRateLimit(env.LOCKDOWN_KV, req1, 'devices', config);

    // IP2 should still have both slots
    const r2a = await checkIpRateLimit(env.LOCKDOWN_KV, req2, 'devices', config);
    expect(r2a.allowed).toBe(true);

    // IP1 should be blocked
    const r1c = await checkIpRateLimit(env.LOCKDOWN_KV, req1, 'devices', config);
    expect(r1c.allowed).toBe(false);
  });

  it('rateLimitResponse returns 429 with Retry-After', () => {
    const resp = rateLimitResponse(30);
    expect(resp.status).toBe(429);
    expect(resp.headers.get('Retry-After')).toBe('30');
  });

  it('DEVICE_RATE_LIMITS has configs for firmware endpoints', () => {
    expect(DEVICE_RATE_LIMITS.verdict).toBeDefined();
    expect(DEVICE_RATE_LIMITS.attest).toBeDefined();
    expect(DEVICE_RATE_LIMITS.enroll).toBeDefined();
  });

  it('IP_RATE_LIMITS has configs for admin endpoints', () => {
    expect(IP_RATE_LIMITS.devices).toBeDefined();
  });

  it('policy and health have no rate limit configs (edge-cached/trivial)', () => {
    expect(DEVICE_RATE_LIMITS.policy).toBeUndefined();
    expect(DEVICE_RATE_LIMITS.health).toBeUndefined();
    expect(IP_RATE_LIMITS.policy).toBeUndefined();
    expect(IP_RATE_LIMITS.health).toBeUndefined();
  });

  it('rate limit window resets after expiry', async () => {
    const config = { maxRequests: 1, windowSeconds: 1 };
    const dev = 'a1b2c3d4'.repeat(8);

    const r1 = await checkDeviceRateLimit(env.LOCKDOWN_KV, dev, 'verdict', config);
    expect(r1.allowed).toBe(true);

    const r2 = await checkDeviceRateLimit(env.LOCKDOWN_KV, dev, 'verdict', config);
    expect(r2.allowed).toBe(false);

    // Wait for window to expire
    await new Promise(resolve => setTimeout(resolve, 1100));

    const r3 = await checkDeviceRateLimit(env.LOCKDOWN_KV, dev, 'verdict', config);
    expect(r3.allowed).toBe(true);
  });
});
