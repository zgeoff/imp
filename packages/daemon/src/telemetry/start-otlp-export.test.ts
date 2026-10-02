import { afterEach, expect, test } from 'bun:test';
import { metrics, trace } from '@opentelemetry/api';
import { startOtlpExport } from './start-otlp-export';

const ENDPOINT_VAR = 'OTEL_EXPORTER_OTLP_ENDPOINT';

afterEach(() => {
  metrics.disable();
  trace.disable();
  delete process.env[ENDPOINT_VAR];
});

test('with no endpoint it starts nothing', async () => {
  const stop = await startOtlpExport({}, '0.0.0');

  expect(stop).toBeNull();
});

test('with an endpoint it sends metrics and spans to the collector there', async () => {
  const received: string[] = [];

  using collector = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.arrayBuffer();

      received.push(
        `${new URL(request.url).pathname} ${String(request.headers.get('content-type'))} ${String(body.byteLength > 0)}`,
      );

      return new Response(null, { status: 200 });
    },
  });

  // the exporters read it from the process environment, not the argument
  process.env[ENDPOINT_VAR] = `http://127.0.0.1:${String(collector.port)}`;

  const stop = await startOtlpExport(process.env, '0.3.0');

  metrics.getMeter('impd').createCounter('imp.test').add(1);
  trace.getTracer('impd').startSpan('imp.test').end();

  await stop?.();

  expect(received.toSorted()).toEqual([
    '/v1/metrics application/x-protobuf true',
    '/v1/traces application/x-protobuf true',
  ]);
});
