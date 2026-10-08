import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '../../../scripts/test-utils/create-stub-bin';

// These tests drive load_tailscale_authkey in scripts/lib.sh and its caller
// scripts/dev.sh, which readTailscaleAuthKey reads the key through.

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-tskey-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it keeps a key from the env out of a bash -x trace', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      'bash',
      '-x',
      '-c',
      'source "$1"; load_tailscale_authkey; echo "found $?"',
      'bash',
      join(import.meta.dir, '..', '..', '..', 'scripts', 'lib.sh'),
    ],
    {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: ctx.dir,
        TAILSCALE_AUTHKEY: 'fake-tskey-for-the-trace-check',
      },
    },
  );

  expect(result.stdout.toString()).toBe('found 0\n');
  expect(result.stderr.toString()).not.toContain('fake-tskey-for-the-trace-check');
});

test('it exports a key from op and keeps it out of a bash -x trace', () => {
  const ctx = setupTest();
  const op = createStubBin(ctx.dir, 'op', "echo 'fake-tskey-for-the-trace-check'");

  // the comparison runs untraced: only the function's own trace is checked
  const result = Bun.spawnSync(
    [
      'bash',
      '-x',
      '-c',
      `source "$1"; unset TAILSCALE_AUTHKEY; load_tailscale_authkey
      { set +x; } 2>/dev/null; [ "$TAILSCALE_AUTHKEY" = 'fake-tskey-for-the-trace-check' ] && echo match`,
      'bash',
      join(import.meta.dir, '..', '..', '..', 'scripts', 'lib.sh'),
    ],
    {
      env: {
        PATH: `${op.bin}:${process.env['PATH'] ?? ''}`,
        HOME: ctx.dir,
        IMP_TAILSCALE_OP: '1',
      },
    },
  );

  expect(result.stdout.toString()).toBe('match\n');
  expect(result.stderr.toString()).not.toContain('fake-tskey-for-the-trace-check');
});

test('it asks op once in a run after an op miss', () => {
  const ctx = setupTest();
  const op = createStubBin(ctx.dir, 'op', 'exit 1');

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'source "$1"; unset TAILSCALE_AUTHKEY; load_tailscale_authkey; load_tailscale_authkey; echo "$IMP_TAILSCALE_OP_MISSED"',
      'bash',
      join(import.meta.dir, '..', '..', '..', 'scripts', 'lib.sh'),
    ],
    {
      env: {
        PATH: `${op.bin}:${process.env['PATH'] ?? ''}`,
        HOME: ctx.dir,
        IMP_TAILSCALE_OP: '1',
      },
    },
  );

  expect(result.stdout.toString()).toBe('1\n');

  expect(readFileSync(op.calls, 'utf8')).toBe(
    'op read op://cloud/imp-tailscale-authkey/credential\n',
  );
});

test('it never asks op without IMP_TAILSCALE_OP=1', () => {
  const ctx = setupTest();
  const op = createStubBin(ctx.dir, 'op', "echo 'fake-tskey-for-the-trace-check'");

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'source "$1"; unset TAILSCALE_AUTHKEY; load_tailscale_authkey; echo "found $?"',
      'bash',
      join(import.meta.dir, '..', '..', '..', 'scripts', 'lib.sh'),
    ],
    { env: { PATH: `${op.bin}:${process.env['PATH'] ?? ''}`, HOME: ctx.dir } },
  );

  // the run reaches its end: sourcing and the lookup left the shell alive
  expect(result.exitCode).toBe(0);
  expect(readFileSync(op.calls, 'utf8')).toBe('');
});

test('it passes the key to docker by name only in dev.sh up, and never traces it', () => {
  const ctx = setupTest();

  // the proxy's compile writes its binary into the data dir, and its run
  // passes; every other run and inspect fails, so up stops right at the
  // container start, after building its argv
  const docker = createStubBin(
    ctx.dir,
    'docker',
    [
      'case "$*" in *imp-docker-proxy.new) : > "$IMP_DEV_DATA/imp-docker-proxy.new"; exit 0 ;; esac',
      'case "$*" in *bin/imp-docker-proxy) exit 0 ;; esac',
      'case "$1" in run|inspect) exit 1 ;; esac',
      'exit 0',
    ].join('\n'),
  );

  const repo = join(import.meta.dir, '..', '..', '..');

  const result = Bun.spawnSync(['bash', '-x', join(repo, 'scripts', 'dev.sh'), 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      TAILSCALE_AUTHKEY: 'fake-tskey-for-the-trace-check',
      IMP_DEV_NAME: 'imp-dev-trace-check',
      IMP_DEV_DATA: join(ctx.dir, 'data'),
      IMP_HOST_IMAGE_READY: '1',
      IMP_KERNEL: join(repo, 'package.json'),
      IMP_SYSTEM_DRIVE: join(repo, 'package.json'),
    },
  });

  const trace = result.stderr.toString();

  expect(result.exitCode).not.toBe(0);
  expect(trace).toContain('-e TAILSCALE_AUTHKEY ');
  expect(trace).not.toContain('fake-tskey-for-the-trace-check');
});
