import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IMAGE_BUILD_PATH,
  IMAGE_BUILD_STREAM_TYPE,
  ImageBuildEventSchema,
  ImageBuildResultSchema,
} from '@imp/api';
import type { Scope } from '@imp/api';
import * as z from 'zod';
import { createApiAudit } from '../audit/api-audit';
import { listApiCalls } from '../db/api-audit';
import { createImage } from '../db/images';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '../imps/test-imps';
import { findFreePorts } from '../net/test-free-ports';
import { createForwardedPeers } from '../proxy/forwarded-peers';
import { startWakeProxy } from '../proxy/wake-proxy';
import { buildUploadsDir } from '../storage/data-layout';
import { createBuildContextRoute } from './build-context-route';
import { BUILD_KEEPALIVE_MS } from './build-event-stream';
import { PIN_INSPECT_FORMAT } from './image-pin';
import type { ImageService } from './image-service';

interface BuildCall {
  readonly bytes: string;
  readonly name: string;
  readonly dockerfile: string | undefined;
}

interface TestOptions {
  readonly env?: Readonly<Record<string, string>>;

  // holds every build until it resolves
  readonly gate?: Promise<void>;

  // replaces the fake build; 'image-service' builds as impd does
  readonly build?: ImageService['buildImageFromContext'] | 'image-service';

  // the gap between a streamed build's progress lines
  readonly keepaliveMs?: number;
}

// the headers of a client that reads the build as a stream of events
const STREAM = { accept: IMAGE_BUILD_STREAM_TYPE };

type BuildEvent = z.infer<typeof ImageBuildEventSchema>;

// impd with a fake build that records what reached it; 'image-service'
// builds on the host engine, a fake docker, through the same input guard
// and pins as a builder's
async function setupTest(options: TestOptions = {}) {
  const harness = await setupImpTest({ env: { IMP_BUILD_ISOLATION: 'host', ...options.env } });

  const calls: BuildCall[] = [];

  // builds stopped because their client went
  const stopped: string[] = [];

  const writeBuildCall: ImageService['buildImageFromContext'] = async (
    tarPath,
    name,
    dockerfile,
    buildOptions,
  ) => {
    const signal = buildOptions.signal;

    calls.push({ bytes: readFileSync(tarPath, 'utf8'), name, dockerfile });

    const gone = Promise.withResolvers<void>();

    signal.addEventListener('abort', () => {
      stopped.push(name);
      gone.resolve();
    });

    await Promise.race([options.gate, gone.promise]);

    signal.throwIfAborted();

    return createImage(harness.db, {
      name,
      ref: `imp/${name}:latest`,
      digest: 'sha256:x',
      sizeBytes: 1,
    });
  };

  const build =
    options.build === 'image-service'
      ? harness.images.buildImageFromContext
      : (options.build ?? writeBuildCall);

  const images = { ...harness.images, buildImageFromContext: build };

  const root = buildTestApp(
    { ...harness, images },
    harness,
    undefined,
    {},
    null,
    {},
    options.keepaliveMs,
  );

  const sendBuild = (
    query: string,
    body: string | ReadableStream<Uint8Array>,
    token = TEST_TOKEN,
    headers: Readonly<Record<string, string>> = {},
    signal: AbortSignal | null = null,
  ): Promise<Response> =>
    root.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?${query}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, ...headers },
        body,
        signal,
      }),
    );

  const readStatus = async (
    query: string,
    body: string | ReadableStream<Uint8Array>,
    token = TEST_TOKEN,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<number> => {
    const response = await sendBuild(query, body, token, headers);

    return response.status;
  };

  const createToken = async (scope: Scope, imps: readonly string[] | null = null) => {
    const made = await root.client.tokens.create({
      name: `t-${scope}-${String(imps?.length ?? 0)}`,
      scope,
      ...(imps !== null && { imps: [...imps] }),
    });

    return made.secret;
  };

  // the outcome of every images.build audit row, oldest first
  const readOutcomes = async (count: number): Promise<string[]> => {
    const deadline = Date.now() + 5000;

    for (;;) {
      const rows = await listApiCalls(harness.db, null, 100, null);

      const builds = rows.filter((row) => row.procedure === 'images.build');

      if (builds.length >= count || Date.now() > deadline) {
        return builds.map((row) => row.outcome).toReversed();
      }

      await Bun.sleep(5);
    }
  };

  return {
    harness,
    app: root.app,
    calls,
    stopped,
    sendBuild,
    readStatus,
    createToken,
    readOutcomes,
    listUploads: () => readdirSync(buildUploadsDir(harness.config.dataDir)),
    [Symbol.asyncDispose]: () => harness[Symbol.asyncDispose](),
  };
}

// every event of a streamed answer, to its end
async function readEvents(response: Response): Promise<BuildEvent[]> {
  const text = await response.text();

  return text
    .trim()
    .split('\n')
    .map((line) => ImageBuildEventSchema.parse(JSON.parse(line)));
}

