import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import * as z from 'zod';
import { createImpClient } from '../src/create-imp-client';

// the stand-in in its own process, with a temp dir of its own for the
// harness's data dir; `served` is the JSON line it prints once ready
async function setupTest() {
  // one stack: the child exits before its temp dir goes
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const tempDir = await mkdtemp(join(tmpdir(), 'run-stub-impd-'));

  stack.defer(() => rm(tempDir, { recursive: true, force: true }));

  const stdoutPath = join(tempDir, 'stdout');

  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'run-stub-impd.ts')], {
    env: { ...process.env, TMPDIR: tempDir },
    stdout: Bun.file(stdoutPath),
    stderr: 'inherit',
  });

  stack.defer(async () => {
    child.kill('SIGKILL');

    await child.exited;
  });

  // the first line, once the stand-in is ready
  const line = await waitFor(
    async () => {
      const text = await readFile(stdoutPath, 'utf8');

      const [first, afterFirst] = text.split('\n');

      // no text after a first newline: the line is not complete yet
      invariant(afterFirst, 'run-stub-impd is not ready yet');

      return first ?? '';
    },
    { timeoutMs: 15_000 },
  );

  const served = z
    .object({ url: z.string(), prefixedUrl: z.string(), closedUrl: z.string(), token: z.string() })
    .parse(JSON.parse(line));

  return { child, tempDir, served };
}

test('it serves impd with the smoke imp to a client holding its token', async () => {
  const ctx = await setupTest();

  const client = createImpClient({ url: ctx.served.url, token: ctx.served.token });

  const imps = await client.imps.list({});

  expect(imps.map((imp) => imp.name)).toStrictEqual(['smoke']);
});

test('it serves impd under the prefix', async () => {
  const ctx = await setupTest();
  const health = await fetch(new URL('health', ctx.served.prefixedUrl));

  expect(health.status).toBe(200);
});

test('it serves nothing outside the prefix', async () => {
  const ctx = await setupTest();
  const outside = await fetch(new URL('/rpc', ctx.served.prefixedUrl));

  expect(outside.status).toBe(404);
});

test('it names a url where nothing listens', async () => {
  const ctx = await setupTest();

  expect(fetch(ctx.served.closedUrl)).rejects.toThrow();
});

test('it exits 0 on SIGTERM and leaves only its output in its temp dir', async () => {
  const ctx = await setupTest();

  ctx.child.kill('SIGTERM');

  const exitCode = await ctx.child.exited;
  const left = await readdir(ctx.tempDir);

  expect(exitCode).toBe(0);
  expect(left).toStrictEqual(['stdout']);
});
