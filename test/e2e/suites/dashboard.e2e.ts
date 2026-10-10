import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { resolveImageName } from '../lib/fixtures';
import { readImpEnv } from '../lib/imp-cli';
import { REPO_ROOT, runChecked } from '../lib/instance';
import { readSuitePrefix } from '../lib/suites';
import { writeMetric } from '../lib/write-metric';

// packages/dashboard/e2e drives the dashboard in a browser. Its imps carry
// the suite's prefix; it removes them, and the harness's reset takes what a
// failed run leaves.

test('it logs in, creates, opens a console, sleeps and destroys an imp, and logs out in a browser against impd', async () => {
  const dashboardDir = join(REPO_ROOT, 'packages', 'dashboard');

  // scripts/dev.sh serves packages/dashboard/dist, which impd reads per request
  await runChecked(['bun', 'run', '--cwd', dashboardDir, 'build']);

  // the headless shell of the Chromium that the locked Playwright pins; a
  // no-op when the cache has it
  await runChecked(['bun', 'run', '--cwd', dashboardDir, 'e2e:install']);

  const impEnv = await readImpEnv();

  const startedAt = performance.now();

  const proc = Bun.spawn(['bun', 'run', 'e2e'], {
    cwd: dashboardDir,
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      ...impEnv,
      E2E_IMP_PREFIX: readSuitePrefix('dashboard'),
      E2E_IMP_IMAGE: resolveImageName('e2e-tiny'),
    },
  });

  onTestFinished(() => {
    proc.kill();
  });

  const exitCode = await proc.exited;

  writeMetric('dashboardBrowserMs', Math.round(performance.now() - startedAt));

  expect(exitCode).toBe(0);
}, 720_000);
