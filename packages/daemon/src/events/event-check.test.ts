import { expect, test } from 'bun:test';
import { EVENT_VERSION } from '@imp/api';
import { buildMockGovernorDecision } from '../test-utils/build-mock-governor-decision';
import { startInMemoryMetrics } from '../test-utils/start-in-memory-metrics';
import { createEventCheck } from './event-check';

function setupTest() {
  const metrics = startInMemoryMetrics();
  const clock = { ms: 0 };
  const logs: string[] = [];

  const isValid = createEventCheck({
    log: (message) => {
      logs.push(message);
    },
    now: () => clock.ms,
  });

  return { metrics, clock, logs, isValid };
}

test('it passes an event that the schema accepts, and logs and counts nothing', async () => {
  const ctx = setupTest();
  const isValid = ctx.isValid(buildMockGovernorDecision());

  const dropped = await ctx.metrics.readPoints('imp.events.dropped');

  expect(isValid).toBe(true);
  expect(ctx.logs).toStrictEqual([]);
  expect(dropped).toStrictEqual([]);
});

test('it counts and logs an event that fails the schema once, however many streams check it', async () => {
  const ctx = setupTest();

  // no imp is named with a space
  const event = buildMockGovernorDecision({ name: 'boot template' });
  const checks = [ctx.isValid(event), ctx.isValid(event), ctx.isValid(event)];

  const dropped = await ctx.metrics.readPoints('imp.events.dropped');

  expect(checks).toStrictEqual([false, false, false]);

  expect(ctx.logs).toStrictEqual([
    'impd: dropped 1 GovernorDecision event(s) that fail the event schema; the latest at name: must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  ]);

  expect(dropped).toStrictEqual([{ attributes: { ev: 'GovernorDecision' }, value: 1 }]);
});

test('it logs the drops of one type at most every 5 minutes, with the count since', async () => {
  const ctx = setupTest();

  ctx.isValid(buildMockGovernorDecision({ name: 'Bad' }));

  ctx.clock.ms = 60_000;

  ctx.isValid(buildMockGovernorDecision({ name: 'Worse' }));
  ctx.isValid(buildMockGovernorDecision({ name: '1st' }));

  ctx.clock.ms = 5 * 60_000;

  ctx.isValid(buildMockGovernorDecision({ name: 'Last' }));

  const dropped = await ctx.metrics.readPoints('imp.events.dropped');

  expect(ctx.logs).toStrictEqual([
    'impd: dropped 1 GovernorDecision event(s) that fail the event schema; the latest at name: must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    'impd: dropped 3 GovernorDecision event(s) that fail the event schema; the latest at name: must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  ]);

  expect(dropped).toStrictEqual([{ attributes: { ev: 'GovernorDecision' }, value: 4 }]);
});

test('it keeps a log interval for each event type', async () => {
  const ctx = setupTest();

  ctx.isValid(buildMockGovernorDecision({ name: 'Bad' }));

  ctx.isValid({
    v: EVENT_VERSION,
    at: new Date('2026-10-02T12:00:00Z'),
    ev: 'CheckpointAdded',
    name: 'Bad',
    checkpoint: { id: 'id-1', createdAt: new Date('2026-10-02T12:00:00Z'), diskMib: 1024 },
  });

  const dropped = await ctx.metrics.readPoints('imp.events.dropped');

  expect(ctx.logs).toStrictEqual([
    'impd: dropped 1 GovernorDecision event(s) that fail the event schema; the latest at name: must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    'impd: dropped 1 CheckpointAdded event(s) that fail the event schema; the latest at name: must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  ]);

  expect(dropped).toStrictEqual([
    { attributes: { ev: 'GovernorDecision' }, value: 1 },
    { attributes: { ev: 'CheckpointAdded' }, value: 1 },
  ]);
});

test('it stays inert without a registered meter provider', () => {
  const isValid = createEventCheck({ log: () => {}, now: () => 0 });

  expect(() => isValid(buildMockGovernorDecision({ name: 'boot template' }))).not.toThrow();
});
