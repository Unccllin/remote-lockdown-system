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
    // Never reuse: on 2026-11-19 a Vite dev server S303 had left running on 5173 since the day
    // before was silently reused here, so the suite drove a server whose /api proxy had been
    // resolved WITHOUT this run's E2E_BACKEND_PORT — the browser talked to a foreign backend
    // while the fixture's own axios login talked to the right one, and the result was 7 test
    // failures that looked like "login is broken" (nothing in the output named the reuse).
    // A busy 5173 must be one setup error the operator can read, not a suite that tests someone
    // else's server. Set PLAYWRIGHT_REUSE_DEV_SERVER=1 only if you know that server is this one.
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_DEV_SERVER === '1',
    // A developer's dashboard/.env may point the UI at the deployed Worker via VITE_API_URL
    // (that is what a standalone build wants). The E2E suite is a SAME-ORIGIN test against the
    // fixture backend, so that value must not leak in: with it, every authenticated test talked
    // to production and got 401, which read as "login is broken" in the UI.
    // Vite gives existing process.env values precedence over .env files, so an empty string here
    // wins and the client falls back to '/api'.
    env: { VITE_API_URL: '' },
  },
});
