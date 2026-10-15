import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sendRawBuild, writeBuildContext } from '../lib/build-context';
import { config } from '../lib/config';
import { runConsole } from '../lib/console';
import { getThroughProxy } from '../lib/http';
import {
  createInstanceClient,
  listImageNames,
  readImpUrls,
  requireImp,
  runImp,
  runInImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { REPO_ROOT, instance, readImpdLogSince, readToken, runChecked } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImageIfPresent, removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// `imp image build` (docs/guides/images.md): what a build keeps of its
// context and Dockerfile, through the CLI, from a host path and as a raw
// upload. Each test builds its own images in a context dir of its own.

// one stack for every release, so each imp goes before the image it boots
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  // under the repo: scripts/dev/dev.sh mounts it at the same path in the
  // container, so `--on-host` finds the directory where impd runs docker build
  await mkdir(join(REPO_ROOT, '.cache', 'e2e'), { recursive: true });

  const buildRoot = await mkdtemp(join(REPO_ROOT, '.cache', 'e2e', 'build-'));

  stack.defer(() => rm(buildRoot, { recursive: true, force: true }));

  return { prefix: readSuitePrefix('images'), stack, client, buildRoot };
}

test('it builds images/examples/hello from its pinned base in a builder, and the imp serves its page through the proxy', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}hello`;
  const helloDir = join(REPO_ROOT, 'images', 'examples', 'hello');

  // unmodified: FROM the published base by digest, which impd pins as is
  const dockerfile = await readFile(join(helloDir, 'Dockerfile'), 'utf8');

  const ref = /^FROM (?<ref>\S+)$/mv.exec(dockerfile)?.groups?.['ref'] ?? '';
  const digest = ref.slice(ref.indexOf('@'));
  const started = Date.now();

  const since = new Date();

  await runImp('image', 'build', helloDir, '--name', name);

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));
  writeMetric('imageBuildHelloMs', Date.now() - started);

  const log = await readImpdLogSince(since);
  const images = await listImageNames();

  expect(digest).toStartWith('@sha256:');
  expect(log).toContain(`pinned FROM ${ref} as ghcr.io/zgeoff/imp-base${digest}`);

  // in a builder, which pulls the frontend and the base cold
  expect(log).toContain(`impd: image build ${name} (imp): pins=`);
  expect(images).toContain(name);

  await runImp('new', name, '--image', name, '--memory', '1024');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const row = await requireImp(name);
  const urls = await readImpUrls(name);
  const page = await readFile(join(helloDir, 'rootfs', 'srv', 'hello', 'index.html'), 'utf8');

  // until its own page comes through, not just any answer
  const body = await waitFor(`${name} to serve its page`, async () => {
    const served = await getThroughProxy(name);

    if (served !== page.trim()) {
      throw new Error(`not its page yet: ${served.slice(0, 80)}`);
    }

    return served;
  });

  expect(urls.local).toBe(row.url);
  expect(body).toBe(page.trim());
});

test('it brings an uploaded context’s files, ENV and WORKDIR into the imp less what .dockerignore drops, and removes the image only once no imp boots it', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}built`;

  const dir = await writeBuildContext(
    ctx.buildRoot,
    'upload',
    'FROM alpine:3.20\nRUN echo built > /etc/e2e-marker\nENV E2E=yes\nWORKDIR /srv\nCOPY . /srv/ctx/\n',
  );

  await writeFile(join(dir, '.dockerignore'), '*.secret\n');
  await writeFile(join(dir, 'kept.txt'), 'kept');
  await writeFile(join(dir, 'dropped.secret'), 'dropped');
  await runImp('image', 'build', dir, '--name', name);

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const images = await listImageNames();

  expect(images).toContain(name);

  await runImp('new', name, '--image', name, '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const seen = await runShellInImp(name, 'cat /etc/e2e-marker; echo "$E2E"; pwd; ls ctx');

  const session = await runConsole(name, [
    { after: null, line: 'echo console-$((2 + 2))' },
    { after: 'console-4', line: 'exit 4' },
  ]);

  expect(seen).toBe('built\nyes\n/srv\nDockerfile\nkept.txt');
  expect(session.exitCode).toBe(4);

  const refused = await tryImp(['image', 'rm', name]);
  const kept = await listImageNames();

  expect(refused).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `imp: CONFLICT: image ${name} is used by 1 imp(s)\n`,
  });

  expect(kept).toContain(name);

  // the same Dockerfile from the host's path: the same image, kept as it is
  await runImp('image', 'build', dir, '--name', name, '--on-host');
  await runImp('rm', name);
  await runImp('image', 'rm', name);

  const after = await listImageNames();

  expect(after).not.toContain(name);
});

