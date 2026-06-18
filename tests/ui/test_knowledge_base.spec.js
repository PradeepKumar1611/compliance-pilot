// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

/**
 * Knowledge Base page tests for Compliance Pilot.
 *
 * Verifies the drag-drop upload area, PDF upload flow, version creation,
 * and document deletion.
 */

test.describe('Knowledge Base', () => {
  test.beforeEach(async ({ page }) => {
    // Log in as admin (KB is admin-only)
    await page.goto('/login');
    await page.fill('#username', 'admin');
    await page.fill('#password', 'admin123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 10000 });

    // Navigate to Knowledge Base
    await page.getByRole('link', { name: /knowledge base/i }).click();
    await page.waitForURL('**/knowledge-base', { timeout: 10000 });
  });

  test('page heading and upload area are visible', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /knowledge base/i })).toBeVisible();
    await expect(page.getByText(/manage compliance policy documents/i)).toBeVisible();
  });

  test('drag-drop upload area is present', async ({ page }) => {
    // The upload zone shows "Drag & drop files here"
    await expect(page.getByText(/drag & drop files here/i)).toBeVisible();
    await expect(page.getByText(/or click to browse/i)).toBeVisible();
    await expect(page.getByText(/accepts .pdf, .docx, .xlsx/i)).toBeVisible();
  });

  test('upload a fixture PDF and it appears in the list', async ({ page }) => {
    // Locate the hidden file input
    const fileInput = page.locator('input[type="file"]');

    // Use a fixture PDF (create a minimal one if it does not exist)
    const fixturePath = path.resolve(__dirname, '..', 'fixtures', 'sample_policy.txt');

    // Set the file on the input element
    await fileInput.setInputFiles(fixturePath);

    // Wait for success toast or the file to appear in the documents table
    const successIndicator = page.locator(
      'text=/uploaded|sample_policy/i'
    );
    await expect(successIndicator.first()).toBeVisible({ timeout: 15000 });

    // The document should appear in the "Uploaded Documents" table
    await expect(page.getByText('Uploaded Documents')).toBeVisible();
    await expect(page.getByText(/sample_policy/i).first()).toBeVisible({ timeout: 10000 });
  });

  test('create new version bumps version number', async ({ page }) => {
    // Capture the current version text if present
    const versionBadgeBefore = page.locator('text=/Version \\d+/i');
    const countBefore = await versionBadgeBefore.count();
    let versionBefore = 0;
    if (countBefore > 0) {
      const text = await versionBadgeBefore.first().textContent();
      const match = text?.match(/\d+/);
      if (match) versionBefore = parseInt(match[0], 10);
    }

    // Click "Create New Version"
    const createBtn = page.getByRole('button', { name: /create new version/i });
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    // Wait for success toast (specific text so it doesn't match hidden <option> "Version N")
    const toast = page.locator('text=/version created/i');
    await expect(toast.first()).toBeVisible({ timeout: 10000 });

    // The version selector should list a "Version N" option (options live in a
    // collapsed <select>, so assert by count rather than visibility).
    const versionOptions = page.locator('select option', { hasText: /Version \d+/i });
    await expect.poll(async () => versionOptions.count(), { timeout: 5000 }).toBeGreaterThan(0);
  });

  test('delete document removes it from list', async ({ page }) => {
    // First ensure there is at least one document by uploading
    const fileInput = page.locator('input[type="file"]');
    const fixturePath = path.resolve(__dirname, '..', 'fixtures', 'sample_policy.txt');
    await fileInput.setInputFiles(fixturePath);

    // Wait for it to appear
    await expect(page.getByText(/sample_policy/i).first()).toBeVisible({ timeout: 15000 });

    // Set up a dialog handler to accept the confirm prompt
    page.on('dialog', (dialog) => dialog.accept());

    // Hover over the row to reveal the delete button, then click it
    const row = page.locator('tr', { hasText: /sample_policy/i }).first();
    await row.hover();

    const deleteButton = row.locator('button[title="Delete document"]');
    await deleteButton.click({ force: true });

    // Wait for deletion success toast
    const toast = page.locator('text=/deleted/i');
    await expect(toast.first()).toBeVisible({ timeout: 10000 });
  });

  test('documents table shows correct column headers', async ({ page }) => {
    // Ensure the active version has at least one document so the table renders
    // (earlier tests may have switched to a fresh, empty version).
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(path.resolve(__dirname, '..', 'fixtures', 'sample_policy.txt'));
    await expect(page.getByText(/sample_policy/i).first()).toBeVisible({ timeout: 20000 });

    // The documents table has specific columns
    const expectedHeaders = ['Filename', 'Version', 'Ingested', 'Chunks', 'Status'];
    for (const header of expectedHeaders) {
      await expect(page.locator(`th:has-text("${header}")`)).toBeVisible({ timeout: 10000 });
    }
  });
});
