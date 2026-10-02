import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveImageName } from '../lib/fixtures';
import { getThroughProxy } from '../lib/http';
import {
  listCheckpoints,
  readState,
  runImp,
  runInImp,
  runShellInImp,
  startImp,
  tryImp,
} from '../lib/imp-cli';
import { createImp, holdImp, readGuestFile, waitForExec, writeGuestFile } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// User code runs in the inner container over the user disk; the agent stays
// outside it (docs/architecture/agent.md#the-inner-container). Nothing done
// inside may take the agent down.
const prefix = setupSuite('inner');
const TINY = resolveImageName('e2e-tiny');
const name = `${prefix}a`;

// the inner init's start time, in clock ticks since boot: it changes only
// when the container starts again
function readInitStart(): Promise<string> {
  return runShellInImp(name, "cut -d' ' -f22 /proc/1/stat");
}

// the guest's uptime in whole seconds, which a container restart keeps
async function readUptime(): Promise<number> {
  const uptime = await runShellInImp(name, 'cut -d. -f1 /proc/uptime');

  return Number(uptime);
}

const PAGE = 'e2e-tiny-ok\n';
const REVERSE_PAGE = 'e2e-inner-reverse\n';

async function readOk(url: string): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${url}: ${String(response.status)}`);
  }

  return response.text();
}

interface TextSink {
  text: string;
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- the sink collects
async function collectText(stream: ReadableStream<Uint8Array>, sink: TextSink): Promise<void> {
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    sink.text += decoder.decode(chunk);
  }
}

async function waitForInit(): Promise<void> {
  await waitFor(`the inner container in ${name}`, () => runInImp(name, 'true'), {
    timeoutMs: 30_000,
  });
}

test('the inner init is PID 1 of what an exec sees', async () => {
  await createImp(name, '--image', TINY);
  await holdImp(name);

  const cmdline = await runShellInImp(name, String.raw`tr '\0' ' ' < /proc/1/cmdline`);

  expect(cmdline.trim()).toBe('/imp-agent inner');

  const agent = await runShellInImp(name, 'test -x /run/imp/sys/imp-agent && echo ok');

  expect(agent).toBe('ok');
});

test('no process inside holds the inner init socket', async () => {
  const own = await runShellInImp(name, String.raw`ls /proc/self/fd | tr "\n" " "`);

  // ls's own fd 3 is its directory
  expect(own.trim()).toBe('0 1 2 3');

  // the httpd service, and everything else, has no fd on the init's socket
  const socket = await runShellInImp(name, 'readlink /proc/1/fd/3');

  const holders = await runShellInImp(
    name,
    `for p in /proc/[0-9]*; do [ "$p" = /proc/1 ] || ls -l "$p/fd" 2>/dev/null; done | grep -c '${socket}' || true`,
  );

  expect(socket).toStartWith('socket:');
  expect(holders).toBe('0');
});

test('a memory hog inside meets the OOM killer, and the container stays up', async () => {
  const before = await readInitStart();
  const adj = await runShellInImp(name, 'cat /proc/self/oom_score_adj');

  expect(adj).toBe('0');

  const hog = await tryImp(['exec', name, '--', 'awk', 'BEGIN { s = "x"; while (1) s = s s }']);

  expect(hog.exitCode).toBe(137);

  await waitForExec(name);

  const after = await readInitStart();

  expect(after).toBe(before);
});

test("the system drive is read-only inside, and the agent's /run is not there", async () => {
  const write = await tryImp(['exec', name, '--', 'touch', '/run/imp/sys/x']);
  const runs = await runShellInImp(name, "grep -c ' /run ' /proc/mounts");

  const agentRun = await runShellInImp(
    name,
    "grep ' /run ' /proc/mounts | grep -c size=16384k || true",
  );

  expect(write.exitCode).not.toBe(0);
  expect(runs).toBe('1');
  expect(agentRun).toBe('0');
});

test('an exec gets its cgroup even after the exec parent is removed inside', async () => {
  await runShellInImp(
    name,
    [
      // out of its own leaf first, which would keep the parent busy
      'echo $$ > /sys/fs/cgroup/init/cgroup.procs',
      'rmdir /sys/fs/cgroup/exec/* 2>/dev/null',
      'rmdir /sys/fs/cgroup/exec',
    ].join('\n'),
  );

  const cgroup = await runInImp(name, 'cat', '/proc/self/cgroup');

  expect(cgroup).toMatch(/^0::\/exec\/\d+$/v);
});

test('signals to PID 1 from inside are ignored', async () => {
  const before = await readInitStart();

  for (const signal of ['TERM', 'SEGV', 'INT', 'HUP', 'QUIT', 'ABRT', 'USR1']) {
    await runShellInImp(name, `kill -${signal} 1`);
  }

  const after = await readInitStart();

  expect(after).toBe(before);
});

test('kill -9 -1 inside leaves the container up', async () => {
  const before = await readInitStart();

  await tryImp(['exec', name, '--', 'sh', '-c', 'kill -9 -1']);
  await waitForExec(name);

  const after = await readInitStart();

  expect(after).toBe(before);
});

test('device nodes removed inside are gone only inside', async () => {
  await runShellInImp(name, 'rm -f /dev/null /dev/zero');

  // the agent opens its own /dev/null for every exec's stdin
  const seen = await runShellInImp(name, 'test -e /dev/null || echo gone');

  expect(seen).toBe('gone');
});

test('a reboot inside starts the container again, not the guest', async () => {
  await writeGuestFile(name, '/root/marker', 'kept');

  const before = await readInitStart();
  const uptimeBefore = await readUptime();

  // busybox reboot -f calls reboot(2), which in a PID namespace kills its init
  await tryImp(['exec', name, '--', 'reboot', '-f']);
  await waitForInit();

  const after = await readInitStart();
  const marker = await readGuestFile(name, '/root/marker');
  const devNull = await runShellInImp(name, 'test -c /dev/null && echo back');
  const uptimeAfter = await readUptime();

  expect(after).not.toBe(before);
  expect(marker).toBe('kept');
  expect(devNull).toBe('back');
  expect(uptimeAfter).toBeGreaterThanOrEqual(uptimeBefore);

  // the service comes back, once
  await waitFor(`httpd in ${name} after the restart`, async () => {
    const pids = await runShellInImp(name, 'pidof httpd || true');

    expect(pids.split(' ').filter((pid) => pid !== '')).toHaveLength(1);
  });

  await Bun.sleep(3000);

  const pids = await runShellInImp(name, 'pidof httpd || true');

  expect(pids.split(' ').filter((pid) => pid !== '')).toHaveLength(1);
});

test('forwards, reverse forwards and the service port work again after a restart', async () => {
  const page = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(REVERSE_PAGE),
  });

  const pagePort = String(page.port);

  const proxy = await startImp([
    'proxy',
    name,
    '0:8080',
    '--reverse',
    `0:${pagePort}`,
    '--reverse',
    `:${pagePort}`,
  ]);

  const stdout = { text: '' };
  const stderr = { text: '' };

  void collectText(proxy.stdout, stdout);
  void collectText(proxy.stderr, stderr);

  try {
    const lines = await waitFor('imp proxy to listen', () => {
      const local = /forwarding localhost:(?<port>\d+) ->/v.exec(stdout.text)?.groups?.['port'];

      const guestPort = /forwarding (?!localhost:)[^:]+:(?<port>\d+) ->/v.exec(stdout.text)
        ?.groups?.['port'];

      const own = /forwarding [^:]+:(?<path>\/run\/imp\/forward\/\S+) ->/v.exec(stdout.text)
        ?.groups?.['path'];

      if (local === undefined || guestPort === undefined || own === undefined) {
        throw new Error(`imp proxy printed ${stdout.text}${stderr.text}`);
      }

      return { local, guestPort, own };
    });

    const fetchInGuest = `wget -qO- http://127.0.0.1:${lines.guestPort}/`;

    const before = await readOk(`http://127.0.0.1:${lines.local}/`);
    const reversedBefore = await runShellInImp(name, fetchInGuest);

    expect(before).toBe(PAGE);
    expect(reversedBefore).toBe(REVERSE_PAGE.trim());

    await tryImp(['exec', name, '--', 'reboot', '-f']);
    await waitForInit();

    // the forward dials anew for each connection, once the service is back
    await waitFor('the forward to the service after the restart', async () => {
      const after = await readOk(`http://127.0.0.1:${lines.local}/`);

      expect(after).toBe(PAGE);
    });

    // the TCP reverse forward kept its port: the guest has one network
    const reversedAfter = await runShellInImp(name, fetchInGuest);

    expect(reversedAfter).toBe(REVERSE_PAGE.trim());

    // the socket in the old container's /run went with it; the client
    // listens again in the new one
    const again = await waitFor('the reverse forward on a socket to listen again', () => {
      const path = /forwarding [^:]+:(?<path>\/run\/imp\/forward\/\S+) -> \S+ again/v.exec(
        stderr.text,
      )?.groups?.['path'];

      if (path === undefined) {
        throw new Error(`imp proxy said ${stderr.text}`);
      }

      return path;
    });

    const exists = await runShellInImp(name, `test -S '${again}' && echo socket`);

    expect(exists).toBe('socket');

    const throughProxy = await getThroughProxy(name);

    expect(throughProxy).toBe(PAGE.trim());
  } finally {
    proxy.kill('SIGINT');

    await proxy.exited;

    await page.stop(true);
  }
});

