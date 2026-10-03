import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEV = new URL('dev.sh', import.meta.url).pathname;

const dir = mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'imp-prune-'));
const calls = join(dir, 'calls');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Fakes docker with five labelled images: a gone checkout's, a live
// checkout's (this dir), a gone checkout's that a container uses, one with an
// empty label, and an untagged leftover. Only rm and prune land in calls.
function writeFakeDocker(): string {
  const docker = `#!/bin/bash
case "$*" in
  "image ls --filter label=imp.worktree --format "*)
    printf '%s\\n' 'imp-host:dev-gone-1 id-gone' 'imp-host:dev-live-2 id-live' \\
      'imp-host:dev-used-3 id-used' 'imp-host:dev-empty-4 id-empty' '<none>:<none> id-dangling' ;;
  "image inspect -f "*" id-gone") echo /nonexistent/gone ;;
  "image inspect -f "*" id-live") echo '${dir}' ;;
  "image inspect -f "*" id-used") echo /nonexistent/used ;;
  "image inspect -f "*" id-empty") echo ;;
  "image inspect -f "*) exit 1 ;;
  "ps -aq --filter ancestor=id-used") echo c0ffee ;;
  "ps -aq --filter ancestor="*) ;;
  "image rm "* | "image prune "*) echo "docker $*" >>'${calls}' ;;
  *) exit 1 ;;
esac
`;

  const binDir = join(dir, 'bin');

  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'docker'), docker);
  chmodSync(join(binDir, 'docker'), 0o755);

  return `${binDir}:${process.env['PATH'] ?? ''}`;
}

test('prune removes only the unused image of a gone checkout, then labelled leftovers', () => {
  const result = Bun.spawnSync([DEV, 'prune'], { env: { PATH: writeFakeDocker() } });

  expect(result.exitCode).toBe(0);

  expect(readFileSync(calls, 'utf8').split('\n')).toEqual([
    'docker image rm imp-host:dev-gone-1',
    'docker image prune -f --filter label=imp.worktree',
    '',
  ]);

  expect(result.stdout.toString()).toContain('keeping imp-host:dev-used-3: a container uses it');
});
