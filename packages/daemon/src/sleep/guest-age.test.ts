import { expect, mock, test } from 'bun:test';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { waitForGuestAge } from './guest-age';

test('it sleeps a guest old enough at once without a wait', async () => {
  const clock = buildStubClock();

  const waited = await waitForGuestAge({
    readUptimeMs: () => Promise.resolve(5000),
    minUptimeMs: 1500,
    isWanted: () => Promise.resolve(true),
    now: clock.now,
    sleep: clock.sleep,
  });

  expect(waited).toBe(0);
  expect(clock.sleeps).toStrictEqual([]);
});

test('it waits out the rest of the minimum uptime for a young guest', async () => {
  const clock = buildStubClock();

  const waited = await waitForGuestAge({
    readUptimeMs: () => Promise.resolve(1350),
    minUptimeMs: 1500,
    isWanted: () => Promise.resolve(true),
    now: clock.now,
    sleep: clock.sleep,
  });

  expect(waited).toBe(150);
});

test('it checks whether the sleep is still wanted every 50 ms of the wait', async () => {
  const clock = buildStubClock();

  await waitForGuestAge({
    readUptimeMs: () => Promise.resolve(1380),
    minUptimeMs: 1500,
    isWanted: () => Promise.resolve(true),
    now: clock.now,
    sleep: clock.sleep,
  });

  expect(clock.sleeps).toStrictEqual([50, 50, 20]);
});

test('it turns the wait off at a minimum of 0 without asking the agent', async () => {
  const readUptimeMs = mock(() => Promise.resolve(10));

  const waited = await waitForGuestAge({
    readUptimeMs,
    minUptimeMs: 0,
    isWanted: () => Promise.resolve(true),
  });

  expect(waited).toBe(0);
  expect(readUptimeMs).not.toHaveBeenCalled();
});

test('it lets the sleep go ahead when the agent does not answer', async () => {
  const waited = await waitForGuestAge({
    readUptimeMs: () => Promise.resolve(null),
    minUptimeMs: 1500,
    isWanted: () => Promise.resolve(true),
  });

  expect(waited).toBe(0);
});

test('it gives way during the wait once the sleep is no longer wanted', async () => {
  const clock = buildStubClock();
  const answers = [true, true, false];

  const waited = await waitForGuestAge({
    readUptimeMs: () => Promise.resolve(0),
    minUptimeMs: 1500,
    isWanted: () => Promise.resolve(answers.shift() ?? false),
    now: clock.now,
    sleep: clock.sleep,
  });

  expect(waited).toBeNull();
  expect(clock.now()).toBe(100);
});

test('it gives way when the sleep is no longer wanted as the wait ends', async () => {
  const clock = buildStubClock();
  const answers = [true, false];

  const waited = await waitForGuestAge({
    readUptimeMs: () => Promise.resolve(1450),
    minUptimeMs: 1500,
    isWanted: () => Promise.resolve(answers.shift() ?? false),
    now: clock.now,
    sleep: clock.sleep,
  });

  expect(waited).toBeNull();
});
