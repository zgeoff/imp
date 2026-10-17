import { expect, onTestFinished, test } from 'bun:test';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import invariant from 'tiny-invariant';
import { waitAwakePastIdle } from '../lib/awake-past-idle';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  assertState,
  createInstanceClient,
  requireImp,
  runImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { collectText, startReverse } from '../lib/imp-proxy';
import { holdImp, waitForExec, waitForGuestPathGone } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { SSH_HOST, setupSshClient, startLocalSshAgent, startSsh } from '../lib/ssh';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// Reverse forwards (docs/guides/reverse-forwards.md), by `impz proxy
// --reverse` and `ssh -R`. This machine's ssh-agent is the unix socket
// service, and `ssh-add -l` in the imp, as the image user, its client.

// one stack for every release, so a forward stops before the agent and the
// imp go
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const ssh = await setupSshClient();

  stack.defer(() => ssh.cleanup());

  // the user's agent on this machine, holding a key made for the test
  const laptop = await startLocalSshAgent(ssh);

  stack.defer(() => laptop.stop());

  return { prefix: readSuitePrefix('reverse'), stack, client, ssh, laptop };
}

test('it refuses a forward it cannot open at once, and says why', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}refuse`;

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const missing = await tryImp(['proxy', name, '--reverse', '/nope/app.sock:9']);
  const low = await tryImp(['proxy', name, '--reverse', '80:9']);
  const ours = await tryImp(['proxy', name, '--reverse', '/run/imp/x.sock:9']);

  expect(missing).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('the directory /nope does not exist in the imp'),
  });

  expect(low).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('port 80 needs root in the imp; pick a port above 1023'),
  });

  expect(ours).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude("leads to the agent's own sockets"),
  });
});

test('it lets a process in the imp reach a unix socket and a port on this machine', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}reach`;
  const socket = '/tmp/e2e-agent.sock';

  // the port service on this machine
  const page = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('e2e-reverse-ok\n'),
  });

  ctx.stack.defer(() => page.stop(true));

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const reverse = await startReverse(
    name,
    `${socket}:${ctx.laptop.socket}`,
    `0:${String(page.port)}`,
    `:${ctx.laptop.socket}`,
  );

  ctx.stack.defer(async () => {
    await reverse.stop();
  });

  const [path = '', port = '', own = ''] = reverse.guests;

  const listed = await runShellInImp(name, `SSH_AUTH_SOCK='${path}' ssh-add -l 2>&1`);
  const listedOwn = await runShellInImp(name, `SSH_AUTH_SOCK='${own}' ssh-add -l 2>&1`);

  const modes = await runShellInImp(
    name,
    `stat -c "%U %a" '${path}' '${own}' "$(dirname '${own}')"`,
  );

  const fetched = await runShellInImp(name, `wget -qO- http://127.0.0.1:${port}/`);
  const code = await reverse.stop();

  expect(path).toBe(socket);
  expect(own).toStartWith('/run/imp/forward/');
  expect(listed).toContain('imp-e2e-laptop (ED25519)');
  expect(listedOwn).toContain('imp-e2e-laptop (ED25519)');
  expect(modes).toBe('dev 600\ndev 600\ndev 700');
  expect(fetched).toBe('e2e-reverse-ok');
  expect(code).toBe(0);

  await waitForGuestPathGone(name, socket);
  await waitForGuestPathGone(name, dirname(own));
});

