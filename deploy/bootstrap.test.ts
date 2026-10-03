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

test('it embeds both units and the env template unchanged', () => {
  expect(runFunction('unit_imp_host')).toBe(readDeployFile('imp-host.service'));
  expect(runFunction('unit_imp_docker_proxy')).toBe(readDeployFile('imp-docker-proxy.service'));
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
    'UUID=1234 /var/lib/imp xfs defaults,nosuid,nofail 0 2\n',
  );

  expect(runFunction('fstab_line', ['/srv/imp.xfs', 'loop'])).toBe(
    '/srv/imp.xfs /var/lib/imp xfs loop,nosuid,nofail 0 0\n',
  );
});

test('it accepts the fstab entry an older bootstrap wrote without nosuid, and no other', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bootstrap-fstab-'));
  const fstab = path.join(dir, 'fstab');
  const device = runFunction('fstab_line', ['UUID=1234', 'device']).trim();
  const loop = runFunction('fstab_line', ['/srv/imp.xfs', 'loop']).trim();

  const readState = (lines: string, line: string) => {
    writeFileSync(fstab, `UUID=abcd / ext4 defaults 0 1\n${lines}`);

    return runFunction('fstab_entry_state', [fstab, line]).trim();
  };

  try {
    expect(readState('', device)).toBe('none');
    expect(readState(`${device}\n`, device)).toBe('same');
    expect(readState('UUID=1234 /var/lib/imp xfs defaults,nofail 0 2\n', device)).toBe('old');
    expect(readState('/srv/imp.xfs /var/lib/imp xfs loop,nofail 0 0\n', loop)).toBe('old');
    expect(readState('UUID=9999 /var/lib/imp xfs defaults,nofail 0 2\n', device)).toBe('other');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  readonly ipv6?: string;
  readonly subnet6?: string;
  readonly ksm?: 'on' | 'off';
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
    input.ipv6 ?? 'off',
    input.subnet6 ?? '',
    input.ksm ?? '',
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
    .replace('IMP_IDLE_TIMEOUT_S=60', 'IMP_IDLE_TIMEOUT_S=300')
    .replace('IMP_HOST_IPV6=', 'IMP_HOST_IPV6=off');

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

test('--ksm sets IMP_KSM=1, --no-ksm 0; without either the operator’s IMP_KSM stays', () => {
  const env = renderEnv({ existing: template, ksm: 'on' });

  expect(getEnvValues(env, 'IMP_KSM')).toEqual(['1']);
  expect(renderEnv({ existing: env, ksm: 'on' })).toBe(env);
  expect(getEnvValues(renderEnv({ existing: env, ksm: 'off' }), 'IMP_KSM')).toEqual(['0']);
  expect(renderEnv({ existing: env })).toBe(env);
  expect(getEnvValues(renderEnv({ existing: template }), 'IMP_KSM')).toEqual(['']);
});

test('--no-ksm unmerges while ksmd runs or pages it merged are still shared', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'imp-ksm-'));

  const checkMerges = (run: string, shared: string): boolean => {
    writeFileSync(path.join(dir, 'run'), `${run}\n`);
    writeFileSync(path.join(dir, 'pages_shared'), `${shared}\n`);

    try {
      runFunction('ksm_merges', [], { env: { KSM_DIR: dir } });

      return true;
    } catch {
      return false;
    }
  };

  try {
    expect(checkMerges('1', '0')).toBe(true);
    expect(checkMerges('0', '12')).toBe(true);
    expect(checkMerges('0', '0')).toBe(false);
    expect(checkMerges('2', '0')).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--ksm needs Linux 6.10 and starts ksmd with zero-page merging at boot', () => {
  const checkSupport = (release: string): boolean => {
    try {
      runFunction('kernel_supports_ksm', [release]);

      return true;
    } catch {
      return false;
    }
  };

  expect(
    ['6.10.0-1-amd64', '6.17.0-1022-azure', '7.0.0'].map((release) => checkSupport(release)),
  ).toEqual([true, true, true]);

  expect(
    ['6.9.12', '6.6.87.2-microsoft-standard-WSL2', '5.15.0'].map((release) =>
      checkSupport(release),
    ),
  ).toEqual([false, false, false]);

  expect(runFunction('ksm_tmpfiles')).toBe(
    [
      '# Written by deploy/bootstrap.sh --ksm.',
      'w /sys/kernel/mm/ksm/use_zero_pages - - - - 1',
      'w /sys/kernel/mm/ksm/run - - - - 1',
      '',
    ].join('\n'),
  );
});

