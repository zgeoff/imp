import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEV = new URL('dev.sh', import.meta.url).pathname;
const LIB = new URL('lib.sh', import.meta.url).pathname;

const dir = mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'imp-prune-'));
const calls = join(dir, 'calls');

// what prune compares the labels to, as lib.sh reads them
const machine = readLib('read_machine_id').trim();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLib(call: string): string {
  const result = Bun.spawnSync(['bash', '-c', `source "$1" && ${call}`, 'bash', LIB]);

  expect(result.exitCode).toBe(0);

  return result.stdout.toString();
}

// the tag build_host_image gives the checkout at root
function readTag(root: string): string {
  return readLib(`dev_image_tag ${root}`).trim();
}

// the shell line the fake `image inspect` answers an id's labels with
function printLabels(root: string, from = machine): string {
  return `printf '%s\\t%s\\n' '${root}' '${from}'`;
}

// Fakes docker: `image ls` lists one row per tag, `image inspect` gives each
// id's labels, and the id names the case. Only rm and prune land in calls.
function writeFakeDocker(): string {
  const docker = `#!/bin/bash
case "$*" in
  "image ls --filter label=imp.worktree --format "*)
    printf '%s\\n' '${readTag('/nonexistent/stuck')} id-stuck' '${readTag('/nonexistent/gone')} id-gone' \\
      'imp-host:pinned id-gone' 'imp-host:dev-live-2 id-live' '${readTag('/nonexistent/used')} id-used' \\
      '${readTag('/nonexistent/other')} id-other' 'imp-host:dev-empty-4 id-empty' \\
      'imp-host:dev-broken-5 id-broken' '<none>:<none> id-dangling' ;;
  "image inspect -f "*" id-gone") ${printLabels('/nonexistent/gone')} ;;
  "image inspect -f "*" id-live") ${printLabels(dir)} ;;
  "image inspect -f "*" id-used") ${printLabels('/nonexistent/used')} ;;
  "image inspect -f "*" id-stuck") ${printLabels('/nonexistent/stuck')} ;;
  "image inspect -f "*" id-other") ${printLabels('/nonexistent/other', 'another-machine')} ;;
  "image inspect -f "*" id-empty") ${printLabels('')} ;;
  "image inspect -f "*) exit 1 ;;
  "ps -aq --filter ancestor=id-used") echo c0ffee ;;
  "ps -aq --filter ancestor="*) ;;
  "image rm ${readTag('/nonexistent/stuck')}") echo "docker $*" >>'${calls}'; exit 1 ;;
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

test('prune removes only the own tag of a gone checkout on this machine, then leftovers', () => {
  const result = Bun.spawnSync([DEV, 'prune'], { env: { PATH: writeFakeDocker() } });
  const stdout = result.stdout.toString();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(calls, 'utf8').split('\n')).toEqual([
    `docker image rm ${readTag('/nonexistent/stuck')}`,
    `docker image rm ${readTag('/nonexistent/gone')}`,
    `docker image prune -f --filter label=imp.worktree --filter label=imp.machine=${machine}`,
    '',
  ]);

  expect(stdout).toContain(`keeping ${readTag('/nonexistent/stuck')}: docker image rm failed`);
  expect(stdout).toContain('keeping imp-host:pinned: not the tag of /nonexistent/gone');
  expect(stdout).toContain(`keeping ${readTag('/nonexistent/used')}: a container uses it`);
  expect(stdout).toContain('keeping imp-host:dev-broken-5: docker image inspect failed');
  expect(stdout).not.toContain(readTag('/nonexistent/other'));
});
