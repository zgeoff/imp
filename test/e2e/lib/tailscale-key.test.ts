import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, runCommand } from './instance';
import { LIB_SCRIPT } from './tailscale-key';

const SECRET = 'fake-tskey-for-the-trace-check';
const dir = mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'imp-tskey-'));
const opCalls = join(dir, 'op-calls');

// a stand-in for one CLI: `op` succeeds or fails and counts its calls;
// `docker` succeeds except for `inspect` and a `run` other than the proxy's,
// so dev.sh up stops right at the container start
function writeFakeBin(binDir: string, opBehaviour: 'key' | 'fail'): string {
  const op =
    opBehaviour === 'key'
      ? `#!/bin/sh\necho call >> '${opCalls}'\necho '${SECRET}'\n`
      : `#!/bin/sh\necho call >> '${opCalls}'\nexit 1\n`;

  const docker =
    '#!/bin/sh\ncase "$*" in *docker-proxy/main.ts) exit 0 ;; esac\n' +
    'case "$1" in run|inspect) exit 1 ;; esac\nexit 0\n';

  for (const [name, script] of [
    ['op', op],
    ['docker', docker],
  ] as const) {
    writeFileSync(join(binDir, name), script);
    chmodSync(join(binDir, name), 0o755);
  }

  return `${binDir}:${process.env['PATH'] ?? ''}`;
}

function runTraced(script: string, env: Readonly<Record<string, string>>) {
  return runCommand(['bash', '-x', '-c', script, 'bash', LIB_SCRIPT], { env });
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('a key from the env never shows in a bash -x trace', async () => {
  const result = await runTraced('source "$1"; load_tailscale_authkey; echo "found $?"', {
    TAILSCALE_AUTHKEY: SECRET,
  });

  expect(result.stdout).toBe('found 0\n');
  expect(result.stderr).not.toContain(SECRET);
});

test('a key from op is exported and never shows in a bash -x trace', async () => {
  const binDir = mkdtempSync(join(dir, 'bin-'));

  // the comparison runs untraced: only the function's own trace is checked
  const result = await runTraced(
    `source "$1"; unset TAILSCALE_AUTHKEY; load_tailscale_authkey
    { set +x; } 2>/dev/null; [ "$TAILSCALE_AUTHKEY" = '${SECRET}' ] && echo match`,
    { PATH: writeFakeBin(binDir, 'key'), IMP_TAILSCALE_OP: '1' },
  );

  expect(result.stdout).toBe('match\n');
  expect(result.stderr).not.toContain(SECRET);
});

test('after an op miss, the rest of the run skips op', async () => {
  const binDir = mkdtempSync(join(dir, 'bin-'));

  rmSync(opCalls, { force: true });

  const result = await runCommand(
    [
      'bash',
      '-c',
      'source "$1"; unset TAILSCALE_AUTHKEY; load_tailscale_authkey; load_tailscale_authkey; echo "$IMP_TAILSCALE_OP_MISSED"',
      'bash',
      LIB_SCRIPT,
    ],
    { env: { PATH: writeFakeBin(binDir, 'fail'), IMP_TAILSCALE_OP: '1' } },
  );

  const calls = readFileSync(opCalls, 'utf8').trim().split('\n');

  expect(result.stdout).toBe('1\n');
  expect(calls).toHaveLength(1);
});

test('without IMP_TAILSCALE_OP=1, op is never called', async () => {
  const binDir = mkdtempSync(join(dir, 'bin-'));

  rmSync(opCalls, { force: true });

  const result = await runCommand(
    [
      'bash',
      '-c',
      'source "$1"; unset TAILSCALE_AUTHKEY; load_tailscale_authkey; echo "found $?"',
      'bash',
      LIB_SCRIPT,
    ],
    { env: { PATH: writeFakeBin(binDir, 'key') } },
  );

  // the repo's own .env may still supply a key; op must not be asked
  expect(result.exitCode).toBe(0);
  expect(existsSync(opCalls)).toBeFalse();
});

test('dev.sh up passes the key to docker by name only, and never traces it', async () => {
  const binDir = mkdtempSync(join(dir, 'bin-'));

  const result = await runCommand(['bash', '-x', join(REPO_ROOT, 'scripts', 'dev.sh'), 'up'], {
    env: {
      PATH: writeFakeBin(binDir, 'key'),
      TAILSCALE_AUTHKEY: SECRET,
      IMP_DEV_NAME: 'imp-dev-trace-check',
      IMP_DEV_DATA: join(dir, 'data'),
      IMP_HOST_IMAGE_READY: '1',
      IMP_KERNEL: join(REPO_ROOT, 'package.json'),
      IMP_SYSTEM_DRIVE: join(REPO_ROOT, 'package.json'),
    },
  });

  // the fake docker refuses `run`, so up fails right after building its argv
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('-e TAILSCALE_AUTHKEY ');
  expect(result.stderr).not.toContain(SECRET);
});
