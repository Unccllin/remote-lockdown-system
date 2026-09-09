// Set env vars needed by the server modules.
// These are set BEFORE any test files are loaded via jest setupFiles.
process.env.NODE_ENV = 'test';
process.env.ALLOW_NON_PROD = '1';
process.env.JWT_SECRET = 'test-secret-key-that-is-long-enough-for-validation-32';
process.env.AGENT_SHARED_KEY = 'test-agent-key-that-is-long-enough-24';
// FA3: Pepper for per-device API key hashing (falls back to AGENT_SHARED_KEY)
process.env.AGENT_KEY_PEPPER = 'test-pepper-key-that-is-long-enough-32';
process.env.JWT_EXPIRES_IN = '1h';
process.env.CORS_ORIGIN = 'http://localhost:5173';
// FA2/FA5: encryption keys for at-rest encryption (32-byte hex = 64 chars)
process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.LOCATION_FIELD_KEY = 'b'.repeat(64);
process.env.LOCATION_RETENTION_DAYS = '90';
// D-206: Force PBL KV store to use in-memory Map in tests (no DB pool)
process.env.PBL_KV_IN_MEMORY = '1';
