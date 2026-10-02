import { defineConfig, devices } from '@playwright/test';

// Against a running impd that serves a built dashboard (docs/guides/dashboard.md):
// IMP_URL (default: the dev instance at 7070 + IMP_DEV_PORT_OFFSET) and IMP_TOKEN.
const offset = Number(process.env['IMP_DEV_PORT_OFFSET'] ?? 0);
const baseURL = process.env['IMP_URL'] ?? `http://localhost:${String(7070 + offset)}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  outputDir: '.test-results',

  // one impd, whose RAM budget the specs share
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
