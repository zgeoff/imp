import { expect, test } from 'bun:test';
import { buildStubExecHandle } from './build-stub-exec-handle';

test('it records writes, resizes and closes in call order', async () => {
  const stub = buildStubExecHandle({ exit: new Promise(() => {}) });

  stub.handle.resize(80, 24);

  await stub.handle.write('ls');

  stub.handle.close();

  expect(stub.calls).toStrictEqual([['resize', 80, 24], ['write', 'ls'], ['close']]);
});

test('it hands what the test writes to stdout to the reader of the handle', async () => {
  const stub = buildStubExecHandle({ exit: new Promise(() => {}) });

  const reading = new Response(stub.handle.stdout).text();

  await stub.stdout.write(new TextEncoder().encode('hello'));
  await stub.stdout.close();

  const output = await reading;

  expect(output).toBe('hello');
});

test('it hands what the test writes to stderr to the reader of the handle', async () => {
  const stub = buildStubExecHandle({ exit: new Promise(() => {}) });

  const reading = new Response(stub.handle.stderr).text();

  await stub.stderr.write(new TextEncoder().encode('oops'));
  await stub.stderr.close();

  const output = await reading;

  expect(output).toBe('oops');
});

test('it settles the exit with the given one', () => {
  const stub = buildStubExecHandle({ exit: Promise.resolve({ code: 3, signal: null }) });

  expect(stub.handle.exit).resolves.toStrictEqual({ code: 3, signal: null });
});

test('it reports a started login shell', () => {
  const stub = buildStubExecHandle({ exit: new Promise(() => {}) });

  expect(stub.handle.started).resolves.toStrictEqual({
    pid: 1,
    session: null,
    created: true,
    groupKill: false,
    output: { continuity: 'none' },
  });
});
