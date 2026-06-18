// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Settings page tests for Compliance Pilot.
 *
 * Verifies admin-only access, redirect for non-admin users,
 * save settings toast, test connection button, and user management.
 */

test.describe('Settings - Admin Access', () => {
  test.beforeEach(async ({ page }) => {
    // Log in as admin
    await page.goto('/login');
    await page.fill('#username', 'admin');
    await page.fill('#password', 'admin123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 10000 });
  });

  test('settings page is accessible to admin', async ({ page }) => {
    // Navigate to settings via sidebar
    const settingsLink = page.getByRole('link', { name: /settings/i });
    await expect(settingsLink).toBeVisible();
    await settingsLink.click();

    await page.waitForURL('**/settings', { timeout: 10000 });
    await expect(page).toHaveURL(/\/settings/);
  });

  test('settings nav item is visible in sidebar for admin', async ({ page }) => {
    await expect(page.getByRole('link', { name: /settings/i })).toBeVisible();
  });

  test('save settings shows success toast', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForURL('**/settings', { timeout: 10000 });

    // Target the settings save button specifically (the page also has an
    // "Update Password" button which a looser regex would match first).
    const saveButton = page.getByRole('button', { name: /save settings/i });
    await expect(saveButton).toBeVisible({ timeout: 10000 });
    await saveButton.click();

    // Re-saving the current (valid) settings should succeed.
    const toast = page.locator('text=/saved|updated|success/i');
    await expect(toast.first()).toBeVisible({ timeout: 10000 });
  });

  test('test connection button shows result', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForURL('**/settings', { timeout: 10000 });

    // Look for a "Test Connection" button
    const testConnBtn = page.getByRole('button', { name: /test connection/i });

    const count = await testConnBtn.count();
    if (count > 0) {
      await testConnBtn.first().click();

      // Should show a result: either success or error toast/message
      const result = page.locator('text=/connection|success|error|failed|connected/i');
      await expect(result.first()).toBeVisible({ timeout: 15000 });
    }
  });

  test('user management section shows user list', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForURL('**/settings', { timeout: 10000 });

    // Look for user management section -- may contain a table or list of users
    const userSection = page.locator(
      'text=/user management|manage users|users/i'
    );

    const count = await userSection.count();
    if (count > 0) {
      await expect(userSection.first()).toBeVisible();

      // Should display at least the admin user
      const adminEntry = page.locator('text=/admin/i');
      await expect(adminEntry.first()).toBeVisible({ timeout: 5000 });
    }
  });
});

test.describe('Settings - Non-Admin Access', () => {
  test('non-admin can open settings but sees no admin controls', async ({ page }) => {
    // Log in as a regular user (non-admin)
    // First try to log in with a non-admin account
    await page.goto('/login');
    await page.fill('#username', 'testuser');
    await page.fill('#password', 'testpass123');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Wait for login to complete (may redirect to dashboard)
    await page.waitForURL('**/dashboard', { timeout: 10000 });

    // A non-admin can open Settings (for Change Password), but admin-only
    // sections must be hidden.
    await page.goto('/settings');
    await page.waitForURL('**/settings', { timeout: 10000 });
    await expect(page).toHaveURL(/\/settings/);

    // The admin-only "User Management" section must NOT be visible.
    await expect(page.getByRole('heading', { name: /user management/i })).not.toBeVisible();
  });

  test('settings link is visible in sidebar for all users', async ({ page }) => {
    // Log in as a regular user
    await page.goto('/login');
    await page.fill('#username', 'testuser');
    await page.fill('#password', 'testpass123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 10000 });

    // Settings is available to all users (admin-only sections are gated inside).
    const settingsLink = page.getByRole('link', { name: /settings/i });
    await expect(settingsLink).toBeVisible();
  });

  test('knowledge base link is not visible for non-admin', async ({ page }) => {
    // Log in as a regular user
    await page.goto('/login');
    await page.fill('#username', 'testuser');
    await page.fill('#password', 'testpass123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 10000 });

    // Knowledge Base link should NOT be in the sidebar for non-admin
    const kbLink = page.getByRole('link', { name: /knowledge base/i });
    await expect(kbLink).not.toBeVisible();
  });
});
