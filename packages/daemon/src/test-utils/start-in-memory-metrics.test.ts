import { expect, onTestFinished, test } from 'bun:test';
import { metrics } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { startInMemoryMetrics } from './start-in-memory-metrics';

test('it reads back each point a counter recorded, per attribute set', async () => {
  const recorded = startInMemoryMetrics();
  const counter = metrics.getMeter('test').createCounter('test.counted');

  counter.add(1, { kind: 'a' });
  counter.add(2, { kind: 'b' });
  counter.add(3, { kind: 'a' });

  const points = await recorded.readPoints('test.counted');

  expect(points).toStrictEqual([
    { attributes: { kind: 'a' }, value: 4 },
    { attributes: { kind: 'b' }, value: 2 },
  ]);
});

test('it reads no points for a metric nothing recorded', async () => {
  const recorded = startInMemoryMetrics();

  const points = await recorded.readPoints('test.never');

  expect(points).toStrictEqual([]);
});

test('it throws when another meter provider is registered', () => {
  const other = new MeterProvider();

  onTestFinished(() => other.shutdown());

  metrics.setGlobalMeterProvider(other);

  onTestFinished(() => {
    metrics.disable();
  });

  expect(() => startInMemoryMetrics()).toThrowWithMessage(
    Error,
    'another meter provider is registered; this test would read none of its points',
  );
});

test('it unregisters the provider when the test ends', () => {
  startInMemoryMetrics();

  onTestFinished(async () => {
    const next = new MeterProvider();

    // the API takes a new global provider only once the last one is gone
    const isRegistered = metrics.setGlobalMeterProvider(next);

    metrics.disable();

    await next.shutdown();

    expect(isRegistered).toBe(true);
  });

  const intruder = new MeterProvider();

  onTestFinished(() => intruder.shutdown());

  const isTakenOver = metrics.setGlobalMeterProvider(intruder);

  expect(isTakenOver).toBe(false);
});
