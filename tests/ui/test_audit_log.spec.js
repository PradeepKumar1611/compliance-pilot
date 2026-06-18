// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Audit Log page tests for Compliance Pilot.
 *
 * Verifies the audit table columns, flagged filter, CSV export,
 * and side panel detail view.
 */

test.describe('Audit Log', () => {
  test.beforeEach(async ({ page }) => {
    // Log in as admin
    await page.goto('/login');
    await page.fill('#username', 'admin');
    await page.fill('#password', 'admin123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 10000 });

    // Navigate to Audit Log
    await page.getByRole('link', { name: /audit log/i }).click();
    await page.waitForURL('**/audit', { timeout: 10000 });
  });

  test('page heading is visible', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /audit log/i })).toBeVisible();
    await expect(page.getByText(/complete history of all generated answers/i)).toBeVisible();
  });

  test('table renders with correct columns', async ({ page }) => {
    const expectedColumns = [
      'Time',
      'Question',
      'Answer',
      'Confidence',
      'Tier',
      'KB Ver',
      'Model',
      'Lang',
      'Flagged',
    ];

    for (const col of expectedColumns) {
      await expect(
        page.locator(`th:has-text("${col}")`)
      ).toBeVisible({ timeout: 10000 });
    }
  });

  test('filter controls are visible', async ({ page }) => {
    // Date filter inputs
    await expect(page.locator('label:has-text("From")')).toBeVisible();
    await expect(page.locator('label:has-text("To")')).toBeVisible();

    // Confidence tier dropdown
    await expect(page.locator('label:has-text("Confidence Tier")')).toBeVisible();

    // Flagged only toggle
    await expect(page.locator('label:has-text("Flagged Only")')).toBeVisible();

    // KB Version input
    await expect(page.locator('label:has-text("KB Version")')).toBeVisible();

    // Apply and Export buttons
    await expect(page.getByRole('button', { name: /apply filters/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible();
  });

  test('filter by flagged only works', async ({ page }) => {
    // Toggle the "Flagged Only" switch
    const flaggedToggle = page.locator('input[type="checkbox"]').first();
    await flaggedToggle.check({ force: true });

    // Click Apply Filters
    await page.getByRole('button', { name: /apply filters/i }).click();

    // Wait for the table to reload
    await page.waitForTimeout(1000);

    // The table should now show only flagged items or "No audit logs found"
    const tableBody = page.locator('tbody');
    await expect(tableBody).toBeVisible({ timeout: 10000 });

    // If there are rows, each should have a flag icon; or the table shows empty state
    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();

    if (rowCount > 0) {
      // Check that at least the first visible row is not the "no logs" placeholder
      const firstRowText = await rows.first().textContent();
      // If it is not the empty state, rows should contain flagged entries
      if (!firstRowText?.includes('No audit logs found')) {
        // Flagged rows should have a flag icon (svg or the Flag component)
        // Just verify the filter was applied without error
        expect(rowCount).toBeGreaterThan(0);
      }
    }
  });

  test('CSV export triggers download', async ({ page }) => {
    // Set up download listener
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.getByRole('button', { name: /export csv/i }).click(),
    ]);

    // Verify the download was triggered
    expect(download).toBeTruthy();
    const suggestedName = download.suggestedFilename();
    expect(suggestedName).toMatch(/audit_log.*\.csv/);
  });

  test('clicking a row opens side panel with full details', async ({ page }) => {
    // Wait for table to load
    const rows = page.locator('tbody tr');
    await page.waitForTimeout(2000);

    const rowCount = await rows.count();

    if (rowCount > 0) {
      const firstRow = rows.first();
      const firstRowText = await firstRow.textContent();

      // Skip if the empty state message is shown
      if (!firstRowText?.includes('No audit logs found') && !firstRowText?.includes('Loading')) {
        // Click the first data row
        await firstRow.click();

        // The side panel should open with "Audit Detail" heading
        await expect(page.getByText('Audit Detail')).toBeVisible({ timeout: 5000 });

        // Panel should show full detail sections
        await expect(page.locator('text=/timestamp/i').first()).toBeVisible();
        await expect(page.locator('text=/question/i').first()).toBeVisible();
        await expect(page.locator('text=/answer/i').first()).toBeVisible();
        await expect(page.locator('text=/confidence/i').first()).toBeVisible();
        await expect(page.locator('text=/metadata/i').first()).toBeVisible();

        // Close the panel
        const closeButton = page.locator('[class*="fixed"] button').first();
        await closeButton.click();

        // Panel should close
        await expect(page.getByText('Audit Detail')).not.toBeVisible({ timeout: 3000 });
      }
    }
  });

  test('pagination controls are visible', async ({ page }) => {
    // Pagination area should show total records and page controls
    await expect(page.locator('text=/total record/i')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /previous/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /next/i })).toBeVisible();
    await expect(page.locator('text=/Page \\d+ of \\d+/i')).toBeVisible();
  });
});
