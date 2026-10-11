import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { spanExporter } from './register-tracing';
import { runChildTests } from './run-child-tests';

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

test('it refuses to register over a tracer provider registered before it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'register-tracing-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  // a child run, since this run's preload holds the one global provider
  const run = runChildTests(
    dir,
    [
      "import { expect, test } from 'bun:test';",
      `import { trace } from ${JSON.stringify(Bun.resolveSync('@opentelemetry/api', import.meta.dir))};`,
      `import { BasicTracerProvider } from ${JSON.stringify(Bun.resolveSync('@opentelemetry/sdk-trace-base', import.meta.dir))};`,
      `import { registerTracing } from ${JSON.stringify(join(import.meta.dir, 'register-tracing.ts'))};`,
      "test('it throws', () => {",
      '  trace.setGlobalTracerProvider(new BasicTracerProvider());',
      "  expect(() => registerTracing()).toThrow(new Error('a tracer provider was registered before the preload'));",
      '});',
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 1 pass');
});

test('it holds the global tracer provider, so no test can take it over', () => {
  const isTakenOver = trace.setGlobalTracerProvider(new BasicTracerProvider());

  expect(isTakenOver).toBeFalse();
});
