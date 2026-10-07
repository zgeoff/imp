import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../test-utils/start-cli';

test('it refuses a scope a token cannot have', async () => {
  const result = await runCli({
    args: ['token', 'new', 'ci', '--scope', 'root'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: --scope must be one of read, exec, manage\n',
    code: 2,
  });
});

test('it refuses an imp pattern that is not an imp name', async () => {
  const result = await runCli({
    args: ['token', 'new', 'ci', '--scope', 'exec', '--imps', 'Dev*'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: --imps takes imp names with * for any run of characters, such as dev-*; not Dev*\n',
    code: 2,
  });
});

test('it refuses a private key where a .pub file belongs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-key-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const privateKey = join(dir, 'id_ed25519');

  await writeFile(privateKey, '-----BEGIN OPENSSH PRIVATE KEY-----\n');

  const result = await runCli({
    args: ['token', 'key', 'add', 'ci', privateKey],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: `imp: ${privateKey} is a private key; give its .pub file\n`,
    code: 2,
  });
});

test('it refuses a .pub file that holds no key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-key-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const empty = join(dir, 'empty.pub');

  await writeFile(empty, '# nothing\n');

  const result = await runCli({
    args: ['token', 'key', 'add', 'ci', empty],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: `imp: ${empty} holds no key\n`, code: 2 });
});

test('it refuses an --ssh-key file that is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-key-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const missing = join(dir, 'missing.pub');

  const result = await runCli({
    args: ['token', 'new', 'ci', '--scope', 'exec', '--ssh-key', missing],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: `imp: cannot read ${missing}: ENOENT: no such file or directory, open '${missing}'\n`,
    code: 2,
  });
});
