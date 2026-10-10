import { expect, onTestFinished, test } from 'bun:test';
import { createPublicKey } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { buildMockEd25519Key } from './build-mock-ed25519-key';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'mock-ed25519-key-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it builds a default ed25519 key', () => {
  expect(buildMockEd25519Key()).toStrictEqual({
    privateKey: expect.toSatisfy((file: string) =>
      /^-----BEGIN OPENSSH PRIVATE KEY-----\n(?:[\w+\/=]{1,70}\n)+-----END OPENSSH PRIVATE KEY-----\n$/v.test(
        file,
      ),
    ),
    seed: expect.toSatisfy((seed: Buffer) => seed.length === 32),
    publicKey: expect.toSatisfy((publicKey: Buffer) => publicKey.length === 32),
  });
});

test('it applies overrides on top of the defaults', () => {
  const key = buildMockEd25519Key({ comment: 'imp-e2e-laptop' });
  const parsed = utils.parseKey(key.privateKey);

  expect(parsed).toMatchObject({ type: 'ssh-ed25519', comment: 'imp-e2e-laptop' });
});

test('it writes a key file that ssh-keygen reads, with the public key node made', async () => {
  const ctx = await setupTest();

  const key = buildMockEd25519Key();
  const path = join(ctx.dir, 'id');

  await writeFile(path, key.privateKey, { mode: 0o600 });

  const derived = Bun.spawnSync(['ssh-keygen', '-y', '-f', path]);

  // the public key's own encoding, from node: SPKI's last 32 bytes
  const spki = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey.toString('base64url') },
    format: 'jwk',
  }).export({ type: 'spki', format: 'der' });

  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from('ssh-ed25519'),
    Buffer.from([0, 0, 0, 32]),
    spki.subarray(-32),
  ]);

  expect(derived.exitCode).toBe(0);
  expect(derived.stdout.toString()).toBe(`ssh-ed25519 ${blob.toString('base64')} imp-e2e-key\n`);
});
