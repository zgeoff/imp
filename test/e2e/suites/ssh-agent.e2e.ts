import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  createInstanceClient,
  readInfo,
  requireImp,
  runImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { buildImpDiskPath } from '../lib/imp-disk-path';
import { waitForExec, waitForGuestPathGone } from '../lib/imps';
import { readContainerGateway, runChecked, runCommand } from '../lib/instance';
import { countKeyTraces, readKeyPatterns } from '../lib/key-traces';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import {
  SSH_HOST,
  listAgentThroughUnixForward,
  runSsh,
  setupSshClient,
  startLocalSshAgent,
  startSsh,
} from '../lib/ssh';
import { startStubGitSshServer } from '../lib/start-stub-git-ssh-server';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// ssh-agent forwarding (docs/guides/ssh.md): the agent on this machine signs
// for a process in the imp, and the key never reaches the imp. Each test
// boots its own e2e-git imp, whose image user is dev.

// one stack for every release, so ssh stops before the agent and the imp go
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const ssh = await setupSshClient();

  stack.defer(() => ssh.cleanup());

  // the user's agent on this machine, holding a key made for the test
  const laptop = await startLocalSshAgent(ssh);

  stack.defer(() => laptop[Symbol.asyncDispose]());

  // ssh's control and forward sockets: a unix socket path holds 107 bytes,
  // which a worktree's .cache can pass
  const sockets = await mkdtemp(join(tmpdir(), 'imp-ssha-'));

  stack.defer(() => rm(sockets, { recursive: true, force: true }));

  return { prefix: readSuitePrefix('ssh-agent'), stack, client, ssh, laptop, sockets };
}

test('it lists the laptop key over ssh -A, from a socket only the image user owns', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}list`;

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const result = await runSsh(
    ctx.ssh,
    name,
    ['-A', 'ssh-add -l; stat -c "%U %a" "$SSH_AUTH_SOCK" "$(dirname "$SSH_AUTH_SOCK")"'],
    { env: { SSH_AUTH_SOCK: ctx.laptop.socket } },
  );

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: expect.toSatisfy((text: string) =>
      /imp-e2e-laptop \(ED25519\)\n(?:.*\n)*dev 600\ndev 700\n$/v.test(text),
    ),
    stderr: expect.toBeString(),
  });
});

// the git server runs on this machine; the imp reaches it through NAT
test('it signs a git push from the imp with the laptop agent', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}push`;

  const gateway = await readContainerGateway();
  const git = await startStubGitSshServer(gateway, ctx.ssh.dir, ctx.laptop.publicKey);

  ctx.stack.defer(() => git.stop());

  const knownHost = `[${gateway}]:${String(git.port)} ${git.hostKey}`;
  const remote = `ssh://git@${gateway}:${String(git.port)}/repo.git`;

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const result = await runSsh(
    ctx.ssh,
    name,
    [
      '-A',
      [
        'set -e',
        'mkdir -p ~/.ssh',
        `echo '${knownHost}' > ~/.ssh/known_hosts`,
        'cd "$(mktemp -d)"',
        'git init -q -b main',
        'git -c user.email=e2e@imp -c user.name=e2e commit -q --allow-empty -m signed-by-agent',
        `GIT_SSH_COMMAND='ssh -o BatchMode=yes' git push -q ${remote} main`,
        'ls -A ~/.ssh',
      ].join('\n'),
    ],
    { env: { SSH_AUTH_SOCK: ctx.laptop.socket } },
  );

  const pushed = await runChecked(['git', '--git-dir', git.repo, 'log', '--format=%s', 'main']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: 'known_hosts\n', stderr: '' });
  expect(git.logins()).toBeGreaterThan(0);
  expect(pushed.trim()).toBe('signed-by-agent');
});

