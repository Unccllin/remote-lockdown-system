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
      // Coverage gate. Measured 2026-10-28 on vite/vitest 4.1.12:
      //   70.59 stmts / 63.37 branches / 64.80 funcs / 72.02 lines
      // Re-baselined when the coverage provider moved from vitest 3.2 to 4.1:
      // v8 instrumentation counts differently (statements rose ~10 points,
      // branches fell ~7 on unchanged code), so the old floors described a
      // different measurement, not more coverage. Floors stay ~2 points under
      // the measurement; raise on real improvement, never lower to pass a build.
      thresholds: {
        statements: 68,
        branches: 61,
        functions: 62,
        lines: 70,
      },
    },
  },
});
