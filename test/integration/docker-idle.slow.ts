// A build whose engine stays silent past Bun's 360 s fetch limit, as a quiet
// RUN step leaves it, through imp-docker-proxy and impd's build call:
// `bun run test:slow`, about 6.5 minutes. Plain `bun test` skips this file.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDockerProxy } from '../../packages/daemon/src/docker-proxy/proxy';
import { runDockerBuild } from '../../packages/daemon/src/images/docker-build';

// past Bun's limit of 360 s, with room for a slow runner
const SILENT_MS = 375_000;
const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const dir = mkdtempSync(join(tmpdir(), 'imp-docker-idle-'));
const engineSocket = join(dir, 'engine.sock');
const proxySocket = join(dir, 'proxy.sock');
const tarPath = join(dir, 'context.tar');

writeFileSync(tarPath, 'the context');

function toChunk(line: unknown): string {
  const text = `${JSON.stringify(line)}\n`;

  return `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
}

// an engine that answers a build at once, then sends nothing until the
// silence ends, as BuildKit does through a RUN step with no output
const engine = createServer((socket) => {
  socket.once('data', () => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n');
    socket.write('Transfer-Encoding: chunked\r\n\r\n');
    socket.write(toChunk({ id: 'moby.buildkit.trace', aux: 'CgQ=' }));

    setTimeout(() => {
      socket.end(`${toChunk({ id: 'moby.image.id', aux: { ID: IMAGE_ID } })}0\r\n\r\n`);
    }, SILENT_MS);
  });

  socket.on('error', () => {});
}).listen(engineSocket);

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
    buildContextMaxBytes: 1024 ** 2,
    log: () => {},
  }),
} as unknown as Bun.Serve.Options<undefined>);

afterAll(async () => {
  await proxy.stop(true);

  engine.close();

  rmSync(dir, { recursive: true, force: true });
});

test(
  'a build silent past 360 s gets its image',
  async () => {
    const startedAt = Date.now();

    const id = await runDockerBuild({
      dockerHost: `unix://${proxySocket}`,
      tarPath,
      tag: 'imp/x:latest',
      dockerfile: undefined,
      signal: new AbortController().signal,
    });

    expect(id).toBe(IMAGE_ID);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SILENT_MS);
  },
  SILENT_MS + 60_000,
);
