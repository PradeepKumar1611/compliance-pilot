# Compliance Pilot -- Test Suite Documentation

This document describes how to install, run, and extend the test suite for the
Compliance Pilot system.  Tests are split into two categories:

* **Backend tests** -- Python/pytest tests that exercise the FastAPI API layer,
  services, and database logic.
* **UI tests** -- Playwright end-to-end tests that drive the React frontend
  through a real browser.

---

## Prerequisites

| Requirement     | Version    | Notes |
|-----------------|------------|-------|
| Python          | 3.11+      | Used by the backend and pytest |
| Node.js         | 18+ / 20+  | Used by the frontend and Playwright |
| npm             | 9+         | Ships with Node.js |
| Running backend | localhost:8000 | Required for UI tests |
| Running frontend| localhost:5173 | Required for UI tests (Vite dev server) |

---

## Installing Test Dependencies

### Backend tests

From the project root:

```bash
cd backend
pip install -r requirements.txt          # production deps
pip install -r requirements-dev.txt      # pytest, httpx, coverage, etc.
# -- or, if a single requirements file is used --
pip install pytest pytest-asyncio httpx coverage
```

### UI tests

```bash
cd tests/ui
npm install                              # installs @playwright/test
npx playwright install                   # downloads browser binaries (Chromium)
npx playwright install-deps              # installs OS-level libs (Linux)
```

---

## Running Tests

### Backend tests only

```bash
make test-backend
# -- or manually --
cd backend
pytest ../tests/backend -v
```

### UI tests only

> **Important:** The backend and frontend dev servers must both be running
> before you launch UI tests.

```bash
# Terminal 1 -- start the backend
cd backend && uvicorn app.main:app --reload

# Terminal 2 -- start the frontend
cd frontend && npm run dev

# Terminal 3 -- run the UI tests
make test-ui
# -- or manually --
cd tests/ui
npx playwright test
```

To run a single UI test file:

```bash
cd tests/ui
npx playwright test test_login.spec.js
```

To run in headed mode (see the browser):

```bash
npx playwright test --headed
```

### All tests

```bash
make test-all
```

### Coverage report

```bash
make test-coverage
# -- or manually --
cd backend
coverage run -m pytest ../tests/backend -v
coverage html -d ../tests/coverage
```

Then open the HTML report:

```bash
open tests/coverage/index.html      # macOS
xdg-open tests/coverage/index.html  # Linux
```

---

## What Each Test File Covers

### Backend (`tests/backend/`)

| File | Description |
|------|-------------|
| `conftest.py` | Shared fixtures: test client, database setup, auth tokens |

### UI (`tests/ui/`)

| File | Description |
|------|-------------|
| `playwright.config.js` | Playwright configuration (baseURL, timeouts, screenshots, video) |
| `test_login.spec.js` | Login form rendering, valid/invalid credentials, redirect to dashboard, logout flow |
| `test_dashboard.spec.js` | Stats cards (Total KB Documents, Questionnaires Processed, Auto-filled Today, Flagged Today), recent audit table, KB version badge, active jobs widget, sidebar navigation |
| `test_knowledge_base.spec.js` | Drag-drop upload area, PDF upload and appearance in document list, version creation, document deletion, table column headers |
| `test_questionnaire.spec.js` | Questionnaire upload, processing step indicators, download button appearance, downloaded file size validation, "Process Another" reset |
| `test_audit_log.spec.js` | Table columns (Time, Question, Answer, Confidence, Tier, KB Ver, Model, Lang, Flagged), filter controls, flagged-only filter, CSV export download, row click to open side panel, pagination |
| `test_settings.spec.js` | Admin-only access control, non-admin redirect to dashboard, save settings toast, test connection button, user management list, sidebar visibility per role |

---

## Test Fixtures

Test fixture files live in `tests/fixtures/`. These are used by UI tests to
simulate file uploads:

| File | Used by |
|------|---------|
| `sample_policy.pdf` | Knowledge Base upload tests |
| `sample_questionnaire.docx` | Questionnaire processing tests |

To create minimal fixtures for local development:

```bash
# Minimal PDF (if you don't have one)
echo "%PDF-1.4 minimal" > tests/fixtures/sample_policy.pdf

# For DOCX you need a real .docx -- use any small Word document
```

---

## How to Add New Tests

### Adding a backend test

1. Create a new file in `tests/backend/`, e.g. `test_new_feature.py`.
2. Import `pytest` and fixtures from `conftest.py`.
3. Write test functions prefixed with `test_`.
4. Run with `pytest tests/backend/test_new_feature.py -v`.

### Adding a UI test

1. Create a new file in `tests/ui/`, e.g. `test_new_page.spec.js`.
2. Use the standard structure:

```javascript
const { test, expect } = require('@playwright/test');

test.describe('New Feature Page', () => {
  test.beforeEach(async ({ page }) => {
    // Log in as admin
    await page.goto('/login');
    await page.fill('#username', 'admin');
    await page.fill('#password', 'admin123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 10000 });

    // Navigate to the new page
    await page.getByRole('link', { name: /new feature/i }).click();
    await page.waitForURL('**/new-feature', { timeout: 10000 });
  });

  test('page loads correctly', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /new feature/i })).toBeVisible();
  });
});
```

3. Run with `npx playwright test test_new_page.spec.js` from the `tests/ui/` directory.

### Best practices

- Every UI `test.describe` block should include a `beforeEach` that logs in
  and navigates to the page under test.
- Use `getByRole`, `getByText`, and `locator` selectors -- avoid fragile CSS
  class selectors.
- Set generous timeouts for actions that depend on API responses.
- Use `page.on('dialog', ...)` when testing flows that trigger `window.confirm`.
- Place any new fixture files in `tests/fixtures/`.

---

## How to Read the Coverage Report

After running `make test-coverage`, open `tests/coverage/index.html` in a
browser. The report shows:

- **Summary page** -- overall percentage and per-file breakdown.
- **File detail** -- click any file to see line-by-line coverage. Green lines
  were executed, red lines were not.
- **Sort columns** -- click column headers (Statements, Branches, Functions,
  Lines) to sort and identify the least-covered files.

Target a minimum of 80% line coverage for backend code.
