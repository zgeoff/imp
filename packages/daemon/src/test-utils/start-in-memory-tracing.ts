import { onTestFinished } from 'bun:test';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// The trace SDK as the global tracer provider alone (no context manager or
// propagator), keeping finished spans in memory; unregistered at the test's
// end, so a later test traces to the API's no-op tracer again.
export function startInMemoryTracing() {
  const exporter = new InMemorySpanExporter();

  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  trace.setGlobalTracerProvider(tracerProvider);

  onTestFinished(async () => {
    trace.disable();

    await tracerProvider.shutdown();
  });

  return {
    // every span that ended so far, in the order each ended
    readSpans: () => exporter.getFinishedSpans(),
  };
}
