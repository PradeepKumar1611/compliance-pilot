/**
 * Global setup for Playwright tests (Compliance Pilot).
 *
 * Auth is cookie-based (httpOnly access/refresh + CSRF double-submit). This
 * setup:
 *   1. Logs in as admin (cookies stored on the request context).
 *   2. Clears the must_change_password flag so UI logins go straight to the app.
 *   3. Creates a non-admin "testuser" for role-based tests.
 *   4. Seeds the knowledge base (uploads a sample policy) and waits for
 *      ingestion so the end-to-end questionnaire/KB/audit tests have content.
 */

const { request } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BACKEND = process.env.API_BASE || 'http://localhost:9000';
const ADMIN = 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TEST_USER = process.env.TEST_USER || 'testuser';
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD || 'testpass123';

function getCsrf(state) {
  const cookie = (state.cookies || []).find((c) => c.name === 'csrf_token');
  return cookie ? cookie.value : '';
}

function readyCount(docs) {
  if (typeof docs.ready_count === 'number') return docs.ready_count;
  return (docs.items || []).filter((d) => d.status === 'ready').length;
}

module.exports = async function globalSetup() {
  // Generous per-request timeout: ingestion can briefly keep the backend busy.
  const ctx = await request.newContext({ baseURL: BACKEND, timeout: 60000 });

  // 1. Login admin
  let resp = await ctx.post('/api/auth/login', {
    data: { username: ADMIN, password: ADMIN_PASSWORD },
  });
  if (!resp.ok()) {
    throw new Error(
      `Global setup: admin login failed (${resp.status()}). ` +
        `Expected admin/${ADMIN_PASSWORD} — is the backend seeded?`
    );
  }
  let data = await resp.json();
  let csrf = getCsrf(await ctx.storageState());

  // 2. Clear must_change_password (change password to the same value)
  if (data.must_change_password) {
    const cp = await ctx.post('/api/auth/change-password', {
      headers: { 'X-CSRF-Token': csrf },
      data: { current_password: ADMIN_PASSWORD, new_password: ADMIN_PASSWORD },
    });
    if (!cp.ok()) console.warn(`Global setup: change-password failed (${cp.status()})`);
    // Re-login to refresh cookies / cleared flag
    await ctx.post('/api/auth/login', {
      data: { username: ADMIN, password: ADMIN_PASSWORD },
    });
    csrf = getCsrf(await ctx.storageState());
  }

  // 3. Create a non-admin test user (idempotent)
  const cu = await ctx.post('/api/users', {
    headers: { 'X-CSRF-Token': csrf },
    data: { username: TEST_USER, password: TEST_USER_PASSWORD, role: 'user' },
  });
  if (cu.ok()) console.log(`Global setup: created non-admin '${TEST_USER}'`);
  else if (cu.status() === 400) console.log(`Global setup: '${TEST_USER}' already exists`);
  else console.warn(`Global setup: create user failed (${cu.status()})`);

  // 4. Seed the knowledge base if empty
  const docsResp = await ctx.get('/api/kb/documents');
  const docs = docsResp.ok() ? await docsResp.json() : { items: [] };
  if (readyCount(docs) === 0) {
    // Use a .txt policy: KB ingestion of PDF/DOCX/XLSX goes through docling
    // (heavy OCR + model downloads that block the event loop); .txt/.md/.json
    // use the fast path while still exercising real embeddings + RAG.
    const txtPath = path.resolve(__dirname, '..', 'fixtures', 'sample_policy.txt');
    const buffer = fs.readFileSync(txtPath);
    const up = await ctx.post('/api/kb/upload', {
      headers: { 'X-CSRF-Token': csrf },
      multipart: {
        file: { name: 'sample_policy.txt', mimeType: 'text/plain', buffer },
      },
    });
    if (!up.ok()) {
      console.warn(`Global setup: KB upload failed (${up.status()})`);
    } else {
      console.log('Global setup: seeding KB (sample_policy.txt) — waiting for ingestion...');
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        const dr = await ctx.get('/api/kb/documents');
        if (!dr.ok()) continue;
        const d = await dr.json();
        if (readyCount(d) > 0) {
          console.log('Global setup: KB ingestion complete (ready).');
          break;
        }
        if ((d.items || []).some((x) => x.status === 'failed')) {
          console.warn('Global setup: KB ingestion reported failed — continuing anyway.');
          break;
        }
      }
    }
  } else {
    console.log(`Global setup: KB already has ${readyCount(docs)} ready document(s).`);
  }

  console.log(`Global setup complete (admin password: ${ADMIN_PASSWORD}).`);
  await ctx.dispose();
};
