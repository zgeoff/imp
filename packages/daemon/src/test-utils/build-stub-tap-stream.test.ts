import { expect, test } from 'bun:test';
import type { ExecEvent } from '../agent-client/exec-stream';
import { buildMockSessionOutput } from './build-mock-session-output';
import { buildStubTapStream } from './build-stub-tap-stream';

test('it hands the reader the events in the order they came, then ends at a drop', async () => {
  const tap = buildStubTapStream(buildMockSessionOutput());
  const events: ExecEvent[] = [];

  tap.write('hi');
  tap.emitEvent({ type: 'exit', code: 3, signal: 0 });
  tap.drop();

  for await (const event of tap.stream.events()) {
    events.push(event);
  }

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('hi') },
    { type: 'exit', code: 3, signal: 0 },
  ]);
});

test('it waits for an event the test sends after the reader started', async () => {
  const tap = buildStubTapStream(buildMockSessionOutput());
  const reader = tap.stream.events();
  const next = reader.next();

  tap.write('late');

  const result = await next;

  expect(result).toStrictEqual({
    done: false,
    value: { type: 'stdout', data: new TextEncoder().encode('late') },
  });
});

test('it ends the events and drops what is queued once impd closes it', async () => {
  const tap = buildStubTapStream(buildMockSessionOutput());
  const events: ExecEvent[] = [];

  tap.write('unread');
  tap.stream.close();

  for await (const event of tap.stream.events()) {
    events.push(event);
  }

  expect(events).toStrictEqual([]);
  expect(tap.state.closed).toBe(true);
});

test('it marks the stream finished once the reader reached its end', async () => {
  const tap = buildStubTapStream(buildMockSessionOutput());
  const reader = tap.stream.events();
  const pending = reader.next();

  tap.drop();

  await pending;

  expect(tap.state.finished).toBe(true);
});

test('it marks the stream finished once the reader leaves its loop early', async () => {
  const tap = buildStubTapStream(buildMockSessionOutput());
  const reader = tap.stream.events();

  tap.write('one');
  tap.write('two');

  await reader.next();
  await reader.return();

  expect(tap.state.finished).toBe(true);
});

test('it leaves the stream unfinished while the reader waits', async () => {
  const tap = buildStubTapStream(buildMockSessionOutput());
  const reader = tap.stream.events();

  tap.write('one');

  await reader.next();

  expect(tap.state.finished).toBe(false);
});

test('it carries the session output it was built with', () => {
  const output = buildMockSessionOutput({ executionGeneration: 'a'.repeat(32), offset: 5 });

  expect(buildStubTapStream(output).stream.output).toBe(output);
});
