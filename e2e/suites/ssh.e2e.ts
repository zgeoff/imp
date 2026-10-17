import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFreePorts } from '../../packages/daemon/src/test-utils/find-free-ports';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp, runImpWith, runShellInImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { runCommand } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { SSH_HOST, readTapLinkLocal, runSsh, setupSshClient, startSsh } from '../lib/ssh';
import { readSuitePrefix } from '../lib/suites';
import { openCommandTerminal } from '../lib/terminal';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// The SSH gateway (docs/guides/ssh.md): `ssh <imp>@<host>` into an imp, with
// the OpenSSH client as a user runs it. Each test boots its own e2e-tiny imp,
// whose busybox httpd serves e2e-tiny-ok on 8080.

// one stack for every release, so a forward stops before its imp goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const ssh = await setupSshClient();

  stack.defer(() => ssh.cleanup());

  // ssh's forward sockets: a unix socket path holds 107 bytes, which a
  // worktree's .cache can pass
  const sockets = await mkdtemp(join(tmpdir(), 'imp-ssh-'));

  stack.defer(() => rm(sockets, { recursive: true, force: true }));

  return { prefix: readSuitePrefix('ssh'), stack, client, ssh, sockets };
}

test('it runs a command over ssh and returns its output, stderr, exit status and connection', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}cmd`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const result = await runSsh(ctx.ssh, name, ['echo out; echo err >&2; exit 7']);
  const env = await runSsh(ctx.ssh, name, ['echo "$SSH_CONNECTION"']);

  expect(result).toStrictEqual({ exitCode: 7, stdout: 'out\n', stderr: 'err\n' });
  expect(env.stdout).toMatch(/^\S+ \d+ \S+ 22\n$/u);
});

test('it gives a pty the terminal size and follows a resize', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}pty`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const terminal = openCommandTerminal(
    ['ssh', ...ctx.ssh.configArgs, '-tt', `${name}@${SSH_HOST}`],
    {},
    { cols: 100, rows: 30 },
  );

  ctx.stack.defer(() => terminal.close());
  terminal.type('stty size\n');

  await terminal.waitForText('30 100');

  const since = terminal.readOutput().length;

  terminal.resize(120, 40);
  terminal.type('stty size\n');

  await terminal.waitForText('40 120', since);

  terminal.type('exit 3\n');

  const code = await terminal.exited;

  expect(code).toBe(3);
});

test('it copies a file both ways with scp, and serves sftp without an sftp-server in the image', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}scp`;
  const local = join(ctx.ssh.dir, 'blob');
  const back = join(ctx.ssh.dir, 'blob.back');
  const blob = randomBytes(4 * 1024 * 1024);

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  writeFileSync(local, blob);

  const started = Date.now();

  const up = await runCommand([
    'scp',
    ...ctx.ssh.configArgs,
    local,
    `${name}@${SSH_HOST}:/tmp/blob`,
  ]);

  writeMetric('sshScp4MibMs', Date.now() - started);

  const down = await runCommand([
    'scp',
    ...ctx.ssh.configArgs,
    `${name}@${SSH_HOST}:/tmp/blob`,
    back,
  ]);

  const sftp = await runCommand(['sftp', ...ctx.ssh.configArgs, '-b', '-', `${name}@${SSH_HOST}`], {
    stdin: 'cd /tmp\nmkdir sftp-dir\nls -l blob\n',
  });

  const listed = await runShellInImp(name, 'ls -d /tmp/sftp-dir');

  expect(up.exitCode).toBe(0);
  expect(down.exitCode).toBe(0);
  expect(readFileSync(back)).toStrictEqual(blob);

  expect(sftp).toStrictEqual({
    exitCode: 0,
    stdout: expect.toInclude(String(blob.byteLength)),
    stderr: expect.toBeString(),
  });

  expect(listed).toBe('/tmp/sftp-dir');
});

test('it carries a local forward from a TCP port to a port in the imp', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}fwdtcp`;

  // a port no other picker hands out, and ExitOnForwardFailure fails the
  // test should anything else bind it first
  const port = findFreePorts(1).take();

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const forward = startSsh(ctx.ssh, [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-L',
    `${String(port)}:localhost:8080`,
    `${name}@${SSH_HOST}`,
  ]);

  ctx.stack.defer(() => forward.stop());

  const body = await waitFor('the forward to answer', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`);

    return response.text();
  });

  expect(body).toBe('e2e-tiny-ok\n');
});

test('it carries a local forward from a unix socket to a port in the imp', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}fwd`;

  // the gateway sees the same direct-tcpip channel to localhost:8080 as
  // from a TCP port
  const local = join(ctx.sockets, 'forward.sock');

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const forward = startSsh(ctx.ssh, [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-L',
    `${local}:localhost:8080`,
    `${name}@${SSH_HOST}`,
  ]);

  ctx.stack.defer(() => forward.stop());

  const body = await waitFor('the forward to answer', async () => {
    const response = await fetch('http://localhost/', { unix: local });

    return response.text();
  });

  expect(body).toBe('e2e-tiny-ok\n');
});

