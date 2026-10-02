import { afterEach, expect, test } from 'bun:test';
import { EVENT_VERSION } from '@imp/api';
import type { Imp, ImpEvent } from '@imp/api';
import { metrics, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createEventBus } from '../events/event-bus';
import type { ResourceDelta } from '../imps/resource-sampler';
import { startImpTelemetry } from './imp-telemetry';

const AT = new Date('2026-10-02T12:00:00Z');

const imp: Imp = {
  id: 'id-dev',
  name: 'dev',
  image: 'base',
  state: 'running',
  vcpus: 2,
  memoryMib: 2048,
  diskMib: 32_768,
  ip: '10.66.0.2',
  slot: 0,
  port: 20_000,
  httpPort: 8080,
  url: 'http://dev.imp.localhost:7080',
  createdAt: AT,
  lastActiveAt: AT,
};

afterEach(() => {
  metrics.disable();
  trace.disable();
});

// the SDK in memory as the global providers, as an OTLP export would set it
function setupInMemoryTelemetry() {
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 3_600_000,
      }),
    ],
  });

  const spanExporter = new InMemorySpanExporter();

  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });

  metrics.setGlobalMeterProvider(meterProvider);
  trace.setGlobalTracerProvider(tracerProvider);

  // each data point of the metric, as `attributes=value`
  const readPoints = async (name: string): Promise<string[]> => {
    await meterProvider.forceFlush();

    const metric = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .findLast((candidate) => candidate.descriptor.name === name);

    if (metric === undefined) {
      return [];
    }

    if (metric.dataPointType === DataPointType.HISTOGRAM) {
      return metric.dataPoints.map(
        (point) => `${JSON.stringify(point.attributes)}=count ${String(point.value.count)}`,
      );
    }

    return metric.dataPoints.map((point) => {
      const value = typeof point.value === 'number' ? String(point.value) : 'not a number';

      return `${JSON.stringify(point.attributes)}=${value}`;
    });
  };

  return {
    readPoints,
    readSpans: () => spanExporter.getFinishedSpans(),
    async [Symbol.asyncDispose]() {
      await meterProvider.shutdown();
      await tracerProvider.shutdown();
    },
  };
}

test('it counts transitions and decisions, and times the timed ones', async () => {
  await using telemetry = setupInMemoryTelemetry();

  const bus = createEventBus();

  const stop = startImpTelemetry({
    bus,
    readStateCounts: () => Promise.resolve(new Map([['running', 2]])),
    readRam: () => Promise.resolve({ usedMib: 600, budgetMib: 4096 }),
  });

  const envelope = { v: EVENT_VERSION, at: AT } as const;

  const events: ImpEvent[] = [
    { ...envelope, ev: 'ImpAdded', reason: 'created', imp },
    {
      ...envelope,
      ev: 'ImpChanged',
      reason: 'booted',
      imp,
      detail: { durationMs: 900, steps: { 'boot.tap': 100, 'boot.vm': 800 } },
    },
    { ...envelope, ev: 'ImpChanged', reason: 'held', imp },
    {
      ...envelope,
      ev: 'GovernorDecision',
      decision: 'refused',
      name: 'dev',
      trigger: 'admission',
      usedMib: 600,
      budgetMib: 4096,
    },
  ];

  for (const event of events) {
    bus.publish(event);
  }

  stop();

  const transitions = await telemetry.readPoints('imp.lifecycle.transitions');
  const durations = await telemetry.readPoints('imp.lifecycle.duration');
  const decisions = await telemetry.readPoints('imp.governor.decisions');
  const states = await telemetry.readPoints('imp.imps');

  expect(transitions).toEqual([
    '{"reason":"created"}=1',
    '{"reason":"booted"}=1',
    '{"reason":"held"}=1',
  ]);

  expect(durations).toEqual(['{"reason":"booted"}=count 1']);
  expect(decisions).toEqual(['{"decision":"refused"}=1']);

  const spans = telemetry.readSpans().map((span) => [span.name, span.duration[1] / 1e6]);

  expect(spans).toEqual([
    ['boot.tap', 100],
    ['boot.vm', 800],
    ['imp.boot', 900],
  ]);

  // stopped: the gauges no longer read
  expect(states).toEqual([]);
});

test('the gauges read imps by state and the RAM in use against the budget', async () => {
  await using telemetry = setupInMemoryTelemetry();

  const stop = startImpTelemetry({
    bus: createEventBus(),
    readStateCounts: () => Promise.resolve(new Map([['sleeping', 3]])),
    readRam: () => Promise.resolve({ usedMib: 600, budgetMib: 4096 }),
  });

  const states = await telemetry.readPoints('imp.imps');
  const used = await telemetry.readPoints('imp.ram.used');
  const budget = await telemetry.readPoints('imp.ram.budget');

  stop();

  expect(states).toContain('{"state":"sleeping"}=3');
  expect(states).toContain('{"state":"running"}=0');
  expect(used).toEqual(['{}=600']);
  expect(budget).toEqual(['{}=4096']);
});

test('each sampler pass feeds the CPU, network and awake instruments, with no imp name', async () => {
  await using telemetry = setupInMemoryTelemetry();

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

  const delta = {
    intervalMs: 5000,
    cpuPercent: 50,
    cpuUsec: 2_500_000,
    throttledUsec: 500_000,
    netRxBytes: 1000,
    netTxBytes: 30,
  };

  for (const listener of listeners) {
    listener([delta, { ...delta, cpuPercent: 150 }]);
  }

  const usage = await telemetry.readPoints('imp.cpu.usage');
  const utilization = await telemetry.readPoints('imp.cpu.utilization');
  const throttled = await telemetry.readPoints('imp.cpu.throttled');
  const network = await telemetry.readPoints('imp.network.io');
  const awake = await telemetry.readPoints('imp.awake.time');

  stop();

  expect(usage).toEqual(['{}=2']);
  expect(utilization).toEqual(['{}=count 2']);
  expect(throttled).toEqual(['{}=1']);
  expect(network).toEqual(['{"direction":"rx"}=2000', '{"direction":"tx"}=60']);
  expect(awake).toEqual(['{}=10']);
});