test('imp cp works with the system drive unmounted inside', async () => {
  await writeGuestFile(name, '/root/copied', 'through-the-agent-fd');
  await runInImp(name, 'umount', '/run/imp/sys');

  const local = mkdtempSync(join(tmpdir(), 'imp-e2e-inner-'));

  await runImp('cp', `${name}:/root/copied`, local);

  expect(readFileSync(join(local, 'copied'), 'utf8').trim()).toBe('through-the-agent-fd');
});

// a token the suite makes, and removes once the test ends
async function withToken<T>(
  args: readonly string[],
  use: (secret: string) => Promise<T>,
): Promise<T> {
  const token = `${prefix}t`;

  await tryImp(['token', 'rm', token]);

  const made = await runImp('token', 'new', token, ...args);

  const secret = made.trim();

  try {
    return await use(secret);
  } finally {
    await tryImp(['token', 'rm', token]);
  }
}

// docs/architecture/agent.md#outer-exec
test('exec --agent runs a shell as root outside the container, for host-wide manage only', async () => {
  const events = await startImp(['events', name]);

  const sink: TextSink = { text: '' };
  const collecting = collectText(events.stdout, sink);

  try {
    // the shell computes the line, so the terminal's echo of the input
    // does not match it
    const shell = await tryImp(['exec', '--agent', '-t', name, '--', 'sh'], {
      stdin: 'echo outer-$((20 + 22)) $(id -u) $(cat /proc/self/oom_score_adj)\nexit\n',
    });

    const cgroup = await runImp('exec', '--agent', name, '--', 'cat', '/proc/self/cgroup');
    const container = await runInImp(name, 'cat', '/proc/self/cgroup');

    expect(shell.exitCode).toBe(0);
    expect(shell.stdout).toContain('outer-42 0 0');
    expect(cgroup.trim()).toMatch(/^0::\/outer\/\d+$/);
    expect(container.trim()).not.toContain('outer');

    await waitFor('the AgentExec event', () => {
      expect(sink.text).toContain('"ev":"AgentExec"');
    });
  } finally {
    events.kill();

    await collecting;
  }

  const execToken = await withToken(['--scope', 'exec'], (secret) =>
    tryImp(['exec', '--agent', name, '--', 'true'], { token: secret }),
  );

  const oneImpManage = await withToken(['--scope', 'manage', '--imps', name], (secret) =>
    tryImp(['exec', '--agent', name, '--', 'true'], { token: secret }),
  );

  for (const refused of [execToken, oneImpManage]) {
    expect(refused.exitCode).toBe(255);
    expect(refused.stderr).toContain('FORBIDDEN');
  }
});

