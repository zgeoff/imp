import { expect, test } from 'bun:test';
import { readErrorMessage } from '../read-error-message';
import { readRejection } from '../read-rejection';
import { createKeyedMutex } from './keyed-mutex';

test('it serializes tasks for one key and runs other keys alongside', async () => {
  const mutex = createKeyedMutex();
  const log: string[] = [];

  const buildSlowTask = (label: string, ms: number) => async () => {
    log.push(`${label} start`);

    await Bun.sleep(ms);

    log.push(`${label} end`);

    return label;
  };

  const results = await Promise.all([
    mutex.runExclusive('a', buildSlowTask('a1', 20)),
    mutex.runExclusive('a', buildSlowTask('a2', 1)),
    mutex.runExclusive('b', buildSlowTask('b1', 5)),
  ]);

  expect(results).toEqual(['a1', 'a2', 'b1']);
  expect(log.indexOf('a1 end')).toBeLessThan(log.indexOf('a2 start'));
  expect(log.indexOf('b1 start')).toBeLessThan(log.indexOf('a1 end'));
});

test('it keeps the queue moving after a task fails', async () => {
  const mutex = createKeyedMutex();
  const failed = mutex.runExclusive('a', () => Promise.reject(new Error('boom')));
  const next = mutex.runExclusive('a', () => Promise.resolve('ok'));

  const error = await readRejection(failed);

  expect(readErrorMessage(error)).toBe('boom');

  const result = await next;

  expect(result).toBe('ok');
});

test('it reports a key locked while its task runs', async () => {
  const mutex = createKeyedMutex();
  const gate = Promise.withResolvers<void>();
  const running = mutex.runExclusive('a', () => gate.promise);

  expect(mutex.isLocked('a')).toBe(true);
  expect(mutex.isLocked('b')).toBe(false);

  gate.resolve();

  await running;

  expect(mutex.isLocked('a')).toBe(false);
});

test('tryRunExclusive skips a held key without waiting and runs a free one', async () => {
  const mutex = createKeyedMutex();
  const gate = Promise.withResolvers<void>();
  const held = mutex.runExclusive('a', () => gate.promise);

  const skipped = await mutex.tryRunExclusive('a', () => Promise.resolve('never'));
  const free = await mutex.tryRunExclusive('b', () => Promise.resolve('b'));

  expect(skipped).toEqual({ ran: false });
  expect(free).toEqual({ ran: true, value: 'b' });

  gate.resolve();

  await held;

  const after = await mutex.tryRunExclusive('a', () => Promise.resolve('a'));

  expect(after).toEqual({ ran: true, value: 'a' });
});

test('a task queued behind tryRunExclusive waits for it', async () => {
  const mutex = createKeyedMutex();
  const log: string[] = [];

  const first = mutex.tryRunExclusive('a', async () => {
    await Bun.sleep(10);

    log.push('try');
  });

  const second = mutex.runExclusive('a', () => {
    log.push('queued');

    return Promise.resolve();
  });

  await Promise.all([first, second]);

  expect(log).toEqual(['try', 'queued']);
});

test('waitForAll resolves once every queued task is done', async () => {
  const mutex = createKeyedMutex();
  const log: string[] = [];

  const first = mutex.runExclusive('a', async () => {
    await Bun.sleep(10);

    log.push('a');
  });

  const second = mutex.runExclusive('b', async () => {
    await Bun.sleep(20);

    log.push('b');
  });

  await mutex.waitForAll();

  log.push('all');

  await Promise.all([first, second]);

  expect(log).toEqual(['a', 'b', 'all']);
});
