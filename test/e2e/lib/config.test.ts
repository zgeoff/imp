import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config reads the env once, when it loads, so each test loads it in a child
// process with only the variables the test gives

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-config-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it takes the acceptance sizes when no variable is set', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { config } from ${JSON.stringify(join(import.meta.dir, 'config.ts'))}; console.log(JSON.stringify(config));`,
    ],
    { cwd: ctx.dir, env: { PATH: process.env['PATH'] ?? '' } },
  );

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({
    ramBudgetMib: 6144,
    idleTimeoutS: 10,
    scaleCount: 30,
    scaleMemoryMib: 512,
    scaleFillMib: 256,
    chaosRounds: 8,
    chaosSeed: expect.any(Number) as unknown,
    maxNewMs: 3000,
    maxCheckpointMs: 500,
    keep: false,
    acceptance: false,
    metricsFile: null,
  });
});

test('it reads every knob from its variable', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { config } from ${JSON.stringify(join(import.meta.dir, 'config.ts'))}; console.log(JSON.stringify(config));`,
    ],
    {
      cwd: ctx.dir,
      env: {
        PATH: process.env['PATH'] ?? '',
        E2E_RAM_BUDGET_MIB: '4096',
        E2E_IDLE_TIMEOUT_S: '20',
        E2E_SCALE_COUNT: '5',
        E2E_SCALE_MEMORY_MIB: '256',
        E2E_SCALE_FILL_MIB: '128',
        E2E_CHAOS_ROUNDS: '2',
        E2E_CHAOS_SEED: '77',
        E2E_MAX_NEW_MS: '4000',
        E2E_MAX_CHECKPOINT_MS: '900',
        E2E_KEEP: '1',
        E2E_ACCEPTANCE: '1',
        E2E_METRICS_FILE: '/run/e2e/metrics.jsonl',
      },
    },
  );

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({
    ramBudgetMib: 4096,
    idleTimeoutS: 20,
    scaleCount: 5,
    scaleMemoryMib: 256,
    scaleFillMib: 128,
    chaosRounds: 2,
    chaosSeed: 77,
    maxNewMs: 4000,
    maxCheckpointMs: 900,
    keep: true,
    acceptance: true,
    metricsFile: '/run/e2e/metrics.jsonl',
  });
});

test('it takes the default for a variable set empty', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { config } from ${JSON.stringify(join(import.meta.dir, 'config.ts'))}; console.log(config.ramBudgetMib);`,
    ],
    { cwd: ctx.dir, env: { PATH: process.env['PATH'] ?? '', E2E_RAM_BUDGET_MIB: '' } },
  );

  expect(result.stdout.toString()).toBe('6144\n');
});

test.each(['abc', '0', '-5', '1.5'])('it refuses %p as a size', (raw) => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { config } from ${JSON.stringify(join(import.meta.dir, 'config.ts'))}; console.log(config.ramBudgetMib);`,
    ],
    { cwd: ctx.dir, env: { PATH: process.env['PATH'] ?? '', E2E_RAM_BUDGET_MIB: raw } },
  );

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toInclude(
    `E2E_RAM_BUDGET_MIB must be a positive integer, got '${raw}'`,
  );
});
