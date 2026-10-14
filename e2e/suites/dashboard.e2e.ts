import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, readImpEnv } from '../lib/imp-cli';
import { REPO_ROOT, runChecked } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { writeMetric } from '../lib/write-metric';

// packages/dashboard/e2e drives the dashboard in a browser, on an imp this
// journey names; the browser destroys it, and a failed run's goes here.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('dashboard'), stack, client };
}

test('it logs in, creates, opens a console, sleeps and destroys an imp, and logs out in a browser against impd', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}ui`;
  const dashboardDir = join(REPO_ROOT, 'packages', 'dashboard');

  // the browser makes the imp; one a failed run leaves goes with the stack
  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  // scripts/dev/dev.sh serves packages/dashboard/dist, which impd reads per request
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
      E2E_IMP_PREFIX: ctx.prefix,
      E2E_IMP_NAME: name,
      E2E_IMP_IMAGE: resolveImageName('e2e-tiny'),
    },
  });

  ctx.stack.defer(() => {
    proc.kill();
  });

  const exitCode = await proc.exited;

  writeMetric('dashboardBrowserMs', Math.round(performance.now() - startedAt));

  expect(exitCode).toBe(0);
}, 720_000);
