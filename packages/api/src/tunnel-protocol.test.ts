import { expect, test } from 'bun:test';
import { TunnelClientMessageSchema, TunnelServerMessageSchema } from './tunnel-protocol';

test('#TunnelClientMessageSchema accepts an open of a guest port', () => {
  const payload = { type: 'open', name: 'dev', port: 8080 } as const;
  const result = TunnelClientMessageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TunnelClientMessageSchema rejects an open of an imp name that is not a name', () => {
  const result = TunnelClientMessageSchema.safeParse({ type: 'open', name: 'Dev', port: 8080 });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['name'] }));
});

test.each([0, 65_536, 80.5])('#TunnelClientMessageSchema rejects an open of port %p', (port) => {
  const result = TunnelClientMessageSchema.safeParse({ type: 'open', name: 'dev', port });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['port'] }));
});

test('#TunnelClientMessageSchema accepts an eof', () => {
  expect(TunnelClientMessageSchema.safeParse({ type: 'eof' }).data).toStrictEqual({ type: 'eof' });
});

test('#TunnelClientMessageSchema accepts an ack of delivered bytes', () => {
  const payload = { type: 'ack', bytes: 65_536 } as const;
  const result = TunnelClientMessageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test.each([0, 1.5])('#TunnelClientMessageSchema rejects an ack of %p bytes', (bytes) => {
  const result = TunnelClientMessageSchema.safeParse({ type: 'ack', bytes });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['bytes'] }));
});

test('#TunnelClientMessageSchema accepts a tcp listen on a port', () => {
  const payload = { type: 'listen', name: 'dev', network: 'tcp', port: 0 } as const;
  const result = TunnelClientMessageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TunnelClientMessageSchema accepts a unix listen on a path', () => {
  const payload = { type: 'listen', name: 'dev', network: 'unix', path: '/tmp/app.sock' } as const;
  const result = TunnelClientMessageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TunnelClientMessageSchema accepts a unix listen on a path the agent makes', () => {
  const payload = { type: 'listen', name: 'dev', network: 'unix', path: null } as const;
  const result = TunnelClientMessageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TunnelClientMessageSchema rejects a listen of an imp name that is not a name', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'Dev',
    network: 'tcp',
    port: 0,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['name'] }));
});

test('#TunnelClientMessageSchema rejects a listen on a network outside the list', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'udp',
    port: 0,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['network'] }));
});

test('#TunnelClientMessageSchema rejects a unix listen on a relative path', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'unix',
    path: 'tmp/app.sock',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['path'] }));
});

test('#TunnelClientMessageSchema rejects a tcp listen on a port over 65535', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'tcp',
    port: 65_536,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['port'] }));
});

test('#TunnelClientMessageSchema rejects a tcp listen without a port', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'tcp',
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['network'],
      message: 'tcp takes a port, unix a path or null',
    }),
  );
});

test('#TunnelClientMessageSchema rejects a tcp listen with a path', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'tcp',
    path: '/tmp/app.sock',
    port: 0,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['network'],
      message: 'tcp takes a port, unix a path or null',
    }),
  );
});

test('#TunnelClientMessageSchema rejects a unix listen with a port', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'listen',
    name: 'dev',
    network: 'unix',
    path: '/tmp/app.sock',
    port: 0,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['network'],
      message: 'tcp takes a port, unix a path or null',
    }),
  );
});

test('#TunnelClientMessageSchema accepts an accept of a connection', () => {
  const payload = { type: 'accept', name: 'dev', listener: 'l-1', connection: 3 } as const;
  const result = TunnelClientMessageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TunnelClientMessageSchema rejects an accept of an imp name that is not a name', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'accept',
    name: 'Dev',
    listener: 'l-1',
    connection: 3,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['name'] }));
});

test('#TunnelClientMessageSchema rejects an accept with an empty listener', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'accept',
    name: 'dev',
    listener: '',
    connection: 3,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['listener'] }));
});

test('#TunnelClientMessageSchema rejects an accept of connection zero', () => {
  const result = TunnelClientMessageSchema.safeParse({
    type: 'accept',
    name: 'dev',
    listener: 'l-1',
    connection: 0,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['connection'] }),
  );
});

test('#TunnelClientMessageSchema rejects an unknown message type', () => {
  const result = TunnelClientMessageSchema.safeParse({ type: 'close' });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['type'] }));
});

test.each(['opened', 'eof'])('#TunnelServerMessageSchema accepts a bare %s', (type) => {
  expect(TunnelServerMessageSchema.safeParse({ type }).data).toStrictEqual({ type });
});

test('#TunnelServerMessageSchema accepts an ack of delivered bytes', () => {
  const payload = { type: 'ack', bytes: 1024 } as const;
  const result = TunnelServerMessageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TunnelServerMessageSchema rejects an ack of zero bytes', () => {
  const result = TunnelServerMessageSchema.safeParse({ type: 'ack', bytes: 0 });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['bytes'] }));
});

test('#TunnelServerMessageSchema accepts a listening on a port', () => {
  const payload = { type: 'listening', listener: 'l-1', path: null, port: 41_234 } as const;
  const result = TunnelServerMessageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TunnelServerMessageSchema rejects a listening on a fractional port', () => {
  const result = TunnelServerMessageSchema.safeParse({
    type: 'listening',
    listener: 'l-1',
    path: null,
    port: 4.5,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['port'] }));
});

test('#TunnelServerMessageSchema accepts a connection waiting for an accept', () => {
  const payload = { type: 'connection', id: 3 } as const;
  const result = TunnelServerMessageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TunnelServerMessageSchema rejects connection id zero', () => {
  const result = TunnelServerMessageSchema.safeParse({ type: 'connection', id: 0 });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['id'] }));
});

test('#TunnelServerMessageSchema accepts an error with a code', () => {
  const payload = { type: 'error', message: 'nothing listens there', code: 'DIAL_FAILED' } as const;
  const result = TunnelServerMessageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TunnelServerMessageSchema rejects an unknown message type', () => {
  const result = TunnelServerMessageSchema.safeParse({ type: 'listen' });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['type'] }));
});
