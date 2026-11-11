import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Follows E2E_BACKEND_PORT so `E2E_BACKEND_PORT=3101 npx playwright test` moves both
      // halves at once; unset, this is the historical http://localhost:3001.
      '/api': `http://localhost:${process.env.E2E_BACKEND_PORT ?? 3001}`,
    },
  },
});