// A forced sleep ends the forward in the imp. The CLI leaves the imp asleep,
// and once it wakes listens again at the same path, over the old socket.
test('it listens again at the same path once the imp wakes, without waking it', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}again`;
  const socket = '/tmp/e2e-again.sock';

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const reverse = await startReverse(name, `${socket}:${ctx.laptop.socket}`);

  ctx.stack.defer(async () => {
    await reverse.stop();
  });

  await runImp('sleep', name);

  const slept = await requireImp(name);

  await waitFor('the CLI to see the forward end', () => {
    if (!reverse.readStderr().includes('listening again once')) {
      throw new Error(`impz proxy said ${reverse.readStderr()}`);
    }
  });

  // a dwell whose length is the contract (decision 5): a reopen after the
  // CLI's 2 s RETRY_MS (cli/src/forward/reverse-client.ts) would wake the imp by 3 s
  await Bun.sleep(3000);

  const waiting = await requireImp(name);

  const saidBeforeWake = reverse.readStderr();

  await runImp('wake', name);
  await holdImp(name);

  await waitFor('the forward to listen again', () => {
    if (
      !reverse.readStderr().includes(`forwarding ${name}:${socket} -> ${ctx.laptop.socket} again`)
    ) {
      throw new Error(`impz proxy said ${reverse.readStderr()}`);
    }
  });

  const listed = await runShellInImp(name, `SSH_AUTH_SOCK='${socket}' ssh-add -l 2>&1`);

  invariant(slept.resources);
  invariant(waiting.resources);

  expect(slept.state).toBe('sleeping');
  expect(waiting.state).toBe('sleeping');
  expect(waiting.resources.wakeCount).toBe(slept.resources.wakeCount);
  expect(saidBeforeWake).not.toContain(' again\n');
  expect(listed).toContain('imp-e2e-laptop (ED25519)');
});

// An open relay keeps the imp awake, as a tunnel does; the listener alone
// does not, and the imp then sleeps on its idle timeout.
test('it keeps the imp awake while a relay is open, and lets it sleep once only the listener is left', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}relay`;

  // a TCP server on this machine that greets each client and never closes
  const holder = createServer((socket) => {
    socket.write('held\n');
  });

  const listening = Promise.withResolvers<void>();

  holder.listen(0, '127.0.0.1', listening.resolve);

  ctx.stack.defer(() => {
    holder.close();
  });

  await listening.promise;

  const address = holder.address();

  if (address === null || typeof address === 'string') {
    throw new Error(`the holder listens on ${String(address)}`);
  }

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const reverse = await startReverse(name, `0:${String(address.port)}`);

  ctx.stack.defer(async () => {
    await reverse.stop();
  });

  const [port = ''] = reverse.guests;

  await runShellInImp(
    name,
    `setsid sh -c 'sleep 3600 | nc 127.0.0.1 ${port} > /tmp/held.out' >/dev/null 2>&1 &`,
  );

  await waitFor('the held relay', async () => {
    const out = await runShellInImp(name, 'cat /tmp/held.out');

    if (out !== 'held') {
      throw new Error(`the relay said ${out}`);
    }
  });

  await runImp('hold', name, '0');

  const released = Date.now();

  await waitAwakePastIdle(name, released);
  await runShellInImp(name, 'pkill nc || true');

  await waitFor('the imp to sleep', () => assertState(name, 'sleeping'), {
    timeoutMs: (config.idleTimeoutS + 60) * 1000,
  });
}, 180_000);

test('it forwards a port and a unix socket in the imp to this machine with ssh -R', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}sshr`;
  const socket = '/tmp/e2e-ssh-r.sock';

  // the port service on this machine
  const page = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('e2e-reverse-ok\n'),
  });

  ctx.stack.defer(() => page.stop(true));

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const forward = startSsh(ctx.ssh, [
    '-N',
    '-o',
    'LogLevel=INFO',
    '-o',
    'ExitOnForwardFailure=yes',
    '-R',
    `0:127.0.0.1:${String(page.port)}`,
    '-R',
    `${socket}:${ctx.laptop.socket}`,
    `${name}@${SSH_HOST}`,
  ]);

  ctx.stack.defer(() => forward.stop());

  const log = collectText(forward.proc.stderr);

  const port = await waitFor('ssh to allocate the port', () => {
    const allocated = /Allocated port (?<port>\d+) for remote forward/v.exec(log.read());

    if (allocated?.groups?.['port'] === undefined) {
      throw new Error(`ssh said ${log.read()}`);
    }

    return allocated.groups['port'];
  });

  await waitFor('the socket forward', async () => {
    const state = await runShellInImp(name, `if [ -S '${socket}' ]; then echo there; fi`);

    if (state !== 'there') {
      throw new Error(`no ${socket} yet`);
    }
  });

  const fetched = await runShellInImp(name, `wget -qO- http://127.0.0.1:${port}/`);
  const listed = await runShellInImp(name, `SSH_AUTH_SOCK='${socket}' ssh-add -l 2>&1`);

  expect(fetched).toBe('e2e-reverse-ok');
  expect(listed).toContain('imp-e2e-laptop (ED25519)');

  await forward.stop();

  await waitForGuestPathGone(name, socket);
});

test('it refuses ssh -R to a privileged port', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}low`;

  await runImp('new', name, '--image', resolveImageName('e2e-git'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const forward = startSsh(ctx.ssh, [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-R',
    '80:127.0.0.1:9',
    `${name}@${SSH_HOST}`,
  ]);

  ctx.stack.defer(() => forward.stop());

  const code = await forward.proc.exited;

  const stderr = await new Response(forward.proc.stderr).text();

  expect(code).toBe(255);
  expect(stderr).toContain('remote port forwarding failed for listen port 80');
});
