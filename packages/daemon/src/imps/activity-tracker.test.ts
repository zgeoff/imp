import { expect, test } from 'bun:test';
import type { ConnectionKind } from './activity-tracker';
import { createActivityTracker } from './activity-tracker';

test('it counts no connections for an imp that never opened one', () => {
  const tracker = createActivityTracker();

  expect(tracker.count('a')).toBe(0);
});

test.each<ConnectionKind>(['exec', 'proxy', 'ssh', 'tunnel'])(
  'it counts a %s connection under its kind and in the imp total',
  (kind) => {
    const tracker = createActivityTracker();

    tracker.open('a', kind);

    expect(tracker.count('a', kind)).toBe(1);
    expect(tracker.count('a')).toBe(1);
  },
);

test('it adds every kind of open connection into the imp total', () => {
  const tracker = createActivityTracker();

  tracker.open('a', 'exec');
  tracker.open('a', 'proxy');
  tracker.open('a', 'ssh');
  tracker.open('a', 'tunnel');

  expect(tracker.count('a')).toBe(4);
});

test('it counts only the connections of the kind asked for', () => {
  const tracker = createActivityTracker();

  tracker.open('a', 'exec');
  tracker.open('a', 'proxy');
  tracker.open('a', 'proxy');

  expect(tracker.count('a', 'proxy')).toBe(2);
});

test('it keeps the connections of one imp out of another imp total', () => {
  const tracker = createActivityTracker();

  tracker.open('a', 'exec');
  tracker.open('b', 'proxy');

  expect(tracker.count('b')).toBe(1);
});

test('it stops counting a connection once it closes', () => {
  const tracker = createActivityTracker();
  const closeExec = tracker.open('a', 'exec');

  tracker.open('a', 'proxy');

  closeExec();

  expect(tracker.count('a')).toBe(1);
});

test('it ignores a second close of the same connection', () => {
  const tracker = createActivityTracker();
  const closeExec = tracker.open('a', 'exec');

  tracker.open('a', 'exec');

  closeExec();
  closeExec();

  expect(tracker.count('a', 'exec')).toBe(1);
});
