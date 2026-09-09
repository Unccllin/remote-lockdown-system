/**
 * Minimal CBOR encoder/decoder for server-side PBL routes (D-200).
 *
 * This is a JavaScript port of the essential functions from
 * `serverless/pbl/cbor.ts`, covering only the types needed by the
 * verdict, policy, and enrollment endpoints:
 *   - unsigned integers (major type 0)
 *   - byte strings (major type 2)
 *   - text strings (major type 3)
 *   - arrays (major type 4)
 *   - maps (major type 5)
 *   - negative integers (major type 1, for COSE alg IDs)
 *
 * Indefinite-length items, tags, and floats are NOT supported —
 * they are not needed by the PBL wire protocol.
 */

/** Encode an unsigned integer (major type 0). */
function encodeUint(value) {
  if (value < 24) return Buffer.from([value & 0xff]);
  if (value < 0x100) return Buffer.from([0x18, value & 0xff]);
  if (value < 0x10000) return Buffer.from([0x19, (value >> 8) & 0xff, value & 0xff]);
  return Buffer.from([0x1a, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** Encode a negative integer (major type 1). */
function encodeNint(value) {
  const abs = -value - 1;
  if (abs < 24) return Buffer.from([0x20 | abs]);
  if (abs < 0x100) return Buffer.from([0x38, abs & 0xff]);
  if (abs < 0x10000) return Buffer.from([0x39, (abs >> 8) & 0xff, abs & 0xff]);
  return Buffer.from([0x3a, (abs >>> 24) & 0xff, (abs >>> 16) & 0xff, (abs >>> 8) & 0xff, abs & 0xff]);
}

/** Encode a byte string (major type 2). */
function encodeBstr(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let header;
  if (buf.length < 24) header = Buffer.from([0x40 | buf.length]);
  else if (buf.length < 0x100) header = Buffer.from([0x58, buf.length & 0xff]);
  else if (buf.length < 0x10000) header = Buffer.from([0x59, (buf.length >> 8) & 0xff, buf.length & 0xff]);
  else header = Buffer.from([0x5a, (buf.length >>> 24) & 0xff, (buf.length >>> 16) & 0xff, (buf.length >>> 8) & 0xff, buf.length & 0xff]);
  return Buffer.concat([header, buf]);
}

/** Encode a text string (major type 3). */
function encodeTstr(str) {
  const buf = Buffer.from(str, 'utf8');
  let header;
  if (buf.length < 24) header = Buffer.from([0x60 | buf.length]);
  else if (buf.length < 0x100) header = Buffer.from([0x78, buf.length & 0xff]);
  else if (buf.length < 0x10000) header = Buffer.from([0x79, (buf.length >> 8) & 0xff, buf.length & 0xff]);
  else header = Buffer.from([0x7a, (buf.length >>> 24) & 0xff, (buf.length >>> 16) & 0xff, (buf.length >>> 8) & 0xff, buf.length & 0xff]);
  return Buffer.concat([header, buf]);
}

/** Encode an array of pre-encoded items (major type 4). */
function encodeArray(items) {
  let header;
  if (items.length < 24) header = Buffer.from([0x80 | items.length]);
  else if (items.length < 0x100) header = Buffer.from([0x98, items.length & 0xff]);
  else header = Buffer.from([0x99, (items.length >> 8) & 0xff, items.length & 0xff]);
  return Buffer.concat([header, ...items]);
}

/** Encode a map of [key, value] pairs (major type 5), all pre-encoded. */
function encodeMap(pairs) {
  let header;
  if (pairs.length < 24) header = Buffer.from([0xa0 | pairs.length]);
  else if (pairs.length < 0x100) header = Buffer.from([0xb8, pairs.length & 0xff]);
  else header = Buffer.from([0xb9, (pairs.length >> 8) & 0xff, pairs.length & 0xff]);
  const body = pairs.flatMap(([k, v]) => [k, v]);
  return Buffer.concat([header, ...body]);
}

/** Encode null. */
function encodeNull() {
  return Buffer.from([0xf6]);
}

/** Encode a boolean (CBOR simple values: true=21, false=20). */
function encodeBool(value) {
  return Buffer.from([value ? 0xf5 : 0xf4]);
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/** Decode a CBOR item from a buffer, returning { value, offset }. */
function decode(buf, offset = 0) {
  const byte = buf[offset];
  const majorType = byte >> 5;
  const ai = byte & 0x1f;

  let valueLen;
  if (ai < 24) {
    valueLen = ai;
    offset += 1;
  } else if (ai === 24) {
    valueLen = buf[offset + 1];
    offset += 2;
  } else if (ai === 25) {
    valueLen = (buf[offset + 1] << 8) | buf[offset + 2];
    offset += 3;
  } else if (ai === 26) {
    valueLen = (buf[offset + 1] << 24) | (buf[offset + 2] << 16) | (buf[offset + 3] << 8) | buf[offset + 4];
    offset += 5;
  } else {
    throw new Error(`CBOR: additional info ${ai} not supported`);
  }

  switch (majorType) {
    case 0: // unsigned int
      return { value: valueLen, offset };
    case 1: // negative int
      return { value: -1 - valueLen, offset };
    case 2: { // byte string
      const value = buf.subarray(offset, offset + valueLen);
      return { value: Buffer.from(value), offset: offset + valueLen };
    }
    case 3: { // text string
      const value = buf.toString('utf8', offset, offset + valueLen);
      return { value, offset: offset + valueLen };
    }
    case 4: { // array
      const items = [];
      for (let i = 0; i < valueLen; i++) {
        const result = decode(buf, offset);
        items.push(result.value);
        offset = result.offset;
      }
      return { value: items, offset };
    }
    case 5: { // map
      const map = new Map();
      for (let i = 0; i < valueLen; i++) {
        const keyResult = decode(buf, offset);
        offset = keyResult.offset;
        const valResult = decode(buf, offset);
        offset = valResult.offset;
        map.set(keyResult.value, valResult.value);
      }
      return { value: map, offset };
    }
    case 7: { // simple values
      if (ai === 20) return { value: false, offset };
      if (ai === 21) return { value: true, offset };
      if (ai === 22) return { value: null, offset };
      if (ai === 23) return { value: undefined, offset };
      throw new Error(`CBOR: simple value ${ai} not supported`);
    }
    default:
      throw new Error(`CBOR: major type ${majorType} not supported`);
  }
}

/** Decode a CBOR buffer, returning the top-level value. */
function decodeFirst(buf) {
  return decode(buf, 0).value;
}

module.exports = {
  encodeUint,
  encodeNint,
  encodeBstr,
  encodeTstr,
  encodeArray,
  encodeMap,
  encodeNull,
  encodeBool,
  decode,
  decodeFirst,
};
