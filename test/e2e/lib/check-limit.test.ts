import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// checkLimit reads E2E_ACCEPTANCE through config, once, when it loads, so
// each test loads it in a child process with only the variables it gives

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-limit-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it passes a time within the limit in an acceptance run', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { checkLimit } from ${JSON.stringify(join(import.meta.dir, 'check-limit.ts'))}; checkLimit('imp new', 500, 500);`,
    ],
    { cwd: ctx.dir, env: { PATH: process.env['PATH'] ?? '', E2E_ACCEPTANCE: '1' } },
  );

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it fails a time over the limit in an acceptance run', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { checkLimit } from ${JSON.stringify(join(import.meta.dir, 'check-limit.ts'))}; checkLimit('imp new', 501, 500);`,
    ],
    { cwd: ctx.dir, env: { PATH: process.env['PATH'] ?? '', E2E_ACCEPTANCE: '1' } },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toInclude('imp new took 501 ms, over the 500 ms limit');
});

test('it warns of a time over the limit outside an acceptance run', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { checkLimit } from ${JSON.stringify(join(import.meta.dir, 'check-limit.ts'))}; checkLimit('imp new', 501, 500);`,
    ],
    { cwd: ctx.dir, env: { PATH: process.env['PATH'] ?? '' } },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '    warning: imp new took 501 ms, over the 500 ms limit\n',
  });
});
