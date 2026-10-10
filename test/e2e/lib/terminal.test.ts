import { expect, onTestFinished, test } from 'bun:test';
import { openCommandTerminal } from './terminal';

test('#close kills the command on the terminal and resolves once it has exited', async () => {
  const terminal = openCommandTerminal(['cat']);

  onTestFinished(() => terminal.close());

  // cat echoes what is typed once it reads the terminal
  terminal.type('ready\n');

  await terminal.waitForText('ready');
  await terminal.close();

  const code = await terminal.exited;

  expect(code).toBe(143);
});

test('#close is safe once the command has exited', async () => {
  const terminal = openCommandTerminal(['true']);

  onTestFinished(() => terminal.close());

  const code = await terminal.exited;

  await expect(terminal.close()).toResolve();

  expect(code).toBe(0);
});
