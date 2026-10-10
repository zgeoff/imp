import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import * as z from 'zod';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { getThroughProxy, readOkBody } from '../lib/http';
import {
  createInstanceClient,
  runImp,
  runInImp,
  runShellInImp,
  startImp,
  tryImp,
} from '../lib/imp-cli';
import { holdImp, readGuestFile, waitForExec, writeGuestFile } from '../lib/imps';
import { readInitStart, readUptime, waitForInnerInit } from '../lib/inner-container';
import { findSocketListenAgain, parseProxyForwards } from '../lib/proxy-forward-lines';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { startTextCapture } from '../lib/text-capture';
import { waitFor } from '../lib/wait-for';

// A restart of the inner container from inside (docs/architecture/agent.md
// #the-inner-container) starts it again, not the guest: the disk, the
// network and what holds connections to the imp outlast it.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('inner'), stack, client };
}

test('it starts the container again on a reboot inside, not the guest, and its service once', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}reboot`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);
  await writeGuestFile(name, '/root/marker', 'kept');
  await runShellInImp(name, 'rm -f /dev/null');

  const before = await readInitStart(name);
  const uptimeBefore = await readUptime(name);

  // busybox reboot -f calls reboot(2), which in a PID namespace kills its init
  await tryImp(['exec', name, '--', 'reboot', '-f']);
  await waitForInnerInit(name);

  const after = await readInitStart(name);
  const marker = await readGuestFile(name, '/root/marker');
  const devNull = await runShellInImp(name, 'test -c /dev/null && echo back');
  const uptimeAfter = await readUptime(name);

  expect(after).not.toBe(before);
  expect(marker).toBe('kept');
  expect(devNull).toBe('back');
  expect(uptimeAfter).toBeGreaterThanOrEqual(uptimeBefore);

  // the agent starts the image's www service (httpd) in the new container; a
  // second start would bind :8080 again, fail, and count a restart
  const service = await waitFor(`www running in ${name} after the restart`, async () => {
    const listed = await runImp('service', 'ls', name, '--json');

    const found = z
      .array(
        z.object({
          name: z.string(),
          state: z.string(),
          pid: z.number().nullable(),
          restarts: z.number(),
        }),
      )
      .parse(JSON.parse(listed))
      .find((candidate) => candidate.name === 'www');

    if (found?.state !== 'running') {
      throw new Error(`www is ${found?.state ?? 'not listed'}`);
    }

    return found;
  });

  const pids = await runShellInImp(name, 'pidof httpd || true');

  expect(service.restarts).toBe(0);
  expect(pids.split(' ')).toStrictEqual([String(service.pid)]);
});

test('it keeps forwards, reverse forwards and the service port working through a restart inside', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}fwd`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const page = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('e2e-inner-reverse\n'),
  });

  ctx.stack.defer(() => page.stop(true));

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

  const stdout = startTextCapture(proxy.stdout);
  const stderr = startTextCapture(proxy.stderr);

  ctx.stack.defer(async () => {
    proxy.kill('SIGINT');

    await proxy.exited;
  });

  const forwards = await waitFor('imp proxy to listen', () => {
    const parsed = parseProxyForwards(stdout.read());

    if (
      parsed.localPort === undefined ||
      parsed.guestPort === undefined ||
      parsed.socketPath === undefined
    ) {
      throw new Error(`imp proxy printed ${stdout.read()}${stderr.read()}`);
    }

    return parsed;
  });

  invariant(forwards.localPort);
  invariant(forwards.guestPort);

  const local = `http://127.0.0.1:${forwards.localPort}/`;
  const fetchInGuest = `wget -qO- http://127.0.0.1:${forwards.guestPort}/`;

  const before = await readOkBody(fetch(local));
  const reversedBefore = await runShellInImp(name, fetchInGuest);

  expect(before).toBe('e2e-tiny-ok');
  expect(reversedBefore).toBe('e2e-inner-reverse');

  await tryImp(['exec', name, '--', 'reboot', '-f']);
  await waitForInnerInit(name);

  // the forward dials anew for each connection, once the service is back
  const after = await waitFor('the forward to the service after the restart', () =>
    readOkBody(fetch(local)),
  );

  // the TCP reverse forward kept its port: the guest has one network
  const reversedAfter = await runShellInImp(name, fetchInGuest);

  // the socket in the old container's /run went with it; the client listens
  // again in the new one
  const again = await waitFor('the reverse forward on a socket to listen again', () => {
    const path = findSocketListenAgain(stderr.read());

    if (path === undefined) {
      throw new Error(`imp proxy said ${stderr.read()}`);
    }

    return path;
  });

  const exists = await runShellInImp(name, `test -S '${again}' && echo socket`);
  const throughProxy = await getThroughProxy(name);

  expect(after).toBe('e2e-tiny-ok');
  expect(reversedAfter).toBe('e2e-inner-reverse');
  expect(exists).toBe('socket');
  expect(throughProxy).toBe('e2e-tiny-ok');
});

// The init is the agent binary from the system drive and makes its own mount
// points. Only busybox and its loader and libc (/lib, /lib64) stay.
test('it starts a container whose root was wiped again', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}wiped`;
  const keep = '/keep/busybox';

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const before = await readInitStart(name);

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
  expect(listed.split('\n')).toIncludeAllMembers(['keep', 'proc', 'run']);

  expect(broken).toStrictEqual({
    exitCode: 127,
    stdout: '',
    stderr: expect.toInclude('EXEC_FAILED'),
  });
});
