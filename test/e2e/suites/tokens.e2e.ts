import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as z from 'zod';
import { resolveImageName } from '../lib/fixtures';
import { runImp, tryImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';
import { runSsh, setupKeyClient } from '../lib/ssh';
import type { KeyClient } from '../lib/ssh';

// Scoped tokens (docs/guides/tokens.md): what a read token and an exec
// token limited to some imps may do, through the CLI as a user runs it.

const prefix = setupSuite('tokens');
const dev = `${prefix}dev`;
const other = `${prefix}other`;

// token names, made and removed by this suite
const READER = `${prefix}reader`;
const DEV_EXEC = `${prefix}dev-exec`;
const SSH_DEV = `${prefix}ssh-dev`;
const SSH_READER = `${prefix}ssh-reader`;
const GRANTER = `${prefix}granter`;

// a secret the granter may grant, with a synthetic value
const GH = `${prefix}gh`;
const GH_VALUE = 'ghp_synthetic126e2e0123456789';

// ssh Host aliases, one key each, that authorized_keys does not list
const DEV_KEY_HOST = 'imp-e2e-dev-key';
const READ_KEY_HOST = 'imp-e2e-read-key';

const CallSchema = z.object({
  procedure: z.string(),
  actor: z.string(),
  actorName: z.string().optional(),
  outcome: z.string(),
});

const secrets = new Map<string, string>();

let keys: KeyClient;

// `imp token new`, which prints the secret alone on stdout
async function makeToken(name: string, ...args: readonly string[]): Promise<string> {
  await tryImp(['token', 'rm', name]);

  const stdout = await runImp('token', 'new', name, ...args);

  const secret = stdout.trim();

  secrets.set(name, secret);

  return secret;
}

beforeAll(async () => {
  const image = resolveImageName('e2e-tiny');

  await createImp(dev, '--image', image, '--memory', '256');
  await createImp(other, '--image', image, '--memory', '256');

  keys = await setupKeyClient([DEV_KEY_HOST, READ_KEY_HOST]);
}, 120_000);

afterAll(async () => {
  for (const name of secrets.keys()) {
    await tryImp(['token', 'rm', name]);
  }

  await tryImp(['secret', 'rm', GH]);

  await keys.cleanup();
});

function readKeyPath(alias: string): string {
  return keys.publicKeyPaths.get(alias) ?? '';
}

// `ssh <imp>@<alias> echo in`
function runSshAs(alias: string, imp: string) {
  return runSsh(keys, imp, ['echo', 'in'], { host: alias });
}

test('a made token prints once and lists without its secret', async () => {
  const secret = await makeToken(READER, '--scope', 'read');

  expect(secret).toMatch(/^imp_[\w-]+\.[\w-]+$/);

  const listed = await runImp('token', 'ls');
  const whoami = await tryImp(['token', 'whoami'], { token: secret });

  expect(listed).toContain(READER);
  expect(listed).not.toContain(secret.split('.')[1] ?? 'none');
  expect(whoami.stdout.trim()).toBe(`token ${READER}: read on every imp`);
});

test('a read token lists imps but cannot exec, stop or make tokens', async () => {
  const secret = secrets.get(READER) ?? '';

  const listed = await tryImp(['ls'], { token: secret });
  const exec = await tryImp(['exec', dev, '--', 'true'], { token: secret });
  const stop = await tryImp(['stop', dev], { token: secret });
  const token = await tryImp(['token', 'new', `${prefix}x`, '--scope', 'read'], { token: secret });

  expect(listed.exitCode).toBe(0);
  expect(listed.stdout).toContain(dev);

  for (const refused of [exec, stop, token]) {
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('FORBIDDEN');
  }
});

test('an exec token limited to dev-* runs in its imp and cannot touch another', async () => {
  const secret = await makeToken(DEV_EXEC, '--scope', 'exec', '--imps', `${prefix}dev*`);
  const own = await tryImp(['exec', dev, '--', 'echo', 'hi'], { token: secret });
  const otherExec = await tryImp(['exec', other, '--', 'true'], { token: secret });
  const otherStop = await tryImp(['stop', other], { token: secret });
  const otherProxy = await tryImp(['proxy', other, '0:8080'], { token: secret });
  const listed = await tryImp(['ls'], { token: secret });

  expect(own.exitCode).toBe(0);
  expect(own.stdout.trim()).toBe('hi');

  for (const refused of [otherExec, otherStop, otherProxy]) {
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('FORBIDDEN');
  }

  expect(listed.stdout).toContain(dev);
  expect(listed.stdout).not.toContain(other);
});

test('a token for dev-* that may grant one secret grants it there, and nothing more', async () => {
  await tryImp(['secret', 'rm', GH]);

  const added = await tryImp(['secret', 'add', GH, '--kind', 'github'], {
    stdin: `${GH_VALUE}\n`,
  });

  expect(added.exitCode).toBe(0);

  const secret = await makeToken(
    GRANTER,
    '--scope',
    'manage',
    '--imps',
    `${prefix}dev*`,
    '--grantable',
    GH,
  );

  const granted = await tryImp(['grant', dev, GH], { token: secret });
  const otherImp = await tryImp(['grant', other, GH], { token: secret });
  const fork = await tryImp(['fork', dev, `${prefix}dev-copy`], { token: secret });
  const whoami = await tryImp(['token', 'whoami'], { token: secret });

  expect(granted.exitCode).toBe(0);
  expect(whoami.stdout.trim()).toBe(`token ${GRANTER}: manage on ${prefix}dev*; may grant ${GH}`);

  for (const refused of [otherImp, fork]) {
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('FORBIDDEN');
  }

  // the grant stays through a sleep and a wake
  await runImp('sleep', dev);
  await runImp('wake', dev);

  const kept = await tryImp(['grants', dev], { token: secret });
  const revoked = await tryImp(['revoke', dev, GH], { token: secret });
  const listed = await runImp('token', 'ls');

  expect(kept.stdout).toContain(GH);
  expect(revoked.exitCode).toBe(0);
  expect(listed).toContain(GH);
  expect([added.stdout, kept.stdout, listed, whoami.stdout].join('\n')).not.toContain(GH_VALUE);
});

test('the audit log names the token behind each call', async () => {
  const stdout = await runImp('audit', '--kind', 'api', other, '--json');

  const calls = z.array(CallSchema).parse(JSON.parse(stdout));
  const refusedStop = calls.find((call) => call.procedure === 'imps.stop');

  expect(refusedStop).toMatchObject({
    actor: 'token',
    actorName: DEV_EXEC,
    outcome: 'FORBIDDEN',
  });
});

test('a removed token is refused at once', async () => {
  const secret = secrets.get(DEV_EXEC) ?? '';

  await runImp('token', 'rm', DEV_EXEC);

  const after = await tryImp(['ls'], { token: secret });

  secrets.delete(DEV_EXEC);

  expect(after.exitCode).not.toBe(0);
});

test('an ssh key bound to a dev-* exec token logs in to its imp and no other', async () => {
  await makeToken(
    SSH_DEV,
    '--scope',
    'exec',
    '--imps',
    `${prefix}dev*`,
    '--ssh-key',
    readKeyPath(DEV_KEY_HOST),
  );

  const own = await runSshAs(DEV_KEY_HOST, dev);
  const refused = await runSshAs(DEV_KEY_HOST, other);

  expect(own.exitCode).toBe(0);
  expect(own.stdout.trim()).toBe('in');
  expect(refused.exitCode).toBe(255);
  expect(refused.stderr).toContain('Permission denied');
});

test('an ssh key bound to a read token opens no session', async () => {
  await makeToken(SSH_READER, '--scope', 'read', '--ssh-key', readKeyPath(READ_KEY_HOST));

  const refused = await runSshAs(READ_KEY_HOST, dev);

  expect(refused.exitCode).toBe(255);
  expect(refused.stderr).toContain('Permission denied');
});

test('the audit log names the token behind an ssh login', async () => {
  const stdout = await runImp('audit', '--kind', 'api', dev, '--json');

  const calls = z.array(CallSchema).parse(JSON.parse(stdout));
  const login = calls.find((call) => call.actorName === SSH_DEV);

  expect(login).toMatchObject({ actor: 'ssh', outcome: 'ok' });
});

test('an unbound key logs in nowhere', async () => {
  const listed = await runImp('token', 'key', 'ls', SSH_DEV);

  const fingerprint = listed.split(' ')[0] ?? '';

  await runImp('token', 'key', 'rm', SSH_DEV, fingerprint);

  const refused = await runSshAs(DEV_KEY_HOST, dev);

  expect(refused.exitCode).toBe(255);
});