test('it keeps a file capability through the build: nobody binds port 80 with it, and not without', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}caps`;

  // a copy named busybox-* still takes the applet as its first argument
  const dir = await writeBuildContext(
    ctx.buildRoot,
    'caps',
    'FROM alpine:3.20\nRUN apk add --no-cache libcap && cp /bin/busybox /usr/local/bin/busybox-lowbind && setcap cap_net_bind_service+ep /usr/local/bin/busybox-lowbind\n',
  );

  await runImp('image', 'build', dir, '--name', name);

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  await runImp('new', name, '--image', name, '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const getcap = await runInImp(name, 'getcap', '/usr/local/bin/busybox-lowbind');

  // nc listens until timeout's TERM, 143 in busybox; a refused bind exits 1
  const withCap = await runShellInImp(
    name,
    `su -s /bin/sh nobody -c 'timeout 1 busybox-lowbind nc -l -p 80' 2>&1; echo "exit=$?"`,
  );

  const without = await runShellInImp(
    name,
    `su -s /bin/sh nobody -c 'timeout 1 busybox nc -l -p 80' 2>&1; echo "exit=$?"`,
  );

  expect(getcap).toBe('/usr/local/bin/busybox-lowbind cap_net_bind_service=ep');
  expect(withCap).not.toContain('Permission denied');
  expect(withCap).toContain('exit=143');
  expect(without).toContain('nc: bind: Permission denied');
});

test('it leaves out what .dockerignore drops from a build from a host path, as an upload does', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}onhost`;

  const dir = await writeBuildContext(
    ctx.buildRoot,
    'on-host',
    'FROM busybox:1.37\nCOPY . /ctx/\n',
  );

  await writeFile(join(dir, '.dockerignore'), '*.secret\n');
  await writeFile(join(dir, 'kept.txt'), 'kept');
  await writeFile(join(dir, 'dropped.secret'), 'dropped');

  // ./ and the default name: impd sends the proxy one spelling
  await runImp('image', 'build', dir, '--name', name, '--on-host', '--file', './Dockerfile');

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  await runImp('new', name, '--image', name, '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const listed = await runInImp(name, 'ls', '/ctx');

  expect(listed.trim().split('\n')).toStrictEqual(['Dockerfile', 'kept.txt']);
});

test('it builds with the pinned frontend whatever a # syntax= line names', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}syntax`;

  const dir = await writeBuildContext(
    ctx.buildRoot,
    'syntax',
    '# syntax=example.invalid/not-a-frontend:1\nFROM busybox:1.37\nRUN --mount=type=cache,target=/c true\n',
  );

  // a frontend from the line would fail to resolve example.invalid
  const built = await tryImp(['image', 'build', dir, '--name', name]);

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const images = await listImageNames();

  expect(built).toStrictEqual({
    exitCode: 0,
    stdout: expect.toBeString(),
    stderr: expect.toSatisfy((stderr: string) => !stderr.includes('example.invalid')),
  });

  expect(images).toContain(name);
});

test('it still extracts a local ADD of a tar, and builds COPY --from a stage and from an image by digest', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}localadd`;

  await runChecked(['docker', 'pull', '--quiet', 'busybox:1.37']);

  const inspected = await runChecked([
    'docker',
    'image',
    'inspect',
    '--format',
    '{{index .RepoDigests 0}}',
    'busybox:1.37',
  ]);

  const dir = await writeBuildContext(
    ctx.buildRoot,
    'local-add',
    [
      'FROM busybox:1.37 AS build',
      'RUN echo staged > /staged',
      'FROM busybox:1.37',
      'ADD files.tar /extracted/',
      'COPY --from=build /staged /staged',
      `COPY --from=${inspected.trim()} /bin/busybox /copied-busybox`,
      'RUN --mount=type=bind,from=busybox:1.37,target=/m test -x /m/bin/busybox',
    ].join('\n'),
  );

  await writeFile(join(dir, 'inner.txt'), 'inside the tar\n');
  await runChecked(['tar', '-C', dir, '-cf', join(dir, 'files.tar'), 'inner.txt']);
  await runImp('image', 'build', dir, '--name', name);

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  await runImp('new', name, '--image', name, '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const seen = await runShellInImp(
    name,
    'cat /extracted/inner.txt /staged; test -x /copied-busybox && echo copied',
  );

  expect(seen.trim().split('\n')).toStrictEqual(['inside the tar', 'staged', 'copied']);
});

test('it builds a raw upload whose only Dockerfile is a lowercase dockerfile, as the frontend falls back to it', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}lower`;
  const dir = join(ctx.buildRoot, 'lowercase');

  await mkdir(dir);
  await writeFile(join(dir, 'dockerfile'), 'FROM busybox:1.37\nRUN echo lower > /which\n');

  const token = await readToken();

  const response = await sendRawBuild({
    apiUrl: instance.apiUrl,
    token,
    dir,
    files: ['dockerfile'],
    name,
  });

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  expect(response.status).toBe(200);

  await runImp('new', name, '--image', name, '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const which = await runInImp(name, 'cat', '/which');

  expect(which.trim()).toBe('lower');
});

// the engine reads neither ignore file from a context sent as the body: what
// impd checks is every file the tar holds (the CLI applies them as it packs)
test('it applies no ignore file to a raw upload, Dockerfile.dockerignore included', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}ignores`;

  const dir = await writeBuildContext(
    ctx.buildRoot,
    'ignore-names',
    'FROM busybox:1.37\nCOPY . /ctx/\n',
  );

  await writeFile(join(dir, 'Dockerfile.dockerignore'), 'by-dockerfile.txt\n');
  await writeFile(join(dir, '.dockerignore'), 'by-default.txt\n');
  await writeFile(join(dir, 'by-dockerfile.txt'), 'x');
  await writeFile(join(dir, 'by-default.txt'), 'y');

  const token = await readToken();

  const response = await sendRawBuild({
    apiUrl: instance.apiUrl,
    token,
    dir,
    files: [
      'Dockerfile',
      'Dockerfile.dockerignore',
      '.dockerignore',
      'by-dockerfile.txt',
      'by-default.txt',
    ],
    name,
  });

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  expect(response.status).toBe(200);

  await runImp('new', name, '--image', name, '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const listed = await runInImp(name, 'ls', '-A', '/ctx');

  expect(listed.trim().split('\n')).toStrictEqual([
    '.dockerignore',
    'Dockerfile',
    'Dockerfile.dockerignore',
    'by-default.txt',
    'by-dockerfile.txt',
  ]);
});
