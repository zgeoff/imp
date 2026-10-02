import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The pure functions of bootstrap.sh, called from bash. The script runs main
// only when executed, so sourcing it defines the functions and nothing else.
// scripts/test-bootstrap.sh runs the whole script in a systemd container.
const script = path.join(import.meta.dir, 'bootstrap.sh');

interface RunOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

function runFunction(fn: string, args: readonly string[] = [], options: RunOptions = {}): string {
  const result = Bun.spawnSync(
    ['bash', '-c', 'source "$1"; shift; "$@"', 'bootstrap-test', script, fn, ...args],
    {
      env: { PATH: process.env['PATH'] ?? '', ...options.env },
      stdin: Buffer.from(options.stdin ?? ''),
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(`${fn} exited ${result.exitCode}: ${result.stderr.toString()}`);
  }

  return result.stdout.toString();
}

function readDeployFile(name: string): string {
  return readFileSync(path.join(import.meta.dir, name), 'utf8');
}

test('it embeds deploy/imp-host.service and the env template unchanged', () => {
  expect(runFunction('unit_imp_host')).toBe(readDeployFile('imp-host.service'));
  expect(runFunction('env_template')).toBe(readDeployFile('imp-host.env.example'));
});

test('it keeps the larger of 8 GiB and 15 % of RAM for the host', () => {
  // a 64 GB box reports about 62.5 GiB
  expect(runFunction('ram_budget_mib', [String(64_000 * 1024)]).trim()).toBe('54400');
  expect(runFunction('ram_budget_mib', [String(32 * 1024 * 1024)]).trim()).toBe('24576');
  expect(runFunction('ram_budget_mib', [String(128 * 1024 * 1024)]).trim()).toBe('111412');
});

test('with zfs it caps the ARC at 10 % within 1 to 8 GiB and keeps that out of the budget', () => {
  const kib64 = String(64_000 * 1024);

  expect(runFunction('zfs_arc_max_mib', [kib64]).trim()).toBe('6400');
  expect(runFunction('zfs_arc_max_mib', [String(8 * 1024 * 1024)]).trim()).toBe('1024');
  expect(runFunction('zfs_arc_max_mib', [String(256 * 1024 * 1024)]).trim()).toBe('8192');
  expect(runFunction('ram_budget_mib', [kib64, '6400']).trim()).toBe('48000');
});

test('a computed budget below 512 MiB is refused, naming the RAM and the setting', () => {
  const kib3 = String(3 * 1024 * 1024);

  expect(() =>
    runFunction('check_ram_budget', ['-6144', kib3, '1024', 'IMP_RAM_BUDGET_MIB']),
  ).toThrow(
    /comes out at -6144 MiB, below the 512 MiB floor: RAM 3072 MiB.*ARC cap 1024 MiB.*Set IMP_RAM_BUDGET_MIB/u,
  );

  expect(runFunction('check_ram_budget', ['512', kib3, '0', 'IMP_RAM_BUDGET_MIB'])).toBe('');
});

function getMkfsOptions(kernel: string, progs: string): string {
  return runFunction('mkfs_xfs_opts', [kernel, progs]).trim();
}

test('it turns off only the XFS features the kernel cannot mount and mkfs.xfs knows', () => {
  // Debian 13 and Ubuntu 24.04 on their own kernels
  expect(getMkfsOptions('6.12.48+deb13-amd64', '6.13.0')).toBe('-m reflink=1');
  expect(getMkfsOptions('6.8.0-85-generic', '6.6.0')).toBe('-m reflink=1');

  // the WSL dev box running Debian's xfsprogs (the test container)
  expect(getMkfsOptions('6.6.87.2-microsoft-standard-WSL2', '6.13.0')).toBe(
    '-m reflink=1 -i exchange=0 -n parent=0',
  );

  // Ubuntu's xfsprogs 6.6 rejects exchange= and parent=
  expect(getMkfsOptions('6.6.87.2-microsoft-standard-WSL2', '6.6.0')).toBe('-m reflink=1');

  expect(getMkfsOptions('5.15.0-100-generic', '6.13.0')).toBe(
    '-m reflink=1 -i nrext64=0,exchange=0 -n parent=0',
  );
});

test('it sizes a loop file to leave the larger of 30 GiB and 15 % of / free', () => {
  // a 240 GB disk with the OS installed has about 220 GiB free
  expect(runFunction('loop_size_auto_gib', ['220']).trim()).toBe('187');
  expect(runFunction('loop_size_auto_gib', ['100']).trim()).toBe('70');
  expect(runFunction('loop_size_auto_gib', ['40']).trim()).toBe('10');
});

test('it writes the fstab entry by kind', () => {
  expect(runFunction('fstab_line', ['UUID=1234', 'device'])).toBe(
    'UUID=1234 /var/lib/imp xfs defaults,nofail 0 2\n',
  );

  expect(runFunction('fstab_line', ['/srv/imp.xfs', 'loop'])).toBe(
    '/srv/imp.xfs /var/lib/imp xfs loop,nofail 0 0\n',
  );
});

test('it reads SSH ports from sshd -T, socket units and ss', () => {
  const sshdT = 'port 22\nport 2222\naddressfamily any\nlistenaddress [::]:22\n';

  expect(runFunction('ssh_ports_from_sshd_t', [], { stdin: sshdT })).toBe('22\n2222\n');

  const listen = '[::]:22 (Stream)\n0.0.0.0:2200\n';

  expect(runFunction('ssh_ports_from_listen', [], { stdin: listen })).toBe('22\n2200\n');
});

test('it renders a firewall that opens only SSH, DHCP and ICMP', () => {
  const rules = runFunction('render_firewall', ['2222', '22', '22']);

  expect(rules).toContain('tcp dport { 22, 2222 } accept');
  expect(rules).toContain('policy drop;');
  expect(rules).toContain('meta l4proto ipv6-icmp accept');

  // a reload replaces our table in one transaction and leaves Docker's alone
  expect(rules).toContain('table inet imp_host\ndelete table inet imp_host\ntable inet imp_host {');
  expect(rules).not.toContain('flush ruleset');
});

// nft -c parses the ruleset against the kernel, which needs CAP_NET_ADMIN; an
// unprivileged user namespace gives it where the host allows one.
const nftCheck = Bun.spawnSync(['unshare', '-rn', 'nft', '-c', 'list ruleset']).exitCode === 0;

test.skipIf(!nftCheck)('nft accepts the rendered firewall', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'imp-fw-'));

  try {
    const file = path.join(dir, 'firewall.nft');

    writeFileSync(file, runFunction('render_firewall', ['22']));

    const result = Bun.spawnSync(['unshare', '-rn', 'nft', '-c', '-f', file]);

    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const template = runFunction('env_template');

// the script passes file contents through $(...), which drops trailing newlines
function normalizeTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, '');
}

