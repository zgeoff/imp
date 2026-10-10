import { expect, onTestFinished, test } from 'bun:test';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { z } from 'zod';
import { startStubSilentTcpProxy } from './start-stub-silent-tcp-proxy';

// a target on loopback that records what reaches it and keeps its sockets,
// so a test can send to the client through the proxy
async function setupTest() {
  const received: string[] = [];
  const sockets: Socket[] = [];

  const target = createServer((socket) => {
    sockets.push(socket);

    socket.on('data', (data: Buffer) => {
      received.push(data.toString());
    });

    socket.on('error', () => {});
  });

  await new Promise<void>((resolve) => {
    target.listen(0, '127.0.0.1', resolve);
  });

  onTestFinished(() => {
    for (const socket of sockets) {
      socket.destroy();
    }

    target.close();
  });

  // a server listening on a TCP port reports an object with its port
  const address = z.object({ port: z.number() }).parse(target.address());

  return { targetPort: address.port, received, sockets };
}

test('it passes the client’s bytes on to the target and the target’s back', async () => {
  const ctx = await setupTest();
  const proxy = await startStubSilentTcpProxy(ctx.targetPort);

  const back: string[] = [];
  const client = createConnection({ host: '127.0.0.1', port: proxy.port });

  onTestFinished(() => {
    client.destroy();
  });

  client.on('data', (data: Buffer) => {
    back.push(data.toString());
  });

  client.write('ping');

  const socket = await waitFor(() => {
    expect(ctx.received.join('')).toBe('ping');

    const [first] = ctx.sockets;

    invariant(first);

    return first;
  });

  socket.write('pong');

  await waitFor(() => {
    expect(back).not.toBeEmpty();
  });

  expect(back.join('')).toBe('pong');
  expect(ctx.received).toStrictEqual(['ping']);
});

test('it drops the client’s bytes once silent', async () => {
  const ctx = await setupTest();
  const proxy = await startStubSilentTcpProxy(ctx.targetPort);

  const client = createConnection({ host: '127.0.0.1', port: proxy.port });

  onTestFinished(() => {
    client.destroy();
  });

  client.write('before');

  await waitFor(() => {
    expect(ctx.received.join('')).toBe('before');
  });

  proxy.silence();
  client.write('after');

  await waitFor(() => {
    expect(proxy.readDropped()).toBe(5);
  });

  expect(ctx.received.join('')).toBe('before');
});

test('it still passes the target’s bytes to the client once silent', async () => {
  const ctx = await setupTest();
  const proxy = await startStubSilentTcpProxy(ctx.targetPort);

  const back: string[] = [];
  const client = createConnection({ host: '127.0.0.1', port: proxy.port });

  onTestFinished(() => {
    client.destroy();
  });

  client.on('data', (data: Buffer) => {
    back.push(data.toString());
  });

  const socket = await waitFor(() => {
    const [first] = ctx.sockets;

    invariant(first);

    return first;
  });

  proxy.silence();
  socket.write('still here');

  await waitFor(() => {
    expect(back).not.toBeEmpty();
  });

  expect(back.join('')).toBe('still here');
});

test('it stops listening and drops its connections when the test finishes', async () => {
  const ctx = await setupTest();
  const proxy = await startStubSilentTcpProxy(ctx.targetPort);

  const closed = Promise.withResolvers<void>();
  const client = createConnection({ host: '127.0.0.1', port: proxy.port });

  client.on('error', () => {});
  client.once('close', closed.resolve);

  await waitFor(() => {
    expect(ctx.sockets).toHaveLength(1);
  });

  // registered after the proxy's own cleanup, so it runs once that is done
  onTestFinished(async () => {
    await closed.promise;

    const connected = new Promise<void>((resolve, reject) => {
      const probe = createConnection({ host: '127.0.0.1', port: proxy.port });

      probe.once('connect', () => {
        probe.destroy();

        resolve();
      });

      probe.once('error', reject);
    });

    expect(connected).rejects.toThrow('ECONNREFUSED');
  });
});
