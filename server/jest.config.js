module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  // FA7: E2E tests use in-memory PGlite (singleton) — must run in band
  // to avoid parallel workers corrupting the same PGlite instance.
  maxWorkers: 1,
  // Don't use clearMocks — it can interfere with our custom mock implementation.
  // We handle cleanup in beforeEach instead.
  // Timeout: 15s per test (default is 5s, but some E2E tests need more).
  testTimeout: 15000,
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/db/migrate.js',
    '!src/**/*.test.js',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'json'],
};