test('it lets only the image user and root reach the forwarded socket', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}perm`;

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const result = await runSsh(
    ctx.ssh,
    name,
    [
      '-A',
      [
        'S=$SSH_AUTH_SOCK',
        'sudo setpriv --reuid=65534 --regid=65534 --clear-groups env SSH_AUTH_SOCK="$S" ssh-add -l 2>/dev/null',
        'echo "nobody=$?"',
        'sudo env SSH_AUTH_SOCK="$S" ssh-add -l >/dev/null',
        'echo "root=$?"',
      ].join('\n'),
    ],
    { env: { SSH_AUTH_SOCK: ctx.laptop.socket } },
  );

  // ssh-add exits 2 when it cannot reach the agent
  expect(result.stdout).toContain('nobody=2\n');
  expect(result.stdout).toContain('root=0\n');
});

// The gateway dials a unix socket as the image user (dev), not as root: an
// agent of dev's answers, a root-only socket does not, and a root agent on a
// world-writable socket refuses dev by its peer uid.
test("it carries a unix socket forward to the image user's sockets, not root's", async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}unix`;

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  await runShellInImp(
    name,
    [
      'set -e',
      "sudo sh -c 'ssh-agent -a /run/e2e-root.sock && ssh-agent -a /run/e2e-open.sock && chmod 666 /run/e2e-open.sock' >/dev/null",
      'ssh-agent -a /tmp/e2e-dev.sock >/dev/null',
    ].join('\n'),
  );

  const own = await listAgentThroughUnixForward(
    ctx.ssh,
    name,
    '/tmp/e2e-dev.sock',
    join(ctx.sockets, 'dev.sock'),
  );

  const rootOnly = await listAgentThroughUnixForward(
    ctx.ssh,
    name,
    '/run/e2e-root.sock',
    join(ctx.sockets, 'root.sock'),
  );

  const rootAgent = await listAgentThroughUnixForward(
    ctx.ssh,
    name,
    '/run/e2e-open.sock',
    join(ctx.sockets, 'open.sock'),
  );

  expect(own.listed).toStrictEqual({
    exitCode: 1,
    stdout: 'The agent has no identities.\n',
    stderr: '',
  });

  expect(rootOnly.listed).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'error fetching identities: communication with agent failed\n',
  });

  expect(rootOnly.forwardLog).toContain('open failed: connect failed');

  expect(rootAgent.listed).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'error fetching identities: communication with agent failed\n',
  });
});

// OpenSSH asks for forwarding only when it has an agent, so the connection
// starts with one that then goes away; the guest socket must still be there
test('it fails ssh-add in the imp at once when the agent on this machine is gone', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}gone`;
  const control = join(ctx.sockets, 'control');

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const gone = await startLocalSshAgent(ctx.ssh, 'gone');

  ctx.stack.defer(() => gone[Symbol.asyncDispose]());

  const env = { SSH_AUTH_SOCK: gone.socket };

  const master = startSsh(
    ctx.ssh,
    ['-A', '-M', '-S', control, '-N', `${name}@${SSH_HOST}`],
    undefined,
    env,
  );

  ctx.stack.defer(() => master.stop());

  await waitFor('the control socket', () => runChecked(['test', '-S', control]));

  await gone[Symbol.asyncDispose]();

  const result = await runCommand(
    [
      'ssh',
      ...ctx.ssh.configArgs,
      '-A',
      '-S',
      control,
      `${name}@${SSH_HOST}`,
      'echo "$SSH_AUTH_SOCK"; start=$(date +%s); ssh-add -l; echo "code=$? seconds=$(( $(date +%s) - start ))"',
    ],
    { env },
  );

  const [socket = ''] = result.stdout.split('\n');
  const timing = /code=(?<code>\d+) seconds=(?<seconds>\d+)/v.exec(result.stdout)?.groups;

  expect(socket).toStartWith('/run/imp/ssh-agent/');
  expect(timing?.['code']).toBeOneOf(['1', '2']);
  expect(Number(timing?.['seconds'])).toBeLessThan(3);
});

test('it removes the socket when the connection ends', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}end`;

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const result = await runSsh(ctx.ssh, name, ['-A', 'echo "$SSH_AUTH_SOCK"'], {
    env: { SSH_AUTH_SOCK: ctx.laptop.socket },
  });

  const socket = result.stdout.trim();

  expect(socket).toStartWith('/run/imp/ssh-agent/');

  await waitForGuestPathGone(name, dirname(socket));
});

