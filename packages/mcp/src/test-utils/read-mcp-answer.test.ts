import { expect, test } from 'bun:test';
import { readMcpAnswer } from './read-mcp-answer';

test('it reads the answer from a JSON body', async () => {
  const response = Response.json({ jsonrpc: '2.0', id: 1, result: {} });

  const answer = await readMcpAnswer(response);

  expect(answer).toStrictEqual({ jsonrpc: '2.0', id: 1, result: {} });
});

test('it reads the answer from an event stream, past progress and keepalives', async () => {
  const response = new Response(
    [
      ': keepalive',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":1,"progress":1}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"unknown tool: x"}}',
      '',
      '',
    ].join('\n'),
    { headers: { 'content-type': 'text/event-stream' } },
  );

  const answer = await readMcpAnswer(response);

  expect(answer).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32_602, message: 'unknown tool: x' },
  });
});

test('it throws for an event stream that ends with no answer', () => {
  const response = new Response(': keepalive\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });

  expect(readMcpAnswer(response)).rejects.toThrowWithMessage(
    Error,
    /the event stream carries no answer/u,
  );
});
