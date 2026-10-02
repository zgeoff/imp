import { expect, test } from 'bun:test';
import { createStorageGate } from './storage-gate';

test('a task alone waits for the operations in flight, and new ones wait for it', async () => {
  const gate = createStorageGate();
  const events: string[] = [];
  const first = Promise.withResolvers<void>();

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

  const later = gate.join(() => {
    events.push('op 3');

    return Promise.resolve();
  });

  await later;

  expect(result).toEqual({ ran: true, value: 'dropped' });
  expect(events).toEqual(['op 1 start', 'op 2', 'op 1 end', 'gc', 'op 3']);
});

test('an operation that starts while a task runs alone waits until it ends', async () => {
  const gate = createStorageGate();
  const events: string[] = [];
  const release = Promise.withResolvers<void>();

  const alone = gate.runAlone(async () => {
    events.push('gc start');

    await release.promise;

    events.push('gc end');
  }, 5000);

  await Bun.sleep(1);

  const op = gate.join(() => {
    events.push('op');

    return Promise.resolve();
  });

  await Bun.sleep(1);

  expect(events).toEqual(['gc start']);

  release.resolve();

  await alone;
  await op;

  expect(events).toEqual(['gc start', 'gc end', 'op']);
});

test('a task alone gives up when operations keep the gate busy past its timeout', async () => {
  const gate = createStorageGate();
  const stuck = Promise.withResolvers<void>();
  const op = gate.join(() => stuck.promise);

  const alone = await gate.runAlone(() => Promise.resolve('never'), 20);

  expect(alone).toEqual({ ran: false });
  expect(gate.countInFlight()).toBe(1);

  stuck.resolve();

  await op;

  expect(gate.countInFlight()).toBe(0);
});
