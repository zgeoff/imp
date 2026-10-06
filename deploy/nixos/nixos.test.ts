import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The NixOS module's env writer, run with bash as the module runs it. `nix
// flake check` covers the rest (deploy/nixos/tests).
const deployDir = path.join(import.meta.dir, '..');
const writer = path.join(import.meta.dir, 'imp-host-env.sh');
const bootstrap = path.join(deployDir, 'bootstrap.sh');
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'imp-nixos-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTempFile(name: string, content: string): string {
  const file = path.join(dir, name);

  writeFileSync(file, content);

  return file;
}

interface WriterInput {
  readonly storage?: string;
  readonly memTotalKib?: number;
  readonly ramBudget?: string;
  readonly arcMax?: string;
  readonly liveArcMib?: number;
  readonly secrets?: string;
  readonly backupPassword?: string;

  // the fake ip's output, or null for an ip that fails
  readonly ipOutput?: string | null;
}

interface WriterResult {
  readonly exitCode: number;
  readonly output: string;
  readonly env: string;
  readonly arcParam: string;
}

const MIB = 1024 * 1024;

function runWriter(input: WriterInput = {}): WriterResult {
  const out = path.join(dir, 'imp-host.env');

  rmSync(out, { force: true });

  const arcParam = writeTempFile('zfs_arc_max', `${String((input.liveArcMib ?? 0) * MIB)}\n`);
  const bin = path.join(dir, 'bin');

  mkdirSync(bin, { recursive: true });

  const ipOutput = input.ipOutput === undefined ? '' : input.ipOutput;

  const fakeIp =
    ipOutput === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\ncat <<'EOF'\n${ipOutput}EOF\n`;

  writeFileSync(path.join(bin, 'ip'), fakeIp, { mode: 0o755 });

  const result = Bun.spawnSync(['bash', writer, bootstrap], {
    env: {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      IMP_SETTINGS: writeTempFile('settings', 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n'),
      IMP_STORAGE: input.storage ?? 'zfs',
      IMP_RAM_BUDGET: input.ramBudget ?? '',
      IMP_ARC_MAX: input.arcMax ?? '',
      IMP_SECRETS: input.secrets === undefined ? '' : writeTempFile('secrets', input.secrets),
      IMP_ENV_OUT: out,
      IMP_MEMINFO: writeTempFile(
        'meminfo',
        `MemTotal: ${String(input.memTotalKib ?? 64_000 * 1024)} kB\n`,
      ),
      IMP_ARC_PARAM: arcParam,
      IMP_BACKUP_STAGED:
        input.backupPassword === undefined
          ? ''
          : writeTempFile('backup-password', input.backupPassword),
      IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
    },
  });

  let env = '';

  try {
    env = readFileSync(out, 'utf8');
  } catch {
    env = '';
  }

  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
    env,
    arcParam: readFileSync(arcParam, 'utf8').trim(),
  };
}

function getEnvValues(env: string, key: string): string[] {
  return env
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

test('it sizes a zfs host as bootstrap.sh does, and sets the ARC cap it leaves out', () => {
  const result = runWriter();

  expect(result.exitCode).toBe(0);
  expect(getEnvValues(result.env, 'IMP_RAM_BUDGET_MIB')).toEqual(['48000']);
  expect(result.arcParam).toBe(String(6400 * MIB));
  expect(getEnvValues(result.env, 'IMP_HOST_FIREWALL')).toEqual(['none']);
  expect(statSync(path.join(dir, 'imp-host.env')).mode & 0o777).toBe(0o600);
});

test('a cap already set stays, and arcMaxMiB wins over both', () => {
  const kept = runWriter({ liveArcMib: 2048 });

  expect(kept.arcParam).toBe(String(2048 * MIB));
  expect(getEnvValues(kept.env, 'IMP_RAM_BUDGET_MIB')).toEqual(['52352']);
  expect(kept.output).toContain('keeping the ZFS ARC cap already set, 2048 MiB');

  const set = runWriter({ liveArcMib: 2048, arcMax: '4096' });

  expect(set.arcParam).toBe(String(4096 * MIB));
  expect(getEnvValues(set.env, 'IMP_RAM_BUDGET_MIB')).toEqual(['50304']);
});

test('xfs has no ARC, and a set budget wins over the formula', () => {
  const xfs = runWriter({ storage: 'xfs' });

  expect(getEnvValues(xfs.env, 'IMP_RAM_BUDGET_MIB')).toEqual(['54400']);
  expect(xfs.arcParam).toBe('0');

  expect(getEnvValues(runWriter({ ramBudget: '20000' }).env, 'IMP_RAM_BUDGET_MIB')).toEqual([
    '20000',
  ]);
});

test('a small host is refused unless ramBudgetMiB is set', () => {
  const small = { memTotalKib: 3 * 1024 * 1024, arcMax: '1024' };
  const refused = runWriter(small);

  expect(refused.exitCode).not.toBe(0);
  expect(refused.env).toBe('');
  expect(refused.output).toContain('below the 512 MiB floor: RAM 3072 MiB');
  expect(refused.output).toContain('Set services.imp.ramBudgetMiB');

  expect(
    getEnvValues(runWriter({ ...small, ramBudget: '1024' }).env, 'IMP_RAM_BUDGET_MIB'),
  ).toEqual(['1024']);
});

test('the secrets file is copied in, and a later line replaces an earlier one', () => {
  const env = runWriter({
    secrets:
      'IMP_DNS_API_TOKEN=fake-token\nIMP_TAILSCALE_HOSTNAME=imp-other\nIMP_RAM_BUDGET_MIB=1\n',
  }).env;

  expect(getEnvValues(env, 'IMP_DNS_API_TOKEN')).toEqual(['fake-token']);
  expect(getEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toEqual(['48000']);
  expect(env).not.toContain('TAILSCALE_AUTHKEY');
});

test('a backup password names its file; without one, backups stay off', () => {
  const secrets = 'IMP_BACKUP_REPOSITORY=s3:https://example.invalid/imp\n';
  const withPassword = runWriter({ secrets, backupPassword: 'fake-password\n' });

  expect(getEnvValues(withPassword.env, 'IMP_BACKUP_PASSWORD_FILE')).toEqual([
    '/run/imp/backup-password',
  ]);

  expect(getEnvValues(withPassword.env, 'IMP_BACKUP_REPOSITORY')).toEqual([
    's3:https://example.invalid/imp',
  ]);

  expect(withPassword.env).not.toContain('fake-password');

  const without = runWriter({ secrets, backupPassword: '' });

  expect(getEnvValues(without.env, 'IMP_BACKUP_REPOSITORY')).toEqual(['']);
  expect(getEnvValues(without.env, 'IMP_BACKUP_PASSWORD_FILE')).toEqual([]);
  expect(without.output).toContain('backups stay off');
});

test("the host's own global addresses go in last, and an ip that fails leaves them empty", () => {
  const result = runWriter({
    secrets: 'IMP_HOST_ADDRESSES=10.9.9.9\n',
    ipOutput:
      '2: eth0    inet 203.0.113.7/24 brd 203.0.113.255 scope global eth0\\       valid_lft forever\n' +
      '2: eth0    inet6 2001:db8::7/64 scope global \\       valid_lft forever\n',
  });

  expect(result.exitCode).toBe(0);
  expect(getEnvValues(result.env, 'IMP_HOST_ADDRESSES')).toEqual(['203.0.113.7/24,2001:db8::7/64']);

  const failed = runWriter({ ipOutput: null });

  expect(failed.exitCode).toBe(0);
  expect(getEnvValues(failed.env, 'IMP_HOST_ADDRESSES')).toEqual(['']);
  expect(failed.output).toContain("cannot read the host's addresses");
});

// The DNS token's staging, as the module runs it before each start, on a
// change to the file, and every 5 minutes.
const stageDnsToken = path.join(import.meta.dir, 'imp-host-dns-token.sh');

function runStage(source: string, stageDir: string) {
  const result = Bun.spawnSync(['bash', stageDnsToken, source, stageDir], {
    env: { PATH: process.env['PATH'] ?? '' },
  });

  return { exitCode: result.exitCode, output: result.stderr.toString() + result.stdout.toString() };
}

test('the DNS token is staged into its directory, 0400, by rename, and only when it changed', () => {
  const source = writeTempFile('dns-token', 'cf-first\n');
  const stageDir = path.join(dir, 'run', 'dns');
  const staged = path.join(stageDir, 'token');
  const first = runStage(source, stageDir);

  expect(first.exitCode).toBe(0);
  expect(readFileSync(staged, 'utf8')).toBe('cf-first\n');
  expect(statSync(staged).mode & 0o777).toBe(0o400);
  expect(statSync(stageDir).mode & 0o777).toBe(0o700);
  expect(first.output).not.toContain('cf-first');

  // unchanged: the same file, untouched
  const inode = statSync(staged).ino;

  expect(runStage(source, stageDir).output).toBe('');
  expect(statSync(staged).ino).toBe(inode);

  // a new token is a new file in the same directory, which the container
  // mounts
  const stageDirInode = statSync(stageDir).ino;

  writeFileSync(source, 'cf-second\n');

  expect(runStage(source, stageDir).exitCode).toBe(0);
  expect(readFileSync(staged, 'utf8')).toBe('cf-second\n');
  expect(statSync(staged).ino).not.toBe(inode);
  expect(statSync(stageDir).ino).toBe(stageDirInode);
  expect(readdirSync(stageDir)).toEqual(['token']);
});

test('a missing or empty source never replaces a staged token, and never fails the start', () => {
  const source = path.join(dir, 'dns-token');
  const stageDir = path.join(dir, 'dns');
  const staged = path.join(stageDir, 'token');
  const none = runStage(source, stageDir);

  expect(none.exitCode).toBe(0);
  expect(none.output).toContain('certificates and DNS records wait until it holds the token');
  expect(readdirSync(stageDir)).toEqual([]);

  writeFileSync(source, 'cf-good\n');
  runStage(source, stageDir);

  for (const content of ['', ' \n']) {
    writeFileSync(source, content);

    const empty = runStage(source, stageDir);

    expect(empty.exitCode).toBe(0);
    expect(empty.output).toContain('impd keeps the token staged before');
    expect(readFileSync(staged, 'utf8')).toBe('cf-good\n');
  }

  rmSync(source);

  expect(runStage(source, stageDir).exitCode).toBe(0);
  expect(readFileSync(staged, 'utf8')).toBe('cf-good\n');

  // a source that cannot be read, such as a directory in its place
  mkdirSync(source);

  expect(runStage(source, stageDir).exitCode).toBe(0);
  expect(readFileSync(staged, 'utf8')).toBe('cf-good\n');
  expect(readdirSync(stageDir)).toEqual(['token']);
});