test('missing keys are appended once, and rendering twice changes nothing', () => {
  const once = renderEnv({
    existing: 'IMP_IDLE_TIMEOUT_S=30',
    image: 'imp-host:1',
    imageSet: true,
  });

  expect(once).toBe(
    'IMP_IDLE_TIMEOUT_S=30\nIMP_HOST_IMAGE=imp-host:1\nIMP_RAM_BUDGET_MIB=54400\nIMP_STORAGE_BACKEND=xfs\nIMP_HOST_FIREWALL=own\nIMP_HOST_IPV6=off\nIMP_HOST_NETWORK=\n',
  );

  expect(renderEnv({ existing: once, image: 'imp-host:1', imageSet: true })).toBe(once);
});

test('ipv6 on names the network and keeps the subnet; off keeps the subnet for later', () => {
  const on = renderEnv({ existing: template, ipv6: 'on', subnet6: 'fd12:3456:789a::/64' });

  expect(getEnvValues(on, 'IMP_HOST_IPV6')).toEqual(['on']);
  expect(getEnvValues(on, 'IMP_HOST_NETWORK')).toEqual(['--network imp-host']);
  expect(getEnvValues(on, 'IMP_HOST_SUBNET6')).toEqual(['fd12:3456:789a::/64']);
  expect(renderEnv({ existing: on, ipv6: 'on', subnet6: 'fd12:3456:789a::/64' })).toBe(on);

  const off = renderEnv({ existing: on, ipv6: 'off' });

  expect(getEnvValues(off, 'IMP_HOST_IPV6')).toEqual(['off']);
  expect(getEnvValues(off, 'IMP_HOST_NETWORK')).toEqual(['']);
  expect(getEnvValues(off, 'IMP_HOST_SUBNET6')).toEqual(['fd12:3456:789a::/64']);
});

test('it writes IPv6 addresses as Docker prints them', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['fd12:0034:0:0::/64', 'fd12:34::/64'],
    ['FD12:3456:789A:0001::', 'fd12:3456:789a:1::'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['fd12:0:0:1::/64', 'fd12:0:0:1::/64'],
    ['::1', '::1'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
  ];

  for (const [input, want] of cases) {
    expect(runFunction('ipv6_canon', [input])).toBe(`${want}\n`);
  }
});

test('IMP_HOST_SUBNET6 must be a /64 with no host bits', () => {
  expect(runFunction('subnet6', ['FD12:3456:789a:0::/64'])).toBe('fd12:3456:789a::/64\n');

  for (const bad of ['fd12::/56', 'fd12::1/64', 'fd12:::/64', 'nope/64', '10.0.0.0/64']) {
    expect(() => runFunction('subnet6', [bad])).toThrow('subnet6 exited 1');
  }
});

test('a random subnet is a unique local /64', () => {
  const subnet = runFunction('random_ula64').trim();

  expect(subnet).toMatch(/^fd[0-9a-f]{2}:[0-9a-f:]+\/64$/);
  expect(runFunction('subnet6', [subnet]).trim()).toBe(subnet);
});

