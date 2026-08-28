module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Electron code uses Module.createRequire rooted at ../server to resolve
  // express and other server dependencies. Tests run from electron/ so the
  // relative path resolution works the same as in production.
  rootDir: '.',
};
