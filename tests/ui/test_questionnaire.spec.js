// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

/**
 * Questionnaire processing tests for Compliance Pilot.
 *
 * Verifies the upload flow, processing progress steps, and download
 * of the filled questionnaire document.
 */

test.describe('Process Questionnaire', () => {
  test.beforeEach(async ({ page }) => {
    // Log in as admin
    await page.goto('/login');
    await page.fill('#username', 'admin');
    await page.fill('#password', 'admin123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 10000 });

    // Navigate to Process Questionnaire
    await page.getByRole('link', { name: /process/i }).click();
    await page.waitForURL('**/process', { timeout: 10000 });
  });

  test('page heading and upload zone are visible', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /process questionnaire/i })).toBeVisible();
    await expect(page.getByText(/upload and auto-fill compliance questionnaires/i)).toBeVisible();
    await expect(page.getByText(/drop your questionnaire here/i)).toBeVisible();
  });

  test('upload zone accepts file types', async ({ page }) => {
    // The upload zone should indicate accepted file types
    await expect(page.getByText(/PDF, DOCX, XLSX, TXT, or JSON/i)).toBeVisible();
    await expect(page.getByText(/or click to browse/i)).toBeVisible();
  });

  test('upload a fixture questionnaire triggers processing', async ({ page }) => {
    // Locate the hidden file input
    const fileInput = page.locator('input[type="file"]');

    // Use fixture DOCX file
    const fixturePath = path.resolve(__dirname, '..', 'fixtures', 'sample_questionnaire.docx');

    // Upload the file
    await fileInput.setInputFiles(fixturePath);

    // Should see the file name displayed and processing indicators
    await expect(page.getByText(/sample_questionnaire/i).first()).toBeVisible({ timeout: 10000 });

    // Upload toast or status should appear
    const uploadIndicator = page.locator(
      'text=/uploading|uploaded|processing|questions detected/i'
    );
    await expect(uploadIndicator.first()).toBeVisible({ timeout: 15000 });
  });

  test('progress steps appear during processing', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]');
    const fixturePath = path.resolve(__dirname, '..', 'fixtures', 'sample_questionnaire.docx');
    await fileInput.setInputFiles(fixturePath);

    // Wait for processing to start
    await expect(page.getByText(/sample_questionnaire/i).first()).toBeVisible({ timeout: 10000 });

    // The step labels from the STEPS array in ProcessQuestionnaire.jsx
    const expectedSteps = [
      'Extracting questions...',
      'Searching knowledge base...',
      'Filling answers...',
      'Generating document...',
    ];

    // At least the first step should appear once processing begins
    const anyStep = page.locator(
      'text=/extracting questions|searching knowledge|filling answers|generating document/i'
    );
    await expect(anyStep.first()).toBeVisible({ timeout: 15000 });
  });

  test('download button appears when processing is done', async ({ page }) => {
    test.setTimeout(180000); // end-to-end RAG processing can take a while
    const fileInput = page.locator('input[type="file"]');
    const fixturePath = path.resolve(__dirname, '..', 'fixtures', 'sample_questionnaire.docx');
    await fileInput.setInputFiles(fixturePath);

    // Wait for processing to complete -- this can take a while
    const downloadLink = page.getByRole('button', { name: /download filled document/i });

    // Use a generous timeout for end-to-end processing
    await expect(downloadLink).toBeVisible({ timeout: 120000 });
  });

  test('downloaded file is not empty', async ({ page }) => {
    test.setTimeout(180000);
    const fileInput = page.locator('input[type="file"]');
    const fixturePath = path.resolve(__dirname, '..', 'fixtures', 'sample_questionnaire.docx');
    await fileInput.setInputFiles(fixturePath);

    // Wait for the download link to appear
    const downloadLink = page.getByRole('button', { name: /download filled document/i });
    await expect(downloadLink).toBeVisible({ timeout: 120000 });

    // Intercept the download
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadLink.click(),
    ]);

    // Verify the download is not empty
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();

    const fs = require('fs');
    const stats = fs.statSync(downloadPath);
    expect(stats.size).toBeGreaterThan(0);
  });

  test('process another button resets the form after completion', async ({ page }) => {
    test.setTimeout(180000);
    const fileInput = page.locator('input[type="file"]');
    const fixturePath = path.resolve(__dirname, '..', 'fixtures', 'sample_questionnaire.docx');
    await fileInput.setInputFiles(fixturePath);

    // Wait for processing to finish
    const downloadLink = page.getByRole('button', { name: /download filled document/i });
    await expect(downloadLink).toBeVisible({ timeout: 120000 });

    // Click "Process Another"
    const resetButton = page.getByRole('button', { name: /process another/i });
    await expect(resetButton).toBeVisible();
    await resetButton.click();

    // Upload zone should reappear
    await expect(page.getByText(/drop your questionnaire here/i)).toBeVisible();
  });
});
