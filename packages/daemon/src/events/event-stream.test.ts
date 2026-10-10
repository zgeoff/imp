import { expect, test } from 'bun:test';
import type { ImpEvent } from '@imp/api';
import { buildMockGovernorDecision } from '../test-utils/build-mock-governor-decision';
import { buildStubTimers } from '../test-utils/build-stub-timers';
import { createEventBus } from './event-bus';
import { openEventStream } from './event-stream';

test('it sends an event published while the snapshot is read after the snapshot', async () => {
  const bus = createEventBus();

  const controller = new AbortController();

  const snapshot = buildMockGovernorDecision({ name: 'snapshot' });
  const during = buildMockGovernorDecision({ name: 'during' });
  const after = buildMockGovernorDecision({ name: 'after' });

  const stream = openEventStream({
    bus,
    readSnapshot: () => {
      bus.publish(during);

      return Promise.resolve([snapshot]);
    },
    signal: controller.signal,
    endsAt: null,
    now: () => Date.UTC(2026, 9, 2, 12),
  });

  const first = await stream.next();
  const second = await stream.next();

  bus.publish(after);

  const third = await stream.next();

  controller.abort();

  expect(first).toStrictEqual({ done: false, value: snapshot });
  expect(second).toStrictEqual({ done: false, value: during });
  expect(third).toStrictEqual({ done: false, value: after });
});

test('it ends a subscriber that falls behind by the queue limit', async () => {
  const bus = createEventBus();

  const stream = openEventStream({
    bus,
    readSnapshot: () => {
      bus.publish(buildMockGovernorDecision());
      bus.publish(buildMockGovernorDecision());
      bus.publish(buildMockGovernorDecision());

      return Promise.resolve([]);
    },
    endsAt: null,
    now: () => Date.UTC(2026, 9, 2, 12),
    queueLimit: 2,
  });

  const sent = await Array.fromAsync(stream);

  expect(sent).toStrictEqual([]);
});

test('it leaves out the events its subscriber may not see', async () => {
  const bus = createEventBus();

  const controller = new AbortController();

  const shown = buildMockGovernorDecision({ name: 'shown' });

  const stream = openEventStream({
    bus,
    readSnapshot: () => Promise.resolve([]),
    signal: controller.signal,
    endsAt: null,
    now: () => Date.UTC(2026, 9, 2, 12),
    accepts: (event) => event.ev === 'GovernorDecision' && event.name !== 'hidden',
  });

  const next = stream.next();

  bus.publish(buildMockGovernorDecision({ name: 'hidden' }));
  bus.publish(shown);

  const first = await next;

  controller.abort();

  expect(first).toStrictEqual({ done: false, value: shown });
});

test('it ends at its abort and lets go of the bus', async () => {
  const bus = createEventBus();

  const controller = new AbortController();

  const subscriptions: string[] = [];

  const counted = {
    publish: bus.publish,
    subscribe: (listener: (event: Readonly<ImpEvent>) => void) => {
      subscriptions.push('subscribed');

      const unsubscribe = bus.subscribe(listener);

      return () => {
        subscriptions.push('unsubscribed');

        unsubscribe();
      };
    },
  };

  const snapshot = buildMockGovernorDecision();

  const stream = openEventStream({
    bus: counted,
    readSnapshot: () => Promise.resolve([snapshot]),
    signal: controller.signal,
    endsAt: null,
    now: () => Date.UTC(2026, 9, 2, 12),
  });

  const first = await stream.next();

  const waiting = stream.next();

  controller.abort();

  const last = await waiting;

  expect(first).toStrictEqual({ done: false, value: snapshot });
  expect(last).toStrictEqual({ done: true, value: undefined });
  expect(subscriptions).toStrictEqual(['subscribed', 'unsubscribed']);
});

test('it ends at its end time and lets go of the bus', async () => {
  const bus = createEventBus();
  const timers = buildStubTimers();
  const subscriptions: string[] = [];

  const counted = {
    publish: bus.publish,
    subscribe: (listener: (event: Readonly<ImpEvent>) => void) => {
      subscriptions.push('subscribed');

      const unsubscribe = bus.subscribe(listener);

      return () => {
        subscriptions.push('unsubscribed');

        unsubscribe();
      };
    },
  };

  const stream = openEventStream({
    bus: counted,
    readSnapshot: () => Promise.resolve([]),
    endsAt: Date.UTC(2026, 9, 2, 12) + 50,
    now: () => Date.UTC(2026, 9, 2, 12),
    startTimer: timers.startTimer,
  });

  const waiting = stream.next();
  const pendingMs = timers.readPendingMs();

  timers.firePending();

  const last = await waiting;

  expect(pendingMs).toStrictEqual([50]);
  expect(last).toStrictEqual({ done: true, value: undefined });
  expect(subscriptions).toStrictEqual(['subscribed', 'unsubscribed']);
  expect(timers.readPendingMs()).toStrictEqual([]);
});

test('it stays open when the longest timer fires short of a 30-day end, and waits out the rest', async () => {
  const bus = createEventBus();

  const controller = new AbortController();

  const timers = buildStubTimers();
  const snapshot = buildMockGovernorDecision();
  const later = buildMockGovernorDecision();
  const clock = { at: Date.UTC(2026, 9, 2, 12) };

  const stream = openEventStream({
    bus,
    readSnapshot: () => Promise.resolve([snapshot]),
    signal: controller.signal,
    endsAt: Date.UTC(2026, 9, 2, 12) + 30 * 86_400_000,
    now: () => clock.at,
    startTimer: timers.startTimer,
  });

  const first = await stream.next();

  const clampedMs = timers.readPendingMs();

  clock.at = Date.UTC(2026, 9, 2, 12) + 2 ** 31 - 1;

  timers.firePending();
  bus.publish(later);

  const second = await stream.next();

  const pendingMs = timers.readPendingMs();

  controller.abort();

  expect(first).toStrictEqual({ done: false, value: snapshot });

  // setTimeout's longest delay: a longer one would fire at once
  expect(clampedMs).toStrictEqual([2 ** 31 - 1]);
  expect(second).toStrictEqual({ done: false, value: later });

  // 30 days (2_592_000_000 ms) less the longest delay already waited
  expect(pendingMs).toStrictEqual([444_516_353]);
});

test('it ends at a 30-day end once the timer after the longest one fires', async () => {
  const bus = createEventBus();
  const timers = buildStubTimers();
  const snapshot = buildMockGovernorDecision();
  const clock = { at: Date.UTC(2026, 9, 2, 12) };

  const stream = openEventStream({
    bus,
    readSnapshot: () => Promise.resolve([snapshot]),
    endsAt: Date.UTC(2026, 9, 2, 12) + 30 * 86_400_000,
    now: () => clock.at,
    startTimer: timers.startTimer,
  });

  await stream.next();

  clock.at = Date.UTC(2026, 9, 2, 12) + 2 ** 31 - 1;

  timers.firePending();

  clock.at = Date.UTC(2026, 9, 2, 12) + 30 * 86_400_000;

  timers.firePending();

  const last = await stream.next();

  expect(last).toStrictEqual({ done: true, value: undefined });
  expect(timers.readPendingMs()).toStrictEqual([]);
});
