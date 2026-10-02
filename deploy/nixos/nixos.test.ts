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
  readonly secrets?: string;
}

function runWriter(input: WriterInput = {}): string {
  const out = path.join(dir, 'imp-host.env');

  const result = Bun.spawnSync(['bash', writer, bootstrap], {
    env: {
      PATH: process.env['PATH'] ?? '',
      IMP_SETTINGS: writeTempFile('settings', 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n'),
      IMP_STORAGE: input.storage ?? 'zfs',
      IMP_RAM_BUDGET: input.ramBudget ?? '',
      IMP_ARC_MAX: input.arcMax ?? '6400',
      IMP_SECRETS: input.secrets === undefined ? '' : writeTempFile('secrets', input.secrets),
      IMP_ENV_OUT: out,
      IMP_MEMINFO: writeTempFile('meminfo', `MemTotal: ${input.memTotalKib ?? 64_000 * 1024} kB\n`),
    },
  });

  if (result.exitCode !== 0) {
    throw new Error(`imp-host-env.sh exited ${result.exitCode}: ${result.stderr.toString()}`);
  }

  return readFileSync(out, 'utf8');
}

function getEnvValues(env: string, key: string): string[] {
  return env
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

test('it sizes a zfs host as bootstrap.sh does, leaving out the ARC cap', () => {
  const env = runWriter();

  expect(getEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toEqual(['48000']);
  expect(getEnvValues(env, 'IMP_HOST_FIREWALL')).toEqual(['none']);
  expect(statSync(path.join(dir, 'imp-host.env')).mode & 0o777).toBe(0o600);
});

test('xfs has no ARC, and a set budget wins over the formula', () => {
  expect(getEnvValues(runWriter({ storage: 'xfs' }), 'IMP_RAM_BUDGET_MIB')).toEqual(['54400']);
  expect(getEnvValues(runWriter({ ramBudget: '20000' }), 'IMP_RAM_BUDGET_MIB')).toEqual(['20000']);
});

test('the secrets file is copied in before the budget', () => {
  const env = runWriter({ secrets: 'IMP_DNS_API_TOKEN=fake-token\nIMP_RAM_BUDGET_MIB=1\n' });

  expect(getEnvValues(env, 'IMP_DNS_API_TOKEN')).toEqual(['fake-token']);

  // docker --env-file: the last line wins
  expect(getEnvValues(env, 'IMP_RAM_BUDGET_MIB').at(-1)).toBe('48000');
  expect(env).not.toContain('TAILSCALE_AUTHKEY');
});
