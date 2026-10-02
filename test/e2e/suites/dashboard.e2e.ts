import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveImageName } from '../lib/fixtures';
import { readImpEnv } from '../lib/imp-cli';
import { REPO_ROOT, runCommand } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('dashboard');
const DASHBOARD_DIR = join(REPO_ROOT, 'packages', 'dashboard');

// scripts/dev.sh serves packages/dashboard/dist, which impd reads per request
test('the dashboard builds', async () => {
  const built = await runCommand(['bun', 'run', '--cwd', DASHBOARD_DIR, 'build']);

  expect(built.exitCode, built.stderr).toBe(0);
}, 120_000);

// the headless shell of the Chromium that the locked Playwright pins; a no-op
// when the cache has it
test('Playwright has its browser', async () => {
  const installed = await runCommand(['bun', 'run', '--cwd', DASHBOARD_DIR, 'e2e:install']);

  expect(installed.exitCode, installed.stderr).toBe(0);
}, 300_000);

// packages/dashboard/e2e: log in, create, console, sleep, destroy, log out
test('the dashboard works in a browser against impd', async () => {
  const impEnv = await readImpEnv();

  const startedAt = performance.now();

  const proc = Bun.spawn(['bun', 'run', 'e2e'], {
    cwd: DASHBOARD_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      ...impEnv,
      E2E_IMP_PREFIX: prefix,
      E2E_IMP_IMAGE: resolveImageName('e2e-tiny'),
    },
  });

  const exitCode = await proc.exited;

  writeMetric('dashboardBrowserMs', Math.round(performance.now() - startedAt));

  expect(exitCode).toBe(0);
}, 300_000);
