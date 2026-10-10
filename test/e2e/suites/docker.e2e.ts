import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { getThroughProxy } from '../lib/http';
import { createInstanceClient, runImp, runInImp, runShellInImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// Docker inside an imp of images/base, whose dockerd starts with the guest.
// Each test boots its own imp and waits for its dockerd.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('docker'), stack, client };
}

test('it runs and builds images with docker inside an imp', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}build`;

  await runImp('new', name, '--image', 'base');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await waitFor(`dockerd in ${name}`, () => runInImp(name, 'docker', 'info'), {
    timeoutMs: 90_000,
  });

  const hello = await runInImp(name, 'docker', 'run', '--rm', 'hello-world');

  const built = await runShellInImp(
    name,
    [
      'mkdir -p /tmp/e2e-build && cd /tmp/e2e-build',
      String.raw`printf "FROM busybox:1.37\nRUN echo built-\$((6 * 7)) > /built\nCMD [\"cat\", \"/built\"]\n" > Dockerfile`,
      'docker build -q -t e2e-built . >/dev/null && docker run --rm e2e-built',
    ].join('\n'),
  );

  expect(hello).toContain('Hello from Docker!');
  expect(built).toBe('built-42');
});

test('it runs a container from scratch in the inner container, with no registry', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}scratch`;

  await runImp('new', name, '--image', 'base');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await waitFor(`dockerd in ${name}`, () => runInImp(name, 'docker', 'info'), {
    timeoutMs: 90_000,
  });

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

test('it lets a container resolve names and reach the internet', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}net`;

  await runImp('new', name, '--image', 'base');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await waitFor(`dockerd in ${name}`, () => runInImp(name, 'docker', 'info'), {
    timeoutMs: 90_000,
  });

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

test('it serves a container port published on 8080 through the wake proxy, again after a cold boot', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}web`;

  await runImp('new', name, '--image', 'base');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await waitFor(`dockerd in ${name}`, () => runInImp(name, 'docker', 'info'), {
    timeoutMs: 90_000,
  });

  await runInImp(name, 'docker', 'run', '-d', '--name', 'web', '-p', '8080:80', 'nginx:alpine');

  // until nginx's own page comes through, not just any answer
  const page = await waitFor(`nginx in ${name} through the proxy`, async () => {
    const body = await getThroughProxy(name);

    if (!body.includes('<title>Welcome to nginx!</title>')) {
      throw new Error(`not nginx's page yet: ${body.slice(0, 80)}`);
    }

    return body;
  });

  expect(page).toContain('<title>Welcome to nginx!</title>');

  await runImp('stop', name);
  await runImp('start', name);
  await waitForExec(name);
  await holdImp(name);

  await waitFor(`dockerd in ${name} after the cold boot`, () => runInImp(name, 'docker', 'info'), {
    timeoutMs: 90_000,
  });

  await runInImp(name, 'docker', 'start', 'web');

  const again = await waitFor(`nginx in ${name} after the cold boot`, async () => {
    const body = await getThroughProxy(name);

    if (!body.includes('<title>Welcome to nginx!</title>')) {
      throw new Error(`not nginx's page yet: ${body.slice(0, 80)}`);
    }

    return body;
  });

  expect(again).toContain('<title>Welcome to nginx!</title>');
});
