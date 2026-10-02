import { expect, test } from 'bun:test';
import { EVENT_VERSION } from '@imp/api';
import type { ImpEvent } from '@imp/api';
import { createEventBus } from './event-bus';
import { openEventStream } from './event-stream';

const AT = new Date('2026-10-02T12:00:00Z');

function buildDecision(name: string): ImpEvent {
  return {
    v: EVENT_VERSION,
    at: AT,
    ev: 'GovernorDecision',
    decision: 'admitted',
    name,
    trigger: 'admission',
    usedMib: 0,
    budgetMib: 1024,
  };
}

// the names of the events a stream sent, until it ended
async function readNames(stream: Readonly<AsyncGenerator<ImpEvent>>): Promise<string[]> {
  const names: string[] = [];

  for await (const event of stream) {
    const name = event.ev === 'GovernorDecision' ? event.name : event.ev;

    names.push(name);
  }

  return names;
}

test('an event published while the snapshot is read follows the snapshot', async () => {
  const bus = createEventBus();

  const controller = new AbortController();

  const stream = openEventStream({
    bus,
    readSnapshot: () => {
      bus.publish(buildDecision('during'));

      return Promise.resolve([buildDecision('snapshot')]);
    },
    signal: controller.signal,
    endsAt: null,
    now: Date.now,
  });

  const first = await stream.next();
  const second = await stream.next();

  bus.publish(buildDecision('after'));

  const third = await stream.next();

  controller.abort();

  const names = [first, second, third].map((result) =>
    result.done === true || result.value.ev !== 'GovernorDecision' ? null : result.value.name,
  );

  expect(names).toEqual(['snapshot', 'during', 'after']);

  const last = await stream.next();

  expect(last).toEqual({ done: true, value: undefined });
});

test('a subscriber that falls behind by the queue limit is ended, not stalled', async () => {
  const bus = createEventBus();

  const stream = openEventStream({
    bus,
    readSnapshot: () => {
      for (const name of ['a', 'b', 'c']) {
        bus.publish(buildDecision(name));
      }

      return Promise.resolve([]);
    },
    endsAt: null,
    now: Date.now,
    queueLimit: 2,
  });

  const names = await readNames(stream);

  expect(names).toEqual([]);
});

test('a stream ends at its abort and at its end time, and lets go of the bus', async () => {
  const bus = createEventBus();

  const controller = new AbortController();

  const listeners: string[] = [];

  const counted = {
    publish: bus.publish,
    subscribe: (listener: (event: Readonly<ImpEvent>) => void) => {
      listeners.push('subscribed');

      const unsubscribe = bus.subscribe(listener);

      return () => {
        listeners.push('unsubscribed');

        unsubscribe();
      };
    },
  };

  const aborted = readNames(
    openEventStream({
      bus: counted,
      readSnapshot: () => Promise.resolve([buildDecision('snapshot')]),
      signal: controller.signal,
      endsAt: null,
      now: Date.now,
    }),
  );

  await Bun.sleep(5);

  controller.abort();

  const sent = await aborted;

  expect(sent).toEqual(['snapshot']);

  const startedAt = Date.now();

  const expired = await readNames(
    openEventStream({
      bus: counted,
      readSnapshot: () => Promise.resolve([]),
      endsAt: startedAt + 50,
      now: Date.now,
    }),
  );

  expect(expired).toEqual([]);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
  expect(listeners).toEqual(['subscribed', 'unsubscribed', 'subscribed', 'unsubscribed']);
});
