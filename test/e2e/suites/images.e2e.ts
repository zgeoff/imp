import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../lib/config';
import { runConsole } from '../lib/console';
import { getThroughProxy } from '../lib/http';
import { listImageNames, requireImp, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { createImp, removeImps } from '../lib/imps';
import { REPO_ROOT } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

const prefix = setupSuite('images');
const hello = `${prefix}hello`;
const built = `${prefix}built`;
const HELLO_DIR = join(REPO_ROOT, 'images', 'examples', 'hello');

// under the repo: scripts/dev.sh mounts it at the same path in the container,
// so the path the CLI sends exists where impd runs docker build
const CACHE_DIR = join(REPO_ROOT, '.cache', 'e2e');

mkdirSync(CACHE_DIR, { recursive: true });

const buildDir = mkdtempSync(join(CACHE_DIR, 'build-'));

afterAll(async () => {
  rmSync(buildDir, { recursive: true, force: true });

  if (config.keep) {
    return;
  }

  for (const image of [hello, built]) {
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
  const urls = await runImp('url', hello);

  const page = readFileSync(join(HELLO_DIR, 'rootfs', 'srv', 'hello', 'index.html'), 'utf8');

  expect(urls.split('\n')[0]).toBe(row.url);

  await waitFor(`${hello} to serve its page`, async () => {
    const body = await getThroughProxy(hello);

    expect(body).toBe(page.trim());
  });

  await removeImps(hello);
});

test("an image's files, ENV and WORKDIR reach the imp, and console works without bash", async () => {
  writeFileSync(
    join(buildDir, 'Dockerfile'),
    'FROM alpine:3.20\nRUN echo built > /etc/e2e-marker\nENV E2E=yes\nWORKDIR /srv\n',
  );

  await runImp('image', 'build', buildDir, '--name', built);

  const images = await listImageNames();

  expect(images).toContain(built);

  await createImp(built, '--image', built, '--memory', '512');

  const seen = await runShellInImp(built, 'cat /etc/e2e-marker; echo "$E2E"; pwd');
  const session = await runConsole(built, [{ afterMs: 1000, line: 'exit 4' }]);

  expect(seen).toBe('built\nyes\n/srv');
  expect(session.exitCode).toBe(4);
});

test('an image in use cannot be removed; once unused it can', async () => {
  const refused = await tryImp(['image', 'rm', built]);
  const kept = await listImageNames();

  expect(refused.exitCode).not.toBe(0);
  expect(kept).toContain(built);

  await removeImps(built);
  await runImp('image', 'rm', built);

  const after = await listImageNames();

  expect(after).not.toContain(built);
});