test('a memory hog outside the container meets the OOM killer in its 32 MiB', async () => {
  const hog = await tryImp([
    'exec',
    '--agent',
    name,
    '--',
    'awk',
    'BEGIN { s = "x"; while (1) s = s s }',
  ]);

  const events = await runImp(
    'exec',
    '--agent',
    name,
    '--',
    'cat',
    '/sys/fs/cgroup/outer/memory.events',
  );

  const kills = Number(/^oom_kill (?<count>\d+)$/m.exec(events)?.groups?.['count']);

  expect(hog.exitCode).toBe(137);
  expect(kills).toBeGreaterThan(0);

  await runInImp(name, 'true');
});

test('rm -rf / inside leaves the agent answering and a checkpoint restores it', async () => {
  await runImp('checkpoint', name);

  const [checkpoint] = await listCheckpoints(name);

  if (checkpoint === undefined) {
    throw new Error(`${name} has no checkpoint`);
  }

  await tryImp(['exec', name, '--', 'sh', '-c', 'rm -rf /* 2>/dev/null']);

  // the agent answers: exec fails at once, it does not hang
  const started = Date.now();

  const broken = await tryImp(['exec', name, '--', 'true']);

  const tookMs = Date.now() - started;

  const state = await readState(name);

  expect(broken.exitCode).toBe(127);
  expect(broken.stderr).toContain('EXEC_FAILED');
  expect(tookMs).toBeLessThan(10_000);
  expect(state).toBe('running');

  // the agent's world still runs commands, and shows the wiped disk and the
  // container's cgroup
  const left = await runImp('exec', '--agent', name, '--', 'ls', '-A', '/user');

  const events = await runImp(
    'exec',
    '--agent',
    name,
    '--',
    'cat',
    '/sys/fs/cgroup/user/cgroup.events',
  );

  expect(left.split('\n')).not.toContain('etc');
  expect(events).toContain('populated');

  await runImp('restore', name, checkpoint.id);
  await waitForExec(name);

  const marker = await readGuestFile(name, '/root/marker');

  expect(marker).toBe('kept');
});

