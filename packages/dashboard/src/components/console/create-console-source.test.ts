import { expect, test } from 'bun:test';
import { ExecError } from '@zgeoff/imp-client';
import { buildStubExecHandle } from '../../test-utils/build-stub-exec-handle';
import { createConsoleSource, toTerminalConnection } from './create-console-source';

test('#toTerminalConnection merges stdout and stderr into one output that ends when both do', async () => {
  const stub = buildStubExecHandle({ exit: Promise.resolve({ code: 0, signal: null }) });
  const connection = toTerminalConnection(stub.handle);

  const reading = new Response(connection.output).text();

  await stub.stdout.write(new TextEncoder().encode('out '));
  await stub.stderr.write(new TextEncoder().encode('err'));
  await stub.stdout.close();
  await stub.stderr.close();

  const output = await reading;

  expect(output).toBe('out err');
});

test('#toTerminalConnection fails the output when stdout fails', async () => {
  const stub = buildStubExecHandle({ exit: new Promise(() => {}) });
  const connection = toTerminalConnection(stub.handle);

  const reading = new Response(connection.output).text();

  await stub.stdout.abort(new Error('the socket dropped'));

  expect(reading).rejects.toThrowWithMessage(Error, 'the socket dropped');
});

test('#toTerminalConnection cancels stdout and stderr when the output is cancelled', async () => {
  const stub = buildStubExecHandle({ exit: new Promise(() => {}) });
  const connection = toTerminalConnection(stub.handle);

  await connection.output.cancel();

  expect(Promise.allSettled([stub.stdout.closed, stub.stderr.closed])).resolves.toMatchObject([
    { status: 'rejected' },
    { status: 'rejected' },
  ]);
});

test('#toTerminalConnection reports the exit of the program', () => {
  const stub = buildStubExecHandle({ exit: Promise.resolve({ code: 3, signal: null }) });
  const connection = toTerminalConnection(stub.handle);

  expect(connection.ended).resolves.toStrictEqual({ kind: 'exit', code: 3, signal: null });
});

test('#toTerminalConnection reports a dropped connection as an error', () => {
  const stub = buildStubExecHandle({
    exit: Promise.reject(new ExecError('CONNECTION_CLOSED', 'impd went away')),
  });

  const connection = toTerminalConnection(stub.handle);

  expect(connection.ended).resolves.toStrictEqual({ kind: 'error', message: 'impd went away' });
});

test('#toTerminalConnection reports a rejection that is not an Error by its text', () => {
  // oxlint-disable-next-line prefer-promise-reject-errors -- the branch under test
  const stub = buildStubExecHandle({ exit: Promise.reject('impd went away') });
  const connection = toTerminalConnection(stub.handle);

  expect(connection.ended).resolves.toStrictEqual({ kind: 'error', message: 'impd went away' });
});

test('#createConsoleSource opens a login shell on the imp sized to the terminal', async () => {
  const stub = buildStubExecHandle({ exit: new Promise(() => {}) });
  const opened: unknown[] = [];

  const source = createConsoleSource(
    {
      openConsole: (name, options) => {
        opened.push([name, options?.cols, options?.rows]);

        return Promise.resolve(stub.handle);
      },
    },
    'web',
  );

  await source.open({ cols: 100, rows: 30 }, new AbortController().signal);

  expect(source.label).toBe('console on web');
  expect(opened).toStrictEqual([['web', 100, 30]]);
});

test('#createConsoleSource passes resizes, keys and the close to the exec', async () => {
  const stub = buildStubExecHandle({ exit: new Promise(() => {}) });
  const source = createConsoleSource({ openConsole: () => Promise.resolve(stub.handle) }, 'web');

  const connection = await source.open({ cols: 100, rows: 30 }, new AbortController().signal);

  connection.resize({ cols: 80, rows: 24 });

  await connection.write('x');

  connection.close();

  expect(stub.calls).toStrictEqual([['resize', 80, 24], ['write', 'x'], ['close']]);
});
