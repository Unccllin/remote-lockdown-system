import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts', '**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json'],
      reportsDirectory: './coverage',
      include: ['worker.ts'],
      // Coverage gate. Measured 2026-10-28 on vitest 4.1.12:
      //   83.84 stmts / 77.36 branches / 88.00 funcs / 85.50 lines
      // Re-baselined when the coverage provider moved from vitest 3.2 to 4.1:
      // v8 instrumentation counts differently on unchanged code (the 2026-10-27
      // numbers were 85.48/81.67/92.59/85.48). Floors stay ~2 points under the
      // measurement; raise on real improvement, never lower to pass a build.
      thresholds: {
        statements: 82,
        branches: 75,
        functions: 86,
        lines: 83,
      },
    },
  },
  esbuild: {
    target: 'es2021',
  },
});
