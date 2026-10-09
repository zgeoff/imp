import { expect, test } from 'bun:test';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { spanExporter } from './register-tracing';

test('it keeps each span a tracer ended, in the order each ended', () => {
  const tracer = trace.getTracer('test');
  const outer = tracer.startSpan('test.outer');

  tracer.startSpan('test.inner').end();
  outer.end();

  const names = spanExporter.getFinishedSpans().map((span) => span.name);

  expect(names).toStrictEqual(['test.inner', 'test.outer']);
});

test('it keeps no span that has not ended', () => {
  trace.getTracer('test').startSpan('test.open');

  expect(spanExporter.getFinishedSpans()).toStrictEqual([]);
});

test('it holds the global tracer provider, so no test can take it over', () => {
  const isTakenOver = trace.setGlobalTracerProvider(new BasicTracerProvider());

  expect(isTakenOver).toBeFalse();
});
