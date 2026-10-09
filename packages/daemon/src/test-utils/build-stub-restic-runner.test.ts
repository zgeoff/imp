import { expect, test } from 'bun:test';
import { buildStubResticRunner } from './build-stub-restic-runner';

test('it answers with the queued results in order, then with a clean exit', async () => {
  const runner = buildStubResticRunner([
    { exitCode: 10, stdout: '', stderr: 'repository does not exist' },
    { exitCode: 0, stdout: 'created', stderr: '' },
  ]);

  const first = await runner.run(['restic', 'cat', 'config'], {});
  const second = await runner.run(['restic', 'init'], {});
  const third = await runner.run(['restic', 'unlock'], {});

  expect(first).toStrictEqual({ exitCode: 10, stdout: '', stderr: 'repository does not exist' });
  expect(second).toStrictEqual({ exitCode: 0, stdout: 'created', stderr: '' });
  expect(third).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it records each argv joined by spaces and each env, in order', async () => {
  const runner = buildStubResticRunner();

  await runner.run(['restic', 'cat', 'config'], { RESTIC_REPOSITORY: '/srv/a' });
  await runner.run(['restic', 'init'], { RESTIC_REPOSITORY: '/srv/b' });

  expect(runner.argvs).toStrictEqual(['restic cat config', 'restic init']);

  expect(runner.envs).toStrictEqual([
    { RESTIC_REPOSITORY: '/srv/a' },
    { RESTIC_REPOSITORY: '/srv/b' },
  ]);
});
