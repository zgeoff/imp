import { expect, test } from 'bun:test';
import { setupTerminalBridge } from './setup-terminal-bridge';
import type { TerminalScreen } from './setup-terminal-bridge';
import type { TerminalConnection, TerminalSize } from './terminal-source';

function setupTest() {
  const output = new TransformStream<Uint8Array, Uint8Array>();

  const writer = output.writable.getWriter();
  const written: string[] = [];
  const sent: string[] = [];
  const sizes: TerminalSize[] = [];
  const listeners: { data?: (data: string) => void; resize?: (size: TerminalSize) => void } = {};
  const disposed: string[] = [];

  const screen: TerminalScreen = {
    write: (data) => {
      written.push(new TextDecoder().decode(data));
    },
    onData: (listener) => {
      listeners.data = listener;

      return {
        dispose: () => {
          disposed.push('data');
        },
      };
    },
    onResize: (listener) => {
      listeners.resize = listener;

      return {
        dispose: () => {
          disposed.push('resize');
        },
      };
    },
  };

  const connection: TerminalConnection = {
    output: output.readable,
    write: (data) => {
      sent.push(data);

      return Promise.resolve();
    },
    resize: (size) => {
      sizes.push(size);
    },
    close: () => {},
    ended: new Promise(() => {}),
  };

  return { writer, written, sent, sizes, listeners, disposed, screen, connection };
}

test('it copies output to the screen and keys and sizes to the connection', async () => {
  const ctx = setupTest();

  setupTerminalBridge(ctx.screen, ctx.connection);

  await ctx.writer.write(new TextEncoder().encode('$ '));
  await Bun.sleep(0);

  ctx.listeners.data?.('ls\r');
  ctx.listeners.resize?.({ cols: 120, rows: 40 });
  expect(ctx.written).toEqual(['$ ']);
  expect(ctx.sent).toEqual(['ls\r']);
  expect(ctx.sizes).toEqual([{ cols: 120, rows: 40 }]);
});

test('unwiring disposes the listeners and stops reading', async () => {
  const ctx = setupTest();
  const teardown = setupTerminalBridge(ctx.screen, ctx.connection);

  teardown();

  await Bun.sleep(0);

  expect(ctx.disposed).toEqual(['data', 'resize']);

  // the reader cancelled the stream, so a write after it fails
  const late = await ctx.writer.write(new Uint8Array([1])).then(
    () => 'written',
    () => 'refused',
  );

  expect(late).toBe('refused');
  expect(ctx.written).toEqual([]);
});

test('a key the connection refuses does not throw', async () => {
  const ctx = setupTest();

  setupTerminalBridge(ctx.screen, {
    ...ctx.connection,
    write: () => Promise.reject(new Error('the exec session has ended')),
  });

  ctx.listeners.data?.('x');

  await Bun.sleep(0);

  expect(ctx.written).toEqual([]);
});