// free ports for impd's API and its proxy, outside the imp ports of the
// 64-slot subnet the env names
function pickApiPorts(): { readonly api: number; readonly env: Record<string, string> } {
  const ports = findFreePorts(3);
  const api = ports.take();
  const proxy = ports.take();
  const base = ports.take();

  if ([api, proxy].some((port) => port >= base && port < base + 64)) {
    return pickApiPorts();
  }

  return {
    api,
    env: {
      IMP_API_PORT: String(api),
      IMP_PROXY_PORT: String(proxy),
      IMP_PORT_BASE: String(base),
      IMP_SUBNET: '10.99.0.0/24',
    },
  };
}

// a body with no Content-Length: the route can only count what arrives
function createByteStream(total: number): ReadableStream<Uint8Array> {
  const state = { sent: 0 };

  return new ReadableStream({
    pull: (controller) => {
      if (state.sent >= total) {
        controller.close();

        return;
      }

      const chunk = new Uint8Array(Math.min(64 * 1024, total - state.sent));

      state.sent += chunk.byteLength;

      controller.enqueue(chunk);
    },
  });
}

test('a streamed context builds, answers the image and leaves no file behind', async () => {
  await using ctx = await setupTest();

  const response = await ctx.sendBuild('name=web&dockerfile=docker/Dockerfile', 'tar bytes');
  const body: unknown = await response.json();

  expect(response.status).toBe(200);
  expect(ImageBuildResultSchema.parse(body).name).toBe('web');
  expect(ctx.calls).toEqual([{ bytes: 'tar bytes', name: 'web', dockerfile: 'docker/Dockerfile' }]);
  expect(ctx.listUploads()).toEqual([]);

  const outcomes = await ctx.readOutcomes(1);

  expect(outcomes).toEqual(['ok']);
});

test('a client that accepts the stream gets the headers at once, progress while it builds, then the image', async () => {
  const gate = Promise.withResolvers<void>();

  await using ctx = await setupTest({ gate: gate.promise, keepaliveMs: 10 });

  // answered while the build still waits on the gate
  const response = await ctx.sendBuild('name=web', 'tar bytes', TEST_TOKEN, STREAM);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(IMAGE_BUILD_STREAM_TYPE);

  while (ctx.calls.length === 0) {
    await Bun.sleep(1);
  }

  await Bun.sleep(50);

  gate.resolve();

  const events = await readEvents(response);

  const phases = events.flatMap((event) => (event.type === 'progress' ? [event.phase] : []));

  expect(phases[0]).toBe('upload');
  expect(phases.filter((phase) => phase === 'build').length).toBeGreaterThan(2);
  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'web' } });
  expect(ctx.listUploads()).toEqual([]);

  const outcomes = await ctx.readOutcomes(1);

  expect(outcomes).toEqual(['ok']);
});

