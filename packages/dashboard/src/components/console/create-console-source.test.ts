import { expect, test } from 'bun:test';
import type { ExecExit, ExecHandle } from '@zgeoff/imp-client';
import { ExecError } from '@zgeoff/imp-client';
import { createConsoleSource, toTerminalConnection } from './create-console-source';

function buildHandle(exit: Promise<ExecExit>) {
  const stdout = new TransformStream<Uint8Array, Uint8Array>();
  const stderr = new TransformStream<Uint8Array, Uint8Array>();

  const calls: unknown[] = [];

  const handle: ExecHandle = {
    started: Promise.resolve({ pid: 1, session: null, created: true }),
    stdout: stdout.readable,
    stderr: stderr.readable,
    exit,
    write: (data) => {
      calls.push(['write', data]);

      return Promise.resolve();
    },
    closeStdin: () => Promise.resolve(),
    resize: (cols, rows) => {
      calls.push(['resize', cols, rows]);
    },
    sendSignal: () => {},
    close: () => {
      calls.push(['close']);
    },
  };

  return {
    handle,
    calls,
    stdout: stdout.writable.getWriter(),
    stderr: stderr.writable.getWriter(),
  };
}

function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

test('the output holds stdout and stderr and ends when both do', async () => {
  const ctx = buildHandle(Promise.resolve({ code: 0, signal: null }));
  const connection = toTerminalConnection(ctx.handle);
  const text = readText(connection.output);

  await ctx.stdout.write(new TextEncoder().encode('out '));
  await ctx.stderr.write(new TextEncoder().encode('err'));
  await ctx.stdout.close();
  await ctx.stderr.close();

  const output = await text;

  expect(output).toBe('out err');
});

test('it reports the exit, and an error as a disconnect', async () => {
  const exit = Promise.resolve({ code: 3, signal: null });
  const drop = Promise.reject(new ExecError('CONNECTION_CLOSED', 'impd went away'));
  const exited = toTerminalConnection(buildHandle(exit).handle);
  const dropped = toTerminalConnection(buildHandle(drop).handle);

  const exitedEnd = await exited.ended;
  const droppedEnd = await dropped.ended;

  expect(exitedEnd).toEqual({ kind: 'exit', code: 3, signal: null });
  expect(droppedEnd).toEqual({ kind: 'error', message: 'impd went away' });
});

test('the console source opens a login shell sized to the terminal', async () => {
  const opened: unknown[] = [];
  const ctx = buildHandle(new Promise(() => {}));

  const source = createConsoleSource(
    {
      openConsole: (name, options) => {
        opened.push([name, options?.cols, options?.rows]);

        return Promise.resolve(ctx.handle);
      },
    },
    'web',
  );

  const connection = await source.open({ cols: 100, rows: 30 }, new AbortController().signal);

  connection.resize({ cols: 80, rows: 24 });

  await connection.write('x');

  connection.close();

  expect(source.label).toBe('console on web');
  expect(opened).toEqual([['web', 100, 30]]);
  expect(ctx.calls).toEqual([['resize', 80, 24], ['write', 'x'], ['close']]);
});
