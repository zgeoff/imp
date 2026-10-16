import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, readState, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// impd writes the read-only files through the agent, and the inner
// container sees them on a read-only bind, so root inside cannot change one
// (docs/architecture/guest/agent.md#read-only-files).

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('inner'), stack, client };
}

test('it shows a file impd wrote read-only to root, replaces it, keeps it through a sleep and removes it', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}files`;
  const path = '/run/imp/files/notes/rota.json';

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const written = await ctx.client.files.write({
    name,
    path: 'notes/rota.json',
    content: '{"shift":"early","revision":1}',
  });

  const uid = await runShellInImp(name, 'id -u');
  const first = await runShellInImp(name, `cat ${path}`);
  const mode = await runShellInImp(name, `stat -c '%a %u' ${path}`);

  expect(written).toStrictEqual({ path });
  expect(uid).toBe('0');
  expect(first).toBe('{"shift":"early","revision":1}');
  expect(mode).toBe('444 0');

  const overwrite = await tryImp(['exec', name, '--', 'sh', '-c', `echo '{}' > ${path}`]);

  expect(overwrite.exitCode).not.toBe(0);
  expect(overwrite.stderr).toInclude('Read-only file system');

  const remove = await tryImp(['exec', name, '--', 'rm', '-f', path]);

  expect(remove.exitCode).not.toBe(0);
  expect(remove.stderr).toInclude('Read-only file system');

  const chmod = await tryImp(['exec', name, '--', 'chmod', '644', path]);

  expect(chmod.exitCode).not.toBe(0);
  expect(chmod.stderr).toInclude('Read-only file system');

  const create = await tryImp(['exec', name, '--', 'touch', '/run/imp/files/notes/forged.json']);

  expect(create.exitCode).not.toBe(0);
  expect(create.stderr).toInclude('Read-only file system');

  await ctx.client.files.write({
    name,
    path: 'notes/rota.json',
    content: '{"shift":"late","revision":2}',
  });

  const replaced = await runShellInImp(name, `cat ${path}`);

  expect(replaced).toBe('{"shift":"late","revision":2}');

  await runImp('sleep', name);

  const slept = await readState(name);
  const woken = await runShellInImp(name, `cat ${path}`);

  expect(slept).toBe('sleeping');
  expect(woken).toBe('{"shift":"late","revision":2}');

  const removed = await ctx.client.files.remove({ name, path: 'notes/rota.json' });
  const gone = await runShellInImp(name, `test -e ${path} && echo there || echo gone`);

  expect(removed).toStrictEqual({ removed: true });
  expect(gone).toBe('gone');
});

// the dropped exec runs first: the plain exec's remount would leave the
// files writable for it
test('it refuses root a remount of the files in an exec that drops CAP_SYS_ADMIN, and lets a plain exec remount them', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}files-caps`;
  const path = '/run/imp/files/session.json';

  const decoder = new TextDecoder();

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await ctx.client.files.write({ name, path: 'session.json', content: '{"session":"a"}' });

  const dropped = await ctx.client.run(
    name,
    [
      'sh',
      '-c',
      `id -u; mount -o remount,rw /run/imp/files || echo refused; echo '{"session":"b"}' > ${path} || echo read-only; cat ${path}`,
    ],
    { dropSysAdmin: true },
  );

  expect(decoder.decode(dropped.stdout).trim().split('\n')).toStrictEqual([
    '0',
    'refused',
    'read-only',
    '{"session":"a"}',
  ]);

  // busybox's mount names EPERM so
  expect(decoder.decode(dropped.stderr)).toInclude('mount: permission denied');

  const plain = await ctx.client.run(name, [
    'sh',
    '-c',
    `mount -o remount,rw /run/imp/files && echo remounted; echo '{"session":"b"}' > ${path} && cat ${path}`,
  ]);

  expect(decoder.decode(plain.stdout).trim().split('\n')).toStrictEqual([
    'remounted',
    '{"session":"b"}',
  ]);
});
