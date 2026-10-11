import { expect, onTestFinished, test } from 'bun:test';
import {
  collectText,
  countMatches,
  openHeldSocket,
  parseReverseForwards,
  sendOverHeldSocket,
  sendRequest,
} from './imp-proxy';
import { waitFor } from './wait-for';

test('#parseReverseForwards reads where each forward listens in the imp, in order', () => {
  const stdout = [
    'forwarding e2e-rev-a:/tmp/e2e-agent.sock -> /home/u/laptop.sock',
    'forwarding e2e-rev-a:40123 -> localhost:8080',
    'forwarding e2e-rev-a:/run/imp/forward/x/1.sock -> /home/u/laptop.sock',
    '',
  ].join('\n');

  expect(parseReverseForwards(stdout)).toStrictEqual([
    '/tmp/e2e-agent.sock',
    '40123',
    '/run/imp/forward/x/1.sock',
  ]);
});

test('#parseReverseForwards skips a line that is not at the start of the output', () => {
  expect(parseReverseForwards('note: forwarding e2e-rev-a:1 -> x\n')).toStrictEqual([]);
});

test('#collectText gives what the stream sent so far', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode('Allocated port 1'));
      controller.close();
    },
  });

  const collected = collectText(stream);

  const text = await waitFor('the text', () => {
    if (collected.read() === '') {
      throw new Error('nothing yet');
    }

    return collected.read();
  });

  expect(text).toBe('Allocated port 1');
});

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

test('#sendOverHeldSocket resolves with the far end’s first reply and leaves the socket open', async () => {
  // echoes each chunk, as `nc -e cat` does
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (socket, chunk) => {
        socket.write(chunk);
      },
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  const held = await openHeldSocket(server.port);

  onTestFinished(() => {
    held.socket.destroy();
  });

  const reply = await sendOverHeldSocket(held, 'x');

  expect(reply).toBe('x');
  expect(held.socket.destroyed).toBeFalse();
});

test('#sendOverHeldSocket rejects when the far end closes before it replies', async () => {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (socket) => {
        socket.end();
      },
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  const held = await openHeldSocket(server.port);

  onTestFinished(() => {
    held.socket.destroy();
  });

  expect(sendOverHeldSocket(held, 'x')).rejects.toThrowWithMessage(
    Error,
    'the held socket closed before a reply',
  );
});