// A forced sleep resets the agent connections: the guest drops the socket,
// and the connection's next session gets a new one that works.
test('it ends the socket on a forced sleep, and listens again for the next session', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}sleep`;
  const control = join(ctx.sockets, 'control');
  const env = { SSH_AUTH_SOCK: ctx.laptop.socket };
  const muxArgs = [...ctx.ssh.configArgs, '-A', '-S', control, `${name}@${SSH_HOST}`];

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const master = startSsh(
    ctx.ssh,
    ['-A', '-M', '-S', control, '-N', `${name}@${SSH_HOST}`],
    undefined,
    env,
  );

  ctx.stack.defer(() => master.stop());

  await waitFor('the control socket', () => runChecked(['test', '-S', control]));

  const before = await runCommand(['ssh', ...muxArgs, 'echo "$SSH_AUTH_SOCK"'], { env });

  const first = before.stdout.trim();

  await runImp('sleep', name);

  const after = await runCommand(['ssh', ...muxArgs, 'echo "$SSH_AUTH_SOCK"; ssh-add -l'], {
    env,
  });

  const [second = ''] = after.stdout.split('\n');

  expect(first).toStartWith('/run/imp/ssh-agent/');
  expect(second).toStartWith('/run/imp/ssh-agent/');
  expect(second).not.toBe(first);
  expect(after.stdout).toContain('imp-e2e-laptop (ED25519)');

  await waitForGuestPathGone(name, dirname(first));
});

// A reboot inside starts the inner container again, and its /run with the
// socket goes: the guest ends the listener, and the connection's next
// session gets a new socket in the new container.
test('it ends the socket on a restart of the container inside, and listens again for the next session', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}reboot`;
  const control = join(ctx.sockets, 'control');
  const env = { SSH_AUTH_SOCK: ctx.laptop.socket };
  const muxArgs = [...ctx.ssh.configArgs, '-A', '-S', control, `${name}@${SSH_HOST}`];

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const master = startSsh(
    ctx.ssh,
    ['-A', '-M', '-S', control, '-N', `${name}@${SSH_HOST}`],
    undefined,
    env,
  );

  ctx.stack.defer(() => master.stop());

  await waitFor('the control socket', () => runChecked(['test', '-S', control]));

  const before = await runCommand(['ssh', ...muxArgs, 'echo "$SSH_AUTH_SOCK"; ssh-add -l'], {
    env,
  });

  const [first = ''] = before.stdout.split('\n');

  expect(before.stdout).toContain('imp-e2e-laptop (ED25519)');

  // the exec ends with the container it ran in
  await tryImp(['exec', name, '--', 'sudo', 'reboot', '-f']);
  await waitForGuestPathGone(name, dirname(first));

  // impd hears of the ended listener over its stream, a moment after
  const after = await waitFor('a session with a new socket', async () => {
    const result = await runCommand(['ssh', ...muxArgs, 'echo "$SSH_AUTH_SOCK"; ssh-add -l'], {
      env,
    });

    const [second = ''] = result.stdout.split('\n');

    if (second === first) {
      throw new Error(`the session got the old socket ${first}`);
    }

    return { second, stdout: result.stdout };
  });

  expect(after.second).toStartWith('/run/imp/ssh-agent/');
  expect(after.stdout).toContain('imp-e2e-laptop (ED25519)');
});

test('it never lets the key reach the imp: not its disk, not its slept memory', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}key`;

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  // the imp has the agent sign through the forward: ssh-keygen -Y sign with
  // a public key asks the agent for the private half
  const signed = await runSsh(
    ctx.ssh,
    name,
    [
      '-A',
      `printf '%s' '${ctx.laptop.publicKey.trim()}' > /tmp/laptop.pub && echo data | ssh-keygen -q -Y sign -n e2e -f /tmp/laptop.pub`,
    ],
    { env: { SSH_AUTH_SOCK: ctx.laptop.socket } },
  );

  expect(signed).toStrictEqual({
    exitCode: 0,
    stdout: expect.toStartWith('-----BEGIN SSH SIGNATURE-----\n'),
    stderr: expect.toBeString(),
  });

  const imp = await requireImp(name);

  const patterns = readKeyPatterns(ctx.laptop.keyPath);

  await runImp('sleep', name);

  const info = await readInfo();

  const inMemory = await countKeyTraces(
    `/var/lib/imp/imps/${imp.id}/snapshot/mem`,
    patterns,
    'Linux version',
  );

  const onDisk = await countKeyTraces(
    buildImpDiskPath(info.storage.backend, imp.id),
    patterns,
    'dev:x:1000:',
  );

  expect(inMemory).toStrictEqual({ control: true, text: '0', seed: '0' });
  expect(onDisk).toStrictEqual({ control: true, text: '0', seed: '0' });
});
