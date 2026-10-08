import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { createImpClient } from '../src/create-imp-client';

const ServedSchema = z.object({
  url: z.string(),
  prefixedUrl: z.string(),
  closedUrl: z.string(),
  token: z.string(),
});

// the stand-in in its own process, with a temp dir of its own for the
// harness's data dir; `served` is the JSON line it prints once ready
async function setupTest() {
  const tempDir = await mkdtemp(join(tmpdir(), 'run-stub-impd-'));

  onTestFinished(() => rm(tempDir, { recursive: true, force: true }));

  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'run-stub-impd.ts')], {
    env: { ...process.env, TMPDIR: tempDir },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  const reader = child.stdout.getReader();

  const decoder = new TextDecoder();

  const read = { text: '' };

  while (!read.text.includes('\n')) {
    const chunk = await reader.read();

    if (chunk.done) {
      throw new Error(`run-stub-impd exited before it was ready: ${read.text}`);
    }

    read.text += decoder.decode(chunk.value);
  }

  reader.releaseLock();

  const served = ServedSchema.parse(JSON.parse(read.text.split('\n')[0] ?? ''));

  return { child, tempDir, served };
}

test('it serves impd with the smoke imp to a client holding its token', async () => {
  const ctx = await setupTest();

  const client = createImpClient({ url: ctx.served.url, token: ctx.served.token });

  const imps = await client.imps.list({});

  expect(imps.map((imp) => imp.name)).toStrictEqual(['smoke']);
});

test('it serves impd under the prefix and nothing outside it', async () => {
  const ctx = await setupTest();
  const outside = await fetch(new URL('/rpc', ctx.served.prefixedUrl));

  expect(outside.status).toBe(404);
});

test('it names a url where nothing listens', async () => {
  const ctx = await setupTest();

  expect(fetch(ctx.served.closedUrl)).rejects.toThrow();
});

test('it exits 0 on SIGTERM and leaves no temp files behind', async () => {
  const ctx = await setupTest();

  ctx.child.kill('SIGTERM');

  const exitCode = await ctx.child.exited;
  const left = await readdir(ctx.tempDir);

  expect(exitCode).toBe(0);
  expect(left).toStrictEqual([]);
});
