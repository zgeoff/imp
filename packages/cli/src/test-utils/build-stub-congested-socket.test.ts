import { expect, onTestFinished, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { buildStubCongestedSocket } from './build-stub-congested-socket';
import { startStubImpd } from './start-stub-impd';

test('it reports the queued bytes the test sets as its buffered amount', () => {
  const ws = new WebSocket('ws://127.0.0.1:1/exec');

  onTestFinished(() => {
    ws.close();
  });

  const stub = buildStubCongestedSocket(ws);

  stub.queued.bytes = 2048;

  expect(stub.socket.bufferedAmount).toBe(2048);
});

test('it sends through the real socket', async () => {
  using impd = startStubImpd();

  const ws = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`, {
    headers: { authorization: `Bearer ${impd.token}` },
  });

  const stub = buildStubCongestedSocket(ws);

  onTestFinished(() => {
    stub.socket.close();
  });

  stub.socket.addEventListener('open', () => {
    stub.socket.send(JSON.stringify({ type: 'stdin_eof' }));
  });

  await waitFor(() => {
    expect(impd.received).toStrictEqual([{ type: 'stdin_eof' }]);
  });
});

test('it sets the binary type on the real socket', () => {
  const ws = new WebSocket('ws://127.0.0.1:1/exec');

  onTestFinished(() => {
    ws.close();
  });

  const stub = buildStubCongestedSocket(ws);

  stub.socket.binaryType = 'arraybuffer';

  expect(ws.binaryType).toBe('arraybuffer');
});
