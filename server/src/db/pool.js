/**
 * Database pool.
 *
 * By default this exports a PostgreSQL `pg.Pool` instance for production.
 *
 * When `process.env.USE_SQLITE === 'true'` (set by the Electron dev script
 * and the Playwright dashboard E2E fixtures), it instead exports the
 * SQLite pool wrapper from `sqlitePool.js`. This lets code that imports
 * `../db/pool` run against SQLite without a running Postgres instance and
 * without needing a module mock (jest.mock is unavailable outside Jest,
 * e.g. in Playwright).
 *
 * FA6: SSL configuration is controlled by DB_SSL and DB_SSL_VERIFY env vars.
 * - DB_SSL=false: disable SSL entirely (internal networks, e.g. docker-compose)
 * - DB_SSL=true (default) + DB_SSL_VERIFY=true (default): reject unauthorized
 * - DB_SSL=true (default) + DB_SSL_VERIFY=false: allow self-signed certs (dev/test)
 *
 * Previously, ssl: { rejectUnauthorized: false } was hardcoded, which silently
 * accepted any SSL certificate — a MITM risk in production.
 */

const logger = require('../logger');

// SQLite mode: export the SQLite pool wrapper and skip Postgres entirely.
if (process.env.USE_SQLITE === 'true') {
  module.exports = require('./sqlitePool');
} else {
  module.exports = createPgPool();
}

function createPgPool() {
  const { Pool } = require('pg');

  const sslVerify = process.env.DB_SSL_VERIFY !== 'false'; // default: true (secure)
  const sslEnabled = process.env.DB_SSL !== 'false'; // default: true (use SSL)

  const sslConfig = process.env.DATABASE_URL
    ? (sslEnabled ? { rejectUnauthorized: sslVerify } : undefined)
    : undefined; // individual vars mode: SSL only if explicitly configured

  if (process.env.DATABASE_URL && !sslVerify && process.env.NODE_ENV === 'production') {
    logger.warn('DB_SSL_VERIFY=false in production — SSL certificate verification is disabled. This is insecure and should only be used in development.');
  }

  return process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: sslConfig,
      })
    : new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'lockdown_db',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: sslVerify } : undefined,
      });
}
