import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'build-formula.sh');
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

function setupTest(targets: readonly string[] = TARGETS) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-formula-'));
  const sums = join(dir, 'SHA256SUMS');
  const lines = targets.map((target, index) => `${String(index).repeat(64)}  imp-${target}`);

  writeFileSync(sums, `${[...lines, `${'f'.repeat(64)}  vmlinux`].join('\n')}\n`);

  return {
    dir,
    sums,
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runScript(...args: readonly string[]) {
  const result = Bun.spawnSync(['bash', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    code: result.exitCode,
  };
}

test('it renders each platform with its own URL and checksum', () => {
  using ctx = setupTest();

  const result = runScript('1.2.3', ctx.sums);

  expect(result.code).toBe(0);

  for (const [index, target] of TARGETS.entries()) {
    expect(result.stdout).toContain(
      `url "https://github.com/zgeoff/imp/releases/download/v1.2.3/imp-${target}"\n      sha256 "${String(index).repeat(64)}"`,
    );
  }

  expect(result.stdout).toContain('version "1.2.3"');
  expect(result.stdout).toContain('generate_completions_from_executable(bin/"imp", "completion")');
});

test('the formula is valid Ruby', () => {
  using ctx = setupTest();

  const ruby = Bun.which('ruby');

  if (ruby === null) {
    return;
  }

  const formula = join(ctx.dir, 'imp.rb');

  writeFileSync(formula, runScript('1.2.3', ctx.sums).stdout);

  const check = Bun.spawnSync([ruby, '-c', formula], { stdout: 'pipe', stderr: 'pipe' });

  expect(check.stdout.toString()).toBe('Syntax OK\n');
});

test('a platform missing from SHA256SUMS or a bad version renders nothing', () => {
  using ctx = setupTest(['darwin-arm64', 'linux-x64']);

  expect(runScript('1.2.3', ctx.sums)).toEqual({
    stdout: '',
    stderr: `build-formula: no sha256 for imp-darwin-x64 in ${ctx.sums}\n`,
    code: 1,
  });

  expect(runScript('v1.2.3', ctx.sums)).toMatchObject({ stdout: '', code: 2 });
});
