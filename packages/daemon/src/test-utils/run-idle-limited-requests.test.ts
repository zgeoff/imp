import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';

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
