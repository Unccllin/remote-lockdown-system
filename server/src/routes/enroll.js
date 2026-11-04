/**
 * Token-based device enrolment — POST /api/enroll/token + POST /api/enroll/claim.
 *
 * Why this exists
 * ---------------
 * The streamlined enrolment flow is: an admin mints a short-lived token in the
 * dashboard, then the installer runs on the target with `--token <token>` and
 * claims it. Both halves already existed in the Worker
 * (`handleEnrollToken` / `handleEnrollClaim`), and the dashboard's Enroll page
 * (`api.post('/enroll/token')`) plus `agent/installer.py --token` (which posts to
 * `/api/enroll/claim`) were written against them — but the Express server
 * implemented neither endpoint, so token enrolment 404'd on self-hosted
 * deployments (S204).
 *
 * This module implements the same contract here:
 *
 *   POST /api/enroll/token   (operator auth)
 *     → { token, expires_at, expires_in }        token shown ONCE, 15 minutes
 *
 *   POST /api/enroll/claim   (no admin auth — the token IS the credential)
 *     body: { token, hostname, owner_name?, hardware_uuid?, mac_address?, serial_number? }
 *     → 200 { device, api_key, reassociated: true }   existing hardware, new key
 *     → 201 { device, api_key }                       new device
 *     → 401 invalid / already used / expired token
 *
 * Only the SHA-256 of the token is stored. `used_at` is the single-use marker and
 * the claim updates it conditionally, so two concurrent claims cannot both win.
 */

const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateApiKey, hashApiKey } = require('../db/apiKey');

const router = express.Router();

const TOKEN_TTL_SECONDS = 15 * 60;

/** The stored form of a token: SHA-256 hex, so a DB read cannot be replayed. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Device rows carry the key hash; API responses never do. */
function publicDevice(row) {
  const { api_key_hash: _api_key_hash, ...rest } = row;
  return rest;
}

/**
 * POST /api/enroll/token — mint a single-use enrolment token.
 * Auth: operator or above (the same gate as creating a device by hand).
 */
router.post('/token', requireAuth, requireRole('operator'), async (req, res, next) => {
  try {
    const token = generateApiKey(); // 32 random bytes, base64 — high entropy
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000);

    await pool.query(
      `INSERT INTO enrollment_tokens (id, token_hash, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        crypto.randomUUID(),
        hashToken(token),
        req.admin?.id || null,
        now.toISOString(),
        expiresAt.toISOString(),
      ]
    );

    res.json({
      token, // plaintext, returned once — only the hash is stored
      expires_at: expiresAt.toISOString(),
      expires_in: TOKEN_TTL_SECONDS,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/enroll/claim — redeem a token and provision the device.
 *
 * Unauthenticated by design: the token is the credential, which is why the mount
 * carries a strict rate limit (brute-forcing a 44-character token is infeasible,
 * but the limiter keeps the endpoint from being a free oracle).
 */
router.post('/claim', async (req, res, next) => {
  const { token, hostname, owner_name, hardware_uuid, mac_address, serial_number } =
    req.body || {};

  if (typeof token !== 'string' || token.length === 0) {
    return res.status(400).json({ error: 'Enrollment token required' });
  }
  if (typeof hostname !== 'string' || hostname.trim().length === 0) {
    return res.status(400).json({ error: 'hostname required' });
  }

  try {
    const found = await pool.query(
      'SELECT * FROM enrollment_tokens WHERE token_hash = $1',
      [hashToken(token)]
    );
    const record = found.rows[0];

    if (!record || record.used_at) {
      return res.status(401).json({ error: 'Invalid or already-used enrollment token' });
    }
    // Expiry is compared in JS, not SQL: both dialects then treat the timestamp
    // the same way, whatever their native datetime formatting is.
    if (new Date(record.expires_at).getTime() <= Date.now()) {
      return res.status(401).json({ error: 'Enrollment token has expired' });
    }

    // Single use. The conditional UPDATE is the lock: a concurrent claim updates
    // zero rows and is rejected, so a token cannot provision two machines.
    const consumed = await pool.query(
      'UPDATE enrollment_tokens SET used_at = $1 WHERE id = $2 AND used_at IS NULL',
      [new Date().toISOString(), record.id]
    );
    if (consumed.rowCount !== 1) {
      return res.status(401).json({ error: 'Invalid or already-used enrollment token' });
    }

    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);
    const ownerName = owner_name || 'Operator';

    // Re-association by hardware identity (MDM-style): the same physical machine
    // returning means re-issue credentials on the existing record, not a duplicate.
    if (hardware_uuid) {
      const existing = await pool.query('SELECT * FROM devices WHERE hardware_uuid = $1', [
        hardware_uuid,
      ]);
      if (existing.rows[0]) {
        const updated = await pool.query(
          `UPDATE devices
              SET api_key_hash = $1,
                  hostname     = $2,
                  mac_address  = COALESCE($3, mac_address),
                  serial_number = COALESCE($4, serial_number),
                  status       = 'active'
            WHERE id = $5
        RETURNING *`,
          [apiKeyHash, hostname, mac_address || null, serial_number || null, existing.rows[0].id]
        );

        await pool.query(
          'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
          [
            existing.rows[0].id,
            record.created_by || null,
            'device_enrolled',
            { hostname, owner_name: ownerName, via: 'enrollment_token', reassociated: true },
          ]
        );

        return res.status(200).json({
          device: publicDevice(updated.rows[0]),
          api_key: apiKey, // plaintext — capture now, never shown again
          reassociated: true,
        });
      }
    }

    const created = await pool.query(
      `INSERT INTO devices (hostname, owner_name, api_key_hash, hardware_uuid, mac_address, serial_number)
       VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
      [
        hostname,
        ownerName,
        apiKeyHash,
        hardware_uuid || null,
        mac_address || null,
        serial_number || null,
      ]
    );

    await pool.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [
        created.rows[0].id,
        record.created_by || null,
        'device_enrolled',
        { hostname, owner_name: ownerName, via: 'enrollment_token' },
      ]
    );

    res.status(201).json({
      device: publicDevice(created.rows[0]),
      api_key: apiKey, // plaintext — capture now, never shown again
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error:
          'Hostname or hardware identity already registered. Use the existing device or choose a different hostname.',
      });
    }
    next(err);
  }
});

module.exports = router;
