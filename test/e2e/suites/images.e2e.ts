import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_BUILD_PATH } from '../../../packages/api/src/image-build-protocol';
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
import {
  REPO_ROOT,
  instance,
  readImpdLogSince,
  readToken,
  runChecked,
  runCommand,
} from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

const prefix = setupSuite('images');
const hello = `${prefix}hello`;
const built = `${prefix}built`;
const caps = `${prefix}caps`;
const onHost = `${prefix}onhost`;
const rejected = `${prefix}rejected`;
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

  for (const image of [hello, built, caps, onHost]) {
    await tryImp(['image', 'rm', image]);
  }
});

test('an image built from images/examples/hello serves its page through the proxy', async () => {
  await tryImp(['image', 'rm', hello]);

  const started = Date.now();

  // unmodified: FROM the published base by digest, which impd pins as is
  const from = /^FROM (?<ref>\S+)$/mv.exec(readFileSync(join(HELLO_DIR, 'Dockerfile'), 'utf8'));
  const ref = from?.groups?.['ref'] ?? '';
  const digest = ref.slice(ref.indexOf('@'));

  const since = new Date();

  await runImp('image', 'build', HELLO_DIR, '--name', hello);

  const log = await readImpdLogSince(since);

  expect(digest).toStartWith('@sha256:');
  expect(log).toContain(`pinned FROM ${ref} as ghcr.io/zgeoff/imp-base${digest}`);

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

  // ./ and the default name: impd sends the proxy one spelling
  await runImp('image', 'build', dir, '--name', onHost, '--on-host', '--file', './Dockerfile');

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

  // the pinned stable frontend has no --security; the engine never sees the step
  expect(insecureResult.stderr).toContain('unknown flag: --security');

  const images = await listImageNames();

  expect(images).not.toContain(rejected);
});

// The classic store gives an image built here no RepoDigest. The containerd
// store gives it one under its own name: Docker 29.8 builds by it, and 29.7
// asks the registry and fails. No build uses the tag unbound.
test('a FROM image built on the host is refused, or built by its own digest', async () => {
  const local = 'e2e-img-localbase:1';
  const baseDir = writeContext('local-base-image', 'FROM busybox:1.37\nRUN echo local > /m\n');
  const dir = writeContext('local-base', `FROM ${local}\nRUN grep local /m\n`);

  await runChecked(['docker', 'build', '--quiet', '--tag', local, baseDir]);

  const drivers = await runChecked(['docker', 'info', '--format', '{{json .DriverStatus}}']);

  const isContainerdStore = drivers.includes('io.containerd.snapshotter');

  try {
    const result = await tryImp(['image', 'build', dir, '--name', onHost]);

    if (!isContainerdStore) {
      expect(result.exitCode).not.toBe(0);

      expect(result.stderr).toContain(
        `FROM ${local}: this image exists only on this host and has no registry digest, so impd cannot bind the build to it; build FROM a registry image by tag or digest. Local base images are not supported yet (#156).`,
      );
    } else if (result.exitCode === 0) {
      await runImp('image', 'rm', onHost);
    } else {
      expect(result.stderr).toContain('pull access denied');
    }
  } finally {
    await runCommand(['docker', 'rmi', local]);
  }
});

test('a FROM image the host lacks is pulled by impd, under the proxy’s pull rules', async () => {
  const dir = writeContext('missing-base', 'FROM localhost:5000/e2e-missing:1\n');

  const result = await tryImp(['image', 'build', dir, '--name', rejected]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("registry localhost:5000 is the host's own");
});

// #145: what the engine would fetch on its own is refused before the build,
// and a listener on the host's loopback, which the test owns, sees nothing
test('an ADD from a URL is refused, in every spelling, and its listener sees no request', async () => {
  const requests: string[] = [];

  using listener = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      requests.push(request.url);

      return new Response('probe');
    },
  });

  const url = `http://127.0.0.1:${String(listener.port)}/probe`;

  const spellings = [
    `ADD ${url} /probe`,
    `ADD ["${url}", "/probe"]`,
    `ADD h"ttp:"//127.0.0.1:${String(listener.port)}/probe /probe`,
    `ADD git@127.0.0.1:org/repo.git /src`,
  ];

  const stderrs: string[] = [];

  for (const [index, line] of spellings.entries()) {
    const dir = writeContext(`add-url-${String(index)}`, `FROM busybox:1.37\n${line}\n`);

    const result = await tryImp(['image', 'build', dir, '--name', rejected]);

    expect(result.exitCode).not.toBe(0);

    stderrs.push(result.stderr);
  }

  expect(stderrs[0]).toContain(`ADD ${url} is refused`);
  expect(stderrs[1]).toContain(`ADD ${url} is refused`);
  expect(stderrs[2]).toContain('an ambiguous form: the ADD source');
  expect(stderrs[3]).toContain('ADD git@127.0.0.1:org/repo.git is refused');
  expect(requests).toEqual([]);
});

