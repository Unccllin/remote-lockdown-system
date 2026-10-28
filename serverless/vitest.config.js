import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts', '**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json'],
      reportsDirectory: './coverage',
      include: ['worker.ts'],
      // Coverage gate (measured 2026-10-27: 85.48 stmts / 81.67 branches /
      // 92.59 funcs / 85.48 lines). ~2 points of slack for ordinary refactors.
      thresholds: {
        statements: 83,
        branches: 79,
        functions: 90,
        lines: 83,
      },
    },
  },
  esbuild: {
    target: 'es2021',
  },
});
