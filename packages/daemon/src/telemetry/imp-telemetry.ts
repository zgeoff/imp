import { ImpStateSchema } from '@imp/api';
import type { ImpEvent, ImpState } from '@imp/api';
import { ROOT_CONTEXT, metrics, trace } from '@opentelemetry/api';
import type { BatchObservableCallback } from '@opentelemetry/api';
import type { EventBus } from '../events/event-bus';
import type { ResourceDelta } from '../imps/resource-sampler';

// impd's instruments (docs/guides/events.md). Every attribute comes from a
// closed set, never an imp's name, so a series count stays bounded.
const SCOPE = 'impd';

// the timed transitions, as the span each one becomes
const SPAN_NAMES: Readonly<Partial<Record<string, string>>> = {
  booted: 'imp.boot',
  woke: 'imp.wake',
  slept: 'imp.sleep',
  restored: 'imp.restore',
};

interface RamReading {
  readonly usedMib: number;
  readonly budgetMib: number;
}

interface TelemetryDeps {
  readonly bus: EventBus;
  readonly readStateCounts: () => Promise<ReadonlyMap<ImpState, number>>;
  readonly readRam: () => Promise<RamReading>;

  // the disk-usage pass's exclusive bytes, together; none in a test without
  readonly readDiskUsedBytes?: () => number;

  // each pass of the resource sampler; none in a test that has no sampler
  readonly subscribeResources?: (
    listener: (deltas: readonly ResourceDelta[]) => void,
  ) => () => void;
}

// Records from the event bus and two readers. With no SDK registered (no
// OTEL_EXPORTER_OTLP_ENDPOINT), the API's no-op meter and tracer take it all.
// Returns the stop.
export function startImpTelemetry(deps: TelemetryDeps): () => void {
  const meter = metrics.getMeter(SCOPE);
  const tracer = trace.getTracer(SCOPE);

  const transitions = meter.createCounter('imp.lifecycle.transitions', {
    description: 'imp records created, changed or removed, by reason',
  });

  const durations = meter.createHistogram('imp.lifecycle.duration', {
    description: 'how long a boot, wake, sleep or restore took',
    unit: 'ms',
  });

  const decisions = meter.createCounter('imp.governor.decisions', {
    description: 'admissions, refusals and sleeps by the RAM governor',
  });

  const states = meter.createObservableGauge('imp.imps', {
    description: 'imps by state',
  });

  const ramUsed = meter.createObservableGauge('imp.ram.used', {
    description: 'RAM the awake imps own, as the governor measures it',
    unit: 'MiBy',
  });

  const ramBudget = meter.createObservableGauge('imp.ram.budget', {
    description: 'the RAM budget the governor keeps the imps under',
    unit: 'MiBy',
  });

  const diskUsed = meter.createObservableGauge('imp.disk.used', {
    description: 'disk the imps take on their own, together, as of the last usage pass',
    unit: 'By',
  });

  const cpuUsage = meter.createObservableGauge('imp.cpu.usage', {
    description: 'cores the running imps used over the last sample, together',
  });

  const cpuThrottled = meter.createCounter('imp.cpu.throttled', {
    description: 'time CPU limits held imps back',
    unit: 's',
  });

  const cpuUtilization = meter.createHistogram('imp.cpu.utilization', {
    description: "each running imp's CPU over a sample, in percent of one core",
    unit: '%',
  });

  const networkIo = meter.createCounter('imp.network.io', {
    description: "bytes through the imps' network, as the guests see it",
    unit: 'By',
  });

  const awakeTime = meter.createCounter('imp.awake.time', {
    description: 'time imps spent running, together',
    unit: 's',
  });

  // the last pass's total, for the gauge
  const lastPass = { cores: 0 };

  const handlePass = (deltas: readonly ResourceDelta[]): void => {
    let cores = 0;

    for (const delta of deltas) {
      cores += delta.cpuPercent / 100;

      cpuUtilization.record(delta.cpuPercent);
      cpuThrottled.add(delta.throttledUsec / 1_000_000);
      networkIo.add(delta.netRxBytes, { direction: 'rx' });
      networkIo.add(delta.netTxBytes, { direction: 'tx' });
      awakeTime.add(delta.intervalMs / 1000);
    }

    lastPass.cores = cores;
  };

  const readGauges: BatchObservableCallback = async (result) => {
    const [counts, ram] = await Promise.all([deps.readStateCounts(), deps.readRam()]);

    for (const state of ImpStateSchema.options) {
      result.observe(states, counts.get(state) ?? 0, { state });
    }

    result.observe(ramUsed, ram.usedMib);
    result.observe(ramBudget, ram.budgetMib);
    result.observe(cpuUsage, lastPass.cores);

    if (deps.readDiskUsedBytes !== undefined) {
      result.observe(diskUsed, deps.readDiskUsedBytes());
    }
  };

  const gauges = [states, ramUsed, ramBudget, cpuUsage, diskUsed];

  meter.addBatchObservableCallback(readGauges, gauges);

  const handleEvent = (event: Readonly<ImpEvent>): void => {
    if (event.ev === 'GovernorDecision') {
      decisions.add(1, { decision: event.decision });

      return;
    }

    if (event.ev === 'ImpAdded' && event.reason === 'created') {
      transitions.add(1, { reason: 'created' });
    }

    if (event.ev === 'ImpRemoved') {
      transitions.add(1, { reason: 'removed' });
    }

    if (event.ev !== 'ImpChanged') {
      return;
    }

    transitions.add(1, { reason: event.reason });

    const durationMs = event.detail?.durationMs;
    const spanName = SPAN_NAMES[event.reason];

    if (durationMs === undefined || spanName === undefined) {
      return;
    }

    durations.record(durationMs, { reason: event.reason });

    // the operation ended as the event was sent; its steps ran one after
    // another from its start
    const endMs = event.at.getTime();
    const startMs = endMs - durationMs;

    const span = tracer.startSpan(spanName, {
      startTime: startMs,
      attributes: {
        'imp.name': event.imp.name,
        ...(event.detail?.trigger !== undefined && { 'imp.trigger': event.detail.trigger }),
        ...(event.detail?.coldBootReason !== undefined && {
          'imp.cold_boot_reason': event.detail.coldBootReason,
        }),
      },
    });

    const parent = trace.setSpan(ROOT_CONTEXT, span);
    let stepStartMs = startMs;

    for (const [step, ms] of Object.entries(event.detail?.steps ?? {})) {
      tracer.startSpan(step, { startTime: stepStartMs }, parent).end(stepStartMs + ms);

      stepStartMs += ms;
    }

    span.end(endMs);
  };

  const unsubscribe = deps.bus.subscribe(handleEvent);
  const unsubscribeResources = deps.subscribeResources?.(handlePass);

  return () => {
    unsubscribe();
    unsubscribeResources?.();
    meter.removeBatchObservableCallback(readGauges, gauges);
  };
}