test('ONBUILD is refused, also in a local stage a later FROM runs', async () => {
  const dir = writeContext(
    'onbuild',
    'FROM busybox:1.37 AS base\nONBUILD RUN echo trigger > /t\nFROM base\nRUN true\n',
  );

  const result = await tryImp(['image', 'build', dir, '--name', rejected]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('ONBUILD is refused');
});

test('a local ADD of a tar still extracts, COPY --from a stage and an image by digest still build', async () => {
  await runChecked(['docker', 'pull', '--quiet', 'busybox:1.37']);

  const inspected = await runChecked([
    'docker',
    'image',
    'inspect',
    '--format',
    '{{index .RepoDigests 0}}',
    'busybox:1.37',
  ]);

  const repoDigest = inspected.trim();

  const dir = writeContext(
    'local-add',
    [
      'FROM busybox:1.37 AS build',
      'RUN echo staged > /staged',
      'FROM busybox:1.37',
      'ADD files.tar /extracted/',
      'COPY --from=build /staged /staged',
      `COPY --from=${repoDigest} /bin/busybox /copied-busybox`,
      'RUN --mount=type=bind,from=busybox:1.37,target=/m test -x /m/bin/busybox',
    ].join('\n'),
  );

  writeFileSync(join(dir, 'inner.txt'), 'inside the tar\n');

  await runChecked(['tar', '-C', dir, '-cf', join(dir, 'files.tar'), 'inner.txt']);

  try {
    await runImp('image', 'build', dir, '--name', onHost);

    const seen = await runChecked([
      'docker',
      'run',
      '--rm',
      `imp/${onHost}:latest`,
      'sh',
      '-c',
      'cat /extracted/inner.txt /staged; test -x /copied-busybox && echo copied',
    ]);

    expect(seen.trim().split('\n')).toEqual(['inside the tar', 'staged', 'copied']);
  } finally {
    await tryImp(['image', 'rm', onHost]);
  }
});

// a raw upload, as an SDK sends it: the CLI packs only the Dockerfile it
// was told to, so the frontend's fallbacks need a tar of our own
async function sendRawBuild(
  dir: string,
  files: readonly string[],
  name: string,
): Promise<Response> {
  const tar = await runChecked([
    'sh',
    '-c',
    `tar -C '${dir}' -cf - ${files.join(' ')} | base64 -w0`,
  ]);

  const token = await readToken();

  return fetch(`${instance.apiUrl}${IMAGE_BUILD_PATH}?name=${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-tar' },
    body: Buffer.from(tar.trim(), 'base64'),
  });
}

test('a context with only a lowercase dockerfile builds it, as the frontend falls back to it', async () => {
  const dir = join(buildDir, 'lowercase');

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'dockerfile'), 'FROM busybox:1.37\nRUN echo lower > /which\n');

  try {
    const response = await sendRawBuild(dir, ['dockerfile'], onHost);

    expect(response.status).toBe(200);

    const which = await runChecked([
      'docker',
      'run',
      '--rm',
      `imp/${onHost}:latest`,
      'cat',
      '/which',
    ]);

    expect(which.trim()).toBe('lower');
  } finally {
    await tryImp(['image', 'rm', onHost]);
  }
});

// the engine reads neither ignore file from a context sent as the body: what
// impd checks is every file the tar holds (the CLI applies them as it packs)
test('the engine applies no ignore file to an uploaded context, Dockerfile.dockerignore included', async () => {
  const dir = writeContext('ignore-names', 'FROM busybox:1.37\nCOPY . /ctx/\n');

  writeFileSync(join(dir, 'Dockerfile.dockerignore'), 'by-dockerfile.txt\n');
  writeFileSync(join(dir, '.dockerignore'), 'by-default.txt\n');
  writeFileSync(join(dir, 'by-dockerfile.txt'), 'x');
  writeFileSync(join(dir, 'by-default.txt'), 'y');

  try {
    const files = [
      'Dockerfile',
      'Dockerfile.dockerignore',
      '.dockerignore',
      'by-dockerfile.txt',
      'by-default.txt',
    ];

    const response = await sendRawBuild(dir, files, onHost);

    expect(response.status).toBe(200);

    const listed = await runChecked([
      'docker',
      'run',
      '--rm',
      `imp/${onHost}:latest`,
      'ls',
      '-A',
      '/ctx',
    ]);

    expect(listed.trim().split('\n')).toEqual([
      '.dockerignore',
      'Dockerfile',
      'Dockerfile.dockerignore',
      'by-default.txt',
      'by-dockerfile.txt',
    ]);
  } finally {
    await tryImp(['image', 'rm', onHost]);
  }
});
