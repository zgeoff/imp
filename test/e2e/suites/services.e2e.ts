import { expect, test } from 'bun:test';
import * as z from 'zod';
import { resolveImageName } from '../lib/fixtures';
import { getThroughProxy, sendProxyRequest } from '../lib/http';
import { assertState, runImp, runInImp, runShellInImp, startImp, tryImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// The services API (docs/guides/services.md) on e2e-bare, busybox with no
// services: busybox httpd added as a service answers through the proxy, logs
// each request, and lives through a restart, a sleep, a reboot and a remove.

const prefix = setupSuite('services');
const name = `${prefix}a`;

const ServiceRowSchema = z.object({
  name: z.string(),
  state: z.string(),
  pid: z.int().nullable(),
  argv: z.array(z.string()),
  envKeys: z.array(z.string()),
  source: z.string(),
  root: z.boolean(),
});

// what the stream has printed so far, read as it comes
function collectText(stream: ReadableStream<Uint8Array>): { text: string } {
  const collected = { text: '' };

  const decoder = new TextDecoder();

  const readAll = async (): Promise<void> => {
    for await (const chunk of stream) {
      collected.text += decoder.decode(chunk, { stream: true });
    }
  };

  void readAll();

  return collected;
}

async function listServices(): Promise<z.infer<typeof ServiceRowSchema>[]> {
  const stdout = await runImp('service', 'ls', name, '--json');

  return z.array(ServiceRowSchema).parse(JSON.parse(stdout));
}

function waitForPid(other: number | null): Promise<number> {
  return waitFor('the web service to run', async () => {
    const services = await listServices();

    const web = services.find((service) => service.name === 'web');

    if (web?.state !== 'running' || web.pid === null || web.pid === other) {
      throw new Error(`web: ${JSON.stringify(web)}`);
    }

    return web.pid;
  });
}

let firstPid = 0;

test('an added service runs, and the proxy reaches it', async () => {
  await createImp(name, '--image', resolveImageName('e2e-bare'), '--memory', '256');
  await runShellInImp(name, 'mkdir -p /srv/www && echo hello from a service > /srv/www/index.html');

  await runImp(
    'service',
    'add',
    name,
    'web',
    '--env',
    'GREETING=hi',
    '--',
    'busybox',
    'httpd',
    '-f',
    '-vv',
    '-p',
    '8080',
    '-h',
    '/srv/www',
  );

  firstPid = await waitForPid(null);

  const body = await waitFor('the service to answer', () => getThroughProxy(name));
  const file = await runInImp(name, 'cat', '/etc/imp/services.d/web.json');
  const services = await listServices();

  expect(body).toBe('hello from a service');

  const written: unknown = JSON.parse(file);

  // the file name is the name, so the file holds none; busybox runs as root
  expect(written).toMatchObject({ env: ['GREETING=hi'], source: 'api' });
  expect(written).not.toHaveProperty('name');

  expect(services).toMatchObject([
    { name: 'web', envKeys: ['GREETING'], source: 'api', root: true },
  ]);
}, 120_000);

test('logs has the request, and a follow prints the next one', async () => {
  const logs = await runImp('logs', name, 'web');

  expect(logs).toContain('url:/');

  const follow = await startImp(['logs', name, 'web', '-f', '-n', '0']);

  const reader = follow.stdout.getReader();

  const decoder = new TextDecoder();

  let seen = '';

  try {
    const marker = `/followed-${String(Date.now())}`;

    // the follow starts in the background; a request before it may land in
    // the tail it skips, so it asks again until one shows
    // one read stays pending across tries, so no chunk is lost to a timeout
    let pending = reader.read();

    await waitFor('the follow to print a request', async () => {
      await sendProxyRequest(name, marker);

      const timeout = Bun.sleep(1000);

      const chunk = await Promise.race([pending, timeout]);

      if (chunk !== undefined) {
        seen += decoder.decode(chunk.value, { stream: true });
        pending = reader.read();
      }

      if (!seen.includes(marker)) {
        throw new Error(`printed so far: ${JSON.stringify(seen)}`);
      }
    });
  } finally {
    follow.kill();

    await follow.exited;

    reader.releaseLock();
  }

  const all = await runImp('logs', name);

  expect(all).toMatch(/^web \| /m);
}, 60_000);

test('a restart starts the service again from its file', async () => {
  await runImp('service', 'restart', name, 'web');

  const pid = await waitForPid(firstPid);
  const body = await getThroughProxy(name);

  expect(body).toBe('hello from a service');

  firstPid = pid;
}, 60_000);

test('a follow waits out a sleep without a wake, and prints each line once', async () => {
  const follow = await startImp(['logs', name, 'web', '-f', '-n', '0']);

  const stdout = collectText(follow.stdout);
  const stderr = collectText(follow.stderr);

  try {
    // the follow's first open is on the way; a sleep after it ends the stream
    await Bun.sleep(1000);

    await runImp('sleep', name);

    await waitFor('the follow to say the imp sleeps', () => {
      expect(stderr.text).toContain(`${name} is sleeping`);
    });

    await Bun.sleep(2000);

    await assertState(name, 'sleeping');

    const marker = `/after-sleep-${String(Date.now())}`;

    await sendProxyRequest(name, marker);

    await waitFor('the follow to print the request after the wake', () => {
      expect(stdout.text).toContain(`url:${marker}`);
    });

    expect(stderr.text).toContain(`${name} runs again`);
    expect(stdout.text.split(`url:${marker}`)).toHaveLength(2);
  } finally {
    follow.kill();

    await follow.exited;
  }
}, 60_000);

test('a sleeping imp keeps its service, and a reboot starts it from the file', async () => {
  await runImp('sleep', name);
  await assertState(name, 'sleeping');

  const woken = await getThroughProxy(name);
  const services = await listServices();

  expect(woken).toBe('hello from a service');
  expect(services[0]?.pid).toBe(firstPid);

  await runImp('stop', name);
  await runImp('start', name);
  await waitForPid(null);

  const rebooted = await waitFor('the service after a reboot', () => getThroughProxy(name));

  expect(rebooted).toBe('hello from a service');
}, 120_000);

test('a file written by hand starts on its first restart', async () => {
  await runShellInImp(name, `echo '{"argv":["sleep","3600"]}' > /etc/imp/services.d/late.json`);
  await runImp('service', 'restart', name, 'late');

  const late = await waitFor('the late service to run', async () => {
    const services = await listServices();

    const found = services.find((service) => service.name === 'late');

    if (found?.state !== 'running') {
      throw new Error(JSON.stringify(services));
    }

    return found;
  });

  expect(late.argv).toEqual(['sleep', '3600']);
}, 60_000);

test('remove stops the service and deletes its file; its log stays', async () => {
  await runImp('service', 'rm', name, 'web');

  const services = await listServices();
  const files = await runInImp(name, 'ls', '/etc/imp/services.d');
  const response = await sendProxyRequest(name);
  const logs = await runImp('logs', name, 'web');
  const again = await tryImp(['service', 'rm', name, 'web']);

  expect(services.map((service) => service.name)).toEqual(['late']);
  expect(files).toBe('late.json');
  expect(response.ok).toBe(false);
  expect(logs).toContain('url:/');
  expect(again.exitCode).not.toBe(0);
  expect(again.stderr).toContain('not found');
}, 60_000);
