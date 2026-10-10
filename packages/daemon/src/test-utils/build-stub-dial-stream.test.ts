import { expect, test } from 'bun:test';
import type { DialEvent } from '../agent-client/dial-stream';
import { buildStubDialStream } from './build-stub-dial-stream';

test('it yields the guest events in order and ends with the relay', async () => {
  const dial = buildStubDialStream();

  dial.emit({ type: 'data', data: new TextEncoder().encode('rows') });
  dial.emit({ type: 'eof' });
  dial.end();

  const events = await Array.fromAsync(dial.stream.events());

  expect(events).toStrictEqual<DialEvent[]>([
    { type: 'data', data: new TextEncoder().encode('rows') },
    { type: 'eof' },
  ]);
});

test('it ends the events once impd closes the relay', async () => {
  const dial = buildStubDialStream();

  dial.stream.close();

  const events = await Array.fromAsync(dial.stream.events());

  expect(events).toStrictEqual([]);
  expect(dial.state.isClosed).toBeTrue();
});

test('it throws from the events when the agent connection breaks', () => {
  const dial = buildStubDialStream();

  dial.fail(new Error('connection reset'));

  expect(Array.fromAsync(dial.stream.events())).rejects.toThrowWithMessage(
    Error,
    'connection reset',
  );
});

test('it records each write as text and the half-close', () => {
  const dial = buildStubDialStream();

  dial.stream.write(new TextEncoder().encode('query'));
  dial.stream.end();

  expect(dial.state.written).toStrictEqual(['query']);
  expect(dial.state.isEnded).toBeTrue();
});

test('it counts the items impd has not read yet', async () => {
  const dial = buildStubDialStream();

  dial.emit({ type: 'eof' });
  dial.end();

  const before = dial.countUnread();

  await Array.fromAsync(dial.stream.events());

  expect(before).toBe(2);
  expect(dial.countUnread()).toBe(0);
});

test('it settles a drain at once unless held', async () => {
  const dial = buildStubDialStream();

  await expect(dial.stream.drained()).toResolve();

  expect(dial.state.drainWaits).toBe(1);
});

test('it holds a drain until the release runs', async () => {
  const dial = buildStubDialStream();
  const release = dial.holdDrain();
  const drained = dial.stream.drained();

  const whileHeld = await Promise.race([drained, Promise.resolve('held')]);

  release();

  expect(whileHeld).toBe('held');

  await expect(drained).toResolve();
});
