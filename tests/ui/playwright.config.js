// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright configuration for Compliance Pilot UI tests.
 *
 * Expects the frontend dev server to be running on http://localhost:5173
 * and the backend API on http://localhost:9000 (proxied by Vite).
 */
module.exports = defineConfig({
  globalSetup: './global-setup.js',
  testDir: '.',
  testMatch: '**/*.spec.js',

  /* Maximum time one test can run. End-to-end pipeline tests raise this
     further via test.setTimeout(). */
  timeout: 60000,

  /* Fail the build on CI if test.only is left in source */
  forbidOnly: !!process.env.CI,

  /* Retry once on CI, never locally */
  retries: process.env.CI ? 1 : 0,

  /* Limit parallel workers on CI to avoid flakes */
  workers: process.env.CI ? 1 : undefined,

  /* Reporter: list for local, html on CI */
  reporter: process.env.CI ? 'html' : 'list',

  use: {
    /* Base URL for all page.goto() calls */
    baseURL: 'http://localhost:5173',

    /* Collect trace on first retry */
    trace: 'on-first-retry',

    /* Screenshot on test failure */
    screenshot: 'only-on-failure',

    /* Record video on retry */
    video: 'on-first-retry',

    /* Default headless mode */
    headless: true,

    /* Viewport */
    viewport: { width: 1280, height: 720 },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Output directory for screenshots, videos, traces */
  outputDir: './test-results',
});