// impd on a real socket behind the wake proxy, as a build over HTTPS reaches
// it: the first line comes back while the upload still holds its rest
test('through the proxy, a progress line arrives before the upload ends', async () => {
  const ports = pickApiPorts();
  const gate = Promise.withResolvers<void>();

  await using ctx = await setupTest({ env: ports.env, gate: gate.promise, keepaliveMs: 10 });

  ctx.app.listen({ port: ports.api, hostname: '127.0.0.1' });

  const proxy = startWakeProxy({
    config: ctx.harness.config,
    db: ctx.harness.db,
    imps: ctx.harness.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
  });

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  const rest = Promise.withResolvers<void>();
  const upload = { ended: false };

  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      controller.enqueue(encoder.encode('first half, '));

      await rest.promise;

      controller.enqueue(encoder.encode('second half'));

      upload.ended = true;

      controller.close();
    },
  });

  try {
    const response = await fetch(
      `http://127.0.0.1:${String(apex.port)}${IMAGE_BUILD_PATH}?name=web`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_TOKEN}`, ...STREAM },
        body,
        duplex: 'half',
      },
    );

    const lines = response.body?.pipeThrough(new TextDecoderStream()).getReader();

    const first = await lines?.read();

    expect(upload.ended).toBe(false);

    expect(JSON.parse(first?.value?.split('\n')[0] ?? 'null')).toMatchObject({
      type: 'progress',
      phase: 'upload',
    });

    rest.resolve();
    gate.resolve();

    const parts = [first?.value ?? ''];

    for (let chunk = await lines?.read(); chunk?.done === false; chunk = await lines?.read()) {
      parts.push(chunk.value);
    }

    const last = ImageBuildEventSchema.parse(
      JSON.parse(parts.join('').trim().split('\n').at(-1) ?? 'null'),
    );

    expect(last).toMatchObject({ type: 'image', image: { name: 'web' } });
    expect(ctx.calls.map((call) => call.bytes)).toEqual(['first half, second half']);
  } finally {
    await apex.stop(true);
    await proxy.stop();
    await ctx.app.stop(true);
  }
});

test('only a manage caller for the whole host may build', async () => {
  await using ctx = await setupTest();

  const limited = await ctx.createToken('manage', ['dev-*']);
  const reader = await ctx.createToken('read');
  const limitedStatus = await ctx.readStatus('name=web', 'tar', limited);
  const readerStatus = await ctx.readStatus('name=web', 'tar', reader);
  const strangerStatus = await ctx.readStatus('name=web', 'tar', 'not-a-token');

  expect([limitedStatus, readerStatus, strangerStatus]).toEqual([403, 403, 401]);
  expect(ctx.calls).toEqual([]);

  const outcomes = await ctx.readOutcomes(2);

  expect(outcomes).toEqual(['FORBIDDEN', 'FORBIDDEN']);
});

test('a bad name or a Dockerfile outside the context is refused before the upload', async () => {
  await using ctx = await setupTest();

  const queries = [
    'name=Bad Name',
    'name=web&dockerfile=../Dockerfile',
    'name=web&dockerfile=sub/../../Dockerfile',
    'name=web&dockerfile=/etc/passwd',
    '',
  ];

  for (const query of queries) {
    const status = await ctx.readStatus(query, 'tar');

    expect(status).toBe(400);
  }

  expect(ctx.calls).toEqual([]);
});

test('a context over the limit gets 413, by its Content-Length or by the bytes that come', async () => {
  await using ctx = await setupTest({ env: { IMP_BUILD_CONTEXT_MAX_MIB: '1' } });

  const declared = await ctx.readStatus('name=web', 'x', TEST_TOKEN, {
    'content-length': String(2 * 1024 ** 2),
  });

  expect(declared).toBe(413);

  // a refused Content-Length frees its build slot
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const again = await ctx.readStatus('name=web', 'x', TEST_TOKEN, {
      'content-length': String(2 * 1024 ** 2),
    });

    expect(again).toBe(413);
  }

  const streamed = await ctx.sendBuild('name=web', createByteStream(1024 ** 2 + 1));
  const body: unknown = await streamed.json();

  expect(streamed.status).toBe(413);
  expect(body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  expect(ctx.listUploads()).toEqual([]);

  // a stream refuses a Content-Length with its status; bytes past the limit
  // come after its 200, so its last line says so
  const declaredStream = await ctx.readStatus('name=web', 'x', TEST_TOKEN, {
    ...STREAM,
    'content-length': String(2 * 1024 ** 2),
  });

  expect(declaredStream).toBe(413);

  const overStream = await ctx.sendBuild(
    'name=web',
    createByteStream(1024 ** 2 + 1),
    TEST_TOKEN,
    STREAM,
  );

  const events = await readEvents(overStream);

  expect(overStream.status).toBe(200);
  expect(events.at(-1)).toMatchObject({ type: 'error', code: 'PAYLOAD_TOO_LARGE' });
  expect(ctx.listUploads()).toEqual([]);

  // exactly the limit is fine
  const atLimit = await ctx.readStatus('name=web', createByteStream(1024 ** 2));

  expect(atLimit).toBe(200);
  expect(ctx.calls).toHaveLength(1);
});

test('a fifth build while four upload or run gets 429', async () => {
  const gate = Promise.withResolvers<void>();

  await using ctx = await setupTest({ gate: gate.promise });

  const running = [1, 2, 3, 4].map((n) => ctx.readStatus(`name=web${String(n)}`, 'tar'));

  while (ctx.calls.length < 4) {
    await Bun.sleep(1);
  }

  const fifth = await ctx.readStatus('name=web5', 'tar');
  const fifthStream = await ctx.readStatus('name=web5', 'tar', TEST_TOKEN, STREAM);

  expect([fifth, fifthStream]).toEqual([429, 429]);

  gate.resolve();

  const statuses = await Promise.all(running);

  expect(statuses).toEqual([200, 200, 200, 200]);

  const sixth = await ctx.readStatus('name=web6', 'tar');

  expect(sixth).toBe(200);
});

test.each([
  ['JSON', {}],
  ['a stream', STREAM],
])(
  'a client that goes mid-build, answered as %s, stops the build, frees its slot and its file',
  async (_, headers) => {
    const gate = Promise.withResolvers<void>();

    await using ctx = await setupTest({ gate: gate.promise, keepaliveMs: 10 });

    const clients = [1, 2, 3, 4].map(() => new AbortController());

    const builds = clients.map((client, n) =>
      ctx.sendBuild(`name=gone${String(n)}`, 'tar', TEST_TOKEN, headers, client.signal),
    );

    while (ctx.calls.length < 4) {
      await Bun.sleep(1);
    }

    for (const client of clients) {
      client.abort();
    }

    await Promise.allSettled(builds);

    // a stream answered before its build ended: the build's audit row comes
    // after its file is gone
    await ctx.readOutcomes(4);

    expect(ctx.stopped.toSorted()).toEqual(['gone0', 'gone1', 'gone2', 'gone3']);
    expect(ctx.listUploads()).toEqual([]);

    gate.resolve();

    const next = await ctx.readStatus('name=web', 'tar');

    expect(next).toBe(200);
  },
);

// a docker on PATH whose pulls hang, and which logs its argv; a pull execs
// its sleep, so killing it leaves nothing holding its pipes
// a docker on PATH that logs its argv to log, then runs the given lines
function writeFakeDocker(
  dir: string,
  lines: readonly string[],
): { readonly log: string; readonly path: string } {
  const bin = join(dir, 'fake-bin');
  const log = join(dir, 'docker.log');

  mkdirSync(bin, { recursive: true });

  writeFileSync(join(bin, 'docker'), ['#!/bin/sh', `echo "$*" >>'${log}'`, ...lines].join('\n'), {
    mode: 0o755,
  });

  return { log, path: `${bin}:${process.env['PATH'] ?? ''}` };
}

function writeHangingDocker(dir: string): { readonly log: string; readonly path: string } {
  return writeFakeDocker(dir, [
    `[ "$1" = version ] && echo '"linux" "amd64"' && exit 0`,
    '[ "$1" = pull ] && exec sleep 30',
    'exit 1',
  ]);
}

// a tar of a context holding only this Dockerfile
function buildDockerfileTar(dir: string, dockerfile: string): Uint8Array {
  const contextDir = join(dir, `context-${Bun.randomUUIDv7()}`);

  mkdirSync(contextDir);
  writeFileSync(join(contextDir, 'Dockerfile'), dockerfile);

  return Bun.spawnSync(['tar', '-C', contextDir, '-c', 'Dockerfile']).stdout;
}

function readLog(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

test('a client that goes during a base image pull ends it, starts no other and frees its slot', async () => {
  await using ctx = await setupTest({ build: 'image-service' });

  const docker = writeHangingDocker(ctx.harness.config.dataDir);

  const tar = buildDockerfileTar(
    ctx.harness.config.dataDir,
    'FROM first.test/a:1\nFROM second.test/b:1\n',
  );

  const savedPath = process.env['PATH'];

  process.env['PATH'] = docker.path;

  try {
    const clients = [1, 2, 3, 4].map(() => new AbortController());

    const builds = clients.map((client, n) =>
      ctx.sendBuild(
        `name=pull${String(n)}`,
        new Blob([tar]).stream(),
        TEST_TOKEN,
        {},
        client.signal,
      ),
    );

    while (readLog(docker.log).filter((line) => line.startsWith('pull')).length < 4) {
      await Bun.sleep(5);
    }

    for (const client of clients) {
      client.abort();
    }

    // the pulls sleep 30 s: only their kill settles the builds in time
    await Promise.allSettled(builds);

    const pulls = readLog(docker.log).filter((line) => line.startsWith('pull'));

    expect(pulls).toEqual(Array.from({ length: 4 }, () => 'pull --quiet first.test/a:1'));
    expect(ctx.listUploads()).toEqual([]);

    // not a tar: refused by the build, not for want of a slot
    const next = await ctx.readStatus('name=web', 'not a tar');

    expect(next).toBe(400);
  } finally {
    process.env['PATH'] = savedPath;
  }
});

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

// what the fake docker's inspect answers for an image: on amd64, with these
// RepoDigests, and no triggers unless given
function buildInspect(
  repoDigests: readonly string[],
  extra: Readonly<Record<string, unknown>> = {},
  onBuild: readonly string[] | null = null,
) {
  const inspect = {
    Id: `sha256:${'c'.repeat(64)}`,
    RepoDigests: repoDigests,
    Os: 'linux',
    Architecture: 'amd64',
    Config: onBuild === null ? { Env: ['PATH=/bin'] } : { OnBuild: onBuild },
  };

  return `echo '${JSON.stringify({ ...inspect, ...extra })}'`;
}

// An amd64 engine. base.test images and the Dockerfile frontend are on the
// host; the rest are pulled and then inspected, but mnt.test's pull fails.
// Marker files next to it take the frontend away and fail its pull.
const IMAGE_DOCKER = [
  'for last; do :; done',
  'pulled="$(dirname "$0")/pulled-$(echo "$last" | tr "/:@" "___")"',
  'case "$1 $2" in',
  `  "version --format") echo '"linux" "x86_64"' ;;`,
  '  "image inspect") case "$last" in',
  `    base.test/onbuild:1) ${buildInspect([`base.test/onbuild@${DIGEST_A}`], {}, ['RUN id'])} ;;`,
  `    base.test/local:1) ${buildInspect([])} ;;`,
  `    base.test/arm:1) ${buildInspect([`base.test/arm@${DIGEST_A}`], { Architecture: 'aarch64' })} ;;`,
  `    base.test/arm32:1) ${buildInspect([`base.test/arm32@${DIGEST_A}`], { Architecture: 'arm' })} ;;`,
  `    base.test/private:1) ${buildInspect([`localhost:5000/x@${DIGEST_A}`, `10.0.0.5:5000/y@${DIGEST_B}`])} ;;`,
  '    base.test/moving:1) n=$(cat "$pulled" 2>/dev/null || echo 0); echo $((n + 1)) >"$pulled"',
  `      if [ "$n" = 0 ]; then ${buildInspect([`base.test/moving@${DIGEST_A}`])}; else ${buildInspect([`base.test/moving@${DIGEST_B}`])}; fi ;;`,
  '    moving:1|docker.io/library/moving:1|index.docker.io/library/moving) count="$(dirname "$0")/moving"; n=$(cat "$count" 2>/dev/null || echo 0); echo $((n + 1)) >"$count"',
  `      if [ "$n" = 0 ]; then ${buildInspect([`moving@${DIGEST_A}`])}; else ${buildInspect([`moving@${DIGEST_B}`])}; fi ;;`,
  `    LocalHost/name:1) ${buildInspect([`LocalHost/name@${DIGEST_A}`])} ;;`,
  `    base.test/retag:1) ${buildInspect([`other.test/x@${DIGEST_B}`])} ;;`,
  `    base.test/a:1) ${buildInspect([`other.test/x@${DIGEST_B}`, `base.test/a@${DIGEST_A}`])} ;;`,
  '    docker/dockerfile:*) [ -e "$(dirname "$0")/no-frontend" ] && [ ! -e "$pulled" ] && exit 1',
  `      echo sha256:${'f'.repeat(64)} ;;`,
  `    *) [ -e "$pulled" ] || exit 1; ${buildInspect([`tools.test/b@${DIGEST_B}`])} ;;`,
  '  esac ;;',
  '  "pull --quiet") case "$last" in',
  '    docker/dockerfile:*) [ -e "$(dirname "$0")/unreachable-frontend" ] && echo "no route to host" >&2 && exit 1',
  '      touch "$pulled" ;;',
  '    mnt.test/*) echo "no such registry" >&2; exit 1 ;;',
  '    *) touch "$pulled" ;;',
  '  esac ;;',
  '  *) exit 1 ;;',
  'esac',
];

// the fake docker's argv, with the inspect format named
function readCalls(log: string): string[] {
  return readLog(log).map((line) => line.replace(PIN_INSPECT_FORMAT, 'PIN'));
}

// A build through the image service, with the fake docker on PATH and a
// fake engine that records the context it gets and fails the build.
async function sendFakeDockerBuild(
  dockerfile: string,
  engineError = 'the fake engine builds nothing',
  frontend: 'present' | 'no-frontend' | 'unreachable-frontend' = 'present',
) {
  const socketDir = mkdtempSync(join(tmpdir(), 'imp-engine-'));
  const socket = join(socketDir, 'docker.sock');
  const contexts: Uint8Array[] = [];

  // the fake docker's calls when the engine got the build
  let callsAtBuild: string[] = [];
  let log = '';

  const engine = Bun.serve({
    unix: socket,
    fetch: async (request) => {
      const context = await request.arrayBuffer();

      callsAtBuild = readCalls(log);

      contexts.push(new Uint8Array(context));

      return new Response(`${JSON.stringify({ error: engineError })}\n`);
    },
  });

  await using ctx = await setupTest({
    build: 'image-service',
    env: { DOCKER_HOST: `unix://${socket}` },
  });

  const docker = writeFakeDocker(ctx.harness.config.dataDir, IMAGE_DOCKER);
  const tar = buildDockerfileTar(ctx.harness.config.dataDir, dockerfile);

  log = docker.log;

  if (frontend !== 'present') {
    writeFileSync(join(ctx.harness.config.dataDir, 'fake-bin', 'no-frontend'), '');
  }

  if (frontend === 'unreachable-frontend') {
    writeFileSync(join(ctx.harness.config.dataDir, 'fake-bin', 'unreachable-frontend'), '');
  }

  const savedPath = process.env['PATH'];

  process.env['PATH'] = docker.path;

  try {
    const response = await ctx.sendBuild('name=web', new Blob([tar]).stream());
    const body: unknown = await response.json();

    // the Dockerfile in the context the engine got
    const built = contexts.map(
      (context) =>
        Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], { stdin: context }).stdout,
    );

    return {
      status: response.status,
      body,
      calls: readCalls(docker.log),
      callsAtBuild,
      built: built.map((bytes) => new TextDecoder().decode(bytes)),
    };
  } finally {
    process.env['PATH'] = savedPath;

    await engine.stop(true);

    rmSync(socketDir, { recursive: true, force: true });
  }
}

