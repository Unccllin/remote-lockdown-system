import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.jsx'],
    exclude: ['node_modules', 'dist', 'e2e/**'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json'],
      reportsDirectory: './coverage',
      exclude: ['node_modules/', 'e2e/', 'tests/setup.jsx', 'src/main.jsx'],
    },
  },
});
