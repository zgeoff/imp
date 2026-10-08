import { expect, test } from 'bun:test';
import { buildStubGuest } from './build-stub-guest';

test('it sends a stdout string then an exit of 0', async () => {
  const guest = buildStubGuest(() => ({ stdout: 'hello\n' }));

  const stream = await guest.open({ argv: ['echo', 'hello'], tty: false });
  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('hello\n') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it sends each stdout chunk in order', async () => {
  const guest = buildStubGuest(() => ({
    stdout: [new Uint8Array([1, 2]), new Uint8Array([3])],
  }));

  const stream = await guest.open({ argv: ['cat'], tty: false });
  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new Uint8Array([1, 2]) },
    { type: 'stdout', data: new Uint8Array([3]) },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it sends stderr after stdout', async () => {
  const guest = buildStubGuest(() => ({ stdout: 'out', stderr: 'err' }));

  const stream = await guest.open({ argv: ['run'], tty: false });
  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('out') },
    { type: 'stderr', data: new TextEncoder().encode('err') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it exits with the code of the answer', async () => {
  const guest = buildStubGuest(() => Promise.resolve({ code: 3 }));

  const stream = await guest.open({ argv: ['false'], tty: false });
  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'exit', code: 3, signal: 0 }]);
});

test('it ends a dropped exec after its output with no exit', async () => {
  const guest = buildStubGuest(() => ({ stdout: 'partial', isDropped: true }));

  const stream = await guest.open({ argv: ['docker', 'version'], tty: false });
  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'stdout', data: new TextEncoder().encode('partial') }]);
});

test('it keeps a stalled exec open after its output', async () => {
  const guest = buildStubGuest((run) => ({ stdout: 'up', stall: run.argv[0] === 'serve' }));

  const stalled = await guest.open({ argv: ['serve'], tty: false });

  const iterator = stalled.events();

  await iterator.next();

  const next = iterator.next();

  const other = await guest.open({ argv: ['true'], tty: false });

  // a whole other exec runs to its exit while the stalled one waits
  await Array.fromAsync(other.events());

  expect(Bun.peek.status(next)).toBe('pending');
});

test('it ends a stalled exec with no exit once it is closed', async () => {
  const guest = buildStubGuest(() => ({ stdout: 'up', stall: true }));

  const stream = await guest.open({ argv: ['serve'], tty: false });

  const iterator = stream.events();

  await iterator.next();

  const next = iterator.next();

  stream.close();

  const result = await next;

  expect(result).toStrictEqual({ done: true, value: undefined });
});

test('it sends nothing when the exec closes before the answer', async () => {
  const guest = buildStubGuest(() => Promise.withResolvers<{ code: number }>().promise);

  const stream = await guest.open({ argv: ['hang'], tty: false });

  stream.close();

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([]);
});

test('it stops the output once the exec is closed', async () => {
  const guest = buildStubGuest(() => ({ stdout: [new Uint8Array([1]), new Uint8Array([2])] }));

  const stream = await guest.open({ argv: ['cat'], tty: false });

  const iterator = stream.events();

  await iterator.next();

  stream.close();

  const result = await iterator.next();

  expect(result).toStrictEqual({ done: true, value: undefined });
});

test('it resolves readStdin with all of stdin once stdin closes', async () => {
  const guest = buildStubGuest(async (run) => {
    const stdin = await run.readStdin();

    return { stdout: new TextDecoder().decode(stdin) };
  });

  const stream = await guest.open({ argv: ['cat'], tty: false });

  const events = Array.fromAsync(stream.events());

  stream.writeStdin(new TextEncoder().encode('ab'));
  stream.writeStdin(new TextEncoder().encode('cd'));
  stream.closeStdin();

  const received = await events;

  expect(received).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('abcd') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it records the signals each run gets', async () => {
  const guest = buildStubGuest(() => ({ stall: true }));

  const first = await guest.open({ argv: ['one'], tty: false });
  const second = await guest.open({ argv: ['two'], tty: false });

  first.sendSignal(15);
  first.sendSignal(9);
  second.sendSignal(2);

  expect(guest.runs.map((run) => run.signals)).toStrictEqual([[15, 9], [2]]);
});

test('it records the argv of each run and whether it closed', async () => {
  const guest = buildStubGuest(() => ({}));

  const first = await guest.open({ argv: ['ls', '-l'], tty: false });

  await guest.open({ argv: ['pwd'], tty: false });

  first.close();

  expect(guest.runs).toStrictEqual([
    { argv: ['ls', '-l'], signals: [], closed: true },
    { argv: ['pwd'], signals: [], closed: false },
  ]);
});
