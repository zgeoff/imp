import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveImageName } from '../lib/fixtures';
import { runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { runCommand } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import {
  SSH_HOST,
  findFreePort,
  readTapLinkLocal,
  runSsh,
  setupSshClient,
  startSsh,
} from '../lib/ssh';
import type { SshClient } from '../lib/ssh';
import { openCommandTerminal } from '../lib/terminal';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('ssh');
const TINY = resolveImageName('e2e-tiny');
const name = `${prefix}a`;

// a made-up token: the test checks the broker's variables, not a request
const secret = `${prefix}gh`;

// what busybox httpd serves in e2e-tiny
const PAGE = 'e2e-tiny-ok';
let client: SshClient;

beforeAll(async () => {
  client = await setupSshClient();

  await createImp(name, '--image', TINY, '--memory', '256');
}, 120_000);

afterAll(async () => {
  await tryImp(['revoke', name, secret]);
  await tryImp(['secret', 'rm', secret]);

  await client.cleanup();
});

test('ssh runs a command and returns its output, stderr and exit status', async () => {
  const result = await runSsh(client, name, ['echo out; echo err >&2; exit 7']);

  expect(result).toEqual({ exitCode: 7, stdout: 'out\n', stderr: 'err\n' });

  const env = await runSsh(client, name, ['echo "$SSH_CONNECTION"']);

  expect(env.stdout).toMatch(/^\S+ \d+ \S+ 22\n$/);
});

test('a pty has the terminal size and follows a resize', async () => {
  const terminal = openCommandTerminal(
    ['ssh', ...client.configArgs, '-tt', `${name}@${SSH_HOST}`],
    {},
    { cols: 100, rows: 30 },
  );

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

test('scp copies a file both ways and sftp works without an sftp-server in the image', async () => {
  const local = join(client.dir, 'blob');
  const back = join(client.dir, 'blob.back');
  const blob = randomBytes(4 * 1024 * 1024);

  writeFileSync(local, blob);

  const started = Date.now();

  const up = await runCommand([
    'scp',
    ...client.configArgs,
    local,
    `${name}@${SSH_HOST}:/tmp/blob`,
  ]);

  writeMetric('sshScp4MibMs', Date.now() - started);

  expect(up.exitCode).toBe(0);

  const down = await runCommand([
    'scp',
    ...client.configArgs,
    `${name}@${SSH_HOST}:/tmp/blob`,
    back,
  ]);

  expect(down.exitCode).toBe(0);
  expect(readFileSync(back).equals(blob)).toBeTrue();

  const sftp = await runCommand(['sftp', ...client.configArgs, '-b', '-', `${name}@${SSH_HOST}`], {
    stdin: 'cd /tmp\nmkdir sftp-dir\nls -l blob\n',
  });

  expect(sftp.exitCode).toBe(0);
  expect(sftp.stdout).toContain(String(blob.byteLength));

  const listed = await runShellInImp(name, 'ls -d /tmp/sftp-dir');

  expect(listed).toBe('/tmp/sftp-dir');
});

test('a local forward reaches a port in the imp', async () => {
  const port = findFreePort();

  const forward = startSsh(client, [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-L',
    `${String(port)}:localhost:8080`,
    `${name}@${SSH_HOST}`,
  ]);

  try {
    const body = await waitFor('the forward to answer', async () => {
      const response = await fetch(`http://127.0.0.1:${String(port)}/`);

      return response.text();
    });

    expect(body.trim()).toBe(PAGE);
  } finally {
    await forward.stop();
  }
});

// VS Code Remote SSH: a shell on stdin with dynamic forwarding, then its
// connections through the SOCKS port to the imp's own loopback
test('a SOCKS forward next to a shell on stdin, as VS Code opens it', async () => {
  const port = findFreePort();

  const session = startSsh(
    client,
    ['-T', '-D', String(port), `${name}@${SSH_HOST}`, 'sh'],
    'echo shell-ready; sleep 30\n',
  );

  try {
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

    expect(body.trim()).toBe(PAGE);
  } finally {
    await session.stop();
  }
});

test('a forward to anything but the imp is refused', async () => {
  const port = findFreePort();

  // INFO: the client logs a refused channel at that level
  const forward = startSsh(client, [
    '-N',
    '-o',
    'LogLevel=INFO',
    '-L',
    `${String(port)}:example.com:80`,
    `${name}@${SSH_HOST}`,
  ]);

  try {
    // the listener opens before the refusal, so wait until it answers
    const result = await waitFor('the refused forward to close', async () => {
      const curl = await runCommand([
        'curl',
        '-sS',
        '--max-time',
        '5',
        `http://127.0.0.1:${String(port)}/`,
      ]);

      if (curl.stderr.includes('Failed to connect')) {
        throw new Error('the forward is not up yet');
      }

      return curl;
    });

    expect(result.exitCode).not.toBe(0);
  } finally {
    await forward.stop();
  }

  const stderr = await new Response(forward.proc.stderr).text();

  expect(stderr).toContain('administratively prohibited');
});

test('only LANG and LC_* reach the imp from the client env', async () => {
  const result = await runSsh(client, name, [
    '-o',
    'SetEnv=LANG=C.UTF-8 SECRET=leaked',
    'echo "$LANG"; if [ -z "$SECRET" ]; then echo unset; fi',
  ]);

  expect(result.stdout).toBe('C.UTF-8\nunset\n');
});

// The API (7070 in the container) listens dual-stack: without its ip6tables
// rule, a guest reaches it over the tap's IPv6 link-local address.
test('a guest reaches no host port, over IPv4 or IPv6 link-local', async () => {
  await runImp('wake', name);

  // the host end of the tap is the guest's default gateway
  const hostIp = await runShellInImp(name, "ip route | awk '/^default/ {print $3}'");
  const linkLocal = await readTapLinkLocal(hostIp);

  // busybox nc exits non-zero when it cannot connect within 2 s
  const checkPort = (target: string, port: number): Promise<string> =>
    runShellInImp(
      name,
      `if nc -w 2 ${target} ${String(port)} </dev/null >/dev/null 2>&1; then echo open; else echo closed; fi`,
    );

  // a control: the probe connects at all, over IPv6 too
  const control = await checkPort('::1', 8080);

  expect(control).toBe('open');

  const results = {
    ssh: await checkPort(hostIp, 22),
    sshOverIpv6: await checkPort(`${linkLocal}%eth0`, 22),
    apiOverIpv6: await checkPort(`${linkLocal}%eth0`, 7070),
  };

  expect(results).toEqual({ ssh: 'closed', sshOverIpv6: 'closed', apiOverIpv6: 'closed' });
});

// SSH commands get the credential broker's variables as `imp exec` does
// (docs/guides/connectors.md); the guest only ever sees the placeholder
test('an imp with a grant gets the broker variables over ssh', async () => {
  await tryImp(['secret', 'rm', secret]);

  const added = await tryImp(['secret', 'add', secret, '--kind', 'github'], {
    stdin: 'e2e-ssh-not-a-token\n',
  });

  expect(added.exitCode).toBe(0);

  await runImp('grant', name, secret);

  const result = await runSsh(client, name, ['echo "$HTTPS_PROXY"; echo "$GH_TOKEN"']);

  const [proxy, token] = result.stdout.split('\n');

  expect(result.exitCode).toBe(0);
  expect(proxy).toMatch(/^http:\/\/[\d.]+:\d+$/);
  expect(token).toBe('imp-broker-placeholder');
});
