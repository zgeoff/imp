import { expect, mock, test } from 'bun:test';
import { buildStubTerminal } from './build-stub-terminal';

test('it says it is a terminal', () => {
  const terminal = buildStubTerminal();

  expect(terminal.stdin.isTTY).toBeTrue();
});

test('it records each raw-mode switch in order', () => {
  const terminal = buildStubTerminal();

  terminal.stdin.setRawMode(true);
  terminal.stdin.setRawMode(false);

  expect(terminal.modes).toStrictEqual([true, false]);
});

test('it hands what the test types to a data listener', () => {
  const terminal = buildStubTerminal();
  const listener = mock<(chunk: Uint8Array) => void>();

  terminal.stdin.on('data', listener);
  terminal.stdin.write('typed');

  expect(listener).toHaveBeenCalledExactlyOnceWith(Buffer.from('typed'));
});
