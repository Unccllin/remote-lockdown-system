module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Electron code uses Module.createRequire rooted at ../server to resolve
  // express and other server dependencies. Tests run from electron/ so the
  // relative path resolution works the same as in production.
  rootDir: '.',
  testTimeout: 10000,
  collectCoverageFrom: [
    '*.js',
    '!main.js',
    '!preload.js',
    '!**/node_modules/**',
    '!**/tests/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'json'],
  // Coverage gate (measured 2026-10-27: 39.4 stmts / 47.36 branches /
  // 30.95 funcs / 39.3 lines). Main-process and IPC code is not covered yet
  // (main.js/preload.js are excluded above), which is why the floor is low —
  // the point is that it cannot silently fall further.
  coverageThreshold: {
    global: {
      statements: 37,
      branches: 45,
      functions: 29,
      lines: 37,
    },
  },
};
