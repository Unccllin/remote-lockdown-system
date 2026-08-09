/**
 * Tests for src/db/apiKey.js — per-device API key generation and verification.
 *
 * Covers:
 *   - generateApiKey produces 44-char base64 (32 bytes)
 *   - hashApiKey is deterministic (same key + pepper = same hash)
 *   - hashApiKey changes with different pepper
 *   - hashApiKey throws without pepper
 *   - verifyApiKey returns true for matching key
 *   - verifyApiKey returns false for non-matching key
 *   - verifySharedKey returns true/false for correct/wrong shared key
 */

const { generateApiKey, hashApiKey, verifyApiKey, verifySharedKey } = require('../src/db/apiKey');

const PEPPER = 'test-pepper-value-that-is-long-enough-32';

describe('apiKey.js', () => {
  beforeEach(() => {
    delete process.env.AGENT_KEY_PEPPER;
    delete process.env.AGENT_KEY_PEPPER_FILE;
    delete process.env.AGENT_SHARED_KEY;
    process.env.AGENT_KEY_PEPPER = PEPPER;
  });

  afterEach(() => {
    delete process.env.AGENT_KEY_PEPPER;
    delete process.env.AGENT_KEY_PEPPER_FILE;
    delete process.env.AGENT_SHARED_KEY;
  });

  test('generateApiKey produces 44-char base64 string (32 bytes encoded)', () => {
    const key = generateApiKey();
    expect(typeof key).toBe('string');
    expect(key.length).toBe(44);
    // base64 of 32 bytes -> 44 chars (with padding)
    expect(Buffer.from(key, 'base64').length).toBe(32);
  });

  test('hashApiKey is deterministic (same key + pepper = same hash)', () => {
    const key = generateApiKey();
    const h1 = hashApiKey(key);
    const h2 = hashApiKey(key);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  test('hashApiKey changes with different pepper', () => {
    const key = generateApiKey();
    const h1 = hashApiKey(key);
    process.env.AGENT_KEY_PEPPER = 'a-different-pepper-value-that-is-long-32';
    const h2 = hashApiKey(key);
    expect(h1).not.toBe(h2);
  });

  test('hashApiKey throws without pepper (AGENT_KEY_PEPPER not set)', () => {
    delete process.env.AGENT_KEY_PEPPER;
    delete process.env.AGENT_SHARED_KEY;
    expect(() => hashApiKey('some-key')).toThrow(/must be set/);
  });

  test('verifyApiKey returns true for matching key', () => {
    const key = generateApiKey();
    const storedHash = hashApiKey(key);
    expect(verifyApiKey(key, storedHash)).toBe(true);
  });

  test('verifyApiKey returns false for non-matching key', () => {
    const key = generateApiKey();
    const storedHash = hashApiKey(key);
    const wrongKey = generateApiKey();
    expect(verifyApiKey(wrongKey, storedHash)).toBe(false);
  });

  test('verifySharedKey returns true for correct shared key, false for wrong', () => {
    const sharedKey = 'the-real-shared-key-value-for-testing';
    expect(verifySharedKey(sharedKey, sharedKey)).toBe(true);
    expect(verifySharedKey('wrong-key', sharedKey)).toBe(false);
  });
});
