import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { buildStubMcpTransport } from './build-stub-mcp-transport';

test('it answers each request with an open event stream', async () => {
  const transport = buildStubMcpTransport();

  const response = await transport.handle(new Request('http://imp.test/mcp', { method: 'POST' }));

  expect({
    status: response.status,
    type: response.headers.get('content-type'),
    open: response.body !== null,
  }).toStrictEqual({ status: 200, type: 'text/event-stream', open: true });
});

test('it records each request it took, in order', async () => {
  const transport = buildStubMcpTransport();

  const first = new Request('http://imp.test/mcp', { method: 'POST' });
  const second = new Request('http://imp.test/mcp', { method: 'DELETE' });

  await transport.handle(first);
  await transport.handle(second);

  expect(transport.calls.map((call) => call.request)).toStrictEqual([first, second]);
});

test('it ends a call’s tool only when the test ends it', async () => {
  const transport = buildStubMcpTransport();

  const response = await transport.handle(new Request('http://imp.test/mcp', { method: 'POST' }));

  const ended = transport.readCallEnd(response);

  invariant(ended);

  const raced = await Promise.race([ended, Promise.resolve('open')]);

  const [call] = transport.calls;

  invariant(call);

  call.end();

  expect(raced).toBe('open');

  await expect(ended).toResolve();
});

test('it reads no call end for a response it did not make', () => {
  const transport = buildStubMcpTransport();

  expect(transport.readCallEnd(new Response('other'))).toBeNull();
});

test('it counts each close', async () => {
  const transport = buildStubMcpTransport();

  await transport.close();
  await transport.close();

  expect(transport.closes).toBe(2);
});
