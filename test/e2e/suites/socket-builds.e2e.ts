import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCKERFILE_FRONTEND } from '../../../packages/daemon/src/docker-proxy/dockerfile-frontend';
import { buildProxyBuildScript, parseProxyAnswer } from '../lib/docker-proxy-build';
import { buildHostModeProxyArgv } from '../lib/host-mode-proxy';
import {
  REPO_ROOT,
  getHostImage,
  instance,
  runChecked,
  runCommand,
  runInContainer,
} from '../lib/instance';
import { waitFor } from '../lib/wait-for';

// The rules imp-docker-proxy holds a host build to. The dev proxy, under
// IMP_BUILD_ISOLATION=imp, refuses every build, so each test builds through
// a second proxy of the same binary under host isolation.

async function setupTest() {
  // a name and socket of this test's own, so no other proxy is touched
  const id = randomUUID().slice(0, 8);
  const name = `${instance.container}-docker-proxy-host-mode-${id}`;
  const socket = `/run/imp-docker/host-mode-${id}.sock`;

  const gid = await runChecked(['stat', '-c', '%g', '/var/run/docker.sock']);

  const argsJson = readFileSync(join(REPO_ROOT, 'deploy', 'imp-host.args.json'), 'utf8');

  await runChecked(
    buildHostModeProxyArgv({
      argsJson,
      name,
      dockerGid: gid.trim(),
      hostImage: getHostImage(),
      socketVolume: `${instance.container}-docker`,
      socket,
      binary: join(instance.dataDir, 'imp-docker-proxy'),
    }),
  );

  onTestFinished(async () => {
    await runCommand(['docker', 'rm', '-f', name]);
    await runInContainer(['rm', '-f', socket]);
  });

  await waitFor('the host-mode proxy socket', () =>
    runChecked(['docker', 'exec', instance.container, 'test', '-S', socket]),
  );

  return { socket };
}

test("it refuses a build that tags outside imp/ or retags the host's image", async () => {
  const ctx = await setupTest();

  const ubuntu = await runInContainer([
    'sh',
    '-c',
    buildProxyBuildScript(
      [
        ['t', 'ubuntu:latest'],
        ['version', '2'],
        ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })],
      ],
      '/build',
      ctx.socket,
    ),
  ]);

  const retag = await runInContainer([
    'sh',
    '-c',
    buildProxyBuildScript(
      [
        ['t', 'imp/e2e-sock:latest'],
        ['t', getHostImage()],
        ['version', '2'],
        ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })],
      ],
      '/build',
      ctx.socket,
    ),
  ]);

  const ubuntuAnswer = parseProxyAnswer(ubuntu.stdout);
  const retagAnswer = parseProxyAnswer(retag.stdout);

  expect(ubuntuAnswer.status).toBe(403);
  expect(ubuntuAnswer.message).toContain('param t');
  expect(retagAnswer.status).toBe(403);
  expect(retagAnswer.message).toContain('param t');
});

// the engine reads a build's params from r.Form, where a form body replaces
// or adds to the query: these would give RUN the host's network, a remote
// context, a tag outside imp/ and the classic builder, with no frontend pin
test.each([
  [
    'an urlencoded',
    [
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '--data-binary',
      'networkmode=host&remote=http%3A%2F%2F127.0.0.1%3A9%2Fctx.tar&t=e2e-sock-evil%3Alatest&version=1',
    ],
  ],

  // curl sends -F fields as multipart/form-data, with its own boundary
  [
    'a multipart',
    [
      '-F',
      'networkmode=host',
      '-F',
      'remote=http://127.0.0.1:9/ctx.tar',
      '-F',
      't=e2e-sock-evil:latest',
      '-F',
      'version=1',
    ],
  ],
])(
  'it refuses a build with %s form body, which would replace or add to its checked query',
  async (_kind, form) => {
    const ctx = await setupTest();

    // the tag the form body names, with the suite's prefix
    const evil = 'e2e-sock-evil:latest';

    const query = new URLSearchParams([
      ['t', 'imp/e2e-sock:latest'],
      ['version', '2'],
      ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })],
    ]);

    const sent = await runInContainer([
      'curl',
      '-sS',
      '-w',
      '\n%{http_code}',
      '--unix-socket',
      ctx.socket,
      '-X',
      'POST',
      `http://docker/build?${query.toString()}`,
      ...form,
    ]);

    const tagged = await runCommand(['docker', 'image', 'inspect', evil]);

    const [answer, status] = sent.stdout.trim().split('\n');

    expect(status).toBe('403');
    expect(answer).toContain('imp-docker-proxy: a build body is a tar context');
    expect(tagged.exitCode).toBe(1);
  },
);

test.each([
  [
    'the classic builder',
    [
      ['t', 'imp/e2e-sock:latest'],
      ['version', '1'],
      ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })],
    ],
    '/build',
    'param version is "1"',
  ],
  [
    'no frontend pin',
    [
      ['t', 'imp/e2e-sock:latest'],
      ['version', '2'],
    ],
    '/build',
    'param buildargs is missing',
  ],
  [
    'a frontend by tag',
    [
      ['t', 'imp/e2e-sock:latest'],
      ['version', '2'],
      ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: 'docker/dockerfile:1' })],
    ],
    '/build',
    'sets BUILDKIT_SYNTAX',
  ],
  [
    'a session',
    [
      ['t', 'imp/e2e-sock:latest'],
      ['version', '2'],
      ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })],
      ['session', 'x'],
    ],
    '/build',
    'param session is not allowed',
  ],
  [
    "the host's network",
    [
      ['t', 'imp/e2e-sock:latest'],
      ['version', '2'],
      ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })],
      ['networkmode', 'host'],
    ],
    '/build',
    'param networkmode is not allowed',
  ],
  ['the grpc route', [], '/grpc', 'is not a call impd makes'],
  ['the session route', [], '/session', 'is not a call impd makes'],
] satisfies [string, [string, string][], string, string][])(
  'it refuses a build with %s, since a build runs BuildKit with the pinned frontend and no session',
  async (_label, params, path, refusal) => {
    const ctx = await setupTest();

    const result = await runInContainer([
      'sh',
      '-c',
      buildProxyBuildScript(params, path, ctx.socket),
    ]);

    const answer = parseProxyAnswer(result.stdout);

    expect(answer.status).toBe(403);
    expect(answer.message).toContain(refusal);
  },
);
