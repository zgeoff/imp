import { expect, onTestFinished, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { createKeyedMutex } from './keyed-mutex';

test('#runExclusive runs the tasks of one key one at a time, in the order they were queued', async () => {
  const mutex = createKeyedMutex();
  const gate = Promise.withResolvers<void>();
  const log: string[] = [];

  const first = mutex.runExclusive('a', async () => {
    log.push('a1 start');

    await gate.promise;

    log.push('a1 end');
  });

  const second = mutex.runExclusive('a', () => {
    log.push('a2 start');

    return Promise.resolve();
  });

  await waitFor(() => {
    expect(log).toContain('a1 start');
  });

  gate.resolve();

  await Promise.all([first, second]);

  expect(log).toStrictEqual(['a1 start', 'a1 end', 'a2 start']);
});

test('#runExclusive runs a task for another key while a key is held', async () => {
  const mutex = createKeyedMutex();
  const gate = Promise.withResolvers<void>();

  onTestFinished(() => {
    gate.resolve();
  });

  void mutex.runExclusive('a', () => gate.promise);

  const result = await mutex.runExclusive('b', () => Promise.resolve('b'));

  expect(result).toBe('b');
});

test('#runExclusive resolves to the value of its task', async () => {
  const mutex = createKeyedMutex();

  const result = await mutex.runExclusive('a', () => Promise.resolve('ok'));

  expect(result).toBe('ok');
});

test('#runExclusive rejects with the error of its task', () => {
  const mutex = createKeyedMutex();

  expect(mutex.runExclusive('a', () => Promise.reject(new Error('boom')))).rejects.toThrow(
    new Error('boom'),
  );
});

test('#runExclusive runs the next task of a key after a task fails', async () => {
  const mutex = createKeyedMutex();
  const failed = mutex.runExclusive('a', () => Promise.reject(new Error('boom')));
  const next = mutex.runExclusive('a', () => Promise.resolve('ok'));

  const result = await next;

  expect(failed).rejects.toThrow(new Error('boom'));
  expect(result).toBe('ok');
});

test('#isLocked reports a key locked while its task runs', () => {
  const mutex = createKeyedMutex();
  const gate = Promise.withResolvers<void>();

  onTestFinished(() => {
    gate.resolve();
  });

  void mutex.runExclusive('a', () => gate.promise);
  expect(mutex.isLocked('a')).toBeTrue();
});

test('#isLocked reports a key unlocked while another key is held', () => {
  const mutex = createKeyedMutex();
  const gate = Promise.withResolvers<void>();

  onTestFinished(() => {
    gate.resolve();
  });

  void mutex.runExclusive('a', () => gate.promise);
  expect(mutex.isLocked('b')).toBeFalse();
});

test('#isLocked reports a key unlocked once its task is done', async () => {
  const mutex = createKeyedMutex();

  await mutex.runExclusive('a', () => Promise.resolve());

  expect(mutex.isLocked('a')).toBeFalse();
});

test('#tryRunExclusive skips a held key without waiting for it', async () => {
  const mutex = createKeyedMutex();
  const gate = Promise.withResolvers<void>();

  onTestFinished(() => {
    gate.resolve();
  });

  void mutex.runExclusive('a', () => gate.promise);

  const skipped = await mutex.tryRunExclusive('a', () => Promise.resolve('never'));

  expect(skipped).toStrictEqual({ ran: false });
});

test('#tryRunExclusive skips a key whose queued task runs after the holder let go', async () => {
  const mutex = createKeyedMutex();
  const holder = Promise.withResolvers<void>();
  const waiter = Promise.withResolvers<void>();
  const log: string[] = [];

  onTestFinished(() => {
    waiter.resolve();
  });

  void mutex.runExclusive('a', () => holder.promise);

  void mutex.runExclusive('a', async () => {
    log.push('waiter start');

    await waiter.promise;
  });

  holder.resolve();

  await waitFor(() => {
    expect(log).toStrictEqual(['waiter start']);
  });

  const skipped = await mutex.tryRunExclusive('a', () => Promise.resolve('never'));

  expect(skipped).toStrictEqual({ ran: false });
});

test('#tryRunExclusive runs a task on a free key', async () => {
  const mutex = createKeyedMutex();
  const gate = Promise.withResolvers<void>();

  onTestFinished(() => {
    gate.resolve();
  });

  void mutex.runExclusive('a', () => gate.promise);

  const free = await mutex.tryRunExclusive('b', () => Promise.resolve('b'));

  expect(free).toStrictEqual({ ran: true, value: 'b' });
});

test('#tryRunExclusive runs a task on a key once its holder is done', async () => {
  const mutex = createKeyedMutex();

  await mutex.runExclusive('a', () => Promise.resolve());

  const after = await mutex.tryRunExclusive('a', () => Promise.resolve('a'));

  expect(after).toStrictEqual({ ran: true, value: 'a' });
});

test('#tryRunExclusive holds the key, so a task queued behind it waits for it', async () => {
  const mutex = createKeyedMutex();
  const gate = Promise.withResolvers<void>();
  const log: string[] = [];

  const first = mutex.tryRunExclusive('a', async () => {
    log.push('try start');

    await gate.promise;

    log.push('try end');
  });

  const second = mutex.runExclusive('a', () => {
    log.push('queued');

    return Promise.resolve();
  });

  await waitFor(() => {
    expect(log).toContain('try start');
  });

  gate.resolve();

  await Promise.all([first, second]);

  expect(log).toStrictEqual(['try start', 'try end', 'queued']);
});

test('#waitForAll resolves once every task of every key is done', async () => {
  const mutex = createKeyedMutex();
  const gateA = Promise.withResolvers<void>();
  const gateB = Promise.withResolvers<void>();
  const log: string[] = [];

  const first = mutex.runExclusive('a', async () => {
    await gateA.promise;

    log.push('a');
  });

  const second = mutex.runExclusive('b', async () => {
    await gateB.promise;

    log.push('b');
  });

  const all = (async () => {
    await mutex.waitForAll();

    log.push('all');
  })();

  gateA.resolve();
  gateB.resolve();

  await Promise.all([first, second, all]);

  expect(log).toStrictEqual(['a', 'b', 'all']);
});

test('#waitForAll resolves at once when no task runs', async () => {
  const mutex = createKeyedMutex();

  await expect(mutex.waitForAll()).toResolve();
});
