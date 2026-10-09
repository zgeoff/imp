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

test('it unregisters the provider when the test ends', () => {
  startInMemoryMetrics();

  onTestFinished(() => {
    // the API takes a new global provider only once the last one is gone
    const isRegistered = metrics.setGlobalMeterProvider(new MeterProvider());

    metrics.disable();

    expect(isRegistered).toBe(true);
  });

  const isTakenOver = metrics.setGlobalMeterProvider(new MeterProvider());

  expect(isTakenOver).toBe(false);
});
