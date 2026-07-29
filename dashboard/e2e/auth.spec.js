/**
 * E2E tests for the authentication flow.
 *
 * Covers: login page render, valid login → dashboard redirect, invalid login
 * → error message, logout → login redirect, and protected-route redirect
 * when unauthenticated.
 */
import { test, expect, startBackend, stopBackend, getCtx } from './fixtures';

test.beforeAll(async () => {
  await startBackend();
});

test.afterAll(async () => {
  await stopBackend();
});

test.describe('Authentication', () => {
  test('login page renders with form, username/password fields, and submit button', async ({
    page,
  }) => {
    await page.goto('/login');

    // Username + password inputs
    await expect(page.locator('input[placeholder="admin"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();

    // Submit button
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();

    // Heading / branding
    await expect(page.getByText('DeviceLock Admin')).toBeVisible();
  });

  test('login with valid credentials redirects to the dashboard overview', async ({
    page,
  }) => {
    const { admin } = getCtx();
    await page.goto('/login');

    await page.locator('input[placeholder="admin"]').fill(admin.username);
    await page.locator('input[type="password"]').fill(admin.password);
    await page.getByRole('button', { name: /sign in/i }).click();

    // Should land on the overview page (route "/").
    await page.waitForURL('**/');
    await expect(page).toHaveURL(/\/$/);

    // Token should now be persisted in localStorage.
    const token = await page.evaluate(() => window.localStorage.getItem('token'));
    expect(token).toBeTruthy();
  });

  test('login with invalid credentials shows an error message', async ({ page }) => {
    await page.goto('/login');

    await page.locator('input[placeholder="admin"]').fill('e2e-admin');
    await page.locator('input[type="password"]').fill('totally-wrong-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    // react-hot-toast renders the error in a role="status" element.
    await expect(page.getByText(/login failed|invalid/i)).toBeVisible({ timeout: 10_000 });

    // Should remain on the login page.
    await expect(page).toHaveURL(/\/login/);
  });

  test('logout redirects to the login page', async ({ page }) => {
    const { admin } = getCtx();
    await page.goto('/login');
    await page.locator('input[placeholder="admin"]').fill(admin.username);
    await page.locator('input[type="password"]').fill(admin.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/');

    // Click the "Sign out" button in the sidebar.
    await page.getByRole('button', { name: /sign out/i }).click();

    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);

    // Token should be cleared.
    const token = await page.evaluate(() => window.localStorage.getItem('token'));
    expect(token).toBeNull();
  });

  test('protected route without auth redirects to login', async ({ page }) => {
    // Ensure no token is present, then visit a protected route directly.
    await page.goto('/login');
    await page.evaluate(() => window.localStorage.removeItem('token'));

    await page.goto('/devices');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });
});
