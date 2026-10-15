import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@imp/test-utils/update-env';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';
import { buildMockEd25519Key } from './build-mock-ed25519-key';
import { instance } from './instance';
import { countKeyTraces, readKeyPatterns } from './key-traces';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'key-traces-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#readKeyPatterns gives a seed pattern that matches the seed the key holds', async () => {
  const ctx = await setupTest();

  // the seed by another road: node made the key, and its file is built from
  // node's seed
  const key = buildMockEd25519Key();
  const path = join(ctx.dir, 'id');

  await writeFile(path, key.privateKey, { mode: 0o600 });

  const patterns = readKeyPatterns(path);
  const seed = key.seed.toString('latin1');

  expect(seed).toHaveLength(32);
  expect(seed).toMatch(new RegExp(patterns.seedHex, 'v'));
  expect(patterns.seedHex).not.toInclude(String.raw`\x0a`);
});

test('#readKeyPatterns gives a base64 line of the key file as its text', async () => {
  const ctx = await setupTest();

  const key = buildMockEd25519Key();
  const path = join(ctx.dir, 'id');

  await writeFile(path, key.privateKey);

  const patterns = readKeyPatterns(path);

  expect(key.privateKey.split('\n')).toContain(patterns.text);
  expect(patterns.text).toMatch(/^[\w+\/=]+$/v);
});

test('#readKeyPatterns rejects a file that is not a key', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'id');

  await writeFile(path, 'not a key\n');

  expect(() => readKeyPatterns(path)).toThrow();
});

test('#countKeyTraces counts the key’s file line and its seed in a file in the container, beside the control', async () => {
  const ctx = await setupTest();

  // the container's own shell is this machine's: the stub drops `exec <name>`
  const docker = createStubBin(ctx.dir, 'docker', 'shift 2\nexec "$@"');

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const key = buildMockEd25519Key();
  const keyPath = join(ctx.dir, 'id');

  await writeFile(keyPath, key.privateKey, { mode: 0o600 });

  const patterns = readKeyPatterns(keyPath);
  const disk = join(ctx.dir, 'disk.ext4');

  await writeFile(
    disk,
    Buffer.concat([
      Buffer.from(`e2e-control\n${patterns.text}\n`),
      key.seed,
      Buffer.from('\nthe rest\n'),
    ]),
  );

  const traces = await countKeyTraces(disk, patterns, 'e2e-control');
  const calls = await readFile(docker.calls, 'utf8');

  expect(traces).toStrictEqual({ control: true, text: '1', seed: '1' });
  expect(calls).toStartWith(`docker exec ${instance.container} sh -c `);
});

test('#countKeyTraces finds no control and no trace in a file that holds neither', async () => {
  const ctx = await setupTest();

  // the container's own shell is this machine's: the stub drops `exec <name>`
  const docker = createStubBin(ctx.dir, 'docker', 'shift 2\nexec "$@"');

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const key = buildMockEd25519Key();
  const keyPath = join(ctx.dir, 'id');

  await writeFile(keyPath, key.privateKey);

  const patterns = readKeyPatterns(keyPath);
  const disk = join(ctx.dir, 'disk.ext4');

  await writeFile(disk, 'nothing of the key here\n');

  const traces = await countKeyTraces(disk, patterns, 'e2e-control');

  expect(traces).toStrictEqual({ control: false, text: '0', seed: '0' });
});
