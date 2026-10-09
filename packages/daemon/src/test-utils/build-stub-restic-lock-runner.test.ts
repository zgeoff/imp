import { expect, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { parseBackupSummary, parseSnapshots } from '../backup/restic';
import { buildStubResticLockRunner } from './build-stub-restic-lock-runner';

test('it refuses a command without --retry-lock that meets an exclusive lock', async () => {
  const runner = buildStubResticLockRunner();

  void runner.run(['restic', 'prune', '--quiet']);

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start prune']);
  });

  const refused = await runner.run(['restic', 'backup', '--json', '/tree']);

  expect(refused).toStrictEqual({
    exitCode: 11,
    stdout: '',
    stderr: 'unable to create lock in backend\n',
  });
});

test('it starts a waiting --retry-lock command once the lock holder ends', async () => {
  const runner = buildStubResticLockRunner();
  const backup = runner.run(['restic', '--retry-lock', '2m', 'backup', '--json', '/tree']);
  const prune = runner.run(['restic', '--retry-lock', '2m', 'prune', '--quiet']);

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start backup', 'wait prune']);
  });

  runner.stopCommand('backup');

  await waitFor(() => {
    expect(runner.events).toStrictEqual([
      'start backup',
      'wait prune',
      'end backup',
      'start prune',
    ]);
  });

  runner.stopCommand('prune');

  await Promise.all([backup, prune]);

  expect(runner.events).toStrictEqual([
    'start backup',
    'wait prune',
    'end backup',
    'start prune',
    'end prune',
  ]);
});

test('it runs shared commands together', async () => {
  const runner = buildStubResticLockRunner();

  void runner.run(['restic', 'backup', '--json', '/tree']);
  void runner.run(['restic', 'restore', '--quiet', 'a1:/tree']);

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start backup', 'start restore']);
  });
});

test('it runs a --no-lock command while another holds the lock alone', async () => {
  const runner = buildStubResticLockRunner();

  void runner.run(['restic', 'prune', '--quiet']);
  void runner.run(['restic', 'snapshots', '--no-lock', '--json']);

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start prune', 'start snapshots']);
  });
});

test('it answers snapshots and backup with output restic’s parsers read', async () => {
  const runner = buildStubResticLockRunner();
  const snapshots = runner.run(['restic', 'snapshots', '--no-lock', '--json']);
  const backup = runner.run(['restic', 'backup', '--json', '/tree']);

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start snapshots', 'start backup']);
  });

  runner.stopCommand('snapshots');
  runner.stopCommand('backup');

  const listed = await snapshots;
  const backedUp = await backup;

  expect(parseSnapshots(listed.stdout)).toStrictEqual([]);
  expect(parseBackupSummary(backedUp.stdout).snapshotId).toBe('a1');
});

test('it refuses to stop a command that does not run', () => {
  const runner = buildStubResticLockRunner();

  expect(() => {
    runner.stopCommand('prune');
  }).toThrow('the stub restic does not run prune');
});

test('it refuses a second run of a command that still runs', async () => {
  const runner = buildStubResticLockRunner();

  void runner.run(['restic', 'backup', '--json', '/tree']);

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start backup']);
  });

  expect(runner.run(['restic', 'backup', '--json', '/tree'])).rejects.toThrow(
    'the stub restic already runs backup',
  );
});
