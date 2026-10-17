import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { listAuditCalls } from '../lib/audit';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp, runImpWith, tryImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import {
  removeImpIfPresent,
  removeSecretIfPresent,
  removeTokenIfPresent,
} from '../lib/reset-baseline';
import { runSsh, setupKeyClient } from '../lib/ssh';
import { readSuitePrefix } from '../lib/suites';

// Scoped tokens (docs/guides/tokens.md): what a read token and an exec
// token limited to some imps may do, through the CLI as a user runs it.

// one stack for every release, so a token goes before the imps it names
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('tokens'), stack, client };
}

test('it prints a made read token once, lists it without its secret, and lets it list imps but not exec, stop or make tokens', async () => {
  const ctx = await setupTest();

  const dev = `${ctx.prefix}read-dev`;
  const reader = `${ctx.prefix}reader`;

  await runImp('new', dev, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, dev));

  await waitForExec(dev);

  // `impz token new` prints the secret alone on stdout
  const made = await runImp('token', 'new', reader, '--scope', 'read');

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, reader));

  const secret = made.trim();

  expect(secret).toMatch(/^imp_[\w\-]+\.[\w\-]+$/v);

  const [, secretPart] = secret.split('.');

  invariant(secretPart !== undefined);

  const tokens = await runImp('token', 'ls');
  const whoami = await tryImp(['token', 'whoami'], { token: secret });
  const listed = await tryImp(['ls'], { token: secret });
  const exec = await tryImp(['exec', dev, '--', 'true'], { token: secret });
  const stop = await tryImp(['stop', dev], { token: secret });

  const token = await tryImp(['token', 'new', `${ctx.prefix}x`, '--scope', 'read'], {
    token: secret,
  });

  expect(tokens).toContain(reader);
  expect(tokens).not.toContain(secretPart);

  expect(whoami).toStrictEqual({
    exitCode: 0,
    stdout: `token ${reader}: read on every imp\n`,
    stderr: '',
  });

  expect(listed).toStrictEqual({
    exitCode: 0,
    stdout: expect.toInclude(dev),
    stderr: '',
  });

  expect(exec).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });

  expect(stop).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });

  expect(token).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });
});

test('it lets an exec token limited to dev-* run in its imp and not touch another, names it in the audit, and refuses it once removed', async () => {
  const ctx = await setupTest();

  const dev = `${ctx.prefix}exec-dev`;
  const other = `${ctx.prefix}exec-other`;
  const devExec = `${ctx.prefix}dev-exec`;

  await runImp('new', dev, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, dev));

  await runImp('new', other, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, other));

  await waitForExec(dev);
  await waitForExec(other);

  const made = await runImp('token', 'new', devExec, '--scope', 'exec', '--imps', `${dev}*`);

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, devExec));

  const secret = made.trim();

  const own = await tryImp(['exec', dev, '--', 'echo', 'hi'], { token: secret });
  const otherExec = await tryImp(['exec', other, '--', 'true'], { token: secret });
  const otherStop = await tryImp(['stop', other], { token: secret });
  const otherProxy = await tryImp(['proxy', other, '0:8080'], { token: secret });
  const listed = await tryImp(['ls'], { token: secret });

  expect(own).toStrictEqual({ exitCode: 0, stdout: 'hi\n', stderr: '' });

  expect(otherExec).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });

  expect(otherStop).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });

  expect(otherProxy).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });

  expect(listed).toStrictEqual({
    exitCode: 0,
    stdout: expect.toInclude(dev),
    stderr: '',
  });

  expect(listed.stdout).not.toContain(other);

  // the audit log names the token behind each call
  const calls = await listAuditCalls(other);

  expect(calls.find((call) => call.procedure === 'imps.stop')).toMatchObject({
    actor: 'token',
    actorName: devExec,
    outcome: 'FORBIDDEN',
  });

  // a removed token is refused at once
  await runImp('token', 'rm', devExec);

  const after = await tryImp(['ls'], { token: secret });

  expect(after).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'impz: unauthorized: set IMP_TOKEN to the token from <IMP_DATA_DIR>/token, or run impz login <url>\n',
  });
});

