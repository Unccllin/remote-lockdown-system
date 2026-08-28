import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts', '**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json'],
      reportsDirectory: './coverage',
      include: ['worker.ts'],
    },
  },
  esbuild: {
    target: 'es2021',
  },
});
