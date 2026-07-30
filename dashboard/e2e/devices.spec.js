/**
 * E2E tests for device management flows.
 *
 * Covers: device list load, device detail load, flag-stolen flow (hostname
 * confirmation → status change), recover flow (hostname confirmation → status
 * change), audit log page, and health page.
 */
import { test, expect, startBackend, stopBackend, getCtx } from './fixtures';

test.beforeAll(async () => {
  await startBackend();
});

test.afterAll(async () => {
  await stopBackend();
});

test.describe('Device management', () => {
  test('device list page loads with seeded test devices', async ({ authContext }) => {
    const page = await authContext.newPage();
    try {
      await page.goto('/devices');

      await expect(page.getByRole('heading', { name: /^devices$/i })).toBeVisible();

      // Each seeded hostname should appear in the table.
      const { devices } = getCtx();
      for (const d of devices) {
        await expect(page.getByText(d.hostname).first()).toBeVisible({ timeout: 10_000 });
      }

      // "registered devices" count line.
      await expect(page.getByText(/registered devices/i)).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('device detail page loads and shows hostname + owner', async ({ authContext }) => {
    const page = await authContext.newPage();
    try {
      const { devices } = getCtx();
      const target = devices[0];
      await page.goto(`/devices/${target.id}`);

      // Hostname is rendered as an h1.
      await expect(page.getByRole('heading', { name: target.hostname })).toBeVisible();
      // Owner line.
      await expect(page.getByText(`Owner: ${target.owner_name}`)).toBeVisible();
      // Back link.
      await expect(page.getByText(/back to devices/i)).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('flag stolen flow: confirm with hostname → status becomes stolen', async ({
    authContext,
  }) => {
    const page = await authContext.newPage();
    try {
      const { devices } = getCtx();
      const target = devices[1]; // use a distinct device from the detail test
      await page.goto(`/devices/${target.id}`);

      await expect(page.getByRole('heading', { name: target.hostname })).toBeVisible();

      // Open the flag-stolen confirmation modal.
      await page.getByRole('button', { name: /flag as stolen/i }).first().click();

      // The modal is rendered in a fixed overlay.
      const modal = page.locator('.fixed.inset-0');
      await expect(modal).toBeVisible();

      // Type the hostname to enable the confirm button.
      await modal.locator('input').fill(target.hostname);

      // Click the modal's confirm button.
      await modal.getByRole('button', { name: /flag as stolen/i }).click();

      // Status badge should now read "stolen".
      await expect(page.locator('span.badge-stolen')).toHaveText(/stolen/i, { timeout: 10_000 });
    } finally {
      await page.close();
    }
  });

  test('recover device flow: confirm with hostname → status becomes recovering', async ({
    authContext,
  }) => {
    const page = await authContext.newPage();
    try {
      const { devices } = getCtx();
      const target = devices[1]; // same device flagged stolen above
      await page.goto(`/devices/${target.id}`);

      await expect(page.getByRole('heading', { name: target.hostname })).toBeVisible();

      // Device should currently be stolen → Recover button is visible.
      await page.getByRole('button', { name: /recover device/i }).first().click();

      const modal = page.locator('.fixed.inset-0');
      await expect(modal).toBeVisible();

      await modal.locator('input').fill(target.hostname);
      await modal.getByRole('button', { name: /recover device/i }).click();

      // Status badge should now read "recovering".
      // Use .first() — the page has two badge-recovering elements: the status
      // badge (showing just "recovering") and a "Recovery in progress —"
      // notice below it.
      await expect(page.locator('span.badge-recovering').first()).toHaveText(/recovering/i, {
        timeout: 10_000,
      });
    } finally {
      await page.close();
    }
  });

  test('audit log page loads and shows entries', async ({ authContext }) => {
    const page = await authContext.newPage();
    try {
      await page.goto('/audit');

      await expect(page.getByRole('heading', { name: /audit log/i })).toBeVisible();

      // Seeding devices + flag/recover actions produced audit entries.
      // The table renders action names in monospace; wait for at least one.
      await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10_000 });

      // At least one known action should be present.
      await expect(page.getByText(/device_enrolled|flag_stolen|recover_device/i).first()).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('health page loads', async ({ authContext }) => {
    const page = await authContext.newPage();
    try {
      await page.goto('/health');

      await expect(page.getByRole('heading', { name: /system health/i })).toBeVisible();
      // Server status card.
      await expect(page.getByText(/server status/i)).toBeVisible();
      // Fleet status card.
      await expect(page.getByText(/fleet status/i)).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
