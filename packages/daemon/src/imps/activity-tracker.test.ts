import { expect, test } from 'bun:test';
import { createActivityTracker } from './activity-tracker';

test('it counts open connections per imp and kind', () => {
  const tracker = createActivityTracker();
  const closeExec = tracker.open('a', 'exec');
  const closeProxy = tracker.open('a', 'proxy');

  tracker.open('b', 'proxy');

  expect(tracker.count('a')).toBe(2);
  expect(tracker.count('a', 'exec')).toBe(1);

  closeExec();
  closeExec();

  expect(tracker.count('a')).toBe(1);

  closeProxy();

  expect(tracker.count('a')).toBe(0);
  expect(tracker.count('b')).toBe(1);
});

test('an SSH connection counts toward the imp total', () => {
  const tracker = createActivityTracker();
  const closeSsh = tracker.open('a', 'ssh');

  tracker.open('a', 'exec');

  expect(tracker.count('a')).toBe(2);
  expect(tracker.count('a', 'ssh')).toBe(1);

  closeSsh();

  expect(tracker.count('a')).toBe(1);
});