test('a base image with ONBUILD triggers is refused once the host has it', async () => {
  const sent = await sendFakeDockerBuild('FROM base.test/onbuild:1\nRUN true\n');

  expect(sent.status).toBe(400);

  expect(sent.body).toMatchObject({
    message: 'FROM base.test/onbuild:1 has ONBUILD triggers, which impd refuses',
  });

  expect(sent.calls).toEqual([
    'version --format {{json .Server.Os}} {{json .Server.Arch}}',
    'image inspect --format PIN base.test/onbuild:1',
  ]);

  expect(sent.built).toEqual([]);
});

test('COPY --from and RUN --mount images are pulled first, like a FROM, by tag or digest', async () => {
  const sent = await sendFakeDockerBuild(
    [
      'FROM base.test/a:1 AS build',
      `COPY --from=tools.test/b@${DIGEST_B} /x /x`,
      'COPY --from=build /x /y',
      'RUN --mount=type=bind,from=mnt.test/c:3,target=/m true',
    ].join('\n'),
  );

  expect(sent.status).toBe(400);

  expect(sent.body).toMatchObject({
    message: 'RUN --mount from mnt.test/c:3: the pull failed: no such registry',
  });

  expect(sent.calls).toEqual([
    'version --format {{json .Server.Os}} {{json .Server.Arch}}',
    'image inspect --format PIN base.test/a:1',
    `image inspect --format PIN tools.test/b@${DIGEST_B}`,
    `pull --quiet tools.test/b@${DIGEST_B}`,
    `image inspect --format PIN tools.test/b@${DIGEST_B}`,
    'image inspect --format PIN mnt.test/c:3',
    'pull --quiet mnt.test/c:3',
  ]);
});

