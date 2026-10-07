import { expect, test } from 'bun:test';
import { impContract } from '@imp/api';
import { buildMockImp } from '@imp/api/test-utils/build-mock-imp';
import { server } from '@imp/test-utils/mock-server';
import { implement } from '@orpc/server';
import { createImpClient } from '@zgeoff/imp-client';
import { createImpGuard } from '../imp-guard';
import { createMcpServer } from '../mcp-server';
import { buildStubImpd } from '../test-utils/build-stub-impd';

test('it leaves the grant report out of a fork from an impd that sends none', async () => {
  const impd = implement(impContract);
  const mcp = createMcpServer({ version: '1.2.3' });
  const sent: unknown[] = [];

  server.use(
    buildStubImpd('http://impd.test', {
      imps: { fork: impd.imps.fork.handler(() => buildMockImp({ name: 'dev-b' })) },
    }),
  );

  await mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'dev-a', name: 'dev-b' } },
    }),
    {
      reply: (message) => {
        sent.push(JSON.parse(message));
      },
      client: createImpClient({ url: 'http://impd.test' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: expect.objectContaining({
        isError: false,
        structuredContent: { imp: expect.objectContaining({ name: 'dev-b' }) as unknown },
      }) as unknown,
    },
  ]);
});

test('it reports beside the fork why it got none of the grants', async () => {
  const impd = implement(impContract);
  const mcp = createMcpServer({ version: '1.2.3' });
  const sent: unknown[] = [];

  server.use(
    buildStubImpd('http://impd.test', {
      imps: {
        fork: impd.imps.fork.handler(() => ({
          ...buildMockImp({ name: 'dev-b' }),
          grantsError: 'the grant copy failed',
        })),
      },
    }),
  );

  await mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'dev-a', name: 'dev-b' } },
    }),
    {
      reply: (message) => {
        sent.push(JSON.parse(message));
      },
      client: createImpClient({ url: 'http://impd.test' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: expect.objectContaining({
        isError: false,
        structuredContent: {
          imp: expect.objectContaining({ name: 'dev-b' }) as unknown,
          grantsError: 'the grant copy failed',
        },
      }) as unknown,
    },
  ]);
});
