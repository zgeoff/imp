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