test('the engine builds the Dockerfile with each image pinned and the platform named', async () => {
  const sent = await sendFakeDockerBuild(
    [
      'FROM --platform=$BUILDPLATFORM base.test/a:1 AS build',
      'COPY --from=pulled.test/p:2 /x /x',
      'FROM base.test/retag:1',
      'RUN --mount=from=build,target=/b --mount=from=base.test/a:1,target=/a true',
      '',
    ].join('\n'),
  );

  expect(sent.body).toMatchObject({
    message: 'docker build failed: the fake engine builds nothing',
  });

  expect(sent.built).toEqual([
    [
      `FROM --platform=linux/amd64 base.test/a@${DIGEST_A} AS build`,
      `COPY --from=tools.test/b@${DIGEST_B} /x /x`,
      `FROM other.test/x@${DIGEST_B}`,
      `RUN --mount=from=build,target=/b --mount=from=base.test/a@${DIGEST_A},target=/a true`,
      '',
    ].join('\n'),
  ]);
});

test('the frontend runs the triggers of COPY --from and mount images too, so impd refuses them', async () => {
  const copied = await sendFakeDockerBuild('FROM scratch\nCOPY --from=base.test/onbuild:1 / /\n');

  const mounted = await sendFakeDockerBuild(
    'FROM base.test/a:1\nRUN --mount=from=base.test/onbuild:1,target=/m true\n',
  );

  expect(copied.body).toMatchObject({
    message: 'COPY --from base.test/onbuild:1 has ONBUILD triggers, which impd refuses',
  });

  expect(mounted.body).toMatchObject({
    message: 'RUN --mount from base.test/onbuild:1 has ONBUILD triggers, which impd refuses',
  });

  expect([copied.built, mounted.built]).toEqual([[], []]);
});

