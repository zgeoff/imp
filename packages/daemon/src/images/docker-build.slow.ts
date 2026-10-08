// A build whose engine stays silent past Bun's 360 s fetch limit, as a quiet
// RUN step leaves it, through imp-docker-proxy and impd's build call:
// `bun run test:slow`, about 6.5 minutes. Plain `bun test` skips this file.
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDockerProxy } from '../docker-proxy/proxy';
import { startStubSilentBuildEngine } from '../test-utils/start-stub-silent-build-engine';
import { runDockerBuild } from './docker-build';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'imp-docker-idle-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const engineSocket = join(dir, 'engine.sock');
  const proxySocket = join(dir, 'proxy.sock');
  const tarPath = join(dir, 'context.tar');

  // the build's body: the stub engine never reads it
  await writeFile(tarPath, 'the context');

  // as imp-docker-proxy's main serves it; Bun's types leave idleTimeout off
  // unix servers, but it applies there too
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  const proxy = Bun.serve({
    unix: proxySocket,
    idleTimeout: 0,
    fetch: createDockerProxy({
      upstreamSocket: engineSocket,
      token: 'test-token',
      hostImage: 'ghcr.io/zgeoff/imp-host:latest',

      // host isolation: the proxy lets builds through
      builderImage: null,
      buildContextMaxBytes: 1024 ** 2,
      log: () => {},
    }),
  } as unknown as Bun.Serve.Options<undefined>);

  stack.defer(() => proxy.stop(true));

  const owned = stack.move();

  return {
    engineSocket,
    proxySocket,
    tarPath,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test(
  'it gets the image of a build silent past 360 s',
  async () => {
    await using ctx = await setupTest();

    // past Bun's limit of 360 s, with room for a slow runner
    // declared after ctx, so the engine closes before ctx's dir goes
    await using held = new AsyncDisposableStack();

    const engine = await startStubSilentBuildEngine({
      socketPath: ctx.engineSocket,
      imageId: `sha256:${'c'.repeat(64)}`,
      holdUntil: () => Bun.sleep(375_000),
    });

    held.use(engine);

    const startedAt = Date.now();

    const id = await runDockerBuild({
      dockerHost: `unix://${ctx.proxySocket}`,
      tarPath: ctx.tarPath,
      tag: 'imp/x:latest',
      dockerfile: undefined,
      signal: new AbortController().signal,
    });

    expect(id).toBe(`sha256:${'c'.repeat(64)}`);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(375_000);
  },
  375_000 + 60_000,
);
