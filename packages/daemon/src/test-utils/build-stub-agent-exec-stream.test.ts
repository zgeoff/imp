import { expect, test } from 'bun:test';
import { buildStubAgentExecStream } from './build-stub-agent-exec-stream';

test('it builds a plain exec stream by default', () => {
  const fake = buildStubAgentExecStream();

  expect(fake.stream).toMatchObject({
    pid: 7,
    session: null,
    created: false,
    groupKill: false,
    output: null,
  });
});

test('it reports stdin on its way at once by default', async () => {
  const fake = buildStubAgentExecStream();

  await expect(fake.stream.stdinDrained()).toResolve();
});

test('it applies the fields it is given', () => {
  const fake = buildStubAgentExecStream({ pid: 9, session: 'main', created: true });

  expect(fake.stream).toMatchObject({ pid: 9, session: 'main', created: true });
});

test('it yields the fed events in order and ends after the exit', async () => {
  const fake = buildStubAgentExecStream();

  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('out') });
  fake.emitEvent({ type: 'exit', code: 0, signal: 0 });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('after') });

  const events = await Array.fromAsync(fake.stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('out') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it ends after a detached', async () => {
  const fake = buildStubAgentExecStream();

  fake.emitEvent({ type: 'detached', reason: 'taken_over' });

  const events = await Array.fromAsync(fake.stream.events());

  expect(events).toStrictEqual([{ type: 'detached', reason: 'taken_over' }]);
});

test('it waits for an event fed after the read began', async () => {
  const fake = buildStubAgentExecStream();
  const reading = Array.fromAsync(fake.stream.events());

  fake.emitEvent({ type: 'exit', code: 3, signal: 0 });

  const events = await reading;

  expect(events).toStrictEqual([{ type: 'exit', code: 3, signal: 0 }]);
});

test('it ends without an exit when the connection drops', async () => {
  const fake = buildStubAgentExecStream();

  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('partial') });
  fake.drop();

  const events = await Array.fromAsync(fake.stream.events());

  expect(events).toStrictEqual([{ type: 'stdout', data: new TextEncoder().encode('partial') }]);
});

test('it ends a pending read once impd closes the stream', async () => {
  const fake = buildStubAgentExecStream();
  const reading = Array.fromAsync(fake.stream.events());

  fake.stream.close();

  const events = await reading;

  expect(events).toStrictEqual([]);
});

test('it hands over the events fed before a close, then ends', async () => {
  const fake = buildStubAgentExecStream();

  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('before') });
  fake.stream.close();

  const events = await Array.fromAsync(fake.stream.events());

  expect(events).toStrictEqual([{ type: 'stdout', data: new TextEncoder().encode('before') }]);
});

test('it drops an event fed after the connection ended', async () => {
  const fake = buildStubAgentExecStream();

  fake.drop();
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('late') });

  const events = await Array.fromAsync(fake.stream.events());

  expect(events).toStrictEqual([]);
});

test('it records each call made on the stream in order', () => {
  const fake = buildStubAgentExecStream();

  fake.stream.writeStdin(new TextEncoder().encode('ls\n'));
  fake.stream.resize(120, 40);
  fake.stream.sendSignal(2);
  fake.stream.closeStdin();
  fake.stream.close();

  expect(fake.input).toStrictEqual(['stdin:ls\n', 'resize:120x40', 'signal:2', 'eof', 'close']);
});
