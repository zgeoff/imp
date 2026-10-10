import { expect, onTestFinished, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@imp/test-utils/update-env';
import { utils } from 'ssh2';
import { createStubBin } from '../../../scripts/test-utils/create-stub-bin';
import { instance } from './instance';
import { countKeyTraces, readKeyPatterns } from './key-traces';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'key-traces-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#readKeyPatterns gives a seed pattern that matches the seed the key holds', async () => {
  const ctx = await setupTest();

  // the seed by another road: node makes the key, whose JWK's d is the raw
  // ed25519 private key, and ssh-keygen rewrites it as an OpenSSH key file
  const pair = generateKeyPairSync('ed25519');
  const path = join(ctx.dir, 'id');

  await writeFile(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

  const converted = Bun.spawnSync(['ssh-keygen', '-p', '-q', '-N', '', '-P', '', '-f', path]);
  const patterns = readKeyPatterns(path);
  const jwk = pair.privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d ?? '', 'base64url').toString('latin1');

  expect(converted.exitCode).toBe(0);
  expect(seed).toHaveLength(32);
  expect(seed).toMatch(new RegExp(patterns.seedHex, 'v'));
  expect(patterns.seedHex).not.toInclude(String.raw`\x0a`);
});

test('#readKeyPatterns gives a base64 line of the key file as its text', async () => {
  const ctx = await setupTest();

  const key = utils.generateKeyPairSync('ed25519');
  const path = join(ctx.dir, 'id');

  await writeFile(path, key.private);

  const patterns = readKeyPatterns(path);

  expect(key.private.split('\n')).toContain(patterns.text);
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

  const pair = generateKeyPairSync('ed25519');
  const keyPath = join(ctx.dir, 'id');

  await writeFile(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });

  Bun.spawnSync(['ssh-keygen', '-p', '-q', '-N', '', '-P', '', '-f', keyPath]);

  const patterns = readKeyPatterns(keyPath);
  const seed = Buffer.from(pair.privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
  const disk = join(ctx.dir, 'disk.ext4');

  await writeFile(
    disk,
    Buffer.concat([
      Buffer.from(`e2e-control\n${patterns.text}\n`),
      seed,
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

  const key = utils.generateKeyPairSync('ed25519');
  const keyPath = join(ctx.dir, 'id');

  await writeFile(keyPath, key.private);

  const patterns = readKeyPatterns(keyPath);
  const disk = join(ctx.dir, 'disk.ext4');

  await writeFile(disk, 'nothing of the key here\n');

  const traces = await countKeyTraces(disk, patterns, 'e2e-control');

  expect(traces).toStrictEqual({ control: false, text: '0', seed: '0' });
});
