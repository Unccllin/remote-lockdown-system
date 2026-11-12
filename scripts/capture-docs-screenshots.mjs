/**
 * Capture dashboard screenshots for the repository docs.
 *
 * Runs against the Vite dev server with the dashboard's .env pointing at the Worker, logs in as
 * the admin, and saves one PNG per view into docs/images/. Chromium needs the locally extracted
 * NSS libraries (LD_LIBRARY_PATH=~/.local/lib/nspr) on this host.
 *
 * Usage: node scripts/capture-docs-screenshots.mjs <base-url> <password>
 */
import { chromium } from '/home/cllin/remote-lockdown-system/dashboard/node_modules/@playwright/test/index.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:5189';
const PASSWORD = process.argv[3];
const OUT = '/home/cllin/remote-lockdown-system/docs/images';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

async function shot(name, waitMs = 1500) {
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', name);
}

// 1. Login
await page.goto(`${BASE}/login`);
await shot('01-login');

// 2. Signed in — fleet overview (live data from the Worker)
await page.locator('input[placeholder="admin"]').fill('uncletom');
await page.locator('input[type="password"]').fill(PASSWORD);
await page.getByRole('button', { name: /sign in/i }).click();
await page.waitForURL('**/', { timeout: 30000 });
await shot('02-fleet-overview', 3000);

// 3. Devices
await page.goto(`${BASE}/devices`);
await shot('03-devices', 2500);

// 4. Device detail for the enrolled test machine
const row = page.getByText(/FRANKENSTEIN/i).first();
if (await row.count()) {
  await row.click();
  await shot('04-device-detail', 3000);
}

// 5. Enroll page — the serverless callout that points at the per-device installer
await page.goto(`${BASE}/devices/enroll`);
await shot('05-enroll-serverless-callout', 2500);

// 6. Manual enroll page (per-device installer download)
await page.goto(`${BASE}/devices/enroll/manual`);
await shot('06-enroll-manual', 2000);

// 7. PBL devices
await page.goto(`${BASE}/pbl-devices`);
await shot('07-pbl-devices', 2500);

// 8. Audit log
await page.goto(`${BASE}/audit`);
await shot('08-audit-log', 2500);

// 9. Map view (tracking)
await page.goto(`${BASE}/map`);
await shot('09-map-view', 3500);

await browser.close();
console.log('done');
