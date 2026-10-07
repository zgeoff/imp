import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSourcedFunction } from './run-sourced-function';

function setupTest() {
  using stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'imp-sourced-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const owned = stack.move();

  return {
    dir,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it calls the function with its arguments and returns what it printed', () => {
  using ctx = setupTest();

  const script = join(ctx.dir, 'lib.sh');

  writeFileSync(script, 'greet() { echo "hello $1 $2"; echo note >&2; }\n');

  expect(runSourcedFunction({ script, fn: 'greet', args: ['a b', 'c'] })).toStrictEqual({
    exitCode: 0,
    stdout: 'hello a b c\n',
    stderr: 'note\n',
  });
});

test('it returns the exit code of a function that fails, without throwing', () => {
  using ctx = setupTest();

  const script = join(ctx.dir, 'lib.sh');

  writeFileSync(script, 'refuse() { echo "no" >&2; return 4; }\n');

  expect(runSourcedFunction({ script, fn: 'refuse' })).toStrictEqual({
    exitCode: 4,
    stdout: '',
    stderr: 'no\n',
  });
});

test('it feeds stdin to the function', () => {
  using ctx = setupTest();

  const script = join(ctx.dir, 'lib.sh');

  writeFileSync(script, 'upper() { tr a-z A-Z; }\n');

  expect(runSourcedFunction({ script, fn: 'upper', stdin: 'abc\n' }).stdout).toBe('ABC\n');
});

test('it gives the function only PATH and the variables it is passed', () => {
  using ctx = setupTest();

  const script = join(ctx.dir, 'lib.sh');

  writeFileSync(script, `show() { echo "\${IMP_SET-unset} \${HOME-unset}"; }\n`);

  expect(runSourcedFunction({ script, fn: 'show', env: { IMP_SET: 'yes' } }).stdout).toBe(
    'yes unset\n',
  );
});

test('it runs nothing of the script that waits for a direct run', () => {
  using ctx = setupTest();

  const script = join(ctx.dir, 'lib.sh');

  writeFileSync(
    script,
    `ok() { echo ok; }\nif [[ "\${BASH_SOURCE[0]}" == "$0" ]]; then echo main; fi\n`,
  );

  expect(runSourcedFunction({ script, fn: 'ok' }).stdout).toBe('ok\n');
});
