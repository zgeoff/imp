import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubDevDocker } from './test-utils/build-stub-dev-docker';
import { createStubBin } from './test-utils/create-stub-bin';
import { runSourcedFunction } from './test-utils/run-sourced-function';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-dev-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
  };
}

test('it stops before it asks docker anything when there is no machine id', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', 'exit 1');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.dir, 'no-machine-id'),
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    `dev.sh: prune needs a machine id in ${join(ctx.dir, 'no-machine-id')}\n`,
  );

  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});

test('it removes the own tag of a gone checkout on this machine, then the leftovers', () => {
  const ctx = setupTest();

  const lib = new URL('lib.sh', import.meta.url).pathname;

  const gone = runSourcedFunction({
    script: lib,
    fn: 'dev_image_tag',
    args: [join(ctx.dir, 'gone')],
  });

  const tag = gone.stdout.trim();

  writeFileSync(join(ctx.dir, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevDocker([
      {
        tag,
        id: 'id-gone',
        labels: { worktree: join(ctx.dir, 'gone'), machine: 'fake-machine-id' },
      },
    ]),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.dir, 'machine-id'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(result.stdout.toString()).toBe(
    `dev.sh: removed ${tag} (${join(ctx.dir, 'gone')} is gone)\n`,
  );

  expect(
    readFileSync(docker.calls, 'utf8')
      .split('\n')
      .filter((call) => /^docker image (?:rm|prune) /u.test(call)),
  ).toStrictEqual([
    `docker image rm ${tag}`,
    'docker image prune -f --filter label=imp.worktree --filter label=imp.machine=fake-machine-id',
  ]);
});

test("it never removes a live checkout's image, another machine's, or an unmarked one", () => {
  const ctx = setupTest();

  const lib = new URL('lib.sh', import.meta.url).pathname;

  const live = runSourcedFunction({ script: lib, fn: 'dev_image_tag', args: [ctx.dir] });

  const other = runSourcedFunction({
    script: lib,
    fn: 'dev_image_tag',
    args: [join(ctx.dir, 'other')],
  });

  const bare = runSourcedFunction({
    script: lib,
    fn: 'dev_image_tag',
    args: [join(ctx.dir, 'unmarked')],
  });

  writeFileSync(join(ctx.dir, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevDocker([
      {
        tag: live.stdout.trim(),
        id: 'id-live',
        labels: { worktree: ctx.dir, machine: 'fake-machine-id' },
      },
      {
        tag: other.stdout.trim(),
        id: 'id-other',
        labels: { worktree: join(ctx.dir, 'other'), machine: 'another-machine' },
      },
      {
        tag: bare.stdout.trim(),
        id: 'id-unmarked',
        labels: { worktree: join(ctx.dir, 'unmarked'), machine: '' },
      },
      {
        tag: 'imp-host:dev-empty-4',
        id: 'id-empty',
        labels: { worktree: '', machine: 'fake-machine-id' },
      },
      { tag: '<none>:<none>', id: 'id-dangling', labels: null },
    ]),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.dir, 'machine-id'),
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe('');

  expect(
    readFileSync(docker.calls, 'utf8')
      .split('\n')
      .filter((call) => /^docker (?:image rm|ps) /u.test(call)),
  ).toStrictEqual([]);
});

test('it keeps a gone checkout image it cannot remove, and says why', () => {
  const ctx = setupTest();

  const lib = new URL('lib.sh', import.meta.url).pathname;

  const stuck = runSourcedFunction({
    script: lib,
    fn: 'dev_image_tag',
    args: [join(ctx.dir, 'stuck')],
  });

  const used = runSourcedFunction({
    script: lib,
    fn: 'dev_image_tag',
    args: [join(ctx.dir, 'used')],
  });

  writeFileSync(join(ctx.dir, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevDocker([
      {
        tag: stuck.stdout.trim(),
        id: 'id-stuck',
        labels: { worktree: join(ctx.dir, 'stuck'), machine: 'fake-machine-id' },
        isStuck: true,
      },
      {
        tag: 'imp-host:pinned',
        id: 'id-pinned',
        labels: { worktree: join(ctx.dir, 'stuck'), machine: 'fake-machine-id' },
      },
      {
        tag: used.stdout.trim(),
        id: 'id-used',
        labels: { worktree: join(ctx.dir, 'used'), machine: 'fake-machine-id' },
        container: 'c0ffee',
      },
      { tag: 'imp-host:dev-broken-5', id: 'id-broken', labels: null },
    ]),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.dir, 'machine-id'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(result.stdout.toString().split('\n')).toStrictEqual([
    `dev.sh: keeping ${stuck.stdout.trim()}: docker image rm failed`,
    `dev.sh: keeping imp-host:pinned: not the tag of ${join(ctx.dir, 'stuck')}`,
    `dev.sh: keeping ${used.stdout.trim()}: a container uses it`,
    'dev.sh: keeping imp-host:dev-broken-5: docker image inspect failed',
    '',
  ]);
});
