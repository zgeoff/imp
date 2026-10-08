import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'run-hooks-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it puts an env override back before the next test of a run', async () => {
  const ctx = await setupTest();

  await writeFile(
    join(ctx.dir, 'env.test.ts'),
    [
      "import { expect, test } from 'bun:test';",
      `import { updateEnv } from '${join(import.meta.dir, 'update-env.ts')}';`,
      "test('it sets', () => { updateEnv('IMP_TEST_RUN_HOOKS', 'set'); });",
      "test('it sees the override gone', () => { expect(process.env['IMP_TEST_RUN_HOOKS']).toBeUndefined(); });",
    ].join('\n'),
  );

  const result = Bun.spawnSync(
    [
      process.execPath,
      'test',
      '--preload',
      join(import.meta.dir, 'preload-e2e.ts'),
      './env.test.ts',
    ],
    { cwd: ctx.dir },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toInclude(' 2 pass');
});
