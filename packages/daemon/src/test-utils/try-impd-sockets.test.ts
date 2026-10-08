import { expect, onTestFinished, test } from 'bun:test';
import { tryExecSocket, tryTunnelSocket } from './try-impd-sockets';

// a loopback stand-in for impd's own /exec and /tunnel server, to test the
// clients alone: it upgrades every request and echoes each message back
function setupTest() {
  const upgrades: { path: string; query: string; authorization: string | null }[] = [];
  const messages: unknown[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, srv) => {
      const url = new URL(request.url);

      upgrades.push({
        path: url.pathname,
        query: url.search,
        authorization: request.headers.get('authorization'),
      });

      srv.upgrade(request, { data: undefined });
    },
    websocket: {
      message: (socket, message) => {
        messages.push(JSON.parse(String(message)));
        socket.send(`echo ${String(message)}`);
      },
    },
  });

  onTestFinished(() => server.stop(true));

  return {
    port: String(server.port),
    upgrades,
    messages,
  };
}

test('#tryExecSocket sends a start for the name and returns the first message', async () => {
  const ctx = setupTest();

  const reply = await tryExecSocket(ctx.port, 'ticket=abc', 'dev-a');

  expect(reply).toBe('echo {"type":"start","name":"dev-a","argv":["true"],"tty":false}');

  expect(ctx.messages).toStrictEqual([
    { type: 'start', name: 'dev-a', argv: ['true'], tty: false },
  ]);
});

test('#tryExecSocket starts dev when no name is given', async () => {
  const ctx = setupTest();

  await tryExecSocket(ctx.port, '');

  expect(ctx.messages).toStrictEqual([{ type: 'start', name: 'dev', argv: ['true'], tty: false }]);
});

test('#tryExecSocket opens /exec with the query and the headers', async () => {
  const ctx = setupTest();

  await tryExecSocket(ctx.port, 'ticket=abc', 'dev', { authorization: 'Bearer t0k' });

  expect(ctx.upgrades).toStrictEqual([
    { path: '/exec', query: '?ticket=abc', authorization: 'Bearer t0k' },
  ]);
});

test('#tryExecSocket returns rejected when the upgrade is refused', async () => {
  const refusing = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('refused', { status: 401 }),
  });

  onTestFinished(() => refusing.stop(true));

  const reply = await tryExecSocket(String(refusing.port), '');

  expect(reply).toBe('rejected');
});

test('#tryExecSocket returns closed when the server closes without a message', async () => {
  const closing = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, srv) => {
      srv.upgrade(request, { data: undefined });
    },
    websocket: {
      message: (socket) => {
        socket.close();
      },
    },
  });

  onTestFinished(() => closing.stop(true));

  const reply = await tryExecSocket(String(closing.port), '');

  expect(reply).toBe('closed');
});

test('#tryTunnelSocket sends an open for the name on port 5432 and returns the first message', async () => {
  const ctx = setupTest();

  const reply = await tryTunnelSocket(ctx.port, '', {}, 'db');

  expect(reply).toBe('echo {"type":"open","name":"db","port":5432}');
  expect(ctx.messages).toStrictEqual([{ type: 'open', name: 'db', port: 5432 }]);
});

test('#tryTunnelSocket opens nope when no name is given', async () => {
  const ctx = setupTest();

  await tryTunnelSocket(ctx.port, '', {});

  expect(ctx.messages).toStrictEqual([{ type: 'open', name: 'nope', port: 5432 }]);
});

test('#tryTunnelSocket opens /tunnel with the query and the headers', async () => {
  const ctx = setupTest();

  await tryTunnelSocket(ctx.port, 'ticket=abc', { authorization: 'Bearer t0k' });

  expect(ctx.upgrades).toStrictEqual([
    { path: '/tunnel', query: '?ticket=abc', authorization: 'Bearer t0k' },
  ]);
});

test('#tryTunnelSocket returns rejected when the upgrade is refused', async () => {
  const refusing = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('refused', { status: 401 }),
  });

  onTestFinished(() => refusing.stop(true));

  const reply = await tryTunnelSocket(String(refusing.port), '', {});

  expect(reply).toBe('rejected');
});

test('#tryTunnelSocket returns closed when the server closes without a message', async () => {
  const closing = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, srv) => {
      srv.upgrade(request, { data: undefined });
    },
    websocket: {
      message: (socket) => {
        socket.close();
      },
    },
  });

  onTestFinished(() => closing.stop(true));

  const reply = await tryTunnelSocket(String(closing.port), '', {});

  expect(reply).toBe('closed');
});
