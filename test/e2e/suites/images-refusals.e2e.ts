import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeBuildContext } from '../lib/build-context';
import { config } from '../lib/config';
import { createInstanceClient, listImageNames, tryImp } from '../lib/imp-cli';
import { REPO_ROOT, runChecked, runCommand } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImageIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// What `imp image build` and `imp image add` refuse (docs/guides/images.md),
// before a build or in its builder; none of them leaves an image.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  await mkdir(join(REPO_ROOT, '.cache', 'e2e'), { recursive: true });

  const buildRoot = await mkdtemp(join(REPO_ROOT, '.cache', 'e2e', 'build-'));

  stack.defer(() => rm(buildRoot, { recursive: true, force: true }));

  return { prefix: readSuitePrefix('images'), stack, client, buildRoot };
}

test('it refuses a RUN step that asks for the host network or insecure mode', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}runflags`;

  const hostNet = await writeBuildContext(
    ctx.buildRoot,
    'host-net',
    'FROM busybox:1.37\nRUN --network=host true\n',
  );

  const insecure = await writeBuildContext(
    ctx.buildRoot,
    'insecure',
    'FROM busybox:1.37\nRUN --security=insecure true\n',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const netResult = await tryImp(['image', 'build', hostNet, '--name', name]);
  const insecureResult = await tryImp(['image', 'build', insecure, '--name', name]);
  const images = await listImageNames();

  expect(netResult).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('network.host is not allowed'),
  });

  // the pinned stable frontend has no --security; the engine never sees the step
  expect(insecureResult).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('unknown flag: --security'),
  });

  expect(images).not.toContain(name);
});

// A builder has only what it pulls: an image built on the host's Docker is
// not there, and its name pulls from the registry, which has none
test('it fails the pull of a FROM image that only the host’s Docker has', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}localfrom`;

  // the host engine's tags are shared: refuse one this test did not make
  const local = 'e2e-img-localbase:1';

  const existing = await runCommand(['docker', 'image', 'inspect', local]);

  expect(existing.exitCode, `${local} is already on the host's Docker`).not.toBe(0);

  const baseDir = await writeBuildContext(
    ctx.buildRoot,
    'local-base-image',
    'FROM busybox:1.37\nRUN echo local > /m\n',
  );

  const dir = await writeBuildContext(
    ctx.buildRoot,
    'local-base',
    `FROM ${local}\nRUN grep local /m\n`,
  );

  await runChecked(['docker', 'build', '--quiet', '--tag', local, baseDir]);

  ctx.stack.defer(async () => {
    await runCommand(['docker', 'rmi', local]);
  });

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'build', dir, '--name', name]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude(`FROM ${local}: the pull failed`),
  });
});

test('it refuses a FROM image from the host’s own registry under the proxy’s pull rules', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}hostreg`;

  const dir = await writeBuildContext(
    ctx.buildRoot,
    'missing-base',
    'FROM localhost:5000/e2e-missing:1\n',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'build', dir, '--name', name]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude("registry localhost:5000 is the host's own"),
  });
});

// #145: what the engine would fetch on its own is refused before the build,
// and a listener on the host's loopback, which the test owns, sees nothing;
// {url} and {port} stand for that listener's
test.each([
  ['a plain URL', 'ADD {url} /probe', 'ADD {url} is refused'],
  ['a URL in the JSON form', 'ADD ["{url}", "/probe"]', 'ADD {url} is refused'],
  [
    'a URL with a quoted scheme',
    'ADD h"ttp:"//127.0.0.1:{port}/probe /probe',
    'an ambiguous form: the ADD source',
  ],
  [
    'a git address',
    'ADD git@127.0.0.1:org/repo.git /src',
    'ADD git@127.0.0.1:org/repo.git is refused',
  ],
])('it refuses an ADD from %s, unseen by its listener', async (_label, line, refusal) => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}addurl`;
  const requests: string[] = [];

  const listener = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      requests.push(request.url);

      return new Response('probe');
    },
  });

  ctx.stack.defer(() => listener.stop(true));

  const port = String(listener.port);
  const url = `http://127.0.0.1:${port}/probe`;
  const step = line.replaceAll('{url}', url).replaceAll('{port}', port);

  const dir = await writeBuildContext(ctx.buildRoot, 'add-url', `FROM busybox:1.37\n${step}\n`);

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'build', dir, '--name', name]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude(refusal.replaceAll('{url}', url)),
  });

  expect(requests).toStrictEqual([]);
});

test('it refuses ONBUILD, also in a local stage a later FROM runs', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}onbuild`;

  const dir = await writeBuildContext(
    ctx.buildRoot,
    'onbuild',
    'FROM busybox:1.37 AS base\nONBUILD RUN echo trigger > /t\nFROM base\nRUN true\n',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'build', dir, '--name', name]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('ONBUILD is refused'),
  });
});

test('it fails a build in its builder whose FROM registry name resolves to a private address', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}privfrom`;

  const dir = await writeBuildContext(
    ctx.buildRoot,
    'private-registry',
    'FROM 10-0-0-1.nip.io:5000/e2e/x:1\n',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'build', dir, '--name', name]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toIncludeMultiple([
      'FROM 10-0-0-1.nip.io:5000/e2e/x:1: the pull failed',
      'no such host',
    ]),
  });
});

test('it fails an add in its builder whose registry name resolves to a private address', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}privadd`;

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'add', '10-0-0-1.nip.io:5000/e2e/x:1', '--name', name]);
  const names = await listImageNames();

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('the pull of 10-0-0-1.nip.io:5000/e2e/x:1 in the builder failed'),
  });

  expect(names).not.toContain(name);
});
