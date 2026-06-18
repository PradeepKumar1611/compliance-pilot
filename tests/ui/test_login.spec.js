// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Login page tests for Compliance Pilot.
 *
 * These tests verify authentication flows: successful login, error handling,
 * redirect behaviour, and logout.
 */

test.describe('Login Page', () => {
  test.beforeEach(async ({ page }) => {
    // Clear any stored auth state before each test
    await page.goto('/login');
    await page.evaluate(() => {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('lang'); // reset i18n so each test starts in English
    });
    await page.reload();
    await page.waitForSelector('#username');
  });

  test('login form renders with expected fields', async ({ page }) => {
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    await expect(page.getByText('Compliance Pilot').first()).toBeVisible();
  });

  test('language switcher changes the UI language', async ({ page }) => {
    // Default English
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    // Switch to Spanish via the language selector
    await page.getByLabel(/language/i).selectOption('es');
    // The sign-in button label updates to Spanish
    await expect(page.getByRole('button', { name: /iniciar sesión/i })).toBeVisible();
  });

  test('login with valid credentials redirects to dashboard', async ({ page }) => {
    await page.fill('#username', 'admin');
    await page.fill('#password', 'admin123');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Should redirect to /dashboard
    await page.waitForURL('**/dashboard', { timeout: 10000 });
    await expect(page).toHaveURL(/\/dashboard/);

    // Dashboard heading should be visible
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();
  });

  test('login with wrong password shows error message', async ({ page }) => {
    await page.fill('#username', 'admin');
    await page.fill('#password', 'wrongpassword');
    await page.getByRole('button', { name: /sign in/i }).click();

    // An error toast or message should appear
    // The app uses a Toast component for error display
    const errorToast = page.locator('text=/invalid|error|incorrect|failed/i');
    await expect(errorToast.first()).toBeVisible({ timeout: 5000 });

    // Should remain on login page
    await expect(page).toHaveURL(/\/login/);
  });

  test('login with empty fields shows validation message', async ({ page }) => {
    await page.getByRole('button', { name: /sign in/i }).click();

    // Should show a toast asking for credentials
    const toast = page.locator('text=/please enter/i');
    await expect(toast.first()).toBeVisible({ timeout: 5000 });
  });

  test('unauthenticated user is redirected to login', async ({ page }) => {
    // Try to visit dashboard directly without logging in
    await page.goto('/dashboard');

    // Should redirect to /login
    await page.waitForURL('**/login', { timeout: 10000 });
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('Logout', () => {
  test.beforeEach(async ({ page }) => {
    // Log in first
    await page.goto('/login');
    await page.fill('#username', 'admin');
    await page.fill('#password', 'admin123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 10000 });
  });

  test('clicking sign out redirects to login page', async ({ page }) => {
    // The Layout sidebar contains a logout button ("Log out")
    const signOutButton = page.getByRole('button', { name: /log ?out|sign out/i });
    await expect(signOutButton).toBeVisible();
    await signOutButton.click();

    // Should redirect to login
    await page.waitForURL('**/login', { timeout: 10000 });
    await expect(page).toHaveURL(/\/login/);

    // Session cookie is cleared — protected routes now redirect back to login.
    await page.goto('/dashboard');
    await page.waitForURL('**/login', { timeout: 10000 });
    await expect(page).toHaveURL(/\/login/);
  });
});
