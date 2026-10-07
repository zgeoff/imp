import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from './test-utils/create-stub-bin';
import { runSourcedFunction } from './test-utils/run-sourced-function';

function setupTest() {
  using stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'imp-dev-'));

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

test('#prune stops before it asks docker anything when there is no machine id', () => {
  using ctx = setupTest();

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

test('#prune removes the own tag of a gone checkout on this machine, then the leftovers', () => {
  using ctx = setupTest();

  const lib = new URL('lib.sh', import.meta.url).pathname;

  const gone = runSourcedFunction({
    script: lib,
    fn: 'dev_image_tag',
    args: ['/nonexistent/gone'],
  });

  const tag = gone.stdout.trim();

  writeFileSync(join(ctx.dir, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.dir,
    'docker',
    `case "$*" in
  "image ls --filter label=imp.worktree --format "*) echo '${tag} id-gone' ;;
  "image inspect -f "*" id-gone") printf '%s\\t%s\\n' /nonexistent/gone fake-machine-id ;;
  "ps -aq --filter ancestor=id-gone" | "image rm "* | "image prune "*) ;;
  *) exit 1 ;;
esac`,
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.dir, 'machine-id'),
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(`dev.sh: removed ${tag} (/nonexistent/gone is gone)\n`);

  expect(
    readFileSync(docker.calls, 'utf8')
      .split('\n')
      .filter((call) => /^docker image (?:rm|prune) /u.test(call)),
  ).toStrictEqual([
    `docker image rm ${tag}`,
    'docker image prune -f --filter label=imp.worktree --filter label=imp.machine=fake-machine-id',
  ]);
});

test("#prune never removes a live checkout's image, another machine's, or an unmarked one", () => {
  using ctx = setupTest();

  const lib = new URL('lib.sh', import.meta.url).pathname;

  const live = runSourcedFunction({ script: lib, fn: 'dev_image_tag', args: [ctx.dir] });
  const other = runSourcedFunction({ script: lib, fn: 'dev_image_tag', args: ['/nonexistent/o'] });
  const bare = runSourcedFunction({ script: lib, fn: 'dev_image_tag', args: ['/nonexistent/u'] });

  writeFileSync(join(ctx.dir, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.dir,
    'docker',
    `case "$*" in
  "image ls --filter label=imp.worktree --format "*)
    printf '%s\\n' '${live.stdout.trim()} id-live' '${other.stdout.trim()} id-other' \\
      '${bare.stdout.trim()} id-unmarked' 'imp-host:dev-empty-4 id-empty' '<none>:<none> id-dangling' ;;
  "image inspect -f "*" id-live") printf '%s\\t%s\\n' '${ctx.dir}' fake-machine-id ;;
  "image inspect -f "*" id-other") printf '%s\\t%s\\n' /nonexistent/o another-machine ;;
  "image inspect -f "*" id-unmarked") printf '%s\\t%s\\n' /nonexistent/u '' ;;
  "image inspect -f "*" id-empty") printf '%s\\t%s\\n' '' fake-machine-id ;;
  "ps -aq "* | "image rm "* | "image prune "*) ;;
  *) exit 1 ;;
esac`,
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

test('#prune keeps a gone checkout image it cannot remove, and says why', () => {
  using ctx = setupTest();

  const lib = new URL('lib.sh', import.meta.url).pathname;

  const stuck = runSourcedFunction({ script: lib, fn: 'dev_image_tag', args: ['/nonexistent/s'] });
  const used = runSourcedFunction({ script: lib, fn: 'dev_image_tag', args: ['/nonexistent/u'] });

  writeFileSync(join(ctx.dir, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.dir,
    'docker',
    `case "$*" in
  "image ls --filter label=imp.worktree --format "*)
    printf '%s\\n' '${stuck.stdout.trim()} id-stuck' 'imp-host:pinned id-pinned' \\
      '${used.stdout.trim()} id-used' 'imp-host:dev-broken-5 id-broken' ;;
  "image inspect -f "*" id-stuck") printf '%s\\t%s\\n' /nonexistent/s fake-machine-id ;;
  "image inspect -f "*" id-pinned") printf '%s\\t%s\\n' /nonexistent/s fake-machine-id ;;
  "image inspect -f "*" id-used") printf '%s\\t%s\\n' /nonexistent/u fake-machine-id ;;
  "image inspect -f "*) exit 1 ;;
  "ps -aq --filter ancestor=id-used") echo c0ffee ;;
  "ps -aq "* | "image prune "*) ;;
  "image rm "*) exit 1 ;;
  *) exit 1 ;;
esac`,
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
    'dev.sh: keeping imp-host:pinned: not the tag of /nonexistent/s',
    `dev.sh: keeping ${used.stdout.trim()}: a container uses it`,
    'dev.sh: keeping imp-host:dev-broken-5: docker image inspect failed',
    '',
  ]);
});
