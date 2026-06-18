// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Chat page tests for Compliance Pilot.
 *
 * Verifies the empty-state sample prompts render and that clicking one starts
 * a conversation against the seeded knowledge base.
 */

const SAMPLE_PROMPTS = [
  'Do you encrypt customer data at rest?',
  'How do you handle access control and authentication?',
  'What is your data retention and deletion policy?',
  'Do you have an incident response plan?',
];

test.describe('Chat', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', 'admin');
    await page.fill('#password', 'admin123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 10000 });

    await page.getByRole('link', { name: /chat/i }).click();
    await page.waitForURL('**/chat', { timeout: 10000 });
  });

  test('empty state shows the four sample prompts', async ({ page }) => {
    for (const prompt of SAMPLE_PROMPTS) {
      await expect(page.getByRole('button', { name: prompt })).toBeVisible();
    }
  });

  test('clicking a sample prompt starts a conversation', async ({ page }) => {
    const firstPrompt = SAMPLE_PROMPTS[0];
    await page.getByRole('button', { name: firstPrompt }).click();

    // The question appears as a user message (chips are replaced by the thread).
    await expect(page.getByText(firstPrompt).first()).toBeVisible({ timeout: 10000 });

    // The query is fired — the "Searching knowledge base..." loading indicator
    // appears. (Answering makes several real LLM calls; we don't block on the
    // full answer here to keep the test deterministic.)
    await expect(page.getByText(/searching knowledge base/i)).toBeVisible({ timeout: 15000 });
  });

  test('input box is present for free-form questions', async ({ page }) => {
    await expect(page.getByPlaceholder(/ask a compliance question/i)).toBeVisible();
  });
});
