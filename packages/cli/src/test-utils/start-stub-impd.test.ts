import { expect, onTestFinished, test } from 'bun:test';
import { EXEC_CHANNELS, ExecServerMessageSchema, encodeExecFrame } from '@imp/api';
import { buildMockImage } from '@imp/api/test-utils/build-mock-image';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
import { startStubImpd } from './start-stub-impd';

test('it answers a procedure with its output as oRPC encodes it', async () => {
  const image = buildMockImage();

  using impd = startStubImpd({ rpc: { 'images/list': { output: [image] } } });

  const client = createImpClient({ url: impd.url, token: impd.token });

  const answer = await client.images.list();

  expect(answer).toStrictEqual([image]);
});

test('it streams an event iterator’s events and then ends it', async () => {
  const image = buildMockImage();
  const progress = { type: 'progress', phase: 'pull', elapsedMs: 0 } as const;

  using impd = startStubImpd({
    rpc: { 'images/addStream': { events: [progress, { type: 'image', image }] } },
  });

  const client = createImpClient({ url: impd.url, token: impd.token });

  const stream = await client.images.addStream({ ref: image.ref });
  const events = await Array.fromAsync(stream);

  expect(events).toStrictEqual([progress, { type: 'image', image }]);
});

test('it answers NOT_FOUND for a procedure it was not given', () => {
  using impd = startStubImpd();

  const client = createImpClient({ url: impd.url, token: impd.token });

  expect(client.system.info()).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
});

test('it refuses a token that is not its own', () => {
  using impd = startStubImpd({ rpc: { 'system/info': { output: {} } } });

  const client = createImpClient({ url: impd.url, token: 'another-token' });

  expect(client.system.info()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
});

test('it records each procedure a client called', async () => {
  using impd = startStubImpd({ rpc: { 'system/info': { output: {} } } });

  const client = createImpClient({ url: impd.url, token: impd.token });

  await client.system.info();

  expect(impd.calls).toStrictEqual(['system/info']);
});

test('it records each exec message as the protocol parses it', async () => {
  using impd = startStubImpd();

  const ws = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`, {
    headers: { authorization: `Bearer ${impd.token}` },
  });

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'start', name: 'box', argv: ['cat'], tty: false }));
    ws.send(encodeExecFrame(EXEC_CHANNELS.stdin, new TextEncoder().encode('typed')));
    ws.send(JSON.stringify({ type: 'stdin_eof' }));
  });

  await waitFor(() => {
    expect(impd.received).toHaveLength(3);
  });

  expect(impd.received).toStrictEqual([
    { type: 'start', name: 'box', argv: ['cat'], tty: false },
    { type: 'stdin', text: 'typed', bytes: 5 },
    { type: 'stdin_eof' },
  ]);
});

test('it sends the client what the exec script sends, frames on any channel included', async () => {
  using impd = startStubImpd({
    onExec: (peer) => {
      peer.send({ type: 'started', pid: 7 });
      peer.sendFrame(9, 'odd');
      peer.sendText('{not json');
    },
  });

  const texts: string[] = [];
  const frames: { channel: number; text: string }[] = [];

  const ws = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`, {
    headers: { authorization: `Bearer ${impd.token}` },
  });

  ws.binaryType = 'arraybuffer';

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'start', name: 'box', argv: ['cat'], tty: false }));
  });

  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      // the channel byte, then the data
      const bytes = new Uint8Array(event.data);

      frames.push({ channel: bytes[0] ?? -1, text: new TextDecoder().decode(bytes.subarray(1)) });
    } else {
      texts.push(String(event.data));
    }
  });

  await waitFor(() => {
    expect(texts).toHaveLength(2);
  });

  expect(ExecServerMessageSchema.parse(JSON.parse(texts[0] ?? ''))).toStrictEqual({
    type: 'started',
    pid: 7,
  });

  expect(texts[1]).toBe('{not json');
  expect(frames).toStrictEqual([{ channel: 9, text: 'odd' }]);
});

test('it closes the exec socket with the code and reason the script gives', async () => {
  using impd = startStubImpd({
    onExec: (peer) => {
      peer.close(1011, 'agent gone');
    },
  });

  const ws = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`, {
    headers: { authorization: `Bearer ${impd.token}` },
  });

  const closing = Promise.withResolvers<CloseEvent>();

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'stdin_eof' }));
  });

  ws.addEventListener('close', (event) => {
    closing.resolve(event);
  });

  const event = await closing.promise;

  expect({ code: event.code, reason: event.reason }).toStrictEqual({
    code: 1011,
    reason: 'agent gone',
  });
});

test('it resolves closed once the client closed its exec socket', async () => {
  using impd = startStubImpd();

  const ws = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`, {
    headers: { authorization: `Bearer ${impd.token}` },
  });

  ws.addEventListener('open', () => {
    ws.close();
  });

  await expect(impd.closed).toResolve();
});

test('it serves the exec socket and the procedures under its prefix', async () => {
  using impd = startStubImpd({ prefix: '/imp', rpc: { 'system/info': { output: {} } } });

  const client = createImpClient({ url: impd.url, token: impd.token });

  await client.system.info();

  expect(impd.paths).toStrictEqual(['/imp/rpc/system/info']);
});
