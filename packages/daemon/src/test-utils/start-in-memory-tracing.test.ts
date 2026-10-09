import { expect, onTestFinished, test } from 'bun:test';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { startInMemoryTracing } from './start-in-memory-tracing';

test('it reads back each span that ended, in the order each ended', () => {
  const traced = startInMemoryTracing();
  const tracer = trace.getTracer('test');
  const outer = tracer.startSpan('test.outer');

  tracer.startSpan('test.inner').end();
  outer.end();

  const names = traced.readSpans().map((span) => span.name);

  expect(names).toStrictEqual(['test.inner', 'test.outer']);
});

test('it reads no span that has not ended', () => {
  const traced = startInMemoryTracing();

  trace.getTracer('test').startSpan('test.open');

  expect(traced.readSpans()).toStrictEqual([]);
});

test('it unregisters the provider when the test ends', () => {
  startInMemoryTracing();

  onTestFinished(() => {
    // the API takes a new global provider only once the last one is gone
    const isRegistered = trace.setGlobalTracerProvider(new BasicTracerProvider());

    trace.disable();

    expect(isRegistered).toBe(true);
  });

  const isTakenOver = trace.setGlobalTracerProvider(new BasicTracerProvider());

  expect(isTakenOver).toBe(false);
});