interface EnvInput {
  readonly existing: string;
  readonly image?: string;
  readonly imageSet?: boolean;
  readonly key?: string;
  readonly storage?: string;
  readonly zfsRoot?: string;
  readonly hostFirewall?: string;
}

function renderEnv(input: EnvInput): string {
  const args = [
    normalizeTrailingNewlines(input.existing),
    normalizeTrailingNewlines(template),
    '54400',
    input.image ?? 'ghcr.io/zgeoff/imp-host:latest',
    input.imageSet === true ? '1' : '',
    input.storage ?? 'xfs',
    input.zfsRoot ?? '',
    input.hostFirewall ?? 'own',
  ];

  return runFunction('render_env', args, { env: { BOOTSTRAP_AUTHKEY: input.key ?? '' } });
}

function getEnvValues(env: string, key: string): string[] {
  return env
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

test('a new env file is the template with the budget, the image and the key', () => {
  const env = renderEnv({ existing: '', image: 'imp-host:1.2.3', key: 'fake-key-for-tests' });

  expect(getEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toEqual(['54400']);
  expect(getEnvValues(env, 'IMP_HOST_IMAGE')).toEqual(['imp-host:1.2.3']);
  expect(getEnvValues(env, 'TAILSCALE_AUTHKEY')).toEqual(['fake-key-for-tests']);
  expect(getEnvValues(env, 'IMP_STORAGE_BACKEND')).toEqual(['xfs']);
  expect(getEnvValues(env, 'IMP_ZFS_ROOT')).toEqual(['']);
  expect(getEnvValues(env, 'IMP_HOST_FIREWALL')).toEqual(['own']);
  expect(getEnvValues(env, 'IMP_IDLE_TIMEOUT_S')).toEqual(['60']);
});

test('an existing env file keeps the operator values', () => {
  const existing = template
    .replace('IMP_RAM_BUDGET_MIB=16384', 'IMP_RAM_BUDGET_MIB=30000')
    .replace('IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest', 'IMP_HOST_IMAGE=imp-host:pinned')
    .replace('TAILSCALE_AUTHKEY=', 'TAILSCALE_AUTHKEY=fake-old-key')
    .replace('IMP_IDLE_TIMEOUT_S=60', 'IMP_IDLE_TIMEOUT_S=300');

  expect(renderEnv({ existing })).toBe(existing);
});

test('the template budget is replaced; --image and a new key win', () => {
  const env = renderEnv({
    existing: template,
    image: 'imp-host:2.0.0',
    imageSet: true,
    key: 'fake-new-key',
  });

  expect(getEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toEqual(['54400']);
  expect(getEnvValues(env, 'IMP_HOST_IMAGE')).toEqual(['imp-host:2.0.0']);
  expect(getEnvValues(env, 'TAILSCALE_AUTHKEY')).toEqual(['fake-new-key']);
});

test('zfs sets the backend and the dataset', () => {
  const env = renderEnv({ existing: template, storage: 'zfs', zfsRoot: 'tank/imp' });

  expect(getEnvValues(env, 'IMP_STORAGE_BACKEND')).toEqual(['zfs']);
  expect(getEnvValues(env, 'IMP_ZFS_ROOT')).toEqual(['tank/imp']);
  expect(renderEnv({ existing: env, storage: 'zfs', zfsRoot: 'tank/imp' })).toBe(env);
});

test('none replaces own, and stays on the next render', () => {
  const env = renderEnv({ existing: template, hostFirewall: 'none' });

  expect(getEnvValues(env, 'IMP_HOST_FIREWALL')).toEqual(['none']);
  expect(renderEnv({ existing: env, hostFirewall: 'none' })).toBe(env);
});

test('missing keys are appended once, and rendering twice changes nothing', () => {
  const once = renderEnv({
    existing: 'IMP_IDLE_TIMEOUT_S=30',
    image: 'imp-host:1',
    imageSet: true,
  });

  expect(once).toBe(
    'IMP_IDLE_TIMEOUT_S=30\nIMP_HOST_IMAGE=imp-host:1\nIMP_RAM_BUDGET_MIB=54400\nIMP_STORAGE_BACKEND=xfs\nIMP_HOST_FIREWALL=own\n',
  );

  expect(renderEnv({ existing: once, image: 'imp-host:1', imageSet: true })).toBe(once);
});

test('blanking the key leaves every other line alone', () => {
  const env =
    'IMP_HOST_IMAGE=imp-host:1\nTAILSCALE_AUTHKEY=fake-key-for-tests\nIMP_TAILSCALE_HOSTNAME=imp\n';

  expect(runFunction('blank_env_key', [], { stdin: env })).toBe(
    'IMP_HOST_IMAGE=imp-host:1\nTAILSCALE_AUTHKEY=\nIMP_TAILSCALE_HOSTNAME=imp\n',
  );
});
