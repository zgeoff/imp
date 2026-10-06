import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
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
  readContainerGateway,
  readImpdLogSince,
  readToken,
  runChecked,
  runCommand,
  runInContainer,
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

  // in a builder, which pulls the frontend and the base cold
  expect(log).toContain(`impd: image build ${hello} (imp): pins=`);

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

// what argv prints in an imp of the image: an isolated build tags nothing
// on the host's Docker
async function runInImage(image: string, ...argv: readonly string[]): Promise<string> {
  const name = `${prefix}look`;

  await createImp(name, '--image', image, '--memory', '512');

  try {
    return await runInImp(name, ...argv);
  } finally {
    await removeImps(name);
  }
}

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

  const listed = await runInImage(onHost, 'ls', '/ctx');

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

// A builder has only what it pulls: an image built on the host's Docker is
// not there, and its name pulls from the registry, which has none
test('a FROM image built on the host is not in the builder, so its pull fails', async () => {
  const local = 'e2e-img-localbase:1';
  const baseDir = writeContext('local-base-image', 'FROM busybox:1.37\nRUN echo local > /m\n');
  const dir = writeContext('local-base', `FROM ${local}\nRUN grep local /m\n`);

  await runChecked(['docker', 'build', '--quiet', '--tag', local, baseDir]);

  try {
    const result = await tryImp(['image', 'build', dir, '--name', onHost]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`FROM ${local}: the pull failed`);
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

    const seen = await runInImage(
      onHost,
      'sh',
      '-c',
      'cat /extracted/inner.txt /staged; test -x /copied-busybox && echo copied',
    );

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

    const which = await runInImage(onHost, 'cat', '/which');

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

    const listed = await runInImage(onHost, 'ls', '-A', '/ctx');

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

// #156: a RUN step in the builder reaches the internet only. The listener is
// the test's, on every address of this machine, so the Docker host behind
// the bridge gateway; impd's API and the metadata address are the others.
test('an isolated build reaches the internet but not the host, impd or a private address', async () => {
  const requests: string[] = [];

  using listener = Bun.serve({
    hostname: '0.0.0.0',
    port: 0,
    fetch: (request) => {
      requests.push(request.url);

      return new Response('probe');
    },
  });

  const gateway = await readContainerGateway();

  const port = String(listener.port);
  const targets = [`${gateway}:${port}`, '10.66.0.1:7070', '169.254.169.254:80'];

  const dir = writeContext(
    'isolation',
    [
      'FROM busybox:1.37',
      `RUN for t in ${targets.join(' ')}; do \\`,
      '      if wget -T 3 -q -O /dev/null "http://$t/"; then echo "$t open"; else echo "$t closed"; fi; \\',
      '    done > /probe.txt; \\',
      '    if wget -T 15 -q -O /dev/null http://example.com/; then echo "public open"; else echo "public closed"; fi >> /probe.txt',
      '',
    ].join('\n'),
  );

  const name = `${prefix}iso`;

  await runImp('image', 'build', dir, '--name', name);

  try {
    await createImp(name, '--image', name);

    const probe = await runInImp(name, 'cat', '/probe.txt');

    expect(probe.split('\n')).toEqual([
      ...targets.map((target) => `${target} closed`),
      'public open',
    ]);

    expect(requests).toEqual([]);
  } finally {
    await removeImps(name);
    await tryImp(['image', 'rm', name]);
  }

  // every build's builder is gone with it
  const listedJson = await runImp('ls', '--builders', '--json');

  const listed: unknown = JSON.parse(listedJson);
  const kinds = z.array(z.object({ kind: z.string().optional() })).parse(listed);

  expect(kinds.filter((imp) => imp.kind === 'builder')).toEqual([]);
});

// The host container's own IPv6 addresses, every scope but loopback
async function readContainerAddresses6(): Promise<string[]> {
  const shown = await runInContainer(['ip', '-6', '-o', 'addr', 'show']);

  return [
    ...shown.stdout.matchAll(/ inet6 (?<address>[\da-f:]+)\/\d+ scope (?:global|link)/gv),
  ].map((match) => match.groups?.['address'] ?? '');
}

// #156 and #180: a RUN step has no IPv6 of its own; what IPv6 it reaches
// goes through the broker on the builder's gateway, its second hop after the
// engine's bridge, and the public policy holds the broker to the internet.
test("an isolated build's broker tunnel reaches the internet, but not the host, its taps or impd", async () => {
  const requests: string[] = [];

  using listener = Bun.serve({
    hostname: '0.0.0.0',
    port: 0,
    fetch: (request) => {
      requests.push(request.url);

      return new Response('probe');
    },
  });

  const gateway = await readContainerGateway();
  const own6 = await readContainerAddresses6();
  const route6 = await runInContainer(['ip', '-6', 'route', 'show', 'default']);

  const hasIpv6 = route6.stdout.trim() !== '';

  const refused = [
    `${gateway}:${String(listener.port)}`,
    '10.66.0.1:7070',
    'GW:7070',
    '127.0.0.1:7070',
    '[::1]:7070',
    '[fe80::1]:7070',
    '169.254.169.254:80',
    ...own6.map((address) => `[${address}]:7070`),
  ];

  const allowed = ['example.com:80', ...(hasIpv6 ? ['[2606:4700:4700::1111]:80'] : [])];

  const dir = writeContext(
    'broker',
    [
      'FROM busybox:1.37',
      "RUN gw=$(traceroute -n -m 2 -w 2 1.1.1.1 2>/dev/null | awk '$1 == 2 { print $2 }'); \\",
      '    awk \'$6 != "lo" { print "ipv6 " $6 }\' /proc/net/if_inet6 > /probe.txt; \\',
      '    if wget -T 3 -q -O /dev/null "http://$gw:7070/"; then echo "direct open"; else echo "direct closed"; fi >> /probe.txt; \\',
      `    for t in ${[...refused, ...allowed].join(' ')}; do \\`,
      '      d=$(echo "$t" | sed "s/^GW:/$gw:/"); \\',
      '      reply=$( (printf \'CONNECT %s HTTP/1.1\\r\\nHost: %s\\r\\n\\r\\n\' "$d" "$d"; sleep 3) | nc -w 5 "$gw" 7081 | head -1 | cut -d \' \' -f 2); \\',
      '      echo "$t $reply"; \\',
      '    done >> /probe.txt',
      '',
    ].join('\n'),
  );

  const name = `${prefix}broker`;

  await runImp('image', 'build', dir, '--name', name);

  try {
    await createImp(name, '--image', name);

    const probe = await runInImp(name, 'cat', '/probe.txt');

    if (!hasIpv6) {
      console.log(
        '    the host container has no IPv6 default route; the public IPv6 fetch is skipped',
      );
    }

    expect(probe.split('\n')).toEqual([
      'direct closed',
      ...refused.map((target) => `${target} 403`),
      ...allowed.map((target) => `${target} 200`),
    ]);

    expect(requests).toEqual([]);
  } finally {
    await removeImps(name);
    await tryImp(['image', 'rm', name]);
  }
});

test('a FROM whose registry name resolves to a private address fails in the builder', async () => {
  const dir = writeContext('private-registry', 'FROM 10-0-0-1.nip.io:5000/e2e/x:1\n');

  const result = await tryImp(['image', 'build', dir, '--name', rejected]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('FROM 10-0-0-1.nip.io:5000/e2e/x:1: the pull failed');
  expect(result.stderr).toContain('no such host');
});

// the host engine's busybox images, each with its digests and ID, sorted:
// other work on this engine may change other repositories meanwhile
async function listEngineBusybox(): Promise<readonly string[]> {
  const listed = await runChecked([
    'docker',
    'image',
    'ls',
    '--all',
    '--digests',
    '--no-trunc',
    '--format',
    '{{.Repository}}:{{.Tag}}@{{.Digest}} {{.ID}}',
    'busybox',
  ]);

  return listed.split('\n').toSorted();
}

// #169: an add pulls in a builder imp, so the host engine never has the image
test('an added image comes from a builder: the host engine gains no image, and the image boots', async () => {
  const name = `${prefix}added`;

  const before = await listEngineBusybox();

  await runImp('image', 'add', 'busybox:1.36.1', '--name', name);

  try {
    const after = await listEngineBusybox();
    const inspected = await runCommand(['docker', 'image', 'inspect', 'busybox:1.36.1']);

    expect(after).toEqual(before);
    expect(inspected.exitCode).not.toBe(0);

    // the audit row, written after the answer, names the bytes the pull took
    await waitFor('the add in the audit log', async () => {
      const auditJson = await runImp('audit', '--kind', 'api', '--json', '--limit', '20');

      const audit: unknown = JSON.parse(auditJson);
      const calls = z.array(z.object({ procedure: z.string(), detail: z.string().optional() }));

      const add = calls
        .parse(audit)
        .find((call) => call.procedure === 'images.add' || call.procedure === 'images.addStream');

      expect(add?.detail).toMatch(/^busybox@sha256:[a-f0-9]{64}$/v);
    });

    await createImp(name, '--image', name);

    const banner = await runInImp(name, 'busybox');

    expect(banner).toContain('BusyBox v1.36.1');
  } finally {
    await removeImps(name);
    await tryImp(['image', 'rm', name]);
  }

  const listedJson = await runImp('ls', '--builders', '--json');

  const listed: unknown = JSON.parse(listedJson);
  const kinds = z.array(z.object({ kind: z.string().optional() })).parse(listed);

  expect(kinds.filter((imp) => imp.kind === 'builder')).toEqual([]);
});

test('an add whose registry name resolves to a private address fails in the builder', async () => {
  const result = await tryImp(['image', 'add', '10-0-0-1.nip.io:5000/e2e/x:1', '--name', rejected]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('the pull of 10-0-0-1.nip.io:5000/e2e/x:1 in the builder failed');

  const names = await listImageNames();

  expect(names).not.toContain(rejected);
});
