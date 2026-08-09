/**
 * Pino logger — structured JSON logging with redaction of sensitive fields.
 *
 * Usage:
 *   const logger = require('./logger');
 *   logger.info({ port: 3001 }, 'Server running');
 *   const child = logger.child({ module: 'auth' });
 *
 * Redaction: any object key matching the paths below is replaced with
 * '[REDACTED]' before serialization, so secrets never leak into logs.
 */

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      'password', 'password_hash', 'token', 'apiKey', 'api_key',
      'secret', 'key_material', 'key',
      '*.password', '*.password_hash', '*.token', '*.apiKey',
      '*.api_key', '*.secret', '*.key_material', '*.key',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
