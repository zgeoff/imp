import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChildTests } from '@imp/test-utils/run-child-tests';
import { startOtlpExport } from './start-otlp-export';

// An export that starts sets the global meter and tracer providers, which the
// run's preload holds, so each such case runs as its own child `bun test`
// with no preload. Its source imports these by absolute path.
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'otlp-export-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return {
    dir,
    exportPath: JSON.stringify(join(import.meta.dir, 'start-otlp-export.ts')),
    apiPath: JSON.stringify(Bun.resolveSync('@opentelemetry/api', import.meta.dir)),
    updateEnvPath: JSON.stringify(Bun.resolveSync('@imp/test-utils/update-env', import.meta.dir)),
  };
}

test('it starts nothing without an endpoint', async () => {
  const stop = await startOtlpExport({}, '0.0.0');

  expect(stop).toBeNull();
});

test('it starts nothing with an empty endpoint', async () => {
  const stop = await startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }, '0.0.0');

  expect(stop).toBeNull();
});

test('it sends metrics and spans to the collector at the endpoint', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    `import { expect, onTestFinished, test } from 'bun:test';
import { metrics, trace } from ${ctx.apiPath};
import { startOtlpExport } from ${ctx.exportPath};
import { updateEnv } from ${ctx.updateEnvPath};

test('it sends', async () => {
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
  updateEnv('OTEL_EXPORTER_OTLP_ENDPOINT', \`http://127.0.0.1:\${String(collector.port)}\`);

  const stop = await startOtlpExport(process.env, '0.3.0');
  onTestFinished(() => stop?.());

  metrics.getMeter('impd').createCounter('imp.test').add(1);
  trace.getTracer('impd').startSpan('imp.test').end();
  await stop?.();
  await collector.stop(true);

  const sorted = received.toSorted((a, b) => a.path.localeCompare(b.path));

  expect(sorted.map((each) => [each.path, each.contentType])).toStrictEqual([
    ['/v1/metrics', 'application/x-protobuf'],
    ['/v1/traces', 'application/x-protobuf'],
  ]);
  expect(sorted.map((each) => each.bodyBytes > 0)).toStrictEqual([true, true]);
});
`,
  );

  expect(run.output).toInclude(' 1 pass');
  expect(run.exitCode).toBe(0);
});

test('it names the service and its version in what it sends', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    `import { expect, onTestFinished, test } from 'bun:test';
import { trace } from ${ctx.apiPath};
import { startOtlpExport } from ${ctx.exportPath};
import { updateEnv } from ${ctx.updateEnvPath};

test('it names', async () => {
  const bodies: string[] = [];
  const collector = Bun.serve({
    port: 0,
    fetch: async (request) => {
      bodies.push(await request.text());

      return new Response(null, { status: 200 });
    },
  });
  onTestFinished(() => collector.stop(true));

  updateEnv('OTEL_EXPORTER_OTLP_ENDPOINT', \`http://127.0.0.1:\${String(collector.port)}\`);

  const stop = await startOtlpExport(
    { ...process.env, OTEL_SERVICE_NAME: 'impd-staging' },
    '0.3.0',
  );
  onTestFinished(() => stop?.());

  trace.getTracer('impd').startSpan('imp.test').end();
  await stop?.();
  await collector.stop(true);

  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.filter((body) => !body.includes('impd-staging') || !body.includes('0.3.0'))).toStrictEqual([]);
});
`,
  );

  expect(run.output).toInclude(' 1 pass');
  expect(run.exitCode).toBe(0);
});

test('it rejects its stop when the collector answers with an error', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    `import { expect, onTestFinished, test } from 'bun:test';
import { trace } from ${ctx.apiPath};
import { startOtlpExport } from ${ctx.exportPath};
import { updateEnv } from ${ctx.updateEnvPath};

test('it rejects', async () => {
  const paths: string[] = [];
  const collector = Bun.serve({
    port: 0,
    fetch: (request) => {
      paths.push(new URL(request.url).pathname);

      return new Response('collector down for maintenance', { status: 500 });
    },
  });
  onTestFinished(() => collector.stop(true));

  updateEnv('OTEL_EXPORTER_OTLP_ENDPOINT', \`http://127.0.0.1:\${String(collector.port)}\`);

  const stop = await startOtlpExport(process.env, '0.3.0');
  // a second shutdown hands back the span processor's first, rejected, result
  onTestFinished(() => Promise.allSettled([stop?.()]));

  trace.getTracer('impd').startSpan('imp.test').end();

  const stopping = stop === null ? Promise.resolve('no stop') : stop();

  expect(stopping).rejects.toThrow();
  await collector.stop(true);
  expect(paths).toContain('/v1/traces');
});
`,
  );

  expect(run.output).toInclude(' 1 pass');
  expect(run.exitCode).toBe(0);
});

test('it rejects its stop when nothing listens at the endpoint', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    `import { expect, onTestFinished, test } from 'bun:test';
import { trace } from ${ctx.apiPath};
import { startOtlpExport } from ${ctx.exportPath};
import { updateEnv } from ${ctx.updateEnvPath};

test('it rejects', async () => {
  const collector = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 200 }) });
  onTestFinished(() => collector.stop(true));
  const deadEndpoint = \`http://127.0.0.1:\${String(collector.port)}\`;

  await collector.stop(true);
  updateEnv('OTEL_EXPORTER_OTLP_ENDPOINT', deadEndpoint);

  // the exporters' own deadline for retrying a refused send; 10 s by default
  updateEnv('OTEL_EXPORTER_OTLP_TIMEOUT', '200');

  const stop = await startOtlpExport(process.env, '0.3.0');
  // a second shutdown hands back the span processor's first, rejected, result
  onTestFinished(() => Promise.allSettled([stop?.()]));

  trace.getTracer('impd').startSpan('imp.test').end();

  const stopping = stop === null ? Promise.resolve('no stop') : stop();

  expect(stopping).rejects.toThrow();
});
`,
  );

  expect(run.output).toInclude(' 1 pass');
  expect(run.exitCode).toBe(0);
});
