import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImage } from '@impz/daemon/src/db/images';
import { buildImagePaths, buildImpPaths } from '@impz/daemon/src/storage/data-layout';
import { buildMockNewImage } from '@impz/daemon/src/test-utils/build-mock-new-image';
import { startStubInnerAgent } from '@impz/daemon/src/test-utils/start-stub-inner-agent';
import { writeHostConfig } from '../host-store';
import { parseJsonOutput } from '../test-utils/parse-json-output';
import { runCli } from '../test-utils/start-cli';
import { startImpdHost } from '../test-utils/start-impd-host';

// The CLI's home, where config.json keeps the saved hosts, so none of this
// machine's reaches it; the impd host a test starts releases into `stack`
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-info-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { home: { HOME: dir, XDG_CONFIG_HOME: dir }, stack };
}

test('it shows an awake imp’s inner container as down, with its restarts and last error', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  const imp = await box.client.imps.create({ name: 'web' });

  // its agent answers, with the container down after three restarts
  await startStubInnerAgent(buildImpPaths(box.dataDir, imp.id).vsockSocket, {
    inner: { up: false, restarts: 3, lastError: 'start inner init: exit status 1' },
    stack: ctx.stack,
  });

  await box.runIdleCheck();

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const shown = await runCli({ args: ['info', 'web'], env: ctx.home });

  expect(shown.code).toBe(0);

  expect(shown.stdout.split('\n')).toIncludeAllMembers([
    'name        web',
    'state       running',
    'container   down',
    'restarts    3',
    'last error  start inner init: exit status 1',
  ]);
});

test('it shows an imp’s inner container as unknown before its agent answered', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'web' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const shown = await runCli({ args: ['info', 'web'], env: ctx.home });

  expect(shown.stdout.split('\n')).toContain('container   unknown');
  expect(shown.stdout).not.toInclude('restarts');
});

test('it shows impd itself without a name', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const shown = await runCli({ args: ['info'], env: ctx.home });

  expect(shown.stdout).toStartWith('version     ');
});

test('it prints impd’s --json output in the shape of the committed schema', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const shown = await runCli({ args: ['info', '--json'], env: ctx.home });

  expect(shown.code).toBe(0);
  expect(parseJsonOutput('info', shown.stdout).data).toStrictEqual(JSON.parse(shown.stdout));
});

test('it prints an imp’s --json output in the shape of the committed schema', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'web' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const shown = await runCli({ args: ['info', 'web', '--json'], env: ctx.home });

  expect(shown.code).toBe(0);
  expect(parseJsonOutput('info <name>', shown.stdout).data).toStrictEqual(JSON.parse(shown.stdout));
});
