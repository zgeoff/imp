import { expect, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { createSemaphore } from './semaphore';

test('it runs no more than its limit of tasks at once', async () => {
  const semaphore = createSemaphore(2);
  const gate = Promise.withResolvers<void>();
  const state = { started: 0, active: 0, peak: 0 };

  const runTask = () =>
    semaphore.run(async () => {
      state.started += 1;
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);

      await gate.promise;

      state.active -= 1;
    });

  const tasks = Promise.all(Array.from({ length: 6 }, runTask));

  await waitFor(() => {
    expect(state.started).toBe(2);
  });

  gate.resolve();

  await tasks;

  expect(state.peak).toBe(2);
  expect(state.started).toBe(6);
  expect(state.active).toBe(0);
});

test('it starts a waiting task once a running one is done', async () => {
  const semaphore = createSemaphore(1);
  const gate = Promise.withResolvers<void>();
  const log: string[] = [];

  const first = semaphore.run(async () => {
    log.push('first start');

    await gate.promise;

    log.push('first end');
  });

  const second = semaphore.run(() => {
    log.push('second start');

    return Promise.resolve();
  });

  await waitFor(() => {
    expect(log).toContain('first start');
  });

  gate.resolve();

  await Promise.all([first, second]);

  expect(log).toStrictEqual(['first start', 'first end', 'second start']);
});

test('it resolves to the value of its task', async () => {
  const semaphore = createSemaphore(1);

  const result = await semaphore.run(() => Promise.resolve('ok'));

  expect(result).toBe('ok');
});

test('it rejects with the error of its task', () => {
  const semaphore = createSemaphore(1);

  expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow(new Error('boom'));
});

test('it frees the slot of a task that rejects for the task waiting on it', async () => {
  const semaphore = createSemaphore(1);
  const failed = semaphore.run(() => Promise.reject(new Error('boom')));
  const waiting = semaphore.run(() => Promise.resolve('ok'));

  const result = await waiting;

  expect(failed).rejects.toThrow(new Error('boom'));
  expect(result).toBe('ok');
});

test('it frees the slot of a task that rejects for a task queued later', async () => {
  const semaphore = createSemaphore(1);
  const failed = semaphore.run(() => Promise.reject(new Error('boom')));

  await Promise.allSettled([failed]);

  const result = await semaphore.run(() => Promise.resolve('ok'));

  expect(failed).rejects.toThrow(new Error('boom'));
  expect(result).toBe('ok');
});
