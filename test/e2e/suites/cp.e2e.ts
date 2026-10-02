import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveImageName } from '../lib/fixtures';
import { requireImp, runInImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { REPO_ROOT, runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';

// `imp cp` (docs/guides/cp.md) on the e2e-git image, whose USER is `dev`, not
// root: what a copy makes belongs to the owner of the directory it lands in
// unless --owner says otherwise.

const prefix = setupSuite('cp');
const name = `${prefix}a`;

// big enough that the upload stops at the stdin window many times
const BIG_BYTES = 48 * 1_048_576;
let local: string;
let bigHash: string;

function buildHash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

beforeAll(async () => {
  mkdirSync(join(REPO_ROOT, '.cache', 'e2e'), { recursive: true });

  local = mkdtempSync(join(REPO_ROOT, '.cache', 'e2e', 'cp-'));

  const app = join(local, 'app');

  mkdirSync(join(app, 'bin'), { recursive: true, mode: 0o750 });
  writeFileSync(join(app, 'bin', 'run'), '#!/bin/sh\necho ran\n', { mode: 0o755 });
  writeFileSync(join(app, 'notes with spaces.txt'), 'hello', { mode: 0o600 });
  symlinkSync('bin/run', join(app, 'link'));

  const big = randomBytes(BIG_BYTES);

  bigHash = buildHash(big);

  writeFileSync(join(app, 'big.bin'), big);

  await createImp(name, '--image', resolveImageName('e2e-git'), '--memory', '256');
}, 120_000);

afterAll(() => {
  rmSync(local, { recursive: true, force: true });
});

test('a directory goes into a root-owned path, owned by root, modes kept', async () => {
  const result = await tryImp(['cp', join(local, 'app'), `${name}:/srv`]);

  expect(result).toMatchObject({ exitCode: 0 });

  const listed = await runInImp(
    name,
    'sudo',
    'sh',
    '-c',
    [
      'cd /srv/app',
      'stat -c "%n %U %a" . bin bin/run "notes with spaces.txt"',
      'readlink link',
      'sha256sum big.bin | cut -d" " -f1',
      './bin/run',
    ].join('\n'),
  );

  expect(listed).toBe(
    [
      '. root 750',
      'bin root 750',
      'bin/run root 755',
      'notes with spaces.txt root 600',
      'bin/run',
      bigHash,
      'ran',
    ].join('\n'),
  );
});

test('a copy into the home belongs to the image user', async () => {
  const notes = join(local, 'app', 'notes with spaces.txt');

  const result = await tryImp(['cp', notes, `${name}:/home/dev`]);

  expect(result.exitCode).toBe(0);

  const listed = await runInImp(name, 'stat', '-c', '%U %G', '/home/dev/notes with spaces.txt');

  expect(listed).toBe('dev dev');
});

test('--owner sets the owner, and a relative path lands in the home', async () => {
  const result = await tryImp(['cp', '--owner', 'root', join(local, 'app', 'bin'), `${name}:work`]);

  expect(result.exitCode).toBe(0);

  const listed = await runShellInImp(
    name,
    'sudo stat -c "%n %U" /home/dev/work /home/dev/work/run',
  );

  expect(listed).toBe('/home/dev/work root\n/home/dev/work/run root');
});

test('a copy out of the imp comes back whole, modes and symlink kept', async () => {
  const back = join(local, 'back');

  mkdirSync(back);

  const result = await tryImp(['cp', `${name}:/srv/app`, back]);

  expect(result).toMatchObject({ exitCode: 0 });

  const backBig = readFileSync(join(back, 'app', 'big.bin'));

  expect(buildHash(backBig)).toBe(bigHash);
  expect(lstatSync(join(back, 'app', 'notes with spaces.txt')).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(back, 'app', 'bin')).mode & 0o777).toBe(0o750);
  expect(readlinkSync(join(back, 'app', 'link'))).toBe('bin/run');
});

// a guest process puts a symlink where the copy's top lands; the copy, as
// root, must not write through it
test('a symlink in the imp is not written through', async () => {
  await runShellInImp(name, 'ln -s /etc /home/dev/trap');

  mkdirSync(join(local, 'trap'));
  writeFileSync(join(local, 'trap', 'planted'), 'x');

  const result = await tryImp(['cp', join(local, 'trap'), `${name}:/home/dev`]);

  const planted = await runShellInImp(
    name,
    'if [ -e /etc/planted ]; then echo there; else echo gone; fi',
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('under a symlink');
  expect(planted).toBe('gone');
});

test('a path that is not there fails with the reason', async () => {
  const result = await tryImp(['cp', `${name}:/no/such`, local]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('/no/such');
});

test('an imp whose agent predates imp cp gets AGENT_OUTDATED', async () => {
  const imp = await requireImp(name);

  const file = `/var/lib/imp/imps/${imp.id}/vm.json`;

  await runInContainer([
    'sh',
    '-c',
    `cp ${file} ${file}.e2e && sed -i 's/"agentVersion": "[^"]*"/"agentVersion": "0.6.0"/' ${file}`,
  ]);

  try {
    const result = await tryImp(['cp', join(local, 'trap'), `${name}:/tmp`]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('AGENT_OUTDATED');
  } finally {
    await runInContainer(['mv', `${file}.e2e`, file]);
  }
});
