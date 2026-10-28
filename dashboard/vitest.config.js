import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.jsx'],
    exclude: ['node_modules', 'dist', 'e2e/**'],
    // The plain suite keeps 15s. The coverage script raises this to 60s via
    // --testTimeout: v8 instrumentation roughly doubles render cost, and page
    // renders that pass uninstrumented at 15s were timing out under load.
    // A genuine hang still fails at 60s.
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json'],
      reportsDirectory: './coverage',
      exclude: ['node_modules/', 'e2e/', 'tests/setup.jsx', 'src/main.jsx'],
      // Coverage gate (measured 2026-10-27: 60.74 stmts / 70.19 branches /
      // 52.38 funcs / 60.74 lines). ~2 points of slack for ordinary refactors.
      // Raise when coverage improves; never lower to make a build pass.
      thresholds: {
        statements: 58,
        branches: 68,
        functions: 50,
        lines: 58,
      },
    },
  },
});
