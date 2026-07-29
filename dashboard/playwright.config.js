import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration for the DeviceLock admin dashboard.
 *
 * The Vite dev server is started automatically by Playwright's `webServer`
 * option. The backend API server (Express + SQLite test DB) is booted by the
 * test fixtures in `e2e/fixtures.js` and listens on port 3001, which is where
 * the Vite proxy forwards `/api` requests (see vite.config.js).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Additional browsers can be enabled later:
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit',  use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
  },
});
