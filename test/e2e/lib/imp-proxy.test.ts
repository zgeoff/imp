import { expect, onTestFinished, test } from 'bun:test';
import { countMatches, openHeldSocket, sendRequest } from './imp-proxy';

test('#countMatches counts each occurrence of the needle', () => {
  expect(countMatches('ok\nok\nnope\nok\n', 'ok')).toBe(3);
});

test('#countMatches counts none in text without the needle', () => {
  expect(countMatches('nope\n', 'ok')).toBe(0);
});

test('#sendRequest half-closes after the body and resolves with all the far end sent', async () => {
  // echoes once it has the whole request, then closes
  const server = Bun.listen<{ received: string }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (socket) => {
        socket.data = { received: '' };
      },
      data: (socket, chunk) => {
        socket.data.received += chunk.toString();
      },
      end: (socket) => {
        socket.write(`got ${socket.data.received}`);
        socket.end();
      },
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  const reply = await sendRequest(server.port, 'ping');

  expect(reply).toBe('got ping');
});

test('#sendRequest rejects when nothing listens', () => {
  // a port that was free a moment ago
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const port = server.port;

  server.stop(true);

  expect(sendRequest(port, 'ping')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});

test('#openHeldSocket settles closed when the far end closes the connection', async () => {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (socket) => {
        socket.end();
      },
      data: () => {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  const held = await openHeldSocket(server.port);

  onTestFinished(() => {
    held.socket.destroy();
  });

  await expect(held.closed).toResolve();
});
