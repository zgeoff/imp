import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../lib/config';
import { runConsole } from '../lib/console';
import { getThroughProxy } from '../lib/http';
import {
  listImageNames,
  readImpUrls,
  requireImp,
  runImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { createImp, removeImps } from '../lib/imps';
import { REPO_ROOT, runChecked } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

const prefix = setupSuite('images');
const hello = `${prefix}hello`;
const built = `${prefix}built`;
const onHost = `${prefix}onhost`;
const rejected = `${prefix}rejected`;
const HELLO_DIR = join(REPO_ROOT, 'images', 'examples', 'hello');

// under the repo: scripts/dev.sh mounts it at the same path in the container,
// so `--on-host` finds the directory where impd runs docker build
const CACHE_DIR = join(REPO_ROOT, '.cache', 'e2e');

mkdirSync(CACHE_DIR, { recursive: true });

const buildDir = mkdtempSync(join(CACHE_DIR, 'build-'));

afterAll(async () => {
  rmSync(buildDir, { recursive: true, force: true });

  if (config.keep) {
    return;
  }

  for (const image of [hello, built, onHost]) {
    await tryImp(['image', 'rm', image]);
  }
});

test('an image built from images/examples/hello serves its page through the proxy', async () => {
  await tryImp(['image', 'rm', hello]);

  const started = Date.now();

  await runImp('image', 'build', HELLO_DIR, '--name', hello);

  console.log(`    imp image build images/examples/hello: ${String(Date.now() - started)} ms`);

  const images = await listImageNames();

  expect(images).toContain(hello);

  await createImp(hello, '--image', hello, '--memory', '1024');

  const row = await requireImp(hello);
  const urls = await readImpUrls(hello);

  const page = readFileSync(join(HELLO_DIR, 'rootfs', 'srv', 'hello', 'index.html'), 'utf8');

  expect(urls.local).toBe(row.url);

  await waitFor(`${hello} to serve its page`, async () => {
    const body = await getThroughProxy(hello);

    expect(body).toBe(page.trim());
  });

  await removeImps(hello);
});

test("an uploaded context's files, ENV and WORKDIR reach the imp, less what .dockerignore drops", async () => {
  writeFileSync(
    join(buildDir, 'Dockerfile'),
    'FROM alpine:3.20\nRUN echo built > /etc/e2e-marker\nENV E2E=yes\nWORKDIR /srv\nCOPY . /srv/ctx/\n',
  );

  writeFileSync(join(buildDir, '.dockerignore'), '*.secret\n');
  writeFileSync(join(buildDir, 'kept.txt'), 'kept');
  writeFileSync(join(buildDir, 'dropped.secret'), 'dropped');

  await runImp('image', 'build', buildDir, '--name', built);

  const images = await listImageNames();

  expect(images).toContain(built);

  await createImp(built, '--image', built, '--memory', '512');

  const seen = await runShellInImp(built, 'cat /etc/e2e-marker; echo "$E2E"; pwd; ls ctx');
  const session = await runConsole(built, [{ afterMs: 1000, line: 'exit 4' }]);

  expect(seen).toBe('built\nyes\n/srv\nDockerfile\nkept.txt');
  expect(session.exitCode).toBe(4);
});

test('an image in use cannot be removed; once unused it can', async () => {
  const refused = await tryImp(['image', 'rm', built]);
  const kept = await listImageNames();

  expect(refused.exitCode).not.toBe(0);
  expect(kept).toContain(built);

  // the same Dockerfile from the host's path: the same image, kept as it is
  await runImp('image', 'build', buildDir, '--name', built, '--on-host');
  await removeImps(built);
  await runImp('image', 'rm', built);

  const after = await listImageNames();

  expect(after).not.toContain(built);
});

// a context directory under buildDir with this Dockerfile
function writeContext(name: string, dockerfile: string): string {
  const dir = join(buildDir, name);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Dockerfile'), dockerfile);

  return dir;
}

test('a build from a host path leaves out what .dockerignore drops, as an upload does', async () => {
  const dir = writeContext('on-host', 'FROM busybox:1.37\nCOPY . /ctx/\n');

  writeFileSync(join(dir, '.dockerignore'), '*.secret\n');
  writeFileSync(join(dir, 'kept.txt'), 'kept');
  writeFileSync(join(dir, 'dropped.secret'), 'dropped');

  await runImp('image', 'build', dir, '--name', onHost, '--on-host');

  const listed = await runChecked(['docker', 'run', '--rm', `imp/${onHost}:latest`, 'ls', '/ctx']);

  expect(listed.trim().split('\n')).toEqual(['Dockerfile', 'kept.txt']);

  await runImp('image', 'rm', onHost);
});

test('a # syntax= line cannot pick the frontend: the pinned one builds it', async () => {
  const dir = writeContext(
    'syntax',
    '# syntax=example.invalid/not-a-frontend:1\nFROM busybox:1.37\nRUN --mount=type=cache,target=/c true\n',
  );

  await runImp('image', 'build', dir, '--name', onHost);
  await runImp('image', 'rm', onHost);
});

test('a RUN step cannot ask for the host network or insecure mode', async () => {
  const hostNet = writeContext('host-net', 'FROM busybox:1.37\nRUN --network=host true\n');
  const insecure = writeContext('insecure', 'FROM busybox:1.37\nRUN --security=insecure true\n');

  const netResult = await tryImp(['image', 'build', hostNet, '--name', rejected]);
  const insecureResult = await tryImp(['image', 'build', insecure, '--name', rejected]);

  expect(netResult.exitCode).not.toBe(0);
  expect(netResult.stderr).toContain('network.host is not allowed');
  expect(insecureResult.exitCode).not.toBe(0);

  // docker/dockerfile:1.19 keeps --security in its labs channel; later ones parse it, and the
  // engine refuses the entitlement
  expect(insecureResult.stderr).toMatch(
    /security\.insecure is not allowed|unknown flag: --security/v,
  );

  const images = await listImageNames();

  expect(images).not.toContain(rejected);
});
