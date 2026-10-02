import { expect, test } from 'bun:test';
import { readRejection } from '../read-rejection';
import { createStreamRunner } from './run-stream';

test('a command stopped on purpose ends quietly; one that fails says why', async () => {
  const runner = createStreamRunner();
  const stopped = runner.readFrom(['sleep', '10']);

  stopped.stop();

  const failed = runner.readFrom(['sh', '-c', 'echo broken >&2; exit 3']);

  const quiet = await readRejection(stopped.done);
  const error = await readRejection(failed.done);

  expect(quiet).toBeNull();
  expect(String(error)).toContain('exited 3: broken');
});

test('a command fed a stream reads it all, and its failure carries its stderr', async () => {
  const runner = createStreamRunner();

  await runner.writeTo(
    ['sh', '-c', 'test "$(cat)" = hello'],
    new Response('hello').body ?? new ReadableStream(),
  );

  const error = await readRejection(
    runner.writeTo(
      ['sh', '-c', 'cat >/dev/null; echo refused >&2; exit 1'],
      new Response('x').body ?? new ReadableStream(),
    ),
  );

  expect(String(error)).toContain('exited 1: refused');
});