test('it lets a token for dev-* that may grant one secret grant it there and nothing more, through a sleep', async () => {
  const ctx = await setupTest();

  const dev = `${ctx.prefix}grant-dev`;
  const other = `${ctx.prefix}grant-other`;
  const granter = `${ctx.prefix}granter`;
  const gh = `${ctx.prefix}gh`;

  // a synthetic value, which no output may show
  const ghValue = 'ghp_synthetic126e2e0123456789';

  await runImp('new', dev, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, dev));

  await runImp('new', other, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, other));

  await waitForExec(dev);
  await waitForExec(other);

  const added = await runImpWith(
    { stdin: `${ghValue}\n` },
    'secret',
    'add',
    gh,
    '--kind',
    'github',
  );

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, gh));

  const made = await runImp(
    'token',
    'new',
    granter,
    '--scope',
    'manage',
    '--imps',
    `${dev}*`,
    '--grantable',
    gh,
  );

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, granter));

  const secret = made.trim();

  const granted = await tryImp(['grant', dev, gh], { token: secret });
  const otherImp = await tryImp(['grant', other, gh], { token: secret });

  // the fork's name matches dev-*, so only the missing scope refuses it
  const fork = await tryImp(['fork', dev, `${dev}-copy`], { token: secret });

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, `${dev}-copy`));

  const whoami = await tryImp(['token', 'whoami'], { token: secret });

  expect(granted.exitCode).toBe(0);

  expect(whoami).toStrictEqual({
    exitCode: 0,
    stdout: `token ${granter}: manage on ${dev}*; may grant ${gh}\n`,
    stderr: '',
  });

  expect(otherImp).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });

  expect(fork).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });

  // the grant stays through a sleep and a wake
  await runImp('sleep', dev);
  await runImp('wake', dev);

  const kept = await tryImp(['grants', dev], { token: secret });
  const revoked = await tryImp(['revoke', dev, gh], { token: secret });
  const tokens = await runImp('token', 'ls');

  expect(kept).toStrictEqual({
    exitCode: 0,
    stdout: expect.toInclude(gh),
    stderr: '',
  });

  expect(revoked.exitCode).toBe(0);
  expect(tokens).toContain(gh);
  expect(added).not.toContain(ghValue);
  expect(kept.stdout).not.toContain(ghValue);
  expect(tokens).not.toContain(ghValue);
});

test('it lets an ssh key bound to a dev-* exec token log in to its imp and no other, names it in the audit, and lets it in nowhere once unbound', async () => {
  const ctx = await setupTest();

  const dev = `${ctx.prefix}key-dev`;
  const other = `${ctx.prefix}key-other`;
  const sshDev = `${ctx.prefix}ssh-dev`;

  // an ssh Host alias whose key authorized_keys does not list
  const keyHost = 'imp-e2e-dev-key';

  await runImp('new', dev, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, dev));

  await runImp('new', other, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, other));

  await waitForExec(dev);
  await waitForExec(other);

  const keys = await setupKeyClient([keyHost]);

  ctx.stack.defer(() => keys.cleanup());

  const keyPath = keys.publicKeyPaths.get(keyHost);

  invariant(keyPath !== undefined);

  await runImp(
    'token',
    'new',
    sshDev,
    '--scope',
    'exec',
    '--imps',
    `${dev}*`,
    '--ssh-key',
    keyPath,
  );

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, sshDev));

  const own = await runSsh(keys, dev, ['echo', 'in'], { host: keyHost });
  const refused = await runSsh(keys, other, ['echo', 'in'], { host: keyHost });

  expect(own).toStrictEqual({ exitCode: 0, stdout: 'in\n', stderr: '' });

  expect(refused).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('Permission denied'),
  });

  // the audit log names the token behind the login
  const calls = await listAuditCalls(dev);

  expect(calls.find((call) => call.actorName === sshDev)).toMatchObject({
    actor: 'ssh',
    outcome: 'ok',
  });

  // an unbound key logs in nowhere
  const bound = await runImp('token', 'key', 'ls', sshDev);

  const [fingerprint] = bound.split(' ');

  invariant(fingerprint !== undefined);

  await runImp('token', 'key', 'rm', sshDev, fingerprint);

  const unbound = await runSsh(keys, dev, ['echo', 'in'], { host: keyHost });

  expect(unbound).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('Permission denied'),
  });
});

test('it opens no ssh session for a key bound to a read token', async () => {
  const ctx = await setupTest();

  const dev = `${ctx.prefix}read-key-dev`;
  const sshReader = `${ctx.prefix}ssh-reader`;

  // an ssh Host alias whose key authorized_keys does not list
  const keyHost = 'imp-e2e-read-key';

  await runImp('new', dev, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, dev));

  await waitForExec(dev);

  const keys = await setupKeyClient([keyHost]);

  ctx.stack.defer(() => keys.cleanup());

  const keyPath = keys.publicKeyPaths.get(keyHost);

  invariant(keyPath !== undefined);

  await runImp('token', 'new', sshReader, '--scope', 'read', '--ssh-key', keyPath);

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, sshReader));

  const refused = await runSsh(keys, dev, ['echo', 'in'], { host: keyHost });

  expect(refused).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('Permission denied'),
  });
});