test('a ref the build names twice is inspected and pinned once, so a moving tag gives one image', async () => {
  const sent = await sendFakeDockerBuild(
    'FROM base.test/moving:1\nCOPY --from=base.test/moving:1 /x /x\nRUN --mount=from=base.test/moving:1,target=/m true\n',
  );

  const inspects = sent.calls.filter((call) => call.startsWith('image inspect --format PIN'));

  expect(inspects).toEqual(['image inspect --format PIN base.test/moving:1']);

  expect(sent.built).toEqual([
    [
      `FROM base.test/moving@${DIGEST_A}`,
      `COPY --from=base.test/moving@${DIGEST_A} /x /x`,
      `RUN --mount=from=base.test/moving@${DIGEST_A},target=/m true`,
      '',
    ].join('\n'),
  ]);
});

test('the spellings of one image are inspected and pinned once', async () => {
  const sent = await sendFakeDockerBuild(
    'FROM moving:1\nCOPY --from=docker.io/library/moving:1 /x /x\nRUN --mount=from=index.docker.io/library/moving,target=/m true\n',
  );

  const inspects = sent.calls.filter((call) => call.startsWith('image inspect --format PIN'));

  // moving and moving:1 differ: no tag is latest
  expect(inspects).toEqual([
    'image inspect --format PIN moving:1',
    'image inspect --format PIN index.docker.io/library/moving',
  ]);

  expect(sent.built).toEqual([
    [
      `FROM moving@${DIGEST_A}`,
      `COPY --from=moving@${DIGEST_A} /x /x`,
      `RUN --mount=from=moving@${DIGEST_B},target=/m true`,
      '',
    ].join('\n'),
  ]);
});

test('a pinned build the registry denies says how impd pinned it, and what to build from', async () => {
  const sent = await sendFakeDockerBuild(
    'FROM base.test/retag:1\n',
    'pull access denied, repository does not exist or may require authorization',
  );

  expect(sent.body).toMatchObject({
    code: 'BAD_REQUEST',
    message: `docker build failed: pull access denied, repository does not exist or may require authorization\nimpd pinned FROM base.test/retag:1 as other.test/x@${DIGEST_B}. On the containerd image store a retag of a multi-platform image cannot be pinned: build FROM its original repository, such as busybox:1.37, instead of the retag.`,
  });
});

