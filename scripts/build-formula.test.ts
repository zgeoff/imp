import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-formula-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it renders each platform with its own URL and checksum', () => {
  const ctx = setupTest();
  const sums = join(ctx.dir, 'SHA256SUMS');

  writeFileSync(
    sums,
    [
      `${'0'.repeat(64)}  imp-darwin-arm64`,
      `${'1'.repeat(64)}  imp-darwin-x64`,
      `${'2'.repeat(64)}  imp-linux-arm64`,
      `${'3'.repeat(64)}  imp-linux-x64`,
      `${'f'.repeat(64)}  vmlinux`,
      '',
    ].join('\n'),
  );

  const result = Bun.spawnSync(['bash', join(import.meta.dir, 'build-formula.sh'), '1.2.3', sums]);

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": 
    "class Imp < Formula
      desc "CLI for impd: persistent Linux microVMs that sleep when idle"
      homepage "https://github.com/zgeoff/imp"
      version "1.2.3"
      license "MIT"

      on_macos do
        on_arm do
          url "https://github.com/zgeoff/imp/releases/download/v1.2.3/imp-darwin-arm64"
          sha256 "0000000000000000000000000000000000000000000000000000000000000000"
        end
        on_intel do
          url "https://github.com/zgeoff/imp/releases/download/v1.2.3/imp-darwin-x64"
          sha256 "1111111111111111111111111111111111111111111111111111111111111111"
        end
      end

      on_linux do
        on_arm do
          url "https://github.com/zgeoff/imp/releases/download/v1.2.3/imp-linux-arm64"
          sha256 "2222222222222222222222222222222222222222222222222222222222222222"
        end
        on_intel do
          url "https://github.com/zgeoff/imp/releases/download/v1.2.3/imp-linux-x64"
          sha256 "3333333333333333333333333333333333333333333333333333333333333333"
        end
      end

      def install
        # a bare download may arrive without +x, and the completions below run
        # the binary before Homebrew fixes modes
        binary = Dir["imp-*"].first
        chmod 0755, binary
        bin.install binary => "imp"
        generate_completions_from_executable(bin/"imp", "completion")
      end

      test do
        assert_equal version.to_s, shell_output("#{bin}/imp --version").strip
      end
    end
    "
    ,
    }
  `);
});

test('it renders the same formula from the same release twice', () => {
  const ctx = setupTest();
  const sums = join(ctx.dir, 'SHA256SUMS');

  writeFileSync(
    sums,
    [
      `${'0'.repeat(64)}  imp-darwin-arm64`,
      `${'1'.repeat(64)}  imp-darwin-x64`,
      `${'2'.repeat(64)}  imp-linux-arm64`,
      `${'3'.repeat(64)}  imp-linux-x64`,
      '',
    ].join('\n'),
  );

  const script = join(import.meta.dir, 'build-formula.sh');
  const first = Bun.spawnSync(['bash', script, '1.2.3', sums]).stdout.toString();
  const second = Bun.spawnSync(['bash', script, '1.2.3', sums]).stdout.toString();

  expect(first).toStrictEqual(second);
});

test.skipIf(Bun.which('ruby') === null)('it renders a formula that is valid Ruby', () => {
  const ctx = setupTest();
  const sums = join(ctx.dir, 'SHA256SUMS');
  const formula = join(ctx.dir, 'imp.rb');

  writeFileSync(
    sums,
    [
      `${'0'.repeat(64)}  imp-darwin-arm64`,
      `${'1'.repeat(64)}  imp-darwin-x64`,
      `${'2'.repeat(64)}  imp-linux-arm64`,
      `${'3'.repeat(64)}  imp-linux-x64`,
      '',
    ].join('\n'),
  );

  writeFileSync(
    formula,
    Bun.spawnSync(['bash', join(import.meta.dir, 'build-formula.sh'), '1.2.3', sums]).stdout,
  );

  const check = Bun.spawnSync(['ruby', '-c', formula]);

  expect(check.stdout.toString()).toBe('Syntax OK\n');
});

test('it renders nothing for a platform missing from SHA256SUMS', () => {
  const ctx = setupTest();
  const sums = join(ctx.dir, 'SHA256SUMS');

  writeFileSync(
    sums,
    [`${'0'.repeat(64)}  imp-darwin-arm64`, `${'3'.repeat(64)}  imp-linux-x64`, ''].join('\n'),
  );

  const result = Bun.spawnSync(['bash', join(import.meta.dir, 'build-formula.sh'), '1.2.3', sums]);

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: '',
    stderr: `build-formula: no sha256 for imp-darwin-x64 in ${sums}\n`,
    exitCode: 1,
  });
});

test('it renders nothing for a checksum that is not 64 hex digits', () => {
  const ctx = setupTest();
  const sums = join(ctx.dir, 'SHA256SUMS');

  writeFileSync(
    sums,
    [
      `${'0'.repeat(64)}  imp-darwin-arm64`,
      `${'1'.repeat(64)}  imp-darwin-x64`,
      `${'Z'.repeat(64)}  imp-linux-arm64`,
      `${'3'.repeat(64)}  imp-linux-x64`,
      '',
    ].join('\n'),
  );

  const result = Bun.spawnSync(['bash', join(import.meta.dir, 'build-formula.sh'), '1.2.3', sums]);

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: '',
    stderr: `build-formula: no sha256 for imp-linux-arm64 in ${sums}\n`,
    exitCode: 1,
  });
});

test('it refuses a version that is not X.Y.Z', () => {
  const ctx = setupTest();
  const sums = join(ctx.dir, 'SHA256SUMS');

  writeFileSync(
    sums,
    [
      `${'0'.repeat(64)}  imp-darwin-arm64`,
      `${'1'.repeat(64)}  imp-darwin-x64`,
      `${'2'.repeat(64)}  imp-linux-arm64`,
      `${'3'.repeat(64)}  imp-linux-x64`,
      '',
    ].join('\n'),
  );

  const result = Bun.spawnSync(['bash', join(import.meta.dir, 'build-formula.sh'), 'v1.2.3', sums]);

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({ stdout: '', stderr: 'build-formula: v1.2.3 is not X.Y.Z\n', exitCode: 2 });
});

test('it prints its usage when not given both arguments', () => {
  const script = join(import.meta.dir, 'build-formula.sh');
  const result = Bun.spawnSync(['bash', script, '1.2.3']);

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: '',
    stderr: `usage: ${script} <version> <SHA256SUMS>\n`,
    exitCode: 2,
  });
});
