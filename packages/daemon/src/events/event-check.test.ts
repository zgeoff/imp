import { afterEach, expect, test } from 'bun:test';
import { EVENT_VERSION } from '@imp/api';
import type { ImpEvent } from '@imp/api';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { createEventCheck } from './event-check';

const AT = new Date('2026-10-02T12:00:00Z');

afterEach(() => {
  metrics.disable();
});

function buildDecision(name: string): ImpEvent {
  return {
    v: EVENT_VERSION,
    at: AT,
    ev: 'GovernorDecision',
    decision: 'slept',
    name,
    trigger: 'admission',
    usedMib: 0,
    budgetMib: 1024,
  };
}

// a check over a clock the test moves, with its log lines and the
// `imp.events.dropped` points as `attributes=value`
function setupEventCheck() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

  const meterProvider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
  });

  metrics.setGlobalMeterProvider(meterProvider);

  const clock = { ms: 0 };
  const logs: string[] = [];

  const isValid = createEventCheck({
    log: (message) => {
      logs.push(message);
    },
    now: () => clock.ms,
  });

  const readDropped = async (): Promise<string[]> => {
    await meterProvider.forceFlush();

    const metric = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .findLast((candidate) => candidate.descriptor.name === 'imp.events.dropped');

    return (metric?.dataPoints ?? []).map(
      (point) => `${JSON.stringify(point.attributes)}=${JSON.stringify(point.value)}`,
    );
  };

  return {
    isValid,
    logs,
    clock,
    readDropped,
    async [Symbol.asyncDispose]() {
      await meterProvider.shutdown();
    },
  };
}

test('a valid event passes', async () => {
  await using check = setupEventCheck();

  expect(check.isValid(buildDecision('dev'))).toBe(true);
  expect(check.logs).toEqual([]);

  const dropped = await check.readDropped();

  expect(dropped).toEqual([]);
});

test('an event that fails the schema is counted and logged once, whoever checks it', async () => {
  await using check = setupEventCheck();

  // no imp is named with a space; three streams check the one event
  const event = buildDecision('boot template');

  expect([check.isValid(event), check.isValid(event), check.isValid(event)]).toEqual([
    false,
    false,
    false,
  ]);

  expect(check.logs).toEqual([
    'impd: dropped 1 GovernorDecision event(s) that fail the event schema; the latest at name: must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  ]);

  const dropped = await check.readDropped();

  expect(dropped).toEqual(['{"ev":"GovernorDecision"}=1']);
});

test('drops of one type are logged at most every 5 minutes, with the count since', async () => {
  await using check = setupEventCheck();

  check.isValid(buildDecision('Bad'));

  check.clock.ms = 60_000;

  check.isValid(buildDecision('Worse'));
  check.isValid(buildDecision('1st'));

  check.clock.ms = 5 * 60_000;

  check.isValid(buildDecision('Last'));

  expect(check.logs.map((line) => line.split(';')[0])).toEqual([
    'impd: dropped 1 GovernorDecision event(s) that fail the event schema',
    'impd: dropped 3 GovernorDecision event(s) that fail the event schema',
  ]);

  const dropped = await check.readDropped();

  expect(dropped).toEqual(['{"ev":"GovernorDecision"}=4']);
});

test('each event type has its own log interval', async () => {
  await using check = setupEventCheck();

  const checkpoint: ImpEvent = {
    v: EVENT_VERSION,
    at: AT,
    ev: 'CheckpointAdded',
    name: 'Bad',
    checkpoint: { id: 'id-1', createdAt: AT, diskMib: 1024 },
  };

  check.isValid(buildDecision('Bad'));
  check.isValid(checkpoint);

  expect(check.logs.map((line) => line.split(' event(s)')[0])).toEqual([
    'impd: dropped 1 GovernorDecision',
    'impd: dropped 1 CheckpointAdded',
  ]);

  const dropped = await check.readDropped();

  expect(dropped).toEqual(['{"ev":"GovernorDecision"}=1', '{"ev":"CheckpointAdded"}=1']);
});
