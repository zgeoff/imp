import { expect, test } from 'bun:test';
import { EVENT_VERSION, ImpStateSchema } from '@imp/api';
import { buildMockImp } from '@imp/api/test-utils/build-mock-imp';
import { invariant } from '@imp/test-utils/invariant';
import { createEventBus } from '../events/event-bus';
import type { ResourceDelta } from '../imps/resource-sampler';
import { buildMockGovernorDecision } from '../test-utils/build-mock-governor-decision';
import { startInMemoryMetrics } from '../test-utils/start-in-memory-metrics';
import { startInMemoryTracing } from '../test-utils/start-in-memory-tracing';
import { startImpTelemetry } from './imp-telemetry';

test('it records imp.lifecycle.transitions per reason', async () => {
  const recorded = startInMemoryMetrics();
  const bus = createEventBus();

  const stop = startImpTelemetry({
    bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  bus.publish({
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpAdded',
    reason: 'created',
    imp: buildMockImp(),
  });

  bus.publish({
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'held',
    imp: buildMockImp(),
  });

  bus.publish({
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'held',
    imp: buildMockImp(),
  });

  bus.publish({ v: EVENT_VERSION, at: new Date(), ev: 'ImpRemoved', imp: buildMockImp() });

  stop();

  const points = await recorded.readPoints('imp.lifecycle.transitions');

  expect(points).toStrictEqual([
    { attributes: { reason: 'created' }, value: 1 },
    { attributes: { reason: 'held' }, value: 2 },
    { attributes: { reason: 'removed' }, value: 1 },
  ]);
});

test('it records imp.lifecycle.duration per timed reason', async () => {
  const recorded = startInMemoryMetrics();
  const bus = createEventBus();

  const stop = startImpTelemetry({
    bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  bus.publish({
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'booted',
    imp: buildMockImp(),
    detail: { durationMs: 900 },
  });

  bus.publish({
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'woke',
    imp: buildMockImp(),
    detail: { durationMs: 40 },
  });

  bus.publish({
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'held',
    imp: buildMockImp(),
    detail: { durationMs: 5 },
  });

  stop();

  const points = await recorded.readPoints('imp.lifecycle.duration');

  expect(points).toStrictEqual([
    { attributes: { reason: 'booted' }, value: expect.objectContaining({ count: 1, sum: 900 }) },
    { attributes: { reason: 'woke' }, value: expect.objectContaining({ count: 1, sum: 40 }) },
  ]);
});

test('it records imp.governor.decisions per decision', async () => {
  const recorded = startInMemoryMetrics();
  const bus = createEventBus();

  const stop = startImpTelemetry({
    bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  bus.publish(buildMockGovernorDecision({ decision: 'refused' }));
  bus.publish(buildMockGovernorDecision({ decision: 'admitted' }));
  bus.publish(buildMockGovernorDecision({ decision: 'refused' }));

  stop();

  const points = await recorded.readPoints('imp.governor.decisions');

  expect(points).toStrictEqual([
    { attributes: { decision: 'refused' }, value: 2 },
    { attributes: { decision: 'admitted' }, value: 1 },
  ]);
});

test('it records a span per timed transition, with each step a child in turn', () => {
  const traced = startInMemoryTracing();
  const bus = createEventBus();

  const stop = startImpTelemetry({
    bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  bus.publish({
    v: EVENT_VERSION,
    at: new Date('2026-10-02T12:00:00.900Z'),
    ev: 'ImpChanged',
    reason: 'booted',
    imp: buildMockImp({ name: 'dev' }),
    detail: { durationMs: 900, steps: { 'boot.tap': 100, 'boot.vm': 800 } },
  });

  stop();

  const spans = traced.readSpans().map((span) => ({
    name: span.name,
    startMs: span.startTime[0] * 1000 + span.startTime[1] / 1e6,
    endMs: span.endTime[0] * 1000 + span.endTime[1] / 1e6,
    parentSpanId: span.parentSpanContext?.spanId,
    attributes: span.attributes,
  }));

  const rootSpanId = traced.readSpans().at(-1)?.spanContext().spanId;

  expect(spans).toStrictEqual([
    {
      name: 'boot.tap',
      startMs: Date.parse('2026-10-02T12:00:00.000Z'),
      endMs: Date.parse('2026-10-02T12:00:00.100Z'),
      parentSpanId: rootSpanId,
      attributes: {},
    },
    {
      name: 'boot.vm',
      startMs: Date.parse('2026-10-02T12:00:00.100Z'),
      endMs: Date.parse('2026-10-02T12:00:00.900Z'),
      parentSpanId: rootSpanId,
      attributes: {},
    },
    {
      name: 'imp.boot',
      startMs: Date.parse('2026-10-02T12:00:00.000Z'),
      endMs: Date.parse('2026-10-02T12:00:00.900Z'),
      parentSpanId: undefined,
      attributes: { 'imp.name': 'dev' },
    },
  ]);
});

test('it puts the trigger and the cold boot reason on the span', () => {
  const traced = startInMemoryTracing();
  const bus = createEventBus();

  const stop = startImpTelemetry({
    bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  bus.publish({
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'woke',
    imp: buildMockImp({ name: 'dev' }),
    detail: { durationMs: 40, trigger: 'exec', coldBootReason: 'no-snapshot' },
  });

  stop();

  const attributes = traced.readSpans().map((span) => span.attributes);

  expect(attributes).toStrictEqual([
    { 'imp.name': 'dev', 'imp.trigger': 'exec', 'imp.cold_boot_reason': 'no-snapshot' },
  ]);
});

test('it records no span for a transition without a duration', () => {
  const traced = startInMemoryTracing();
  const bus = createEventBus();

  const stop = startImpTelemetry({
    bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  bus.publish({
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'booted',
    imp: buildMockImp(),
  });

  stop();

  expect(traced.readSpans()).toStrictEqual([]);
});

test('it reads the imps by state into imp.imps', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    bus: createEventBus(),
    readStateCounts: () => Promise.resolve(new Map([['sleeping', 3]])),
    readRam: () => Promise.resolve({ usedMib: 600, budgetMib: 4096 }),
  });

  const points = await recorded.readPoints('imp.imps');

  stop();

  expect(points).toHaveLength(ImpStateSchema.options.length);

  expect(points).toIncludeAllMembers([
    { attributes: { state: 'sleeping' }, value: 3 },
    { attributes: { state: 'running' }, value: 0 },
  ]);

  const others = points.filter((point) => point.attributes['state'] !== 'sleeping');

  expect(others.map((point) => point.value)).toSatisfyAll((value: unknown) => value === 0);
});

test('it reads the RAM in use into imp.ram.used', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    bus: createEventBus(),
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 600, budgetMib: 4096 }),
  });

  const points = await recorded.readPoints('imp.ram.used');

  stop();

  expect(points).toStrictEqual([{ attributes: {}, value: 600 }]);
});

test('it reads the RAM budget into imp.ram.budget', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    bus: createEventBus(),
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 600, budgetMib: 4096 }),
  });

  const points = await recorded.readPoints('imp.ram.budget');

  stop();

  expect(points).toStrictEqual([{ attributes: {}, value: 4096 }]);
});

