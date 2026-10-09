import { expect, mock, onTestFinished, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { createStorageGate } from './storage-gate';

test('it runs a task alone after the operations in flight, and lets new ones pass while it waits', async () => {
  const gate = createStorageGate();
  const events: string[] = [];
  const first = Promise.withResolvers<void>();

  onTestFinished(() => {
    first.resolve();
  });

  const running = gate.join(async () => {
    events.push('op 1 start');

    await first.promise;

    events.push('op 1 end');
  });

  const alone = gate.runAlone(() => {
    events.push('gc');

    return Promise.resolve('dropped');
  }, 5000);

  // a GC that waits holds nothing back
  await gate.join(() => {
    events.push('op 2');

    return Promise.resolve();
  });

  first.resolve();

  const result = await alone;

  await running;

  await gate.join(() => {
    events.push('op 3');

    return Promise.resolve();
  });

  expect(result).toStrictEqual({ ran: true, value: 'dropped' });
  expect(events).toStrictEqual(['op 1 start', 'op 2', 'op 1 end', 'gc', 'op 3']);
});

test('it holds an operation that starts while a task runs alone until the task ends', async () => {
  const gate = createStorageGate();
  const events: string[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  onTestFinished(() => {
    release.resolve();
  });

  const alone = gate.runAlone(async () => {
    events.push('gc start');
    started.resolve();

    await release.promise;

    events.push('gc end');
  }, 5000);

  await started.promise;

  const op = gate.join(() => {
    events.push('op');

    return Promise.resolve();
  });

  const whileAlone = [...events];

  release.resolve();

  await alone;
  await op;

  expect(whileAlone).toStrictEqual(['gc start']);
  expect(events).toStrictEqual(['gc start', 'gc end', 'op']);
});

test('it gives up a task alone when operations keep the gate busy past its timeout', async () => {
  const gate = createStorageGate();
  const stuck = Promise.withResolvers<void>();

  onTestFinished(() => {
    stuck.resolve();
  });

  const op = gate.join(() => stuck.promise);

  // a timeout of 0 is already past: the task never waits on a timer
  const alone = await gate.runAlone(() => Promise.resolve('never'), 0);

  const inFlight = gate.countInFlight();

  stuck.resolve();

  await op;

  expect(alone).toStrictEqual({ ran: false });
  expect(inFlight).toBe(1);
});

test('it gives up a task alone whose wait runs out while an operation stays in flight', async () => {
  const gate = createStorageGate();
  const stuck = Promise.withResolvers<void>();

  onTestFinished(() => {
    stuck.resolve();
  });

  const op = gate.join(() => stuck.promise);
  const task = mock(() => Promise.resolve('never'));

  // a short real wait, long enough to see it start: then its deadline passes
  const alone = gate.runAlone(task, 200);

  await waitFor(() => {
    expect(gate.countWaiting()).toBe(1);
  });

  const result = await alone;

  const waitingAfter = gate.countWaiting();

  stuck.resolve();

  await op;

  expect(result).toStrictEqual({ ran: false });
  expect(task).not.toHaveBeenCalled();
  expect(waitingAfter).toBe(0);
});

test('it counts a task alone as waiting until the operations in flight end', async () => {
  const gate = createStorageGate();
  const stuck = Promise.withResolvers<void>();

  onTestFinished(() => {
    stuck.resolve();
  });

  const op = gate.join(() => stuck.promise);
  const alone = gate.runAlone(() => Promise.resolve('swept'), 5000);

  await waitFor(() => {
    expect(gate.countWaiting()).toBe(1);
  });

  stuck.resolve();

  await op;
  await alone;

  expect(gate.countWaiting()).toBe(0);
});

test('it counts an operation as in flight only until it ends', async () => {
  const gate = createStorageGate();

  await gate.join(() => Promise.resolve());

  expect(gate.countInFlight()).toBe(0);
});

test('it runs a second task alone only after the first one ends', async () => {
  const gate = createStorageGate();
  const events: string[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  onTestFinished(() => {
    release.resolve();
  });

  const first = gate.runAlone(async () => {
    events.push('first start');
    started.resolve();

    await release.promise;

    events.push('first end');
  }, 5000);

  const second = gate.runAlone(() => {
    events.push('second');

    return Promise.resolve();
  }, 5000);

  await started.promise;

  release.resolve();

  await Promise.all([first, second]);

  expect(events).toStrictEqual(['first start', 'first end', 'second']);
});

test('it lets operations through again after a task alone throws', async () => {
  const gate = createStorageGate();
  const failed = gate.runAlone(() => Promise.reject(new Error('the sweep failed')), 5000);

  expect(failed).rejects.toThrowWithMessage(Error, 'the sweep failed');

  const after = await gate.join(() => Promise.resolve('ran'));

  expect(after).toBe('ran');
});
