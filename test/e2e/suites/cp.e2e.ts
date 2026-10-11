import { expect, onTestFinished, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  createInstanceClient,
  requireImp,
  runImp,
  runInImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { REPO_ROOT, runInContainer } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// `imp cp` (docs/guides/cp.md) on the e2e-git image, whose USER is `dev`, not
// root: what a copy makes belongs to the owner of the directory it lands in
// unless --owner says otherwise.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  await mkdir(join(REPO_ROOT, '.cache', 'e2e'), { recursive: true });

  const local = await mkdtemp(join(REPO_ROOT, '.cache', 'e2e', 'cp-'));

  stack.defer(() => rm(local, { recursive: true, force: true }));

  return { prefix: readSuitePrefix('cp'), stack, client, local };
}

test('it copies a directory into a root-owned path as root with its modes, and back out whole with its modes and symlink', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}rt`;
  const app = join(ctx.local, 'app');

  // 48 MiB: big enough that the upload stops at the stdin window many times
  const big = randomBytes(48 * 1_048_576);
  const bigHash = createHash('sha256').update(big).digest('hex');

  await mkdir(join(app, 'bin'), { recursive: true, mode: 0o750 });
  await writeFile(join(app, 'bin', 'run'), '#!/bin/sh\necho ran\n', { mode: 0o755 });
  await writeFile(join(app, 'notes with spaces.txt'), 'hello', { mode: 0o600 });
  await symlink('bin/run', join(app, 'link'));
  await writeFile(join(app, 'big.bin'), big);
  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  // runImp throws on a failed copy, with its stderr
  await runImp('cp', app, `${name}:/srv`);

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

  const back = join(ctx.local, 'back');

  await mkdir(back);
  await runImp('cp', `${name}:/srv/app`, back);

  const backBig = await readFile(join(back, 'app', 'big.bin'));
  const notesStat = await lstat(join(back, 'app', 'notes with spaces.txt'));
  const binStat = await lstat(join(back, 'app', 'bin'));
  const link = await readlink(join(back, 'app', 'link'));

  expect(createHash('sha256').update(backBig).digest('hex')).toBe(bigHash);
  expect(notesStat.mode & 0o777).toBe(0o600);
  expect(binStat.mode & 0o777).toBe(0o750);
  expect(link).toBe('bin/run');
});

test('it gives a copy into the home to the image user', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}home`;
  const notes = join(ctx.local, 'notes with spaces.txt');

  await writeFile(notes, 'hello', { mode: 0o600 });
  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  // runImp throws on a failed copy, with its stderr
  await runImp('cp', notes, `${name}:/home/dev`);

  const listed = await runInImp(name, 'stat', '-c', '%U %G', '/home/dev/notes with spaces.txt');

  expect(listed).toBe('dev dev');
});

test('it gives a copy the --owner it names, and lands a relative path in the home', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}own`;
  const bin = join(ctx.local, 'bin');

  await mkdir(bin, { mode: 0o750 });
  await writeFile(join(bin, 'run'), '#!/bin/sh\necho ran\n', { mode: 0o755 });
  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  // runImp throws on a failed copy, with its stderr
  await runImp('cp', '--owner', 'root', bin, `${name}:work`);

  const listed = await runShellInImp(
    name,
    'sudo stat -c "%n %U" /home/dev/work /home/dev/work/run',
  );

  expect(listed).toBe('/home/dev/work root\n/home/dev/work/run root');
});

// a guest process puts a symlink where the copy's top lands; the copy, as
// root, must not write through it
test('it refuses to write through a symlink in the imp', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}trap`;
  const trap = join(ctx.local, 'trap');

  await mkdir(trap);
  await writeFile(join(trap, 'planted'), 'x');
  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runShellInImp(name, 'ln -s /etc /home/dev/trap');

  const result = await tryImp(['cp', trap, `${name}:/home/dev`]);

  const planted = await runShellInImp(
    name,
    'if [ -e /etc/planted ]; then echo there; else echo gone; fi',
  );

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('under a symlink'),
  });

  expect(planted).toBe('gone');
});

test('it fails with the path when the path is not in the imp', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}miss`;

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const result = await tryImp(['cp', `${name}:/no/such`, ctx.local]);

  expect(result).toStrictEqual({ exitCode: 1, stdout: '', stderr: expect.toInclude('/no/such') });
});

test('it refuses with AGENT_OUTDATED an imp whose agent predates imp cp', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}old`;
  const file = join(ctx.local, 'file.txt');

  await writeFile(file, 'x');
  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const row = await requireImp(name);

  const identity = `/var/lib/imp/imps/${row.id}/vm.json`;

  await runInContainer([
    'sh',
    '-c',
    `cp ${identity} ${identity}.e2e && sed -i 's/"agentVersion": "[^"]*"/"agentVersion": "0.6.0"/' ${identity}`,
  ]);

  ctx.stack.defer(async () => {
    await runInContainer(['mv', `${identity}.e2e`, identity]);
  });

  const result = await tryImp(['cp', file, `${name}:/tmp`]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('AGENT_OUTDATED'),
  });
});