test('it reads the disk the imps take on their own into imp.disk.used', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    bus: createEventBus(),
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
    readDiskUsedBytes: () => 3_221_225_472,
  });

  const points = await recorded.readPoints('imp.disk.used');

  stop();

  expect(points).toStrictEqual([{ attributes: {}, value: 3_221_225_472 }]);
});

test('it reads no gauge once stopped', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    bus: createEventBus(),
    readStateCounts: () => Promise.resolve(new Map([['running', 2]])),
    readRam: () => Promise.resolve({ usedMib: 600, budgetMib: 4096 }),
  });

  stop();

  const points = await recorded.readPoints('imp.imps');

  expect(points).toStrictEqual([]);
});

test('it feeds each sampler pass to the CPU, network and awake instruments', async () => {
  const recorded = startInMemoryMetrics();
  const listeners: ((deltas: readonly ResourceDelta[]) => void)[] = [];

  const stop = startImpTelemetry({
    bus: createEventBus(),
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
    subscribeResources: (listener) => {
      listeners.push(listener);

      return () => {};
    },
  });

  const [listener] = listeners;

  invariant(listener);

  listener([
    {
      intervalMs: 5000,
      cpuPercent: 50,
      cpuUsec: 2_500_000,
      throttledUsec: 500_000,
      netRxBytes: 1000,
      netTxBytes: 30,
    },
    {
      intervalMs: 5000,
      cpuPercent: 150,
      cpuUsec: 7_500_000,
      throttledUsec: 500_000,
      netRxBytes: 1000,
      netTxBytes: 30,
    },
  ]);

  const usage = await recorded.readPoints('imp.cpu.usage');
  const utilization = await recorded.readPoints('imp.cpu.utilization');
  const throttled = await recorded.readPoints('imp.cpu.throttled');
  const network = await recorded.readPoints('imp.network.io');
  const awake = await recorded.readPoints('imp.awake.time');

  stop();

  expect(usage).toStrictEqual([{ attributes: {}, value: 2 }]);

  expect(utilization).toStrictEqual([
    { attributes: {}, value: expect.objectContaining({ count: 2, sum: 200 }) },
  ]);

  expect(throttled).toStrictEqual([{ attributes: {}, value: 1 }]);

  expect(network).toStrictEqual([
    { attributes: { direction: 'rx' }, value: 2000 },
    { attributes: { direction: 'tx' }, value: 60 },
  ]);

  expect(awake).toStrictEqual([{ attributes: {}, value: 10 }]);
});

test('it stays inert without a registered meter provider', () => {
  const bus = createEventBus();

  const stop = startImpTelemetry({
    bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  expect(() => {
    bus.publish({
      v: EVENT_VERSION,
      at: new Date(),
      ev: 'ImpChanged',
      reason: 'booted',
      imp: buildMockImp(),
      detail: { durationMs: 900, steps: { 'boot.vm': 900 } },
    });

    stop();
  }).not.toThrow();
});
