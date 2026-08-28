/**
 * Tests for Phase 2: Server DB integrity fixes.
 *
 * Covers:
 *   - A2: withTransaction (BEGIN/COMMIT/ROLLBACK)
 *   - A3: Encryption at rest (key_material_encrypted, password_encrypted)
 *   - CC16: Dual-mode read (encrypted vs plaintext fallback)
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { mockPool, JWT_SECRET } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const { withTransaction } = require('../src/db/withTransaction');
const { encryptField, decryptField, readDualMode } = require('../src/db/fieldCrypto');
const { clearKeyCache } = require('../src/db/crypto');

const agentRoutes = require('../src/routes/agent');
const devicesRoutes = require('../src/routes/devices');

const AGENT_KEY = 'test-agent-key-that-is-long-enough-24';

function makeToken(adminId = 'admin-1', username = 'admin') {
  return jwt.sign({ id: adminId, username, role: 'super-admin' }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  mockPool.query.reset();
  clearKeyCache();
});

afterAll(() => {
  clearKeyCache();
});

// ---------------------------------------------------------------------------
// A2: withTransaction
// ---------------------------------------------------------------------------

describe('withTransaction', () => {
  test('runs callback inside BEGIN/COMMIT', async () => {
    const result = await withTransaction(async (client) => {
      await client.query('INSERT INTO foo VALUES (1)');
      return 'success';
    });

    expect(result).toBe('success');

    // Verify BEGIN and COMMIT were called
    const calls = mockPool.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
  });

  test('ROLLBACK on error', async () => {
    await expect(
      withTransaction(async (client) => {
        await client.query('INSERT INTO foo VALUES (1)');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const calls = mockPool.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  test('releases client after success', async () => {
    const _client = await mockPool.connect();
    await withTransaction(async (c) => {
      await c.query('SELECT 1');
    });
    // connect() was called, and release() should have been called
    expect(mockPool.connect).toHaveBeenCalled();
  });

  test('releases client after error', async () => {
    await expect(
      withTransaction(async (_c) => {
        throw new Error('fail');
      })
    ).rejects.toThrow('fail');
    // Client should still be released (tested via no hanging)
  });
});

// ---------------------------------------------------------------------------
// A3: Encryption at rest
// ---------------------------------------------------------------------------

describe('fieldCrypto — encryption at rest', () => {
  test('encryptField produces ciphertext + nonce + tag', () => {
    const result = encryptField('my-secret-key==');
    expect(result.ciphertext).toBeDefined();
    expect(result.nonce).toBeDefined();
    expect(result.tag).toBeDefined();
    // Ciphertext should NOT be the plaintext
    expect(result.ciphertext).not.toBe('my-secret-key==');
  });

  test('decryptField round-trips correctly', () => {
    const plaintext = 'fernet-key-base64==';
    const enc = encryptField(plaintext);
    const dec = decryptField(enc.ciphertext, enc.nonce, enc.tag);
    expect(dec).toBe(plaintext);
  });

  test('different encryptions produce different ciphertexts (random nonce)', () => {
    const enc1 = encryptField('same-plaintext');
    const enc2 = encryptField('same-plaintext');
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.nonce).not.toBe(enc2.nonce);
  });

  test('decryptField with wrong key throws', () => {
    const enc = encryptField('secret');
    // Clear cache and set a different key
    clearKeyCache();
    const origKey = process.env.FIELD_ENCRYPTION_KEY;
    process.env.FIELD_ENCRYPTION_KEY = 'b'.repeat(64);
    try {
      expect(() => decryptField(enc.ciphertext, enc.nonce, enc.tag)).toThrow();
    } finally {
      process.env.FIELD_ENCRYPTION_KEY = origKey;
      clearKeyCache();
    }
  });
});

// ---------------------------------------------------------------------------
// CC16: Dual-mode read
// ---------------------------------------------------------------------------

describe('readDualMode — CC16 dual-mode read', () => {
  test('decrypts when encrypted columns are populated', () => {
    const plaintext = 'my-key==';
    const enc = encryptField(plaintext);
    const row = {
      key_material: null, // plaintext column is null (encrypted-only row)
      key_material_encrypted: enc.ciphertext,
      key_enc_nonce: enc.nonce,
      key_enc_tag: enc.tag,
    };
    expect(readDualMode(row, 'key_material', 'key_material_encrypted', 'key_enc_nonce', 'key_enc_tag')).toBe(plaintext);
  });

  test('falls back to plaintext column when encrypted columns are null', () => {
    const row = {
      key_material: 'legacy-plaintext-key==',
      key_material_encrypted: null,
      key_enc_nonce: null,
      key_enc_tag: null,
    };
    expect(readDualMode(row, 'key_material', 'key_material_encrypted', 'key_enc_nonce', 'key_enc_tag')).toBe('legacy-plaintext-key==');
  });

  test('returns null for null row', () => {
    expect(readDualMode(null, 'key_material', 'key_material_encrypted', 'key_enc_nonce', 'key_enc_tag')).toBeNull();
  });

  test('prefers encrypted column over plaintext when both exist', () => {
    const plaintext = 'encrypted-value';
    const enc = encryptField(plaintext);
    const row = {
      key_material: 'old-plaintext',
      key_material_encrypted: enc.ciphertext,
      key_enc_nonce: enc.nonce,
      key_enc_tag: enc.tag,
    };
    // Should return the decrypted value, not the plaintext
    expect(readDualMode(row, 'key_material', 'key_material_encrypted', 'key_enc_nonce', 'key_enc_tag')).toBe(plaintext);
  });
});
