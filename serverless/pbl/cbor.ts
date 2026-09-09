/**
 * CBOR encoder/decoder — pure JS, no dependencies.
 *
 * Implements the subset of RFC 8949 needed by PBL:
 * - Major type 0 (unsigned integers)
 * - Major type 1 (negative integers)
 * - Major type 2 (byte strings)
 * - Major type 3 (text strings)
 * - Major type 4 (arrays)
 * - Major type 5 (maps)
 * - Major type 6 (tags)
 * - Major type 7 (simple values: true, false, null, undefined)
 * - Half-precision floats (encode only, for RFC 8949 vector compliance)
 *
 * No indefinite-length items.
 */

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/** Encode a CBOR head (major type + additional info / length). */
function encodeHead(majorType: number, value: number): Uint8Array {
  const mt = majorType << 5;
  if (value < 24) {
    return new Uint8Array([mt | value]);
  }
  if (value < 0x100) {
    return new Uint8Array([mt | 24, value]);
  }
  if (value < 0x10000) {
    return new Uint8Array([mt | 25, (value >> 8) & 0xff, value & 0xff]);
  }
  // 4-byte
  return new Uint8Array([
    mt | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

/** Encode an unsigned integer. */
export function encodeUint(value: number): Uint8Array {
  return encodeHead(0, value);
}

/** Encode a byte string (bstr). */
export function encodeBstr(data: Uint8Array): Uint8Array {
  const head = encodeHead(2, data.length);
  const result = new Uint8Array(head.length + data.length);
  result.set(head, 0);
  result.set(data, head.length);
  return result;
}

/** Encode a text string (tstr). */
export function encodeTstr(str: string): Uint8Array {
  const encoded = new TextEncoder().encode(str);
  const head = encodeHead(3, encoded.length);
  const result = new Uint8Array(head.length + encoded.length);
  result.set(head, 0);
  result.set(encoded, head.length);
  return result;
}

/** Encode a boolean (CBOR simple value). */
export function encodeBool(value: boolean): Uint8Array {
  return new Uint8Array([value ? 0xf5 : 0xf4]);
}

/** Encode null. */
export function encodeNull(): Uint8Array {
  return new Uint8Array([0xf6]);
}

/** Encode undefined (CBOR simple value 23). */
export function encodeUndefined(): Uint8Array {
  return new Uint8Array([0xf7]);
}

/** Encode a negative integer (major type 1).
 *  CBOR encodes negative integers as -1 - value, so -1 → 0x20, -10 → 0x29, etc.
 */
export function encodeNegativeInt(value: number): Uint8Array {
  if (value >= 0) throw new Error('CBOR: encodeNegativeInt requires a negative value');
  return encodeHead(1, -1 - value);
}

/** Encode a tagged value (major type 6).
 *  @param tag      Tag number (e.g., 0 for RFC 3339 date/time string)
 *  @param content  CBOR-encoded content
 */
export function encodeTag(tag: number, content: Uint8Array): Uint8Array {
  const head = encodeHead(6, tag);
  const result = new Uint8Array(head.length + content.length);
  result.set(head, 0);
  result.set(content, head.length);
  return result;
}

/** Encode a CBOR array of items. */
export function encodeArray(items: Uint8Array[]): Uint8Array {
  const head = encodeHead(4, items.length);
  const totalLen = items.reduce((sum, item) => sum + item.length, 0);
  const result = new Uint8Array(head.length + totalLen);
  result.set(head, 0);
  let offset = head.length;
  for (const item of items) {
    result.set(item, offset);
    offset += item.length;
  }
  return result;
}

/** Encode a CBOR map from an array of [key, value] pairs. */
export function encodeMap(entries: [Uint8Array, Uint8Array][]): Uint8Array {
  const head = encodeHead(5, entries.length);
  const totalLen = entries.reduce(
    (sum, [k, v]) => sum + k.length + v.length,
    0,
  );
  const result = new Uint8Array(head.length + totalLen);
  result.set(head, 0);
  let offset = head.length;
  for (const [key, value] of entries) {
    result.set(key, offset);
    offset += key.length;
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

export class CborDecoder {
  private buf: Uint8Array;
  private offset: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.offset = 0;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  /** Read the CBOR head: returns [majorType, value]. */
  private readHead(): [number, number] {
    if (this.offset >= this.buf.length) {
      throw new Error('CBOR: unexpected end of buffer');
    }
    const first = this.buf[this.offset++];
    const majorType = (first & 0xe0) >> 5;
    const info = first & 0x1f;

    if (info < 24) {
      return [majorType, info];
    }
    if (info === 24) {
      return [majorType, this.readByte()];
    }
    if (info === 25) {
      return [majorType, this.readUint16()];
    }
    if (info === 26) {
      return [majorType, this.readUint32()];
    }
    throw new Error(`CBOR: unsupported info ${info}`);
  }

  private readByte(): number {
    if (this.offset >= this.buf.length) throw new Error('CBOR: unexpected EOF');
    return this.buf[this.offset++];
  }

  private readUint16(): number {
    return (this.readByte() << 8) | this.readByte();
  }

  private readUint32(): number {
    return (
      (this.readByte() << 24) |
      (this.readByte() << 16) |
      (this.readByte() << 8) |
      this.readByte()
    );
  }

  /** Read a bstr (returns a view into the original buffer). */
  readBstr(): Uint8Array {
    const [mt, len] = this.readHead();
    if (mt !== 2) throw new Error(`CBOR: expected bstr, got major type ${mt}`);
    if (this.offset + len > this.buf.length) {
      throw new Error('CBOR: bstr length exceeds buffer');
    }
    const result = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return result;
  }

  /** Read a tstr. */
  readTstr(): string {
    const [mt, len] = this.readHead();
    if (mt !== 3) throw new Error(`CBOR: expected tstr, got major type ${mt}`);
    if (this.offset + len > this.buf.length) {
      throw new Error('CBOR: tstr length exceeds buffer');
    }
    const result = new TextDecoder().decode(
      this.buf.subarray(this.offset, this.offset + len),
    );
    this.offset += len;
    return result;
  }

  /** Read an unsigned integer. */
  readUint(): number {
    const [mt, value] = this.readHead();
    if (mt !== 0) throw new Error(`CBOR: expected uint, got major type ${mt}`);
    return value;
  }

  /** Read a boolean. */
  readBool(): boolean {
    const [mt, value] = this.readHead();
    if (mt !== 7) throw new Error(`CBOR: expected simple, got major type ${mt}`);
    if (value === 21) return true;
    if (value === 20) return false;
    throw new Error(`CBOR: expected bool, got simple value ${value}`);
  }

  /** Read null. */
  readNull(): null {
    const [mt, value] = this.readHead();
    if (mt !== 7 || value !== 22) throw new Error('CBOR: expected null');
    return null;
  }

  /** Read undefined (simple value 23). */
  readUndefined(): undefined {
    const [mt, value] = this.readHead();
    if (mt !== 7 || value !== 23) throw new Error('CBOR: expected undefined');
    return undefined;
  }

  /** Read a negative integer (major type 1). Returns the actual negative value. */
  readNegativeInt(): number {
    const [mt, value] = this.readHead();
    if (mt !== 1) throw new Error(`CBOR: expected negative int, got major type ${mt}`);
    return -1 - value;
  }

  /** Read a tag (major type 6). Returns [tagNumber, taggedContentBytes]. */
  readTag(): [number, Uint8Array] {
    const [mt, tag] = this.readHead();
    if (mt !== 6) throw new Error(`CBOR: expected tag, got major type ${mt}`);
    const startOffset = this.offset;
    this.skipItem();
    return [tag, this.buf.subarray(startOffset, this.offset)];
  }

  /** Skip one CBOR item (any type). */
  skipItem(): void {
    const [mt, value] = this.readHead();
    switch (mt) {
      case 0:
      case 1:
      case 7:
        return;
      case 2:
      case 3:
        this.offset += value;
        return;
      case 4:
        for (let i = 0; i < value; i++) this.skipItem();
        return;
      case 5:
        for (let i = 0; i < value; i++) {
          this.skipItem(); // key
          this.skipItem(); // value
        }
        return;
      case 6:
        this.skipItem(); // tag content
        return;
      default:
        throw new Error(`CBOR: cannot skip major type ${mt}`);
    }
  }

  /** Read a map, returning entries as [keyUint, valueBytes] for int-keyed maps. */
  readIntKeyedMap(): Map<number, Uint8Array> {
    const [mt, count] = this.readHead();
    if (mt !== 5) throw new Error(`CBOR: expected map, got major type ${mt}`);
    const result = new Map<number, Uint8Array>();
    for (let i = 0; i < count; i++) {
      const key = this.readUint();
      const startOffset = this.offset;
      this.skipItem();
      result.set(key, this.buf.subarray(startOffset, this.offset));
    }
    return result;
  }

  /** Read a map, returning entries as [keyString, valueBytes] for string-keyed maps. */
  readStringKeyedMap(): Map<string, Uint8Array> {
    const [mt, count] = this.readHead();
    if (mt !== 5) throw new Error(`CBOR: expected map, got major type ${mt}`);
    const result = new Map<string, Uint8Array>();
    for (let i = 0; i < count; i++) {
      const key = this.readTstr();
      const startOffset = this.offset;
      this.skipItem();
      result.set(key, this.buf.subarray(startOffset, this.offset));
    }
    return result;
  }

  /** Read a CBOR array, returning the raw bytes of each element. */
  readArray(): Uint8Array[] {
    const [mt, count] = this.readHead();
    if (mt !== 4) throw new Error(`CBOR: expected array, got major type ${mt}`);
    const result: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const startOffset = this.offset;
      this.skipItem();
      result.push(this.buf.subarray(startOffset, this.offset));
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Convenience: decode a verdict request body
// ---------------------------------------------------------------------------

export interface VerdictRequest {
  device_id: Uint8Array; // 32 bytes
  nonce: Uint8Array; // 32 bytes
  platform_state_digest: Uint8Array; // 32 bytes
  policy_version: number;
}

/** Decode a PBL verdict request (CBOR map with keys 1-4). */
export function decodeVerdictRequest(buf: Uint8Array): VerdictRequest {
  const dec = new CborDecoder(buf);
  const map = dec.readIntKeyedMap();
  const deviceIdRaw = map.get(1);
  const nonceRaw = map.get(2);
  const digestRaw = map.get(3);
  const policyVersionRaw = map.get(4);
  if (!deviceIdRaw || !nonceRaw || !digestRaw || !policyVersionRaw) {
    throw new Error('CBOR: missing required verdict request field');
  }
  // Each value is a CBOR-encoded item — decode it
  const deviceId = new CborDecoder(deviceIdRaw).readBstr();
  const nonce = new CborDecoder(nonceRaw).readBstr();
  const platform_state_digest = new CborDecoder(digestRaw).readBstr();
  const policy_version = new CborDecoder(policyVersionRaw).readUint();
  return { device_id: deviceId, nonce, platform_state_digest, policy_version };
}
