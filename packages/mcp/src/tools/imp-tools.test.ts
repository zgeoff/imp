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
  const imp = buildMockImp({ name: 'dev-b' });

  // the imp as it crosses impd's API, its dates as ISO strings, which a
  // structuredClone would keep as dates
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const wire: unknown = JSON.parse(JSON.stringify(imp));

  server.use(
    buildStubImpd('http://impd.test', {
      imps: { fork: impd.imps.fork.handler(() => imp) },
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
      result: {
        content: [{ type: 'text', text: JSON.stringify({ imp: wire }, null, 2) }],
        structuredContent: { imp: wire },
        isError: false,
      },
    },
  ]);
});

test('it reports beside the fork why it got none of the grants', async () => {
  const impd = implement(impContract);
  const mcp = createMcpServer({ version: '1.2.3' });
  const sent: unknown[] = [];
  const imp = buildMockImp({ name: 'dev-b' });

  // the imp as it crosses impd's API, its dates as ISO strings, which a
  // structuredClone would keep as dates
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const wire: unknown = JSON.parse(JSON.stringify(imp));

  server.use(
    buildStubImpd('http://impd.test', {
      imps: {
        fork: impd.imps.fork.handler(() => ({ ...imp, grantsError: 'the grant copy failed' })),
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
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ imp: wire, grantsError: 'the grant copy failed' }, null, 2),
          },
        ],
        structuredContent: { imp: wire, grantsError: 'the grant copy failed' },
        isError: false,
      },
    },
  ]);
});

test('it reports beside the fork each grant it did not get', async () => {
  const impd = implement(impContract);
  const mcp = createMcpServer({ version: '1.2.3' });
  const sent: unknown[] = [];
  const imp = buildMockImp({ name: 'dev-b' });

  // the imp as it crosses impd's API, its dates as ISO strings, which a
  // structuredClone would keep as dates
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const wire: unknown = JSON.parse(JSON.stringify(imp));

  server.use(
    buildStubImpd('http://impd.test', {
      imps: {
        fork: impd.imps.fork.handler(() => ({
          ...imp,
          grantsNotCopied: [{ secret: 'github-token', reason: 'not-grantable' }],
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
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { imp: wire, grantsNotCopied: [{ secret: 'github-token', reason: 'not-grantable' }] },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          imp: wire,
          grantsNotCopied: [{ secret: 'github-token', reason: 'not-grantable' }],
        },
        isError: false,
      },
    },
  ]);
});
