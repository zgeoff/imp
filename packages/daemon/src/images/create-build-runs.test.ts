import { expect, test } from 'bun:test';
import { createBuildRuns } from './create-build-runs';

test('it lists a build from its start with its phase, step and builder as they change', () => {
  const runs = createBuildRuns(() => Date.parse('2026-05-06T07:08:09.000Z'));
  const run = runs.start('web-app', 'upload');

  run.setPhase('build');
  run.setBuilder('imp-build-k3m9pqrs');
  run.setStep('[3/7] RUN make all');

  expect(runs.list()).toStrictEqual([
    {
      name: 'web-app',
      source: 'upload',
      startedAt: new Date('2026-05-06T07:08:09.000Z'),
      phase: 'build',
      step: '[3/7] RUN make all',
      builder: 'imp-build-k3m9pqrs',
    },
  ]);
});

test('it starts an upload in its upload phase and an on-host build in its pack phase', () => {
  const runs = createBuildRuns(() => 0);

  runs.start('web-app', 'upload');
  runs.start('web-api', 'host');

  expect(runs.list().map((run) => [run.name, run.phase])).toStrictEqual([
    ['web-app', 'upload'],
    ['web-api', 'pack'],
  ]);
});

test('it takes a build off the list when it ends, and leaves the others', () => {
  const runs = createBuildRuns(() => 0);
  const first = runs.start('web-app', 'upload');

  runs.start('web-app', 'host');
  first.end();

  expect(runs.list().map((run) => run.source)).toStrictEqual(['host']);
});
