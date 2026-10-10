import { onTestFinished } from 'bun:test';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

// one data point of a metric, as the in-memory reader exports it
interface MetricPoint {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly value: unknown;
}

// The OpenTelemetry metrics SDK as the global meter provider, exporting to
// memory only when read. At the test's end it shuts the provider down and
// unregisters it, so a later test records to the API's no-op meter again.
export function startInMemoryMetrics() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

  // an hour: no export runs on its own during a test
  const meterProvider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
  });

  const isRegistered = metrics.setGlobalMeterProvider(meterProvider);

  if (!isRegistered) {
    throw new Error(
      'another meter provider is registered; this test would read none of its points',
    );
  }

  onTestFinished(async () => {
    metrics.disable();

    await meterProvider.shutdown();
  });

  return {
    // the points of the metric `name` recorded so far; none for a metric
    // nothing recorded
    readPoints: async (name: string): Promise<MetricPoint[]> => {
      await meterProvider.forceFlush();

      const metric = exporter
        .getMetrics()
        .flatMap((resource) => resource.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .findLast((candidate) => candidate.descriptor.name === name);

      return (metric?.dataPoints ?? []).map((point) => ({
        attributes: point.attributes,
        value: point.value,
      }));
    },
  };
}