test('an image with no registry digest, or for another platform, is refused before the build', async () => {
  const local = await sendFakeDockerBuild('FROM base.test/local:1\n');
  const copied = await sendFakeDockerBuild('FROM scratch\nCOPY --from=base.test/local:1 / /\n');
  const arm = await sendFakeDockerBuild('FROM base.test/arm:1\n');

  expect(local.body).toMatchObject({
    message:
      'FROM base.test/local:1: this image exists only on this host and has no registry digest, so impd cannot bind the build to it; build FROM a registry image by tag or digest. Local base images are not supported yet (#156).',
  });

  expect(copied.body).toMatchObject({
    message:
      'COPY --from base.test/local:1: this image exists only on this host and has no registry digest, so impd cannot bind the build to it; name a registry image by tag or digest. Local base images are not supported yet (#156).',
  });

  expect(arm.body).toMatchObject({
    message:
      'FROM base.test/arm:1: the host has this image for linux/arm64, and builds for linux/amd64',
  });

  const arm32 = await sendFakeDockerBuild('FROM base.test/arm32:1\n');

  expect(arm32.body).toMatchObject({
    code: 'BAD_REQUEST',
    message:
      'FROM base.test/arm32:1: the host has this image for linux/arm, and builds for linux/amd64',
  });

  expect([local.built, copied.built, arm.built, arm32.built]).toEqual([[], [], [], []]);
});

function readMessage(body: unknown): string {
  return z.object({ message: z.string() }).parse(body).message;
}

// with the image on the host already, no pull would meet the proxy's rule
test('an image or its digest under a registry the pull rule refuses is refused', async () => {
  const named = await sendFakeDockerBuild('FROM 127.0.0.1:5000/x:1\n');
  const pinned = await sendFakeDockerBuild('FROM base.test/private:1\n');

  expect(named.body).toMatchObject({
    message: 'FROM 127.0.0.1:5000/x:1: registry 127.0.0.1:5000 is an IP address',
  });

  expect(pinned.body).toMatchObject({
    message: `FROM base.test/private:1: its registry digests name only registries impd refuses: localhost:5000/x@${DIGEST_A}, 10.0.0.5:5000/y@${DIGEST_B}`,
  });

  expect(named.calls).toEqual(['version --format {{json .Server.Os}} {{json .Server.Arch}}']);

  // the host has it, so no pull would meet the proxy; docker reads the
  // label as localhost in any case
  const local = await sendFakeDockerBuild('FROM LocalHost/name:1\n');

  expect(local.body).toMatchObject({
    message: "FROM LocalHost/name:1: registry LocalHost is the host's own",
  });

  expect(local.calls).toEqual(['version --format {{json .Server.Os}} {{json .Server.Arch}}']);
  expect(local.built).toEqual([]);
  expect([named.built, pinned.built]).toEqual([[], []]);
});

test('a platform variable set by ARG, or another --platform, is refused before any pull', async () => {
  const global = await sendFakeDockerBuild(
    'ARG BUILDPLATFORM=linux/arm64\nFROM --platform=$BUILDPLATFORM base.test/a:1\n',
  );

  const staged = await sendFakeDockerBuild('FROM base.test/a:1\nARG TARGETPLATFORM\n');

  const braced = await sendFakeDockerBuild(
    ['FROM --platform=$', '{BUILDPLATFORM} base.test/a:1\n'].join(''),
  );

  expect(readMessage(global.body)).toContain('line 1: ARG BUILDPLATFORM is refused');
  expect(readMessage(staged.body)).toContain('line 2: ARG TARGETPLATFORM is refused');

  expect(readMessage(braced.body)).toContain(
    ['FROM --platform=$', '{BUILDPLATFORM} is refused'].join(''),
  );

  expect([global.calls, staged.calls, braced.calls]).toEqual([[], [], []]);
});

test('an engine without the Dockerfile frontend pulls it by digest once, before the build', async () => {
  const lacking = await sendFakeDockerBuild('FROM base.test/a:1\n', undefined, 'no-frontend');
  const having = await sendFakeDockerBuild('FROM base.test/a:1\n');

  const inspectCall = `image inspect --format {{.Id}} ${DOCKERFILE_FRONTEND}`;
  const frontendCalls = [inspectCall, `pull --quiet ${DOCKERFILE_FRONTEND}`];

  expect(lacking.callsAtBuild.slice(-2)).toEqual(frontendCalls);
  expect(lacking.calls.filter((call) => call.includes('docker/dockerfile'))).toEqual(frontendCalls);
  expect(lacking.built).toHaveLength(1);

  expect(having.callsAtBuild.filter((call) => call.includes('docker/dockerfile'))).toEqual([
    inspectCall,
  ]);

  expect(having.calls.filter((call) => call.startsWith('pull'))).toEqual([]);
  expect(having.built).toHaveLength(1);
});

