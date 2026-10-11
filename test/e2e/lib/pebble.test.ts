import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@imp/test-utils/update-env';
import { createStubBin } from '../../../scripts/test-utils/create-stub-bin';
import { buildPebbleEnv, parsePublishedPort, startPebbleStack } from './pebble';

// the caller's stack goes before the temp dir that holds the stub docker
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'pebble-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { stack, dir };
}

test('#startPebbleStack refuses a Pebble container name that is taken, before it makes anything', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    ['case "$*" in', '  *-pebble) exit 0 ;;', 'esac', 'exit 1'].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  expect(startPebbleStack(ctx.stack, 'imp-acme-it-x')).rejects.toThrowWithMessage(
    Error,
    'a container named imp-acme-it-x-pebble is already there',
  );

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls.split('\n')).toStrictEqual([
    'docker container inspect imp-acme-it-x-pebble',
    'docker container inspect imp-acme-it-x-challtestsrv',
    'docker network inspect imp-acme-it-x-acme',
    '',
  ]);
});

test('#startPebbleStack refuses a challtestsrv container name that is taken, before it makes anything', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    ['case "$*" in', '  *-challtestsrv) exit 0 ;;', 'esac', 'exit 1'].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  expect(startPebbleStack(ctx.stack, 'imp-acme-it-x')).rejects.toThrowWithMessage(
    Error,
    'a container named imp-acme-it-x-challtestsrv is already there',
  );

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls.split('\n')).toStrictEqual([
    'docker container inspect imp-acme-it-x-pebble',
    'docker container inspect imp-acme-it-x-challtestsrv',
    'docker network inspect imp-acme-it-x-acme',
    '',
  ]);
});

test('#startPebbleStack refuses a network name that is taken, before it makes anything', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    ['case "$*" in', '  "network inspect "*) exit 0 ;;', 'esac', 'exit 1'].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  expect(startPebbleStack(ctx.stack, 'imp-acme-it-x')).rejects.toThrowWithMessage(
    Error,
    'a network named imp-acme-it-x-acme is already there',
  );

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls.split('\n')).toStrictEqual([
    'docker container inspect imp-acme-it-x-pebble',
    'docker container inspect imp-acme-it-x-challtestsrv',
    'docker network inspect imp-acme-it-x-acme',
    '',
  ]);
});

test('#startPebbleStack removes only what it made when the Pebble container is not created', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    [
      'case "$*" in',
      '  *inspect*) exit 1 ;;',
      '  *"--name imp-acme-it-x-pebble "*) exit 1 ;;',
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  expect(startPebbleStack(ctx.stack, 'imp-acme-it-x')).rejects.toThrow();

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls.split('\n').filter((line) => line.includes(' rm '))).toStrictEqual([
    'docker rm --force imp-acme-it-x-challtestsrv',
    'docker network rm imp-acme-it-x-acme',
  ]);
});

test('#startPebbleStack removes the Pebble container it created when that container does not start', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    [
      'case "$*" in',
      '  *inspect*) exit 1 ;;',
      '  "start imp-acme-it-x-pebble") exit 1 ;;',
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  expect(startPebbleStack(ctx.stack, 'imp-acme-it-x')).rejects.toThrowWithMessage(
    Error,
    'docker start imp-acme-it-x-pebble exited 1: ',
  );

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls.split('\n').filter((line) => line.includes(' rm '))).toStrictEqual([
    'docker rm --force imp-acme-it-x-pebble',
    'docker rm --force imp-acme-it-x-challtestsrv',
    'docker network rm imp-acme-it-x-acme',
  ]);
});

test('#startPebbleStack copies the minica PEM into the directory the caller names', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    ['case "$*" in', '  *inspect*|"cp "*) exit 1 ;;', 'esac'].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  expect(
    startPebbleStack(ctx.stack, 'imp-acme-it-x', { minicaDir: join(ctx.dir, 'ca') }),
  ).rejects.toThrow();

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls.split('\n')).toContain(
    `docker cp imp-acme-it-x-pebble:/test/certs/pebble.minica.pem ${join(ctx.dir, 'ca', 'imp-acme-it-x-pebble-minica.pem')}`,
  );
});

test('#parsePublishedPort reads the host port of a loopback binding', () => {
  expect(parsePublishedPort('acme-pebble', 14_000, '127.0.0.1:49153\n')).toBe('49153');
});

test('#parsePublishedPort reads the first binding’s port when there are several', () => {
  expect(parsePublishedPort('acme-pebble', 14_000, '0.0.0.0:49153\n[::]:49154\n')).toBe('49153');
});

test('#parsePublishedPort refuses output that names no port, with the container and port', () => {
  expect(() => parsePublishedPort('acme-pebble', 14_000, '\n')).toThrowWithMessage(
    Error,
    'acme-pebble publishes no port for 14000: ',
  );
});

test('#buildPebbleEnv points the instance at the stack named after its container', () => {
  const repoRoot = join(import.meta.dir, '..', '..', '..');

  expect(buildPebbleEnv('imp-wt')).toStrictEqual({
    IMP_DEV_NETWORK: 'imp-wt-acme',
    IMP_E2E: '1',
    IMP_DOMAIN: 'imp.test',
    IMP_DNS_PROVIDER: 'challtestsrv',
    IMP_DNS_API_URL: 'http://challtestsrv:8055',
    IMP_ACME_DIRECTORY: 'https://pebble:14000/dir',
    IMP_ACME_CA_FILE: join(repoRoot, '.cache', 'e2e', 'imp-wt-pebble-minica.pem'),
    IMP_PUBLIC_IP: '203.0.113.7',
  });
});
