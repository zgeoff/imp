import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPathGoneCheck } from './imps';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imps-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#buildPathGoneCheck reports a unix socket that is still there', async () => {
  const ctx = await setupTest();

  const socket = join(ctx.dir, 'agent.sock');
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen(socket, resolve);
  });

  onTestFinished(() => {
    server.close();
  });

  const result = Bun.spawnSync(['sh', '-c', buildPathGoneCheck(socket)]);

  expect(result.stdout.toString()).toBe('there\n');
});

test('#buildPathGoneCheck reports a path with nothing at it as gone', async () => {
  const ctx = await setupTest();

  const result = Bun.spawnSync(['sh', '-c', buildPathGoneCheck(join(ctx.dir, 'agent.sock'))]);

  expect(result.stdout.toString()).toBe('gone\n');
});