test('a failed pull of the Dockerfile frontend fails the build before the engine gets it', async () => {
  const sent = await sendFakeDockerBuild('FROM base.test/a:1\n', undefined, 'unreachable-frontend');

  expect(sent.status).toBe(502);

  expect(sent.body).toMatchObject({
    code: 'BAD_GATEWAY',
    message: `the Dockerfile frontend ${DOCKERFILE_FRONTEND}: the pull failed: no route to host`,
  });

  expect(sent.built).toEqual([]);
});

test('a failed build answers its error and removes the upload', async () => {
  await using ctx = await setupTest({
    build: () => Promise.reject(new Error('disk on fire')),
  });

  const response = await ctx.sendBuild('name=web', 'tar');
  const body: unknown = await response.json();

  expect(response.status).toBe(500);
  expect(body).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: 'disk on fire' });
  expect(ctx.listUploads()).toEqual([]);

  const streamed = await ctx.sendBuild('name=web', 'tar', TEST_TOKEN, STREAM);
  const events = await readEvents(streamed);

  expect(events.at(-1)).toEqual({
    type: 'error',
    code: 'INTERNAL_SERVER_ERROR',
    message: 'disk on fire',
  });

  expect(ctx.listUploads()).toEqual([]);

  const outcomes = await ctx.readOutcomes(2);

  expect(outcomes).toEqual(['INTERNAL_SERVER_ERROR', 'INTERNAL_SERVER_ERROR']);
});

test('a new route clears what an earlier impd left in the uploads directory', async () => {
  await using harness = await setupImpTest();

  const uploadsDir = buildUploadsDir(harness.config.dataDir);
  const leftover = join(uploadsDir, 'old.tar');

  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(leftover, 'half a context');

  createBuildContextRoute({
    config: harness.config,
    images: harness.images,
    diskBudget: harness.diskBudget,
    audit: createApiAudit({ db: harness.db, now: harness.now, log: () => {} }),
    keepaliveMs: BUILD_KEEPALIVE_MS,
    now: harness.now,
  });

  expect(existsSync(leftover)).toBe(false);
});

test('an on-host build reports its unpack, after the engine built the image', async () => {
  const socketDir = mkdtempSync(join(tmpdir(), 'imp-engine-'));
  const socket = join(socketDir, 'docker.sock');
  const builtId = `sha256:${'e'.repeat(64)}`;

  // the engine builds the image at once
  const engine = Bun.serve({
    unix: socket,
    fetch: async (request) => {
      await request.arrayBuffer();

      return new Response(`${JSON.stringify({ id: 'moby.image.id', aux: { ID: builtId } })}\n`);
    },
  });

  await using ctx = await setupTest({
    build: 'image-service',
    env: { DOCKER_HOST: `unix://${socket}` },
  });

  const dataDir = ctx.harness.config.dataDir;
  const contextDir = join(dataDir, 'context');
  const inspect = JSON.stringify([{ Id: builtId, Config: {}, Size: 1 }]);

  // the frontend and the built tag are on the host; the unpack's create fails
  const docker = writeFakeDocker(dataDir, [
    'for last; do :; done',
    'case "$1 $2 $last" in',
    `  "version --format "*) echo '"linux" "x86_64"' ;;`,
    `  "image inspect docker/dockerfile:"*) echo ${builtId} ;;`,
    `  "image inspect imp/web:latest") echo '${inspect}' ;;`,
    '  *) echo "no $1 in this test" >&2; exit 1 ;;',
    'esac',
  ]);

  mkdirSync(contextDir);
  writeFileSync(join(contextDir, 'Dockerfile'), 'FROM scratch\n');

  const phases: string[] = [];
  const savedPath = process.env['PATH'];

  process.env['PATH'] = docker.path;

  try {
    const failure = await ctx.harness.images
      .buildImage(contextDir, 'web', undefined, {
        setPhase: (phase) => {
          phases.push(phase);
        },
      })
      .catch((error: unknown) => error);

    expect(String(failure)).toContain('no create in this test');
    expect(phases).toEqual(['build', 'unpack']);
  } finally {
    process.env['PATH'] = savedPath;

    await engine.stop(true);

    rmSync(socketDir, { recursive: true, force: true });
  }
});

test('on-host builds and uploads share the four build slots', async () => {
  await using ctx = await setupTest();

  const held = [1, 2, 3, 4].map(() => ctx.harness.images.claimBuildSlot());

  // an on-host build waits for no slot: it is refused at once, before any check
  const onHost = await ctx.harness.images
    .buildImage('relative/path', 'web')
    .catch((error: unknown) => error);

  const upload = await ctx.readStatus('name=web', 'tar');

  expect(onHost).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  expect(upload).toBe(429);

  // a slot freed lets the next one through to its own checks
  held[0]?.();

  const next = await ctx.harness.images
    .buildImage('relative/path', 'web')
    .catch((error: unknown) => error);

  expect(next).toMatchObject({ code: 'BAD_REQUEST' });

  for (const release of held.slice(1)) {
    release();
  }
});