// The init is the agent binary from the system drive and makes its own mount
// points. Only busybox and its loader and libc (/lib, /lib64) stay.
test('a container whose root was wiped starts again', async () => {
  const keep = '/keep/busybox';

  const before = await readInitStart();

  await runShellInImp(name, `mkdir /keep && cp /bin/busybox ${keep}`);

  await tryImp([
    'exec',
    name,
    '--',
    'sh',
    '-c',
    `for f in /*; do case $f in /keep|/lib|/lib64) ;; *) ${keep} rm -rf "$f" ;; esac; done 2>/dev/null; ${keep} reboot -f`,
  ]);

  const after = await waitFor(`the inner container in ${name} after the wipe`, async () => {
    const stat = await runInImp(name, keep, 'cat', '/proc/1/stat');

    const start = stat.split(' ').at(21);

    if (start === before) {
      throw new Error('the old container still runs');
    }

    return start;
  });

  const listed = await runInImp(name, keep, 'ls', '/');
  const broken = await tryImp(['exec', name, '--', 'true']);

  expect(after).not.toBe(before);
  expect(listed.split('\n')).toContain('keep');
  expect(listed.split('\n')).toContain('proc');
  expect(listed.split('\n')).toContain('run');
  expect(broken.stderr).toContain('EXEC_FAILED');
});

test('an imp whose disk was wiped still stops and goes', async () => {
  await tryImp(['exec', name, '--', 'sh', '-c', 'rm -rf /* 2>/dev/null']);
  await runImp('stop', name);

  const state = await readState(name);

  expect(state).toBe('stopped');

  await runImp('rm', name);
});
