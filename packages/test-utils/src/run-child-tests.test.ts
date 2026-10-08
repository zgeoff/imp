import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChildTests } from './run-child-tests';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'child-tests-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it exits 0 and reports each pass for a passing file', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    "import { expect, test } from 'bun:test';\ntest('it passes', () => { expect(1).toBe(1); });\n",
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 1 pass');
});

test('it exits 1 for a file with a failing test', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    "import { expect, test } from 'bun:test';\ntest('it fails', () => { expect(1).toBe(2); });\n",
  );

  expect(run.exitCode).toBe(1);
  expect(run.output).toInclude(' 1 fail');
});

test('it runs the child with the dir as its temp dir', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    [
      "import { expect, test } from 'bun:test';",
      "import { tmpdir } from 'node:os';",
      `test('it sees the dir', () => { expect(tmpdir()).toBe(${JSON.stringify(ctx.dir)}); });`,
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
});

test('it lets a later test read what an earlier test released', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    [
      "import { expect, onTestFinished, test } from 'bun:test';",
      'const state = { isReleased: false };',
      "test('it registers', () => { onTestFinished(() => { state.isReleased = true; }); });",
      "test('it sees the release', () => { expect(state.isReleased).toBeTrue(); });",
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});
