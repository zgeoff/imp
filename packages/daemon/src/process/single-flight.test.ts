import { expect, mock, test } from 'bun:test';
import { createSingleFlight } from './single-flight';

test('it joins a call to the run in flight for its key', async () => {
  const flight = createSingleFlight<number>();
  const gate = Promise.withResolvers<number>();
  const task = mock(() => gate.promise);
  const first = flight.run('a', task);
  const second = flight.run('a', task);

  gate.resolve(7);

  const results = await Promise.all([first, second]);

  expect(results).toStrictEqual([7, 7]);
  expect(task).toHaveBeenCalledOnce();
});

test('it runs calls on different keys apart', async () => {
  const flight = createSingleFlight<string>();
  const first = flight.run('a', () => Promise.resolve('a'));
  const second = flight.run('b', () => Promise.resolve('b'));

  const results = await Promise.all([first, second]);

  expect(results).toStrictEqual(['a', 'b']);
});

test('it runs a key again once its run resolved', async () => {
  const flight = createSingleFlight<number>();
  const task = mock(() => Promise.resolve(1));

  await flight.run('a', task);
  await flight.run('a', task);

  expect(task).toHaveBeenCalledTimes(2);
});

test('it rejects every joined call with the run that failed', () => {
  const flight = createSingleFlight<number>();
  const gate = Promise.withResolvers<number>();
  const first = flight.run('a', () => gate.promise);
  const second = flight.run('a', () => Promise.resolve(2));

  gate.reject(new Error('boom'));

  expect(first).rejects.toThrowWithMessage(Error, 'boom');
  expect(second).rejects.toThrowWithMessage(Error, 'boom');
});

test('it frees a key once its run rejected', async () => {
  const flight = createSingleFlight<number>();
  const failing = mock(() => Promise.reject(new Error('boom')));

  await Promise.allSettled([flight.run('a', failing)]);

  const value = await flight.run('a', () => Promise.resolve(3));

  expect(value).toBe(3);
});

test('it frees a key whose task throws before it returns a promise', async () => {
  const flight = createSingleFlight<number>();

  const throwing = mock((): Promise<number> => {
    throw new Error('at once');
  });

  await Promise.allSettled([flight.run('a', throwing)]);

  expect(flight.findRun('a')).toBeUndefined();
});

test('it lists the keys with a run in flight', async () => {
  const flight = createSingleFlight<number>();

  void flight.run('a', () => new Promise(() => {}));

  await flight.run('b', () => Promise.resolve(1));

  expect(flight.listKeys()).toStrictEqual(['a']);
});

test('it waits for every run in flight to settle, a failed one included', async () => {
  const flight = createSingleFlight<number>();
  const gate = Promise.withResolvers<number>();
  const running = flight.run('a', () => gate.promise);
  const waiting = flight.waitForAll();

  gate.reject(new Error('boom'));

  await expect(waiting).toResolve();

  expect(running).rejects.toThrowWithMessage(Error, 'boom');
});

test('it finds the run in flight for a key', () => {
  const flight = createSingleFlight<number>();
  const running = flight.run('a', () => new Promise(() => {}));

  expect(flight.findRun('a')).toBe(running);
});
