import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubNftBin } from './create-stub-nft-bin';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-nft-bin-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it records the arguments it was run with', async () => {
  const ctx = await setupTest();
  const nft = await createStubNftBin(ctx.dir);

  await Bun.spawn([nft.path, '-f', '-'], { stdin: 'ignore' }).exited;

  const argv = await nft.readArgv();

  expect(argv).toBe('-f -\n');
});

test('it records the script it read on stdin', async () => {
  const ctx = await setupTest();
  const nft = await createStubNftBin(ctx.dir);

  await Bun.spawn([nft.path, '-f', '-'], {
    stdin: new TextEncoder().encode("table inet imp_egress {}\n# it's\n"),
  }).exited;

  const stdin = await nft.readStdin();

  expect(stdin).toBe("table inet imp_egress {}\n# it's\n");
});

test('it exits 0 and prints nothing by default', async () => {
  const ctx = await setupTest();
  const nft = await createStubNftBin(ctx.dir);

  const child = Bun.spawn([nft.path, '-f', '-'], { stdin: 'ignore', stderr: 'pipe' });

  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
});

test('it prints the stderr it is given and exits with the code it is given', async () => {
  const ctx = await setupTest();

  const nft = await createStubNftBin(ctx.dir, {
    stderr: "Error: syntax error, unexpected newline\ndon't\n",
    exitCode: 3,
  });

  const child = Bun.spawn([nft.path, '-f', '-'], { stdin: 'ignore', stderr: 'pipe' });

  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  expect(exitCode).toBe(3);
  expect(stderr).toBe("Error: syntax error, unexpected newline\ndon't\n");
});
