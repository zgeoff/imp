import { expect, test } from 'bun:test';
import { buildStubExecGuest } from './build-stub-exec-guest';

test('it reads the first N bytes of a stored file with head -c', async () => {
  const guest = buildStubExecGuest(false);

  guest.files.set('/work/notes.txt', new TextEncoder().encode('hello world'));

  const stream = await guest.openExec('imp-a', {
    argv: ['head', '-c', '5', '/work/notes.txt'],
    tty: false,
  });

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('hello') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it fails head -c with the no such file error for a missing file', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', {
    argv: ['head', '-c', '5', '/work/missing.txt'],
    tty: false,
  });

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    {
      type: 'stderr',
      data: new TextEncoder().encode(
        "head: cannot open '/work/missing.txt' for reading: No such file or directory\n",
      ),
    },
    { type: 'exit', code: 1, signal: 0 },
  ]);
});

test('it stores the write script stdin at the path when stdin closes', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', {
    argv: ['/bin/sh', '-c', 'cat > "$1"', 'sh', '/work/out.txt'],
    tty: false,
  });

  stream.writeStdin(new TextEncoder().encode('hello '));
  stream.writeStdin(new TextEncoder().encode('world'));
  stream.closeStdin();

  const events = await Array.fromAsync(stream.events());

  expect({ events, stored: guest.files.get('/work/out.txt') }).toStrictEqual({
    events: [{ type: 'exit', code: 0, signal: 0 }],
    stored: new TextEncoder().encode('hello world'),
  });
});

test('it stores nothing before the write script stdin closes', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', {
    argv: ['/bin/sh', '-c', 'cat > "$1"', 'sh', '/work/out.txt'],
    tty: false,
  });

  stream.writeStdin(new TextEncoder().encode('hello'));

  expect([...guest.files.keys()]).toStrictEqual([]);
});

test('it fails a write under /readonly/ with the read-only file system error', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', {
    argv: ['/bin/sh', '-c', 'cat > "$1"', 'sh', '/readonly/out.txt'],
    tty: false,
  });

  stream.writeStdin(new TextEncoder().encode('hello'));
  stream.closeStdin();

  const events = await Array.fromAsync(stream.events());

  expect({ events, keys: [...guest.files.keys()] }).toStrictEqual({
    events: [
      {
        type: 'stderr',
        data: new TextEncoder().encode(
          "mkdir: can't create directory '/readonly': Read-only file system\n",
        ),
      },
      { type: 'exit', code: 1, signal: 0 },
    ],
    keys: [],
  });
});

test('it prints the text of a shell echo and exits 0', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', {
    argv: ['/bin/sh', '-c', 'echo hello there'],
    tty: false,
  });

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('hello there\n') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it runs a plain argv as the command its words join to', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', { argv: ['echo', 'hello', 'there'], tty: false });
  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('hello there\n') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it prints partial output then boom and exits 3 for fail', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', { argv: ['/bin/sh', '-c', 'fail'], tty: false });
  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('partial') },
    { type: 'stderr', data: new TextEncoder().encode('boom') },
    { type: 'exit', code: 3, signal: 0 },
  ]);
});

test('it floods N bytes from HEAD to TAIL in 4096-byte chunks', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', {
    argv: ['/bin/sh', '-c', 'flood 10000'],
    tty: false,
  });

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode(`HEAD${'x'.repeat(4092)}`) },
    { type: 'stdout', data: new TextEncoder().encode('x'.repeat(4096)) },
    { type: 'stdout', data: new TextEncoder().encode(`${'x'.repeat(1804)}TAIL`) },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it echoes stdin for cat and exits 0 when stdin closes', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', { argv: ['/bin/sh', '-c', 'cat'], tty: false });

  stream.writeStdin(new TextEncoder().encode('one'));
  stream.writeStdin(new TextEncoder().encode('two'));
  stream.closeStdin();

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('one') },
    { type: 'stdout', data: new TextEncoder().encode('two') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it exits 0 for the kill sweep', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', {
    argv: ['/bin/sh', '-c', 'kill -KILL -- -42'],
    tty: false,
  });

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'exit', code: 0, signal: 0 }]);
});

test('it exits sleepy with 128 plus the signal on SIGTERM', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', { argv: ['/bin/sh', '-c', 'sleepy'], tty: false });

  stream.sendSignal(15);

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'exit', code: 143, signal: 15 }]);
});

test('it keeps stubborn running through SIGTERM and exits it on SIGKILL', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', {
    argv: ['/bin/sh', '-c', 'stubborn'],
    tty: false,
  });

  stream.sendSignal(15);
  stream.sendSignal(9);

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'exit', code: 137, signal: 9 }]);
});

test('it records each signal a command gets as command:number', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', {
    argv: ['/bin/sh', '-c', 'stubborn'],
    tty: false,
  });

  stream.sendSignal(15);
  stream.sendSignal(9);

  expect(guest.signals).toStrictEqual(['stubborn:15', 'stubborn:9']);
});

test('it records the command of each stream that is closed', async () => {
  const guest = buildStubExecGuest(false);

  const first = await guest.openExec('imp-a', { argv: ['/bin/sh', '-c', 'sleepy'], tty: false });

  await guest.openExec('imp-a', { argv: ['/bin/sh', '-c', 'cat'], tty: false });

  first.close();

  expect(guest.closed).toStrictEqual(['sleepy']);
});

test('it records every request it is sent', async () => {
  const guest = buildStubExecGuest(false);

  await guest.openExec('imp-a', { argv: ['head', '-c', '5', '/work/notes.txt'], tty: false });
  await guest.openExec('imp-b', { argv: ['/bin/sh', '-c', 'echo hi'], tty: true, cols: 80 });

  expect(guest.requests).toStrictEqual([
    { argv: ['head', '-c', '5', '/work/notes.txt'], tty: false },
    { argv: ['/bin/sh', '-c', 'echo hi'], tty: true, cols: 80 },
  ]);
});

test('it kills the group when a new agent gets a kill grace', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', {
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
    killGraceMs: 5000,
  });

  expect(stream.groupKill).toBeTrue();
});

test('it leaves the group alone when an old agent gets a kill grace', async () => {
  const guest = buildStubExecGuest(true);

  const stream = await guest.openExec('imp-a', {
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
    killGraceMs: 5000,
  });

  expect(stream.groupKill).toBeFalse();
});

test('it leaves the group alone when a new agent gets no kill grace', async () => {
  const guest = buildStubExecGuest(false);

  const stream = await guest.openExec('imp-a', { argv: ['/bin/sh', '-c', 'sleepy'], tty: false });

  expect(stream.groupKill).toBeFalse();
});