test('a network differs on IPv6, the bridge name or the subnet', () => {
  const want = 'fd12:3456:789a::/64';

  const readDrift = (inspect: string): string =>
    runFunction('network_drift', [want, inspect]).trim();

  expect(readDrift('true br-imphost 172.18.0.0/16 fd12:3456:789a::/64')).toBe('');
  expect(readDrift('false br-imphost 172.18.0.0/16')).toBe('it has no IPv6');

  expect(readDrift('true unnamed 172.18.0.0/16 fd12:3456:789a::/64')).toBe(
    'its bridge is unnamed, not br-imphost',
  );

  expect(readDrift('true br-imphost 172.18.0.0/16 fd00::/64')).toBe(
    'its IPv6 subnet is fd00::/64, not fd12:3456:789a::/64',
  );

  // an existing right network gives its subnet to an env file without one
  expect(runFunction('network_subnet6', ['true br-imphost 172.18.0.0/16 fd12:0:0:1::/64'])).toBe(
    'fd12:0:0:1::/64\n',
  );

  expect(runFunction('network_subnet6', ['true unnamed fd12::/64'])).toBe('');
});

test('it reads the uplink and the origin of an IPv6 default route', () => {
  const route = 'default via fe80::1 dev eth0.100 proto ra metric 1024 expires 1797sec pref medium';

  expect(runFunction('route_uplink', [route])).toBe('eth0.100\n');
  expect(() => runFunction('route_is_ra', [route])).not.toThrow();
  expect(() => runFunction('route_is_ra', ['default via fe80::1 dev eth0 proto static'])).toThrow();
});

test('the accept_ra file keeps a dotted interface name whole', () => {
  const file = runFunction('render_ra_file', ['eth0.100']);

  expect(file).toContain('\nnet/ipv6/conf/eth0.100/accept_ra = 2\n');
  expect(runFunction('ra_file_uplink', [], { stdin: file })).toBe('eth0.100\n');
});

test('the unit creates the network as bootstrap.sh does', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'imp-docker-'));

  try {
    const docker = path.join(dir, 'docker');

    writeFileSync(docker, '#!/bin/sh\necho "$@" >&2\n', { mode: 0o755 });

    const created = Bun.spawnSync(
      ['bash', '-c', 'source "$1"; ipv6_subnet=fd12::/64 create_host_network', 'test', script],
      { env: { PATH: `${dir}:${process.env['PATH'] ?? ''}` } },
    );

    const args = created.stderr.toString().trim();
    const unit = readDeployFile('imp-host.service').replaceAll('"$$IMP_HOST_SUBNET6"', 'fd12::/64');

    expect(args).toBe(
      'network create --ipv6 --subnet fd12::/64 -o com.docker.network.bridge.name=br-imphost imp-host',
    );

    expect(unit).toContain(`/usr/bin/docker ${args} ;;`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('blanking the key leaves every other line alone', () => {
  const env =
    'IMP_HOST_IMAGE=imp-host:1\nTAILSCALE_AUTHKEY=fake-key-for-tests\nIMP_TAILSCALE_HOSTNAME=imp\n';

  expect(runFunction('blank_env_key', [], { stdin: env })).toBe(
    'IMP_HOST_IMAGE=imp-host:1\nTAILSCALE_AUTHKEY=\nIMP_TAILSCALE_HOSTNAME=imp\n',
  );
});

// a docker that reports `label` as every image's imp.host-contract
function runContractCheck(label: string) {
  const bin = mkdtempSync(path.join(tmpdir(), 'imp-contract-'));

  writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho '${label}'\n`, { mode: 0o755 });

  try {
    return Bun.spawnSync(
      [
        'bash',
        '-c',
        'source "$1"; check_image_contract ghcr.io/zgeoff/imp-host:latest',
        'x',
        script,
      ],
      { env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` } },
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test('a stale image, from before the proxy, is refused with how to get the new one', () => {
  const stale = runContractCheck('unprivileged');

  expect(stale.exitCode).toBe(1);

  expect(stale.stderr.toString()).toContain(
    'pull the new image (docker pull ghcr.io/zgeoff/imp-host:latest)',
  );

  expect(runContractCheck('').exitCode).toBe(1);
  expect(runContractCheck('socket-proxy').exitCode).toBe(0);
});
