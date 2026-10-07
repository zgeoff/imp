import { expect, mock, test } from 'bun:test';
import { buildStubTerminalConnection } from './build-stub-terminal-connection';

test('it records the keys it is sent', async () => {
  const stub = buildStubTerminalConnection();

  await stub.connection.write('ls\r');

  expect(stub.sent).toStrictEqual(['ls\r']);
});

test('it records the sizes it is sent', () => {
  const stub = buildStubTerminalConnection();

  stub.connection.resize({ cols: 120, rows: 40 });

  expect(stub.sizes).toStrictEqual([{ cols: 120, rows: 40 }]);
});

test('it takes keys through the given write', async () => {
  const write = mock(() => Promise.resolve());
  const stub = buildStubTerminalConnection({ write });

  await stub.connection.write('x');

  expect(write).toHaveBeenCalledExactlyOnceWith('x');
});

test('it hands what the test writes to the output to its reader', async () => {
  const stub = buildStubTerminalConnection();

  const reading = new Response(stub.connection.output).text();

  await stub.output.write(new TextEncoder().encode('$ '));
  await stub.output.close();

  const output = await reading;

  expect(output).toBe('$ ');
});
