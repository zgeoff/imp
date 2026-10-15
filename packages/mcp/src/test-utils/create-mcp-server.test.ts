import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import { createImpGuard } from '../imp-guard';
import { createMcpServer } from './create-mcp-server';

test('it resolves a receive once the request is answered, with the answer sent to its reply', async () => {
  const server = createMcpServer({ version: '1.2.3' });

  onTestFinished(() => server.close());

  const sent: unknown[] = [];

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), {
    reply: (message) => {
      sent.push(JSON.parse(message));
    },
    client: createImpClient({ url: 'http://impd.test' }),
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(sent).toStrictEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
});

test('it sends each answer to the reply of the message it answers', async () => {
  const server = createMcpServer({ version: '1.2.3' });

  onTestFinished(() => server.close());

  const first: unknown[] = [];
  const second: unknown[] = [];

  const context = {
    client: createImpClient({ url: 'http://impd.test' }),
    guard: createImpGuard({ all: true }),
    scope: 'read',
  } as const;

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), {
    ...context,
    reply: (message) => {
      first.push(JSON.parse(message));
    },
  });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }), {
    ...context,
    reply: (message) => {
      second.push(JSON.parse(message));
    },
  });

  expect(first).toStrictEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  expect(second).toStrictEqual([{ jsonrpc: '2.0', id: 2, result: {} }]);
});

test('it resolves a receive of a notification with nothing sent', async () => {
  const server = createMcpServer({ version: '1.2.3' });

  onTestFinished(() => server.close());

  const sent: unknown[] = [];

  await server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), {
    reply: (message) => {
      sent.push(JSON.parse(message));
    },
    client: createImpClient({ url: 'http://impd.test' }),
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(sent).toBeEmpty();
});
