import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { DOCKERFILE_FRONTEND } from '../../../packages/daemon/src/docker-proxy/dockerfile-frontend';
import { resolveImageName } from '../lib/fixtures';
import { runImp, runInImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import {
  REPO_ROOT,
  getHostImage,
  instance,
  runChecked,
  runCommand,
  runInContainer,
} from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// imp-docker-proxy (docs/architecture/host-contract.md#the-docker-socket):
// root in the dev container reaches Docker only through it. It closes the
// Docker socket path only: SYS_ADMIN still lets root out of the container.
const prefix = setupSuite('socket');
const tiny = resolveImageName('e2e-tiny');
const name = `${prefix}a`;
const proxy = `${instance.container}-docker-proxy`;
const hostImage = getHostImage();
const hostRepo = hostImage.split(':')[0] ?? hostImage;

// a container the harness makes on the host's own Docker, not through the proxy
const outsider = { id: '' };

// The dev proxy, under IMP_BUILD_ISOLATION=imp, refuses every build; a host
// build's rules are checked on a second proxy of the same binary under host
// isolation, on a socket beside the dev proxy's.
const hostModeProxy = `${proxy}-host-mode`;
const PROXY_SOCKET = '/run/imp-docker/docker.sock';
const HOST_MODE_SOCKET = '/run/imp-docker/host-mode.sock';
const PrivilegesSchema = z.array(z.array(z.string()));
const ProxyArgsSchema = z.object({ proxy: z.object({ privileges: PrivilegesSchema }) });

beforeAll(async () => {
  const argsText = readFileSync(join(REPO_ROOT, 'deploy', 'imp-host.args.json'), 'utf8');
  const args = ProxyArgsSchema.parse(JSON.parse(argsText));

  const gid = await runChecked(['stat', '-c', '%g', '/var/run/docker.sock']);

  await runCommand(['docker', 'rm', '-f', hostModeProxy]);

  await runChecked([
    'docker',
    'run',
    '-d',
    '--name',
    hostModeProxy,
    ...args.proxy.privileges.flat(),
    '--group-add',
    gid.trim(),
    '-e',
    `IMP_HOST_IMAGE=${hostImage}`,
    '-e',
    'IMP_BUILD_ISOLATION=host',
    '-e',
    `IMP_DOCKER_PROXY_LISTEN=${HOST_MODE_SOCKET}`,
    '-e',
    'IMP_DOCKER_PROXY_STATE=/tmp',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${instance.container}-docker:/run/imp-docker`,
    '-v',
    `${join(instance.dataDir, 'imp-docker-proxy')}:/usr/local/bin/imp-docker-proxy:ro`,
    hostImage,
    '/usr/local/bin/imp-docker-proxy',
  ]);

  await waitFor('the host-mode proxy socket', () =>
    runChecked(['docker', 'exec', instance.container, 'test', '-S', HOST_MODE_SOCKET]),
  );
});

afterAll(async () => {
  await runCommand(['docker', 'rm', '-f', hostModeProxy]);

  if (outsider.id !== '') {
    await runCommand(['docker', 'rm', '-f', outsider.id]);
  }
});

// a docker command run as root in the dev container, which must fail at the
// proxy; returns the refusal
async function readRefusal(script: string): Promise<string> {
  const result = await runInContainer(['sh', '-c', script]);

  expect(result.exitCode).not.toBe(0);

  return result.stderr;
}

// POST /build to a proxy as root in the container, with a context of
// FROM busybox; each param is [key, value], sent as given. Prints the
// answer's body, then its status.
function buildScript(
  params: readonly (readonly [string, string])[],
  path = '/build',
  socket = HOST_MODE_SOCKET,
): string {
  const query = new URLSearchParams();

  for (const [key, value] of params) {
    query.append(key, value);
  }

  return [
    String.raw`d=$(mktemp -d) && printf "FROM busybox\n" >"$d/Dockerfile" &&`,
    `tar -C "$d" -c Dockerfile | curl -sS --unix-socket ${socket}`,
    `-X POST -H 'Content-Type: application/x-tar' --data-binary @-`,
    `-w ' %{http_code}' 'http://docker${path}?${query.toString()}'`,
  ].join(' ');
}

const PIN = ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })] as const;
const RefusalSchema = z.object({ message: z.string() });

// a build through a proxy, the host-mode one by default, that it must
// refuse; returns the refusal
async function readBuildRefusal(
  params: readonly (readonly [string, string])[],
  path?: string,
  socket?: string,
): Promise<string> {
  const result = await runInContainer(['sh', '-c', buildScript(params, path, socket)]);

  expect(result.stdout).toEndWith(' 403');

  return RefusalSchema.parse(JSON.parse(result.stdout.slice(0, -' 403'.length))).message;
}

test('the dev container has no docker.sock of the host, and its Docker is the proxy', async () => {
  const missing = await runInContainer(['test', '-e', '/var/run/docker.sock']);
  const version = await runInContainer(['docker', 'version', '--format', '{{.Server.Version}}']);

  expect(missing.exitCode).not.toBe(0);
  expect(version.exitCode).toBe(0);
});

test('a container that could reach the host is refused', async () => {
  const cases = [
    'docker run --rm busybox true',
    'docker create --privileged busybox /bin/true',
    'docker create -v /:/host busybox /bin/true',
    'docker create --network host busybox /bin/true',
    'docker create --pid host busybox /bin/true',
    'docker create --cap-add SYS_ADMIN busybox /bin/true',
    'docker create --device /dev/kvm busybox /bin/true',
    'docker create --volumes-from imp-host busybox /bin/true',
  ];

  for (const script of cases) {
    const refusal = await readRefusal(script);

    expect(refusal).toContain('imp-docker-proxy:');
  }
});

test('calls impd never makes are refused: list, exec, start, load', async () => {
  for (const script of [
    'docker ps',
    'docker images',
    'docker exec imp-host true',
    'docker start imp-host',
    'docker load </dev/null',
  ]) {
    const refusal = await readRefusal(script);

    expect(refusal).toContain('is not a call impd makes');
  }
});

test('an export or rm of a container the proxy did not create is refused', async () => {
  const created = await runChecked(['docker', 'create', 'busybox', '/bin/true']);

  outsider.id = created.trim();

  const exported = await readRefusal(`docker export ${outsider.id} >/dev/null`);
  const removed = await readRefusal(`docker rm -f ${outsider.id}`);

  expect(exported).toContain('was not created by this proxy');
  expect(removed).toContain('was not created by this proxy');

  const state = await runChecked(['docker', 'inspect', '-f', '{{.State.Status}}', outsider.id]);

  expect(state.trim()).toBe('created');
});

// #169: impd builds in builder imps then, so no build reaches the engine
test('under IMP_BUILD_ISOLATION=imp every build is refused, even one a host build may send', async () => {
  const refusal = await readBuildRefusal(
    [['t', 'imp/e2e-sock:latest'], ['version', '2'], PIN],
    '/build',
    PROXY_SOCKET,
  );

  expect(refusal).toBe(
    'imp-docker-proxy: a build is refused: under IMP_BUILD_ISOLATION=imp impd builds in builder imps',
  );
});

test("a build may not tag outside imp/, nor retag the host's image", async () => {
  const ubuntu = await readBuildRefusal([['t', 'ubuntu:latest'], ['version', '2'], PIN]);

  const second = await readBuildRefusal([
    ['t', 'imp/e2e-sock:latest'],
    ['t', hostImage],
    ['version', '2'],
    PIN,
  ]);

  expect(ubuntu).toContain('param t');
  expect(second).toContain('param t');
});

// the engine reads a build's params from r.Form, where a form body replaces
// or adds to the query: these would give RUN the host's network, a remote
// context, a tag outside imp/ and the classic builder, with no frontend pin
test('a build with a form body, which would replace or add to its checked query, is refused', async () => {
  const evil = `${prefix}evil:latest`;

  const fields: [string, string][] = [
    ['networkmode', 'host'],
    ['remote', 'http://127.0.0.1:9/ctx.tar'],
    ['t', evil],
    ['version', '1'],
  ];

  const query = new URLSearchParams([['t', 'imp/e2e-sock:latest'], ['version', '2'], [...PIN]]);

  const urlencoded = [
    '-H',
    'Content-Type: application/x-www-form-urlencoded',
    '--data-binary',
    new URLSearchParams(fields).toString(),
  ];

  // curl sends -F fields as multipart/form-data, with its own boundary
  const multipart = fields.flatMap(([key, value]) => ['-F', `${key}=${value}`]);

  for (const form of [urlencoded, multipart]) {
    const sent = await runInContainer([
      'curl',
      '-sS',
      '-w',
      '\n%{http_code}',
      '--unix-socket',
      HOST_MODE_SOCKET,
      '-X',
      'POST',
      `http://docker/build?${query.toString()}`,
      ...form,
    ]);

    const [answer, status] = sent.stdout.trim().split('\n');

    expect(status).toBe('403');
    expect(answer).toContain('imp-docker-proxy: a build body is a tar context');
  }

  const tagged = await runCommand(['docker', 'image', 'inspect', evil]);

  expect(tagged.exitCode).not.toBe(0);
});

