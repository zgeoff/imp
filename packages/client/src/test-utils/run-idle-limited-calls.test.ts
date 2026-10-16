import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';

function setupTest() {
  // impd's answer to any call at once, as oRPC encodes it
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      await request.text();

      return Response.json({ json: { path: new URL(request.url).pathname } });
    },
  });

  onTestFinished(() => server.stop(true));

  return { url: `http://127.0.0.1:${String(server.port)}` };
}

test('it prints each call’s outcome as a JSON line', async () => {
  const ctx = setupTest();

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-idle-limited-calls.ts'),
      JSON.stringify({ url: ctx.url }),
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
    { kind: 'backups.run', isOk: true, answer: { path: '/rpc/backups/run' } },
    { kind: 'imps.list', isOk: true, answer: { path: '/rpc/imps/list' } },
  ]);
});
