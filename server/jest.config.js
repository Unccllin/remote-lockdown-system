module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  // Don't use clearMocks — it can interfere with our custom mock implementation.
  // We handle cleanup in beforeEach instead.
};
