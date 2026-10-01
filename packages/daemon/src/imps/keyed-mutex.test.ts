import { expect, test } from 'bun:test';
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

  expect(failed).rejects.toThrow('boom');

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
