import { expect, onTestFinished, test } from 'bun:test';
import { createPrivateKey } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { readKeyPatterns } from './key-traces';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'key-traces-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#readKeyPatterns gives a seed pattern that matches the seed the key holds', async () => {
  const ctx = await setupTest();

  const key = utils.generateKeyPairSync('ed25519');
  const path = join(ctx.dir, 'id');

  await writeFile(path, key.private);

  const patterns = readKeyPatterns(path);

  // the seed by another road: the JWK's d is the raw ed25519 private key
  const parsed = utils.parseKey(key.private);

  if (parsed instanceof Error) {
    throw parsed;
  }

  const jwk = createPrivateKey(parsed.getPrivatePEM()).export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d ?? '', 'base64url').toString('latin1');

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
