import { expect, test } from 'bun:test';
import { buildFirecrackerPgrepArgv, readFirecrackerPids } from './firecracker-pids';

test('#buildFirecrackerPgrepArgv matches the imp’s directory in Firecracker’s argv', () => {
  expect(buildFirecrackerPgrepArgv('imp_01')).toStrictEqual([
    'pgrep',
    '-f',
    'firecracker.*imps/imp_01/',
  ]);
});

test('#readFirecrackerPids reads each pid that pgrep printed', () => {
  expect(readFirecrackerPids('imp_01', '412\n415\n')).toStrictEqual(['412', '415']);
});

test('#readFirecrackerPids rejects output with no pid', () => {
  expect(() => readFirecrackerPids('imp_01', '')).toThrowWithMessage(
    Error,
    'no firecracker for imp imp_01',
  );
});