// VS Code Remote SSH: a shell on stdin with dynamic forwarding, then its
// connections through the SOCKS port to the imp's own loopback
test('it carries a SOCKS forward next to a shell on stdin, as VS Code opens it', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}socks`;

  // -D listens on a TCP port only: one no other picker hands out, and
  // ExitOnForwardFailure fails the test should anything else bind it first
  const port = findFreePorts(1).take();

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const session = startSsh(
    ctx.ssh,
    ['-T', '-o', 'ExitOnForwardFailure=yes', '-D', String(port), `${name}@${SSH_HOST}`, 'sh'],
    'echo shell-ready; sleep 30\n',
  );

  ctx.stack.defer(() => session.stop());

  const body = await waitFor('the SOCKS forward to answer', async () => {
    const result = await runCommand([
      'curl',
      '-fsS',
      '--max-time',
      '5',
      '--socks5-hostname',
      `127.0.0.1:${String(port)}`,
      'http://localhost:8080/',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim());
    }

    return result.stdout;
  });

  expect(body).toBe('e2e-tiny-ok\n');
});

test('it refuses a forward to anything but the imp', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}refuse`;
  const local = join(ctx.sockets, 'refused.sock');

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  // INFO: the client logs a refused channel at that level
  const forward = startSsh(ctx.ssh, [
    '-N',
    '-o',
    'LogLevel=INFO',
    '-L',
    `${local}:example.com:80`,
    `${name}@${SSH_HOST}`,
  ]);

  ctx.stack.defer(() => forward.stop());

  // the listener opens before any channel is asked for
  await waitFor('the forward to listen', () => {
    if (!existsSync(local)) {
      throw new Error(`no ${local} yet`);
    }
  });

  const curl = await runCommand([
    'curl',
    '-sS',
    '--max-time',
    '5',
    '--unix-socket',
    local,
    'http://example.com/',
  ]);

  await forward.stop();

  const stderr = await new Response(forward.proc.stderr).text();

  expect(curl.exitCode).not.toBe(0);
  expect(stderr).toContain('administratively prohibited');
});

test('it passes only LANG and LC_* from the client env to the imp', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}env`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const result = await runSsh(ctx.ssh, name, [
    '-o',
    'SetEnv=LANG=C.UTF-8 SECRET=leaked',
    'echo "$LANG"; if [ -z "$SECRET" ]; then echo unset; fi',
  ]);

  expect(result.stdout).toBe('C.UTF-8\nunset\n');
});

// The API (7070 in the container) listens dual-stack: without its ip6tables
// rule, a guest reaches it over the tap's IPv6 link-local address.
test('it lets a guest reach no host port, over IPv4 or IPv6 link-local', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}ports`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  // the host end of the tap is the guest's default gateway
  const hostIp = await runShellInImp(name, "ip route | awk '/^default/ {print $3}'");
  const linkLocal = await readTapLinkLocal(hostIp);

  // busybox nc exits non-zero when it cannot connect within 2 s; the first
  // probe is a control that the probe connects at all, over IPv6 too
  const probed = await runShellInImp(
    name,
    [
      'probe() { if nc -w 2 "$1" "$2" </dev/null >/dev/null 2>&1; then echo open; else echo closed; fi; }',
      'probe ::1 8080',
      `probe ${hostIp} 22`,
      `probe ${linkLocal}%eth0 22`,
      `probe ${linkLocal}%eth0 7070`,
    ].join('\n'),
  );

  const [control, ssh, sshOverIpv6, apiOverIpv6] = probed.split('\n');

  expect(control).toBe('open');
  expect(ssh).toBe('closed');
  expect(sshOverIpv6).toBe('closed');
  expect(apiOverIpv6).toBe('closed');
});

// SSH commands get the credential broker's variables as `impz exec` does
// (docs/guides/connectors.md); the guest only ever sees the placeholder
test('it gives an imp with a grant the broker variables over ssh', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}grant`;

  // a made-up token: the test checks the broker's variables, not a request
  const secret = `${ctx.prefix}gh`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runImpWith({ stdin: 'e2e-ssh-not-a-token\n' }, 'secret', 'add', secret, '--kind', 'github');

  registerRemoval(ctx.stack, config.keep, async () => {
    await runImp('secret', 'rm', secret);
  });

  await runImp('grant', name, secret);

  registerRemoval(ctx.stack, config.keep, async () => {
    await runImp('revoke', name, secret);
  });

  const result = await runSsh(ctx.ssh, name, ['echo "$HTTPS_PROXY"; echo "$GH_TOKEN"']);

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: expect.toSatisfy((text: string) =>
      /^http:\/\/[\d.]+:\d+\nimp-broker-placeholder\n$/v.test(text),
    ),
    stderr: expect.toBeString(),
  });
});
