const { Pool } = require('pg');

/**
 * FA6: SSL configuration is now controlled by DB_SSL_VERIFY env var.
 * - DB_SSL_VERIFY=true (default): reject unauthorized SSL connections
 * - DB_SSL_VERIFY=false: allow self-signed certs (dev/test only — warns in prod)
 *
 * Previously, ssl: { rejectUnauthorized: false } was hardcoded, which silently
 * accepted any SSL certificate — a MITM risk in production.
 */

const sslVerify = process.env.DB_SSL_VERIFY !== 'false'; // default: true (secure)

const sslConfig = process.env.DATABASE_URL
  ? { rejectUnauthorized: sslVerify }
  : undefined; // individual vars mode: SSL only if explicitly configured

if (process.env.DATABASE_URL && !sslVerify && process.env.NODE_ENV === 'production') {
  console.warn('WARNING: DB_SSL_VERIFY=false in production — SSL certificate verification is disabled.');
  console.warn('This is insecure and should only be used in development.');
}

const pool = process.env.DATABASE_URL
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

module.exports = pool;
