import { expect, test } from 'bun:test';
import { buildExitError, runChecked, runCommand } from './run-command';

test('#runCommand captures the exit code, stdout and stderr of a command', async () => {
  const result = await runCommand(['bash', '-c', 'echo out; echo err >&2; exit 3']);

  expect(result).toStrictEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
});

test('#runChecked returns the stdout of a command that exits 0', async () => {
  const stdout = await runChecked(['bash', '-c', 'echo fine']);

  expect(stdout).toBe('fine\n');
});

test('#runChecked throws the exit error of a command that fails', () => {
  expect(runChecked(['bash', '-c', 'echo broke >&2; exit 2'])).rejects.toThrowWithMessage(
    Error,
    'bash -c echo broke >&2; exit 2 exited 2: broke',
  );
});

test('#runChecked runs the command through the runner it is passed', async () => {
  const stdout = await runChecked(['zfs', 'list'], {}, () =>
    Promise.resolve({ exitCode: 0, stdout: 'stub', stderr: '' }),
  );

  expect(stdout).toBe('stub');
});

test('#buildExitError names the command, its exit code and its stderr', () => {
  expect(
    buildExitError(['zfs', 'destroy', 'pool/a'], { exitCode: 1, stderr: ' busy \n', stdout: 'x' }),
  ).toStrictEqual(new Error('zfs destroy pool/a exited 1: busy'));
});

test('#buildExitError falls back to stdout when stderr is empty', () => {
  expect(buildExitError(['tar'], { exitCode: 2, stderr: '', stdout: 'why\n' })).toStrictEqual(
    new Error('tar exited 2: why'),
  );
});

test('#buildExitError takes a result with no stdout', () => {
  expect(buildExitError(['tar'], { exitCode: 2, stderr: '' })).toStrictEqual(
    new Error('tar exited 2: '),
  );
});
