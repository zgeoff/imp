import { expect, onTestFinished, test } from 'bun:test';
import { openBunWebSocket } from './open-bun-web-socket';

test('it sends the headers with the upgrade, not in the URL', async () => {
  const upgraded = Promise.withResolvers<{ path: string; authorization: string | null }>();

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, bun) => {
      const url = new URL(request.url);

      upgraded.resolve({
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.get('authorization'),
      });

      return bun.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
    },
    websocket: { message: () => {} },
  });

  onTestFinished(() => server.stop(true));

  const ws = openBunWebSocket(`ws://127.0.0.1:${String(server.port)}/exec`, {
    authorization: 'Bearer root-token',
  });

  onTestFinished(() => {
    ws.close();
  });

  const upgrade = await upgraded.promise;

  expect(upgrade).toStrictEqual({
    path: '/exec',
    authorization: 'Bearer root-token',
  });
});
