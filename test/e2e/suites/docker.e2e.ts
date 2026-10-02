import { expect, test } from 'bun:test';
import { getThroughProxy } from '../lib/http';
import { runImp, runInImp, runShellInImp } from '../lib/imp-cli';
import { createImp, holdImp, waitForExec } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

const prefix = setupSuite('docker');
const name = `${prefix}a`;
const NGINX_TITLE = '<title>Welcome to nginx!</title>';

function waitForDockerd(): Promise<string> {
  return waitFor(`dockerd in ${name}`, () => runInImp(name, 'docker', 'info'), {
    timeoutMs: 90_000,
  });
}

function waitForNginx(): Promise<void> {
  return waitFor(`nginx in ${name} through the proxy`, async () => {
    const page = await getThroughProxy(name);

    expect(page).toContain(NGINX_TITLE);
  });
}

test('docker runs and builds images inside an imp from images/base', async () => {
  await createImp(name, '--image', 'base');
  await holdImp(name);
  await waitForDockerd();

  const hello = await runInImp(name, 'docker', 'run', '--rm', 'hello-world');

  expect(hello).toContain('Hello from Docker!');

  const built = await runShellInImp(
    name,
    [
      'mkdir -p /tmp/e2e-build && cd /tmp/e2e-build',
      String.raw`printf "FROM busybox:1.37\nRUN echo built-\$((6 * 7)) > /built\nCMD [\"cat\", \"/built\"]\n" > Dockerfile`,
      'docker build -q -t e2e-built . >/dev/null && docker run --rm e2e-built',
    ].join('\n'),
  );

  expect(built).toBe('built-42');
});

test('a container from scratch runs in the inner container, with no registry', async () => {
  // the agent is a static binary: an image of it alone needs no pull
  const version = await runShellInImp(
    name,
    [
      'mkdir -p /tmp/e2e-scratch && cd /tmp/e2e-scratch',
      'cp /run/imp/sys/imp-agent .',
      String.raw`printf "FROM scratch\nCOPY imp-agent /\nENTRYPOINT [\"/imp-agent\", \"version\"]\n" > Dockerfile`,
      'docker build -q -t e2e-scratch . >/dev/null',
      'docker save e2e-scratch | docker load -q >/dev/null',
      'docker run --rm --memory 64m e2e-scratch',
    ].join('\n'),
  );

  expect(version).toMatch(/^\d+\.\d+\.\d+$/v);
});

test('a container port published on 8080 answers through the wake proxy', async () => {
  await runInImp(name, 'docker', 'run', '-d', '--name', 'web', '-p', '8080:80', 'nginx:alpine');
  await waitForNginx();
});

test('a container resolves names and reaches the internet', async () => {
  const page = await runInImp(
    name,
    'docker',
    'run',
    '--rm',
    'alpine:3.20',
    'sh',
    '-c',
    'nslookup example.com >/dev/null && wget -qO- http://example.com',
  );

  expect(page).toContain('<title>Example Domain</title>');
});

test('dockerd and its containers come back after a cold boot', async () => {
  await runImp('stop', name);
  await runImp('start', name);
  await waitForExec(name);
  await holdImp(name);
  await waitForDockerd();
  await runInImp(name, 'docker', 'start', 'web');
  await waitForNginx();
});
