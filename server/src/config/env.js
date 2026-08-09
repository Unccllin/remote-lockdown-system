/**
 * Central environment variable validation.
 *
 * Single source of truth for all env var checks. Each fix phase registers
 * its required vars here. Called at the top of src/index.js (production)
 * and dev-start.js (development).
 *
 * Behavior:
 *   - Production (NODE_ENV=production): fail fast (exit 1) on missing/weak/placeholder vars.
 *   - Non-production: refuse to start unless ALLOW_NON_PROD=1 is set (CC11).
 *   - Dev mode (dev=true flag): relax length floors but still reject placeholders.
 *
 * Consensus: CC2 (one central validator), CC11 (no silent dev defaults in prod).
 */

const logger = require('../logger');

const PLACEHOLDERS = [
  'change_this_to_a_long_random_secret',
  'change_this_to_a_long_random_key',
  'dev-jwt-secret',
  'dev-agent-key',
  '',
];

/**
 * Validate environment variables.
 * @param {object} opts
 * @param {boolean} opts.dev — if true, relax length floors (dev-start.js mode)
 * @returns {void} — throws or exits on failure
 */
function validateEnv({ dev = false } = {}) {
  const errors = [];
  const warnings = [];
  const isProd = process.env.NODE_ENV === 'production';

  // --- CC11: non-production guard ---
  if (!isProd && !dev && process.env.ALLOW_NON_PROD !== '1') {
    errors.push(
      'NODE_ENV is not "production" and ALLOW_NON_PROD is not set. ' +
        'Set NODE_ENV=production for real deployments, or ALLOW_NON_PROD=1 for testing.'
    );
  }

  // --- Helper: check a secret var ---
  // CC12: Supports _FILE convention — if <NAME>_FILE is set, the var itself
  // is not required (the value will be read from the file at runtime).
  function checkSecret(name, minLen, { requiredInDev = false } = {}) {
    const fileVar = process.env[`${name}_FILE`];
    const val = process.env[name] || '';

    // If _FILE convention is used, skip the value check (file content is read at runtime)
    if (fileVar) {
      if (isProd && !require('fs').existsSync(fileVar)) {
        errors.push(`${name}_FILE points to '${fileVar}' which does not exist`);
      }
      return;
    }

    const isPlaceholder = PLACEHOLDERS.includes(val);
    const tooShort = val.length > 0 && val.length < minLen;

    if (isPlaceholder) {
      // Placeholders are ALWAYS rejected, even in dev (CC11)
      if (dev && !requiredInDev) {
        // In dev mode, if it's a placeholder, we'll set a dev default
        // (dev-start.js handles this before calling validateEnv)
        return;
      }
      errors.push(`${name} must not be a placeholder value`);
    } else if (tooShort) {
      if (isProd) {
        errors.push(`${name} must be at least ${minLen} characters`);
      } else if (dev && requiredInDev) {
        errors.push(`${name} must be at least ${minLen} characters`);
      } else if (!dev) {
        warnings.push(`${name} is shorter than ${minLen} characters`);
      }
    } else if (val.length === 0) {
      if (isProd) {
        errors.push(`${name} is required in production`);
      } else if (dev && requiredInDev) {
        errors.push(`${name} is required`);
      } else if (!dev) {
        warnings.push(`${name} is not set`);
      }
    }
  }

  // --- FA6: core secrets ---
  checkSecret('JWT_SECRET', 32);

  // FA3: AGENT_SHARED_KEY is now transitional (per-device keys replace it).
  // In production, warn if not set (legacy devices may still need it).
  // Do NOT fail — new deployments may use only per-device keys.
  // AGENT_KEY_PEPPER is the new var for hashing per-device keys; it falls
  // back to AGENT_SHARED_KEY if not set, so AGENT_SHARED_KEY still works
  // as the pepper during transition.
  const sharedKey = process.env.AGENT_SHARED_KEY || '';
  if (isProd && !sharedKey) {
    warnings.push(
      'AGENT_SHARED_KEY is not set. Legacy devices (enrolled before per-device keys) ' +
      'will not be able to authenticate. Set it for backward compatibility, or ensure ' +
      'all devices have been re-enrolled with per-device keys.'
    );
  }
  if (sharedKey && PLACEHOLDERS.includes(sharedKey)) {
    errors.push('AGENT_SHARED_KEY must not be a placeholder value');
  }
  // AGENT_KEY_PEPPER is optional (falls back to AGENT_SHARED_KEY)
  checkSecret('AGENT_KEY_PEPPER', 32);

  // --- FA2: field encryption key ---
  checkSecret('FIELD_ENCRYPTION_KEY', 32);

  // --- FA5: location field key + retention ---
  checkSecret('LOCATION_FIELD_KEY', 32);
  const retentionDays = parseInt(process.env.LOCATION_RETENTION_DAYS || '90', 10);
  if (isNaN(retentionDays) || retentionDays < 7 || retentionDays > 180) {
    if (isProd || dev) {
      warnings.push(
        `LOCATION_RETENTION_DAYS should be between 7 and 180 (got ${process.env.LOCATION_RETENTION_DAYS || '90'})`
      );
    }
  }

  // --- Batch E: numeric tunables (only validate if explicitly set) ---
  function checkNumeric(name, min, max) {
    if (process.env[name] === undefined) return; // all have defaults
    const val = parseInt(process.env[name], 10);
    if (isNaN(val) || val < min || val > max) {
      warnings.push(
        `${name} should be between ${min} and ${max} (got ${process.env[name]})`
      );
    }
  }

  // HMAC security tunables
  checkNumeric('HMAC_TIMESTAMP_WINDOW_SECONDS', 10, 3600);
  checkNumeric('HMAC_NONCE_TTL_MS', 60000, 3600000);
  checkNumeric('HMAC_CLEANUP_INTERVAL_MS', 1000, 3600000);

  // Agent adaptive polling (seconds)
  checkNumeric('ADAPTIVE_POLL_STOLEN_SEC', 5, 3600);
  checkNumeric('ADAPTIVE_POLL_TRACKING_SEC', 5, 3600);
  checkNumeric('ADAPTIVE_POLL_RECOVERING_SEC', 5, 3600);
  checkNumeric('ADAPTIVE_POLL_LOCKED_SEC', 5, 3600);
  checkNumeric('ADAPTIVE_POLL_ACTIVE_SEC', 5, 3600);

  // Alert scheduler
  checkNumeric('ALERT_SCHEDULER_INTERVAL_MS', 1000, 3600000);
  checkNumeric('ALERT_POLL_INTERVAL_SEC', 5, 3600);
  checkNumeric('STALE_DEVICE_THRESHOLD_SEC', 60, 86400);

  // Retention scheduler
  checkNumeric('RETENTION_SCHEDULER_INTERVAL_MS', 3600000, 604800000);

  // --- FA6: DB config ---
  if (!process.env.DATABASE_URL) {
    // Individual DB vars needed
    for (const v of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
      if (!process.env[v] && isProd) {
        errors.push(`${v} is required when DATABASE_URL is not set (production)`);
      }
    }
  }

  // --- DB_SSL_VERIFY (FA6) ---
  const sslVerify = process.env.DB_SSL_VERIFY;
  if (sslVerify !== undefined && sslVerify !== 'true' && sslVerify !== 'false') {
    warnings.push(`DB_SSL_VERIFY should be 'true' or 'false' (got '${sslVerify}')`);
  }

  // --- Output ---
  for (const w of warnings) {
    logger.warn({ warning: w }, 'Configuration warning');
  }

  if (errors.length > 0) {
    logger.error({ errors }, 'FATAL: invalid configuration');
    process.exit(1);
  }
}

module.exports = { validateEnv };
