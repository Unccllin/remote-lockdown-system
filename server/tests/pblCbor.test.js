/**
 * D-207: CBOR encoder/decoder tests for the Express server-side module.
 *
 * Tests negative integer (nint) encoding/decoding, plus round-trip tests
 * for all supported types. The serverless module already has nint tests
 * (pbl.test.ts), but the Express server-side module (server/src/pbl/cbor.js)
 * had no dedicated tests.
 */

const cbor = require('../src/pbl/cbor');

describe('D-207: CBOR encodeNint (negative integers)', () => {
  it('encodes -1 as 0x20', () => {
    expect(cbor.encodeNint(-1)).toEqual(Buffer.from([0x20]));
  });

  it('encodes -10 as 0x29', () => {
    expect(cbor.encodeNint(-10)).toEqual(Buffer.from([0x29]));
  });

  it('encodes -24 as 0x37', () => {
    expect(cbor.encodeNint(-24)).toEqual(Buffer.from([0x37]));
  });

  it('encodes -25 as 0x38 0x18 (1-byte additional info)', () => {
    expect(cbor.encodeNint(-25)).toEqual(Buffer.from([0x38, 0x18]));
  });

  it('encodes -100 as 0x38 0x63', () => {
    expect(cbor.encodeNint(-100)).toEqual(Buffer.from([0x38, 0x63]));
  });

  it('encodes -256 as 0x38 0xff (1-byte additional info)', () => {
    // -256 → abs = 255 → fits in 1 byte
    expect(cbor.encodeNint(-256)).toEqual(Buffer.from([0x38, 0xff]));
  });

  it('encodes -1000 as 0x39 0x03 0xe7', () => {
    expect(cbor.encodeNint(-1000)).toEqual(Buffer.from([0x39, 0x03, 0xe7]));
  });

  it('encodes -65537 as 0x3a 0x00 0x01 0x00 0x00 (4-byte)', () => {
    // -65537 → abs = 65536 → needs 4 bytes
    expect(cbor.encodeNint(-65537)).toEqual(Buffer.from([0x3a, 0x00, 0x01, 0x00, 0x00]));
  });
});

describe('D-207: CBOR decode (negative integers)', () => {
  it('decodes 0x20 as -1', () => {
    const result = cbor.decode(Buffer.from([0x20]), 0);
    expect(result.value).toBe(-1);
  });

  it('decodes 0x29 as -10', () => {
    const result = cbor.decode(Buffer.from([0x29]), 0);
    expect(result.value).toBe(-10);
  });

  it('decodes 0x38 0x18 as -25', () => {
    const result = cbor.decode(Buffer.from([0x38, 0x18]), 0);
    expect(result.value).toBe(-25);
  });

  it('decodes 0x39 0x03 0xe7 as -1000', () => {
    const result = cbor.decode(Buffer.from([0x39, 0x03, 0xe7]), 0);
    expect(result.value).toBe(-1000);
  });
});

describe('D-207: CBOR round-trip (all supported types)', () => {
  it('round-trips unsigned integers', () => {
    for (const v of [0, 1, 23, 24, 100, 255, 256, 10000, 65535, 65536]) {
      const encoded = cbor.encodeUint(v);
      const decoded = cbor.decodeFirst(encoded);
      expect(decoded).toBe(v);
    }
  });

  it('round-trips negative integers', () => {
    for (const v of [-1, -10, -24, -25, -100, -256, -1000, -65537]) {
      const encoded = cbor.encodeNint(v);
      const decoded = cbor.decodeFirst(encoded);
      expect(decoded).toBe(v);
    }
  });

  it('round-trips byte strings', () => {
    const data = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const encoded = cbor.encodeBstr(data);
    const decoded = cbor.decodeFirst(encoded);
    expect(decoded).toEqual(data);
  });

  it('round-trips text strings', () => {
    const str = 'hello world';
    const encoded = cbor.encodeTstr(str);
    const decoded = cbor.decodeFirst(encoded);
    expect(decoded).toBe(str);
  });

  it('round-trips booleans', () => {
    expect(cbor.decodeFirst(cbor.encodeBool(true))).toBe(true);
    expect(cbor.decodeFirst(cbor.encodeBool(false))).toBe(false);
  });

  it('round-trips null', () => {
    expect(cbor.decodeFirst(cbor.encodeNull())).toBeNull();
  });

  it('round-trips arrays', () => {
    const items = [cbor.encodeUint(1), cbor.encodeUint(2), cbor.encodeUint(3)];
    const encoded = cbor.encodeArray(items);
    const decoded = cbor.decodeFirst(encoded);
    expect(decoded).toEqual([1, 2, 3]);
  });

  it('round-trips maps with integer keys', () => {
    const pairs = [
      [cbor.encodeUint(1), cbor.encodeTstr('hello')],
      [cbor.encodeUint(2), cbor.encodeUint(42)],
    ];
    const encoded = cbor.encodeMap(pairs);
    const decoded = cbor.decodeFirst(encoded);
    expect(decoded.get(1)).toBe('hello');
    expect(decoded.get(2)).toBe(42);
  });

  it('round-trips maps with negative integer keys (COSE alg IDs)', () => {
    // COSE uses negative integers for algorithm IDs: -7 (ES256), -8 (Ed25519)
    const pairs = [
      [cbor.encodeNint(-7), cbor.encodeTstr('ES256')],
      [cbor.encodeNint(-8), cbor.encodeTstr('Ed25519')],
    ];
    const encoded = cbor.encodeMap(pairs);
    const decoded = cbor.decodeFirst(encoded);
    expect(decoded.get(-7)).toBe('ES256');
    expect(decoded.get(-8)).toBe('Ed25519');
  });
});

describe('D-207: CBOR edge cases', () => {
  it('encodes empty byte string', () => {
    const encoded = cbor.encodeBstr(Buffer.alloc(0));
    expect(encoded).toEqual(Buffer.from([0x40]));
    expect(cbor.decodeFirst(encoded)).toEqual(Buffer.alloc(0));
  });

  it('encodes empty text string', () => {
    const encoded = cbor.encodeTstr('');
    expect(encoded).toEqual(Buffer.from([0x60]));
    expect(cbor.decodeFirst(encoded)).toBe('');
  });

  it('encodes empty array', () => {
    const encoded = cbor.encodeArray([]);
    expect(encoded).toEqual(Buffer.from([0x80]));
    expect(cbor.decodeFirst(encoded)).toEqual([]);
  });

  it('encodes empty map', () => {
    const encoded = cbor.encodeMap([]);
    expect(encoded).toEqual(Buffer.from([0xa0]));
    const decoded = cbor.decodeFirst(encoded);
    expect(decoded.size).toBe(0);
  });

  it('handles large unsigned integer (4-byte)', () => {
    const v = 0x12345678;
    const encoded = cbor.encodeUint(v);
    expect(encoded).toEqual(Buffer.from([0x1a, 0x12, 0x34, 0x56, 0x78]));
    expect(cbor.decodeFirst(encoded)).toBe(v);
  });
});
