import { expect, test } from 'bun:test';
import { TunnelClientMessageSchema, TunnelServerMessageSchema } from './tunnel-protocol';

test('#TunnelClientMessageSchema accepts an open of a guest port', () => {
  const payload = { type: 'open', name: 'dev', port: 8080 } as const;

  expect(TunnelClientMessageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#TunnelClientMessageSchema rejects an open of an imp name that is not a name', () => {
  const result = TunnelClientMessageSchema.safeParse({ type: 'open', name: 'Dev', port: 8080 });

  expect(result.error?.issues).toPartiallyContain({ path: ['name'], code: 'invalid_format' });
});

test.each([
  [0, 'too_small'],
  [65_536, 'too_big'],
  [80.5, 'invalid_type'],
])('#TunnelClientMessageSchema rejects an open of port %p with %s', (port, code) => {
  const result = TunnelClientMessageSchema.safeParse({ type: 'open', name: 'dev', port });

  expect(result.error?.issues).toPartiallyContain({ path: ['port'], code });
});

test('#TunnelClientMessageSchema accepts an eof', () => {
  expect(TunnelClientMessageSchema.safeParse({ type: 'eof' }).data).toStrictEqual({ type: 'eof' });
});

test('#TunnelClientMessageSchema accepts an ack of delivered bytes', () => {
  const payload = { type: 'ack', bytes: 65_536 } as const;

  expect(TunnelClientMessageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test.each([
  [0, 'too_small'],
  [1.5, 'invalid_type'],
])('#TunnelClientMessageSchema rejects an ack of %p bytes with %s', (bytes, code) => {
  const result = TunnelClientMessageSchema.safeParse({ type: 'ack', bytes });

  expect(result.error?.issues).toPartiallyContain({ path: ['bytes'], code });
});

test('#TunnelClientMessageSchema accepts a tcp listen on a port', () => {
  const payload = { type: 'listen', name: 'dev', network: 'tcp', port: 0 } as const;

  expect(TunnelClientMessageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#TunnelClientMessageSchema accepts a unix listen on a path', () => {
  const payload = { type: 'listen', name: 'dev', network: 'unix', path: '/tmp/app.sock' } as const;

  expect(TunnelClientMessageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#TunnelClientMessageSchema accepts a unix listen on a path the agent makes', () => {
  const payload = { type: 'listen', name: 'dev', network: 'unix', path: null } as const;

  expect(TunnelClientMessageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#TunnelClientMessageSchema rejects a listen of an imp name that is not a name', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'Dev',
    network: 'tcp',
    port: 0,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['name'], code: 'invalid_format' });
});

test('#TunnelClientMessageSchema rejects a listen on a network outside the list', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'udp',
    port: 0,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['network'], code: 'invalid_value' });
});

test('#TunnelClientMessageSchema rejects a unix listen on a relative path', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'unix',
    path: 'tmp/app.sock',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['path'], code: 'invalid_format' });
});

test('#TunnelClientMessageSchema rejects a tcp listen on a port over 65535', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'tcp',
    port: 65_536,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['port'], code: 'too_big' });
});

test('#TunnelClientMessageSchema rejects a tcp listen without a port', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'tcp',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['network'],
    message: 'tcp takes a port, unix a path or null',
  });
});

test('#TunnelClientMessageSchema rejects a tcp listen with a path', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'tcp',
    path: '/tmp/app.sock',
    port: 0,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['network'],
    message: 'tcp takes a port, unix a path or null',
  });
});

test('#TunnelClientMessageSchema rejects a unix listen with a port', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'unix',
    path: '/tmp/app.sock',
    port: 0,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['network'],
    message: 'tcp takes a port, unix a path or null',
  });
});

test('#TunnelClientMessageSchema accepts an accept of a connection', () => {
  const payload = { type: 'accept', name: 'dev', listener: 'l-1', connection: 3 } as const;

  expect(TunnelClientMessageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#TunnelClientMessageSchema rejects an accept of an imp name that is not a name', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'accept',
    name: 'Dev',
    listener: 'l-1',
    connection: 3,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['name'], code: 'invalid_format' });
});

test('#TunnelClientMessageSchema rejects an accept with an empty listener', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'accept',
    name: 'dev',
    listener: '',
    connection: 3,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['listener'], code: 'too_small' });
});

test('#TunnelClientMessageSchema rejects an accept of connection zero', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'accept',
    name: 'dev',
    listener: 'l-1',
    connection: 0,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['connection'], code: 'too_small' });
});

test('#TunnelClientMessageSchema rejects an unknown message type', () => {
  const result = TunnelClientMessageSchema.safeParse({ type: 'close' });

  expect(result.error?.issues).toPartiallyContain({ path: ['type'], code: 'invalid_union' });
});

test.each(['opened', 'eof'])('#TunnelServerMessageSchema accepts a bare %s', (type) => {
  expect(TunnelServerMessageSchema.safeParse({ type }).data).toStrictEqual({ type });
});

test('#TunnelServerMessageSchema accepts an ack of delivered bytes', () => {
  const payload = { type: 'ack', bytes: 1024 } as const;

  expect(TunnelServerMessageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#TunnelServerMessageSchema rejects an ack of zero bytes', () => {
  const result = TunnelServerMessageSchema.safeParse({ type: 'ack', bytes: 0 });

  expect(result.error?.issues).toPartiallyContain({ path: ['bytes'], code: 'too_small' });
});

test('#TunnelServerMessageSchema accepts a listening on a port', () => {
  const payload = { type: 'listening', listener: 'l-1', path: null, port: 41_234 } as const;

  expect(TunnelServerMessageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#TunnelServerMessageSchema rejects a listening on a fractional port', () => {
  const result = TunnelServerMessageSchema.safeParse({
    type: 'listening',
    listener: 'l-1',
    path: null,
    port: 4.5,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['port'], code: 'invalid_type' });
});

test('#TunnelServerMessageSchema accepts a connection waiting for an accept', () => {
  const payload = { type: 'connection', id: 3 } as const;

  expect(TunnelServerMessageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#TunnelServerMessageSchema rejects connection id zero', () => {
  const result = TunnelServerMessageSchema.safeParse({ type: 'connection', id: 0 });

  expect(result.error?.issues).toPartiallyContain({ path: ['id'], code: 'too_small' });
});

test('#TunnelServerMessageSchema accepts an error with a code', () => {
  const payload = { type: 'error', message: 'nothing listens there', code: 'DIAL_FAILED' } as const;

  expect(TunnelServerMessageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#TunnelServerMessageSchema rejects an unknown message type', () => {
  const result = TunnelServerMessageSchema.safeParse({ type: 'listen' });

  expect(result.error?.issues).toPartiallyContain({ path: ['type'], code: 'invalid_union' });
});
