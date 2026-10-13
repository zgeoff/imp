import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShellcheck } from './run-shellcheck';

test.skipIf(Bun.which('shellcheck') === null)('it reports no findings for a clean script', () => {
  expect(runShellcheck('echo "$1"\n', 'sh')).toStrictEqual({ exitCode: 0, output: '' });
});

test.skipIf(Bun.which('shellcheck') === null)(
  'it reports a finding with its code and a failed exit',
  () => {
    const result = runShellcheck('echo $1\n', 'sh');

    expect(result.exitCode).toBe(1);
    expect(result.output).toInclude('SC2086');
  },
);

test.skipIf(Bun.which('shellcheck') === null)('it accepts a [[ test as bash', () => {
  expect(runShellcheck('if [[ -n "$1" ]]; then echo "$1"; fi\n', 'bash')).toStrictEqual({
    exitCode: 0,
    output: '',
  });
});

test.skipIf(Bun.which('shellcheck') === null)('it refuses a [[ test as POSIX sh', () => {
  expect(runShellcheck('if [[ -n "$1" ]]; then echo "$1"; fi\n', 'sh').output).toInclude('SC3010');
});

test.skipIf(Bun.which('shellcheck') === null)('it removes its temp file once the test ends', () => {
  const before = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith('imp-shellcheck-')),
  );

  runShellcheck('echo "$1"\n', 'sh');

  const dir = readdirSync(tmpdir()).find(
    (name) => name.startsWith('imp-shellcheck-') && !before.has(name),
  );

  onTestFinished(() => {
    const path = join(tmpdir(), dir ?? '');

    expect(dir).toBeString();
    expect(existsSync(path)).toBeFalse();
  });
});
