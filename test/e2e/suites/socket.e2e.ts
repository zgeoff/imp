import { afterAll, expect, test } from 'bun:test';
import * as z from 'zod';
import { DOCKERFILE_FRONTEND } from '../../../packages/daemon/src/docker-proxy/dockerfile-frontend';
import { resolveImageName } from '../lib/fixtures';
import { runImp, runInImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { instance, runChecked, runCommand, runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// imp-docker-proxy (docs/architecture/host-contract.md#the-docker-socket):
// root in the dev container reaches Docker only through it. It closes the
// Docker socket path only: SYS_ADMIN still lets root out of the container.
const prefix = setupSuite('socket');
const tiny = resolveImageName('e2e-tiny');
const name = `${prefix}a`;
const proxy = `${instance.container}-docker-proxy`;
const hostImage = process.env['IMP_HOST_IMAGE'] ?? 'imp-host:dev';
const hostRepo = hostImage.split(':')[0] ?? hostImage;

// a container the harness makes on the host's own Docker, not through the proxy
const outsider = { id: '' };

afterAll(async () => {
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

// POST /build to the proxy as root in the container, with a context of
// FROM busybox; each param is [key, value], sent as given. Prints the
// answer's body, then its status.
function buildScript(params: readonly (readonly [string, string])[], path = '/build'): string {
  const query = new URLSearchParams();

  for (const [key, value] of params) {
    query.append(key, value);
  }

  return [
    String.raw`d=$(mktemp -d) && printf "FROM busybox\n" >"$d/Dockerfile" &&`,
    `tar -C "$d" -c Dockerfile | curl -sS --unix-socket /run/imp-docker/docker.sock`,
    `-X POST -H 'Content-Type: application/x-tar' --data-binary @-`,
    `-w ' %{http_code}' 'http://docker${path}?${query.toString()}'`,
  ].join(' ');
}

const PIN = ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })] as const;
const RefusalSchema = z.object({ message: z.string() });

// a build through the proxy that it must refuse; returns the refusal
async function readBuildRefusal(
  params: readonly (readonly [string, string])[],
  path?: string,
): Promise<string> {
  const result = await runInContainer(['sh', '-c', buildScript(params, path)]);

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
