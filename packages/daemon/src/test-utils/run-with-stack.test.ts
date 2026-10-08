import { expect, test } from 'bun:test';
import { runWithStack } from './run-with-stack';

test('it returns the body’s value after releasing the stack', async () => {
  const events: string[] = [];

  const value = await runWithStack((stack) => {
    stack.defer(() => {
      events.push('released');
    });

    events.push('body');

    return Promise.resolve(42);
  });

  expect(value).toBe(42);
  expect(events).toStrictEqual(['body', 'released']);
});

test('it releases the stack and rethrows when the body fails', () => {
  const events: string[] = [];

  const run = runWithStack((stack) => {
    stack.defer(() => {
      events.push('released');
    });

    return Promise.reject(new Error('the case failed'));
  });

  expect(run).rejects.toThrowWithMessage(Error, 'the case failed');
  expect(events).toStrictEqual(['released']);
});

test('it releases in reverse order of deferral', async () => {
  const events: string[] = [];

  await runWithStack((stack) => {
    stack.defer(() => {
      events.push('first');
    });

    stack.defer(() => {
      events.push('second');
    });

    return Promise.resolve();
  });

  expect(events).toStrictEqual(['second', 'first']);
});

test('it reports a failed release over a failed body as a SuppressedError', () => {
  const run = runWithStack((stack) => {
    stack.defer(() => {
      throw new Error('the release failed');
    });

    return Promise.reject(new Error('the case failed'));
  });

  expect(run).rejects.toMatchObject({
    error: { message: 'the release failed' },
    suppressed: { message: 'the case failed' },
  });
});

test('it rejects with the release error when only the release fails', () => {
  const run = runWithStack((stack) => {
    stack.defer(() => {
      throw new Error('the release failed');
    });

    return Promise.resolve();
  });

  expect(run).rejects.toThrowWithMessage(Error, 'the release failed');
});
