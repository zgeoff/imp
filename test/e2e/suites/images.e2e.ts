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
  runInImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { createImp, removeImps } from '../lib/imps';
import { REPO_ROOT } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

const prefix = setupSuite('images');
const hello = `${prefix}hello`;
const built = `${prefix}built`;
const caps = `${prefix}caps`;
const HELLO_DIR = join(REPO_ROOT, 'images', 'examples', 'hello');

// under the repo: scripts/dev.sh mounts it at the same path in the container,
// so `--on-host` finds the directory where impd runs docker build
const CACHE_DIR = join(REPO_ROOT, '.cache', 'e2e');

mkdirSync(CACHE_DIR, { recursive: true });

const buildDir = mkdtempSync(join(CACHE_DIR, 'build-'));
const capsDir = mkdtempSync(join(CACHE_DIR, 'caps-'));

afterAll(async () => {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(capsDir, { recursive: true, force: true });

  if (config.keep) {
    return;
  }

  for (const image of [hello, built, caps]) {
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

test('a file capability survives the build: nobody binds port 80 with it, and not without', async () => {
  // a copy named busybox-* still takes the applet as its first argument
  writeFileSync(
    join(capsDir, 'Dockerfile'),
    'FROM alpine:3.20\nRUN apk add --no-cache libcap && cp /bin/busybox /usr/local/bin/busybox-lowbind && setcap cap_net_bind_service+ep /usr/local/bin/busybox-lowbind\n',
  );

  await runImp('image', 'build', capsDir, '--name', caps);
  await createImp(caps, '--image', caps, '--memory', '512');

  try {
    const getcap = await runInImp(caps, 'getcap', '/usr/local/bin/busybox-lowbind');

    // nc listens until timeout's TERM, 143 in busybox; a refused bind exits 1
    const tryBind = (binary: string) =>
      runShellInImp(
        caps,
        `su -s /bin/sh nobody -c 'timeout 1 ${binary} nc -l -p 80' 2>&1; echo "exit=$?"`,
      );

    const withCap = await tryBind('busybox-lowbind');
    const without = await tryBind('busybox');

    expect(getcap).toBe('/usr/local/bin/busybox-lowbind cap_net_bind_service=ep');
    expect(withCap).not.toContain('Permission denied');
    expect(withCap).toContain('exit=143');
    expect(without).toContain('nc: bind: Permission denied');
  } finally {
    await removeImps(caps);
  }
});
