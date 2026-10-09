import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { updateEnv } from '@imp/test-utils/update-env';
import { metrics, trace } from '@opentelemetry/api';
import { startOtlpExport } from './start-otlp-export';

test('it starts nothing without an endpoint', async () => {
  const stop = await startOtlpExport({}, '0.0.0');

  expect(stop).toBeNull();
});

test('it starts nothing with an empty endpoint', async () => {
  const stop = await startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }, '0.0.0');

  expect(stop).toBeNull();
});

test('it sends metrics and spans to the collector at the endpoint', async () => {
  const received: { path: string; contentType: string | null; bodyBytes: number }[] = [];

  const collector = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.arrayBuffer();

      received.push({
        path: new URL(request.url).pathname,
        contentType: request.headers.get('content-type'),
        bodyBytes: body.byteLength,
      });

      return new Response(null, { status: 200 });
    },
  });

  onTestFinished(() => collector.stop(true));

  // the exporters read it from the process environment, not the argument
  updateEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${String(collector.port)}`);

  const stop = await startOtlpExport(process.env, '0.3.0');

  onTestFinished(() => {
    metrics.disable();
    trace.disable();
  });

  metrics.getMeter('impd').createCounter('imp.test').add(1);
  trace.getTracer('impd').startSpan('imp.test').end();

  await stop?.();

  expect(received.toSorted((a, b) => a.path.localeCompare(b.path))).toStrictEqual([
    {
      path: '/v1/metrics',
      contentType: 'application/x-protobuf',
      bodyBytes: expect.toBePositive(),
    },
    { path: '/v1/traces', contentType: 'application/x-protobuf', bodyBytes: expect.toBePositive() },
  ]);
});

test('it names the service and its version in what it sends', async () => {
  const bodies: string[] = [];

  const collector = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.text();

      bodies.push(body);

      return new Response(null, { status: 200 });
    },
  });

  onTestFinished(() => collector.stop(true));
  updateEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${String(collector.port)}`);

  const stop = await startOtlpExport(
    { ...process.env, OTEL_SERVICE_NAME: 'impd-staging' },
    '0.3.0',
  );

  onTestFinished(() => {
    metrics.disable();
    trace.disable();
  });

  trace.getTracer('impd').startSpan('imp.test').end();

  await stop?.();

  expect(bodies).toSatisfyAll(
    (body: string) => body.includes('impd-staging') && body.includes('0.3.0'),
  );

  expect(bodies).not.toBeEmpty();
});

test('it rejects its stop when the collector answers with an error', async () => {
  const paths: string[] = [];

  const collector = Bun.serve({
    port: 0,
    fetch: (request) => {
      paths.push(new URL(request.url).pathname);

      return new Response('collector down for maintenance', { status: 500 });
    },
  });

  onTestFinished(() => collector.stop(true));
  updateEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${String(collector.port)}`);

  const stop = await startOtlpExport(process.env, '0.3.0');

  onTestFinished(() => {
    metrics.disable();
    trace.disable();
  });

  trace.getTracer('impd').startSpan('imp.test').end();

  invariant(stop);

  await expect(stop()).toReject();

  expect(paths).toContain('/v1/traces');
});

test('it rejects its stop when nothing listens at the endpoint', async () => {
  const collector = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 200 }) });
  const deadEndpoint = `http://127.0.0.1:${String(collector.port)}`;

  await collector.stop(true);

  updateEnv('OTEL_EXPORTER_OTLP_ENDPOINT', deadEndpoint);

  // the exporters' own deadline for retrying a refused send; 10 s by default
  updateEnv('OTEL_EXPORTER_OTLP_TIMEOUT', '200');

  const stop = await startOtlpExport(process.env, '0.3.0');

  onTestFinished(() => {
    metrics.disable();
    trace.disable();
  });

  trace.getTracer('impd').startSpan('imp.test').end();

  invariant(stop);

  await expect(stop()).toReject();
});
