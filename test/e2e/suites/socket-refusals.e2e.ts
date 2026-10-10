import { expect, onTestFinished, test } from 'bun:test';
import { DOCKERFILE_FRONTEND } from '../../../packages/daemon/src/docker-proxy/dockerfile-frontend';
import { buildProxyBuildScript, parseProxyAnswer } from '../lib/docker-proxy-build';
import { getHostImage, runChecked, runCommand, runInContainer } from '../lib/instance';

// imp-docker-proxy (docs/architecture/host-contract.md#the-docker-socket):
// root in the dev container reaches Docker only through it. It closes the
// Docker socket path only: SYS_ADMIN still lets root out of the container.

test('it gives the dev container no docker.sock of the host, and the proxy as its Docker', async () => {
  const missing = await runInContainer(['test', '-e', '/var/run/docker.sock']);
  const version = await runInContainer(['docker', 'version', '--format', '{{.Server.Version}}']);

  expect(missing.exitCode).toBe(1);
  expect(version.exitCode).toBe(0);
});

test.each([
  ['docker run --rm busybox true'],
  ['docker create --privileged busybox /bin/true'],
  ['docker create -v /:/host busybox /bin/true'],
  ['docker create --network host busybox /bin/true'],
  ['docker create --pid host busybox /bin/true'],
  ['docker create --cap-add SYS_ADMIN busybox /bin/true'],
  ['docker create --device /dev/kvm busybox /bin/true'],
  ['docker create --volumes-from imp-host busybox /bin/true'],
])('it refuses a container that could reach the host: %s', async (script) => {
  const result = await runInContainer(['sh', '-c', script]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('imp-docker-proxy:');
});

test.each([
  ['docker ps'],
  ['docker images'],
  ['docker exec imp-host true'],
  ['docker start imp-host'],
  ['docker load </dev/null'],
])('it refuses %s, a call impd never makes', async (script) => {
  const result = await runInContainer(['sh', '-c', script]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('is not a call impd makes');
});

test('it refuses an export or rm of a container the proxy did not create', async () => {
  // made on the host's own Docker, not through the proxy
  const created = await runChecked(['docker', 'create', 'busybox', '/bin/true']);

  const outsider = created.trim();

  onTestFinished(async () => {
    await runCommand(['docker', 'rm', '-f', outsider]);
  });

  const exported = await runInContainer(['sh', '-c', `docker export ${outsider} >/dev/null`]);
  const removed = await runInContainer(['sh', '-c', `docker rm -f ${outsider}`]);
  const state = await runChecked(['docker', 'inspect', '-f', '{{.State.Status}}', outsider]);

  expect(exported.exitCode).not.toBe(0);
  expect(exported.stderr).toContain('was not created by this proxy');
  expect(removed.exitCode).not.toBe(0);
  expect(removed.stderr).toContain('was not created by this proxy');
  expect(state.trim()).toBe('created');
});

// #169: impd builds in builder imps then, so no build reaches the engine
test('it refuses every build under IMP_BUILD_ISOLATION=imp, even one a host build may send', async () => {
  const result = await runInContainer([
    'sh',
    '-c',
    buildProxyBuildScript(
      [
        ['t', 'imp/e2e-sock:latest'],
        ['version', '2'],
        ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })],
      ],
      '/build',
      '/run/imp-docker/docker.sock',
    ),
  ]);

  expect(parseProxyAnswer(result.stdout)).toStrictEqual({
    status: 403,
    message:
      'imp-docker-proxy: a build is refused: under IMP_BUILD_ISOLATION=imp impd builds in builder imps',
  });
});

test("it refuses a pull of the host's repository, so its tag cannot move", async () => {
  const hostImage = getHostImage();
  const hostRepo = hostImage.split(':')[0] ?? hostImage;

  const result = await runInContainer(['sh', '-c', `docker pull ${hostRepo}:e2e-socket`]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('imp-host runs from');
});