test('a build runs BuildKit with the pinned frontend, and no session', async () => {
  const tag = ['t', 'imp/e2e-sock:latest'] as const;

  const classic = await readBuildRefusal([tag, ['version', '1'], PIN]);
  const unpinned = await readBuildRefusal([tag, ['version', '2']]);

  const byTag = await readBuildRefusal([
    tag,
    ['version', '2'],
    ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: 'docker/dockerfile:1' })],
  ]);

  const session = await readBuildRefusal([tag, ['version', '2'], PIN, ['session', 'x']]);
  const hostNet = await readBuildRefusal([tag, ['version', '2'], PIN, ['networkmode', 'host']]);
  const grpc = await readBuildRefusal([], '/grpc');
  const sessionRoute = await readBuildRefusal([], '/session');

  expect(classic).toContain('param version is "1"');
  expect(unpinned).toContain('param buildargs is missing');
  expect(byTag).toContain('sets BUILDKIT_SYNTAX');
  expect(session).toContain('param session is not allowed');
  expect(hostNet).toContain('param networkmode is not allowed');
  expect(grpc).toContain('is not a call impd makes');
  expect(sessionRoute).toContain('is not a call impd makes');
});

test("a pull of the host's repository is refused, so its tag cannot move", async () => {
  const refusal = await readRefusal(`docker pull ${hostRepo}:e2e-socket`);

  expect(refusal).toContain('imp-host runs from');
});

test('imps keep running, and answer exec, while the proxy is stopped', async () => {
  await createImp(name, '--image', tiny);
  await holdImp(name);
  await runChecked(['docker', 'stop', proxy]);

  try {
    const echoed = await runInImp(name, 'echo', 'still-here');
    const images = await runImp('image', 'ls');

    expect(echoed.trim()).toBe('still-here');
    expect(images).toContain(tiny);
  } finally {
    await runChecked(['docker', 'start', proxy]);
  }

  await waitFor('the proxy socket again', () =>
    runChecked(['docker', 'exec', instance.container, 'docker', 'version']),
  );
});
