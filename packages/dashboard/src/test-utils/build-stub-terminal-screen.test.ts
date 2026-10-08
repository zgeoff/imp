import { expect, mock, test } from 'bun:test';
import { buildStubTerminalScreen } from './build-stub-terminal-screen';

test('it records what is written to it as text', () => {
  const stub = buildStubTerminalScreen();

  stub.screen.write(new TextEncoder().encode('$ '));

  expect(stub.written).toStrictEqual(['$ ']);
});

test('it passes typed keys to the key listener', () => {
  const stub = buildStubTerminalScreen();
  const handleKeys = mock(() => {});

  stub.screen.onData(handleKeys);
  stub.emitKeys('ls\r');

  expect(handleKeys).toHaveBeenCalledExactlyOnceWith('ls\r');
});

test('it passes a new size to the resize listener', () => {
  const stub = buildStubTerminalScreen();
  const handleResize = mock(() => {});

  stub.screen.onResize(handleResize);
  stub.emitResize({ cols: 120, rows: 40 });

  expect(handleResize).toHaveBeenCalledExactlyOnceWith({ cols: 120, rows: 40 });
});

test('it records each disposed listener', () => {
  const stub = buildStubTerminalScreen();
  const data = stub.screen.onData(() => {});
  const resize = stub.screen.onResize(() => {});

  data.dispose();
  resize.dispose();

  expect(stub.disposed).toStrictEqual(['data', 'resize']);
});

test('it refuses keys once the key listener is disposed', () => {
  const stub = buildStubTerminalScreen();

  stub.screen.onData(() => {}).dispose();

  expect(() => {
    stub.emitKeys('x');
  }).toThrowWithMessage(Error, 'nothing listens for keys');
});

test('it refuses a resize when nothing listens for sizes', () => {
  const stub = buildStubTerminalScreen();

  expect(() => {
    stub.emitResize({ cols: 80, rows: 24 });
  }).toThrowWithMessage(Error, 'nothing listens for sizes');
});
