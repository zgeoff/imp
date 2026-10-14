import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// writeMetric reads E2E_METRICS_FILE through config, once, when it loads, so
// each test loads it in a child process with only the variables it gives

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-metric-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it appends each metric to the metrics file as one JSON line', () => {
  const ctx = setupTest();

  Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { writeMetric } from ${JSON.stringify(join(import.meta.dir, 'write-metric.ts'))}; writeMetric('https_issue_ms', 1234); writeMetric('cpuLimitedShare', { share: 0.5 });`,
    ],
    {
      cwd: ctx.dir,
      env: { PATH: process.env['PATH'] ?? '', E2E_METRICS_FILE: join(ctx.dir, 'metrics.jsonl') },
    },
  );

  expect(readFileSync(join(ctx.dir, 'metrics.jsonl'), 'utf8')).toBe(
    '{"https_issue_ms":1234}\n{"cpuLimitedShare":{"share":0.5}}\n',
  );
});

test('it prints each metric', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { writeMetric } from ${JSON.stringify(join(import.meta.dir, 'write-metric.ts'))}; writeMetric('https_issue_ms', 1234);`,
    ],
    { cwd: ctx.dir, env: { PATH: process.env['PATH'] ?? '' } },
  );

  expect(result.stdout.toString()).toBe('    https_issue_ms: 1234\n');
});

test('it writes no file without a metrics file', () => {
  const ctx = setupTest();

  Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { writeMetric } from ${JSON.stringify(join(import.meta.dir, 'write-metric.ts'))}; writeMetric('https_issue_ms', 1234);`,
    ],
    { cwd: ctx.dir, env: { PATH: process.env['PATH'] ?? '' } },
  );

  expect(readdirSync(ctx.dir)).toStrictEqual([]);
});
