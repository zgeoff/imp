import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  const result = Bun.spawnSync(['bash', writer, bootstrap], {
    env: {
      PATH: process.env['PATH'] ?? '',
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
