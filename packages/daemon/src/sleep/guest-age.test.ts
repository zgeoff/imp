import { expect, test } from 'bun:test';
import { waitForGuestAge } from './guest-age';

function isAlwaysWanted(): boolean {
  return true;
}

test('an old enough guest sleeps at once without a wait', async () => {
  const waited = await waitForGuestAge({
    readUptimeMs: () => Promise.resolve(5000),
    minUptimeMs: 1500,
    isWanted: isAlwaysWanted,
  });

  expect(waited).toBe(0);
});

test('a young guest waits out the rest of the minimum uptime', async () => {
  const started = performance.now();

  const waited = await waitForGuestAge({
    readUptimeMs: () => Promise.resolve(1350),
    minUptimeMs: 1500,
    isWanted: isAlwaysWanted,
  });

  expect(waited).not.toBeNull();
  expect(performance.now() - started).toBeGreaterThanOrEqual(145);
});

test('0 turns the wait off without asking the agent', async () => {
  let asked = false;

  const waited = await waitForGuestAge({
    readUptimeMs: () => {
      asked = true;

      return Promise.resolve(10);
    },
    minUptimeMs: 0,
    isWanted: isAlwaysWanted,
  });

  expect(waited).toBe(0);
  expect(asked).toBe(false);
});

test('an agent that does not answer does not hold the sleep', async () => {
  const waited = await waitForGuestAge({
    readUptimeMs: () => Promise.resolve(null),
    minUptimeMs: 1500,
    isWanted: isAlwaysWanted,
  });

  expect(waited).toBe(0);
});

test('a sleep that is no longer wanted gives way during the wait', async () => {
  const started = performance.now();
  let checks = 0;

  const waited = await waitForGuestAge({
    readUptimeMs: () => Promise.resolve(0),
    minUptimeMs: 1500,
    isWanted: () => {
      checks += 1;

      return checks < 3;
    },
  });

  expect(waited).toBeNull();
  expect(performance.now() - started).toBeLessThan(1000);
});
