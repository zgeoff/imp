import { expect, mock, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { buildStubTerminalConnection } from '../../test-utils/build-stub-terminal-connection';
import { buildStubTerminalScreen } from '../../test-utils/build-stub-terminal-screen';
import { setupTerminalBridge } from './setup-terminal-bridge';

test('it copies the output of the connection to the screen', async () => {
  const screen = buildStubTerminalScreen();
  const connection = buildStubTerminalConnection();

  setupTerminalBridge(screen.screen, connection.connection);

  await connection.output.write(new TextEncoder().encode('$ '));

  await waitFor(() => {
    expect(screen.written).toStrictEqual(['$ ']);
  });
});

test('it sends the keys typed on the screen to the connection', async () => {
  const screen = buildStubTerminalScreen();
  const connection = buildStubTerminalConnection();

  setupTerminalBridge(screen.screen, connection.connection);

  screen.emitKeys('ls\r');

  await waitFor(() => {
    expect(connection.sent).toStrictEqual(['ls\r']);
  });
});

test('it sends a new size of the screen to the connection', () => {
  const screen = buildStubTerminalScreen();
  const connection = buildStubTerminalConnection();

  setupTerminalBridge(screen.screen, connection.connection);

  screen.emitResize({ cols: 120, rows: 40 });

  expect(connection.sizes).toStrictEqual([{ cols: 120, rows: 40 }]);
});

test('it disposes the screen listeners when unwired', () => {
  const screen = buildStubTerminalScreen();
  const connection = buildStubTerminalConnection();
  const teardown = setupTerminalBridge(screen.screen, connection.connection);

  teardown();

  expect(screen.disposed).toStrictEqual(['data', 'resize']);
});

test('it cancels the output of the connection when unwired', async () => {
  const screen = buildStubTerminalScreen();
  const connection = buildStubTerminalConnection();
  const teardown = setupTerminalBridge(screen.screen, connection.connection);

  teardown();

  await expect(connection.output.closed).toReject();
});

test('it swallows a key the connection refuses', () => {
  const screen = buildStubTerminalScreen();
  const write = mock(() => Promise.reject(new Error('the exec session has ended')));
  const connection = buildStubTerminalConnection({ write });

  setupTerminalBridge(screen.screen, connection.connection);

  // an unhandled rejection would fail the run
  screen.emitKeys('x');

  expect(write).toHaveBeenCalledExactlyOnceWith('x');
});

test('it swallows a failure of the connection output', async () => {
  const screen = buildStubTerminalScreen();
  const connection = buildStubTerminalConnection();

  setupTerminalBridge(screen.screen, connection.connection);

  // an unhandled rejection would fail the run
  await connection.output.abort(new Error('the socket dropped'));

  expect(screen.written).toStrictEqual([]);
});
