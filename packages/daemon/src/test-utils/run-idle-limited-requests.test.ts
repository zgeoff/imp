import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROXY_LABEL } from '../docker-proxy/proxy';

function setupTest() {
  // an origin that answers each path at once, with the path it got
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      await request.text();

      return new Response(`answered ${new URL(request.url).pathname}`);
    },
  });

  onTestFinished(() => server.stop(true));

  return { origin: `http://127.0.0.1:${String(server.port)}` };
}

test('it prints the outcome of imp-docker-proxy’s pull and export as JSON lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idle-limited-engine-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const socket = join(dir, 'engine.sock');

  // an engine that answers each call at once: the export's ownership
  // inspect with a container of this proxy's, the rest with their path
  const engine = Bun.serve({
    unix: socket,
    fetch: async (request: Request) => {
      await request.text();

      const path = new URL(request.url).pathname;

      return path.endsWith('/json')
        ? Response.json({ Id: 'a'.repeat(64), Config: { Labels: { [PROXY_LABEL]: 'test-token' } } })
        : new Response(`answered ${path}`);
    },
  });

  onTestFinished(() => engine.stop(true));

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-idle-limited-requests.ts'),
      JSON.stringify({ via: 'docker-proxy', socket }),
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );

  onTestFinished(() => {
    child.kill();
  });

  const output = await new Response(child.stdout).text();

  const lines = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

  expect(lines).toIncludeSameMembers([
    { kind: 'control', isOk: true, status: 200, body: 'answered /control' },
    { kind: 'pull', isOk: true, status: 200, body: 'answered /v1.55/images/create' },
    {
      kind: 'export',
      isOk: true,
      status: 200,
      body: `answered /v1.55/containers/${'a'.repeat(64)}/export`,
    },
  ]);
});

test.each(['long-request', 'wake-proxy'])(
  'it prints each outcome as a JSON line through %s',
  async (via) => {
    const ctx = setupTest();

    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'run-idle-limited-requests.ts'),
        JSON.stringify({ origin: ctx.origin, via }),
      ],
      { stdout: 'pipe', stderr: 'inherit' },
    );

    onTestFinished(() => {
      child.kill();
    });

    const output = await new Response(child.stdout).text();

    const lines = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);

    expect(lines).toIncludeSameMembers([
      { kind: 'control', isOk: true, status: 200, body: 'answered /control' },
      { kind: 'long', isOk: true, status: 200, body: 'answered /long' },
    ]);
  },
);
