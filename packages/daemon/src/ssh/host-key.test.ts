import { expect, onTestFinished, test } from 'bun:test';
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { createEd25519Key, loadOrCreateHostKey, readFingerprint, setupSshDir } from './host-key';

async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'imp-hostkey-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  return { dataDir };
}

test('it makes the ssh dir owner-only', async () => {
  const ctx = await setupTest();

  const sshDir = setupSshDir(ctx.dataDir);

  expect(statSync(join(ctx.dataDir, 'ssh')).mode & 0o777).toBe(0o700);
  expect(sshDir).toBe(join(ctx.dataDir, 'ssh'));
});

test('it writes the host key owner-only', async () => {
  const ctx = await setupTest();

  const sshDir = setupSshDir(ctx.dataDir);

  loadOrCreateHostKey(sshDir);

  expect(statSync(join(ctx.dataDir, 'ssh', 'host_key')).mode & 0o777).toBe(0o600);
});

test('it loads the same host key once it is made', async () => {
  const ctx = await setupTest();

  const sshDir = setupSshDir(ctx.dataDir);
  const first = loadOrCreateHostKey(sshDir);

  expect(loadOrCreateHostKey(sshDir)).toBe(first);
});

test('it makes an ed25519 host key that ssh2 reads back', async () => {
  const ctx = await setupTest();

  const sshDir = setupSshDir(ctx.dataDir);
  const parsed = utils.parseKey(loadOrCreateHostKey(sshDir));

  expect(parsed).toMatchObject({ type: 'ssh-ed25519' });
});

test('it reads a key’s fingerprint as SHA256 and unpadded base64', () => {
  expect(readFingerprint(createEd25519Key().private)).toMatch(/^SHA256:[\w+\/]{43}$/v);
});

test('it rejects a fingerprint of a key it cannot parse', () => {
  expect(() => readFingerprint('garbage')).toThrow();
});

// ssh2's generator makes a key that does not parse about once in 256
test('it makes the key again when the first one does not read back', () => {
  const readable = createEd25519Key();
  const pairs = [{ private: 'garbage', public: 'garbage' }, readable];
  const made = createEd25519Key(() => pairs.shift() ?? readable);

  expect(made).toBe(readable);
});

test('it gives up after 16 keys that do not read back', () => {
  const tries = { count: 0 };

  const createKey = () =>
    createEd25519Key(() => {
      tries.count += 1;

      return { private: 'garbage', public: 'garbage' };
    });

  expect(createKey).toThrowWithMessage(Error, 'no readable ed25519 key in 16 attempts');
  expect(tries.count).toBe(16);
});
