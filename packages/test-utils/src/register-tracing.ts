import { afterEach } from 'bun:test';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// every span a test's code ended, until the reset after that test
export const spanExporter = new InMemorySpanExporter();

// The one tracer provider of the run, set before any test gets a tracer, as
// the tracer provider alone: no context manager or propagator is installed.
export function registerTracing(): void {
  const isRegistered = trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }),
  );

  if (!isRegistered) {
    throw new Error('a tracer provider was registered before the preload');
  }

  afterEach(() => {
    spanExporter.reset();
  });
}
