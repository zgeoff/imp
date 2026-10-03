import { afterAll, expect, test } from 'bun:test';
import { resolveImageName } from '../lib/fixtures';
import { runImp, runInImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { getHostImage, instance, runChecked, runCommand, runInContainer } from '../lib/instance';
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

// a classic build of FROM busybox with these -t flags
function buildScript(tags: string): string {
  return `printf 'FROM busybox\\n' | DOCKER_BUILDKIT=0 docker build -q ${tags} -`;
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
  const ubuntu = await readRefusal(buildScript('-t ubuntu:latest'));
  const second = await readRefusal(buildScript(`-t imp/e2e-sock:latest -t ${hostImage}`));

  expect(ubuntu).toContain('param t');
  expect(second).toContain('param t');
});

// the engine reads a build's params with r.FormValue, where a form body
// comes ahead of the query: this body would give RUN the host's network, a
// remote context and a tag outside imp/
test('a build with a form body, which would override its checked query, is refused', async () => {
  const evil = `${prefix}evil:latest`;

  const body = new URLSearchParams({
    networkmode: 'host',
    remote: 'http://127.0.0.1:9/ctx.tar',
    t: evil,
  }).toString();

  const sent = await runInContainer([
    'curl',
    '-sS',
    '-w',
    '\n%{http_code}',
    '--unix-socket',
    '/run/imp-docker/docker.sock',
    '-X',
    'POST',
    'http://docker/build?t=imp%2Fe2e-sock%3Alatest&q=1&version=1',
    '-H',
    'Content-Type: application/x-www-form-urlencoded',
    '--data-binary',
    body,
  ]);

  const [answer, status] = sent.stdout.trim().split('\n');

  expect(status).toBe('400');
  expect(answer).toContain('imp-docker-proxy: a build body is a tar context');

  const tagged = await runCommand(['docker', 'image', 'inspect', evil]);

  expect(tagged.exitCode).not.toBe(0);
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
