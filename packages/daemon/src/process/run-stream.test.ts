import { expect, onTestFinished, test } from 'bun:test';
import { createStreamRunner } from './run-stream';

test('#readFrom streams the stdout of a command', async () => {
  const runner = createStreamRunner();
  const command = runner.readFrom(['sh', '-c', 'echo hello']);

  onTestFinished(() => command.stop());

  const stdout = await new Response(command.stdout).text();

  expect(stdout).toBe('hello\n');
});

test('#readFrom ends a command stopped on purpose quietly', async () => {
  const runner = createStreamRunner();
  const command = runner.readFrom(['sleep', '10']);

  onTestFinished(() => command.stop());

  await command.stop();

  expect(command.done).resolves.toBeUndefined();
});

test('#readFrom rejects with the stderr of a command that fails', () => {
  const runner = createStreamRunner();
  const command = runner.readFrom(['sh', '-c', 'echo broken >&2; exit 3']);

  onTestFinished(() => command.stop());

  expect(command.done).rejects.toThrowWithMessage(
    Error,
    'sh -c echo broken >&2; exit 3 exited 3: broken',
  );
});

test('#writeTo feeds the whole stream to the stdin of a command', () => {
  const runner = createStreamRunner();

  expect(
    runner.writeTo(['sh', '-c', 'test "$(cat)" = hello'], new Blob(['hello']).stream()),
  ).resolves.toBeUndefined();
});

test('#writeTo rejects with the stderr of a command that fails', () => {
  const runner = createStreamRunner();

  expect(
    runner.writeTo(
      ['sh', '-c', 'cat >/dev/null; echo refused >&2; exit 1'],
      new Blob(['x']).stream(),
    ),
  ).rejects.toThrowWithMessage(
    Error,
    'sh -c cat >/dev/null; echo refused >&2; exit 1 exited 1: refused',
  );
});
