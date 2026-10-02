import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The NixOS module's env writer, run with bash as the module runs it, and
// the module's docker run flags against deploy/imp-host.service. `nix flake
// check` covers the rest (deploy/nixos/tests).
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
  readonly authKey?: string;
  readonly joined?: boolean;
}

interface WriterResult {
  readonly env: string;
  readonly stdout: string;
  readonly arcParam: string;
}

function runWriter(input: WriterInput = {}): WriterResult {
  const out = path.join(dir, 'imp-host.env');
  const arcParam = writeTempFile('zfs_arc_max', '0\n');
  const joined = path.join(dir, 'joined');

  if (input.joined === true) {
    writeTempFile('joined', '');
  }

  const result = Bun.spawnSync(['bash', writer, bootstrap], {
    env: {
      PATH: process.env['PATH'] ?? '',
      IMP_SETTINGS: writeTempFile('settings', 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n'),
      IMP_STORAGE: input.storage ?? 'zfs',
      IMP_RAM_BUDGET: input.ramBudget ?? '',
      IMP_ARC_MAX: input.arcMax ?? '',
      IMP_SECRETS: input.secrets === undefined ? '' : writeTempFile('secrets', input.secrets),
      IMP_AUTHKEY_FILE: input.authKey === undefined ? '' : writeTempFile('authkey', input.authKey),
      IMP_JOINED: joined,
      IMP_ENV_OUT: out,
      IMP_MEMINFO: writeTempFile('meminfo', `MemTotal: ${input.memTotalKib ?? 64_000 * 1024} kB\n`),
      IMP_ARC_PARAM: arcParam,
    },
  });

  if (result.exitCode !== 0) {
    throw new Error(`imp-host-env.sh exited ${result.exitCode}: ${result.stderr.toString()}`);
  }

  return {
    env: readFileSync(out, 'utf8'),
    stdout: result.stdout.toString() + result.stderr.toString(),
    arcParam: readFileSync(arcParam, 'utf8').trim(),
  };
}

function getEnvValues(env: string, key: string): string[] {
  return env
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

test('it sizes a zfs host as bootstrap.sh does and sets the ARC cap', () => {
  const result = runWriter();

  expect(getEnvValues(result.env, 'IMP_RAM_BUDGET_MIB')).toEqual(['48000']);
  expect(result.arcParam).toBe(String(6400 * 1024 * 1024));
  expect(getEnvValues(result.env, 'IMP_HOST_FIREWALL')).toEqual(['none']);
  expect(statSync(path.join(dir, 'imp-host.env')).mode & 0o777).toBe(0o600);
});

test('xfs leaves the ARC alone, and set values win over the formula', () => {
  expect(getEnvValues(runWriter({ storage: 'xfs' }).env, 'IMP_RAM_BUDGET_MIB')).toEqual(['54400']);

  const set = runWriter({ ramBudget: '20000', arcMax: '2048' });

  expect(getEnvValues(set.env, 'IMP_RAM_BUDGET_MIB')).toEqual(['20000']);
  expect(set.arcParam).toBe(String(2048 * 1024 * 1024));
  expect(runWriter({ storage: 'xfs' }).arcParam).toBe('0');
});

test('the key goes in until the node has joined, and is never printed', () => {
  const key = 'fake-authkey-for-tests';
  const before = runWriter({ authKey: `${key}\n` });

  expect(getEnvValues(before.env, 'TAILSCALE_AUTHKEY')).toEqual([key]);
  expect(before.stdout).not.toContain(key);

  expect(getEnvValues(runWriter({ authKey: key, joined: true }).env, 'TAILSCALE_AUTHKEY')).toEqual([
    '',
  ]);
});

test('the secrets file is copied in before the budget and the key', () => {
  const env = runWriter({
    secrets: 'IMP_DNS_API_TOKEN=fake-token\nIMP_RAM_BUDGET_MIB=1\nTAILSCALE_AUTHKEY=fake-other\n',
  }).env;

  expect(getEnvValues(env, 'IMP_DNS_API_TOKEN')).toEqual(['fake-token']);

  // docker --env-file: the last line wins
  expect(getEnvValues(env, 'IMP_RAM_BUDGET_MIB').at(-1)).toBe('48000');
  expect(getEnvValues(env, 'TAILSCALE_AUTHKEY').at(-1)).toBe('');
});

// The docker run words of a unit's ExecStart, after the binary.
function getDockerRunWords(execStart: string): string[] {
  return execStart
    .replaceAll('\\\n', ' ')
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(1);
}

test('the module runs the container with the flags of deploy/imp-host.service', () => {
  const unit = readFileSync(path.join(deployDir, 'imp-host.service'), 'utf8');
  const execStart = /^ExecStart=(?<command>(?:.*\\\n)*.*)/m.exec(unit)?.groups?.['command'] ?? '';

  // the unit's image comes from its env file ($-word); the module names it
  const unitWords = getDockerRunWords(execStart).filter((word) => !word.startsWith('$'));
  const module = readFileSync(path.join(import.meta.dir, 'module.nix'), 'utf8');

  const block =
    /ExecStart = lib\.concatStringsSep " " \[(?<words>[\s\S]*?)\];/.exec(module)?.groups?.[
      'words'
    ] ?? '';

  const moduleWords = getDockerRunWords(
    [...block.matchAll(/^\s*"(?<line>.*)"$/gm)]
      .map((match) => match.groups?.['line'] ?? '')
      .join(' '),
  );

  expect(unitWords.length).toBeGreaterThan(10);
  expect(moduleWords).toEqual(unitWords);
});
