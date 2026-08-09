/**
 * Tests for src/db/crypto.js — AES-256-GCM field encryption primitives.
 *
 * Covers:
 *   - resolveKey from env (hex format)
 *   - resolveKey from env (base64 format)
 *   - resolveKey from _FILE path
 *   - resolveKey throws on missing env var
 *   - resolveKey throws on invalid key length
 *   - getKey caches resolved key
 *   - clearKeyCache clears cache
 *   - encrypt/decrypt roundtrip
 *   - decrypt throws on wrong key (auth tag failure)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveKey, getKey, clearKeyCache, encrypt, decrypt } = require('../src/db/crypto');

const VALID_HEX_KEY = 'a'.repeat(64); // 32 bytes
const VALID_B64_KEY = Buffer.alloc(32, 0xab).toString('base64'); // 44 chars

describe('crypto.js', () => {
  beforeEach(() => {
    clearKeyCache();
    delete process.env.FIELD_ENCRYPTION_KEY;
    delete process.env.FIELD_ENCRYPTION_KEY_FILE;
    delete process.env.CUSTOM_KEY;
    delete process.env.CUSTOM_KEY_FILE;
  });

  afterEach(() => {
    clearKeyCache();
    delete process.env.FIELD_ENCRYPTION_KEY;
    delete process.env.FIELD_ENCRYPTION_KEY_FILE;
    delete process.env.CUSTOM_KEY;
    delete process.env.CUSTOM_KEY_FILE;
  });

  describe('resolveKey', () => {
    test('reads hex format (64 hex chars = 32 bytes) from env var', () => {
      process.env.FIELD_ENCRYPTION_KEY = VALID_HEX_KEY;
      const key = resolveKey('FIELD_ENCRYPTION_KEY');
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    test('reads base64 format (44 base64 chars = 32 bytes) from env var', () => {
      process.env.FIELD_ENCRYPTION_KEY = VALID_B64_KEY;
      const key = resolveKey('FIELD_ENCRYPTION_KEY');
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    test('reads from _FILE path (temp file)', () => {
      const tmp = path.join(os.tmpdir(), `crypto-test-${Date.now()}.key`);
      fs.writeFileSync(tmp, VALID_HEX_KEY);
      process.env.FIELD_ENCRYPTION_KEY_FILE = tmp;
      const key = resolveKey('FIELD_ENCRYPTION_KEY');
      expect(key.length).toBe(32);
      fs.unlinkSync(tmp);
    });

    test('throws on missing env var', () => {
      expect(() => resolveKey('FIELD_ENCRYPTION_KEY')).toThrow(/is required/);
    });

    test('throws on invalid key length (too short)', () => {
      process.env.FIELD_ENCRYPTION_KEY = 'short';
      expect(() => resolveKey('FIELD_ENCRYPTION_KEY')).toThrow(/32-byte/);
    });
  });

  describe('getKey / clearKeyCache', () => {
    test('getKey caches resolved key (same Buffer reference returned)', () => {
      process.env.CUSTOM_KEY = VALID_HEX_KEY;
      const k1 = getKey('CUSTOM_KEY');
      const k2 = getKey('CUSTOM_KEY');
      expect(k1).toBe(k2); // Same object reference = cached
    });

    test('clearKeyCache clears cache (new Buffer returned after clear)', () => {
      process.env.CUSTOM_KEY = VALID_HEX_KEY;
      const k1 = getKey('CUSTOM_KEY');
      clearKeyCache();
      const k2 = getKey('CUSTOM_KEY');
      expect(k1).not.toBe(k2); // Different object reference = cache was cleared
      expect(k1.equals(k2)).toBe(true); // But same key value
    });
  });

  describe('encrypt / decrypt', () => {
    test('roundtrip: encrypt then decrypt returns original plaintext', () => {
      process.env.FIELD_ENCRYPTION_KEY = VALID_HEX_KEY;
      const key = getKey('FIELD_ENCRYPTION_KEY');
      const plaintext = 'sensitive-data-123';
      const { ciphertext, nonce, tag } = encrypt(plaintext, key);
      expect(ciphertext).not.toBe(plaintext);
      const decrypted = decrypt(ciphertext, nonce, key, tag);
      expect(decrypted).toBe(plaintext);
    });

    test('decrypt throws on wrong key (auth tag verification failure)', () => {
      process.env.FIELD_ENCRYPTION_KEY = VALID_HEX_KEY;
      const key = getKey('FIELD_ENCRYPTION_KEY');
      const { ciphertext, nonce, tag } = encrypt('secret', key);
      const wrongKey = Buffer.alloc(32, 0xff);
      expect(() => decrypt(ciphertext, nonce, wrongKey, tag)).toThrow();
    });
  });
});
