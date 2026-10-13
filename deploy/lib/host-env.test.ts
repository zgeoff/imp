import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';
import { runSourcedFunction } from '../../scripts/test-utils/run-sourced-function';

// host-env.sh's functions, sourced as upgrade.sh and the NixOS module source them;
// deploy/bootstrap.test.ts tests bootstrap.sh's own.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-host-env-lib-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
  };
}

// a 64 GB box reports about 62.5 GiB
test.each([
  [String(64_000 * 1024), '54400\n'],
  [String(32 * 1024 * 1024), '24576\n'],
  [String(128 * 1024 * 1024), '111412\n'],
])(
  '#ram_budget_mib keeps the larger of 8 GiB and 15 percent of %s KiB for the host, leaving %p',
  (memTotalKib, budget) => {
    const script = new URL('host-env.sh', import.meta.url).pathname;

    expect(runSourcedFunction({ script, fn: 'ram_budget_mib', args: [memTotalKib] })).toStrictEqual(
      { exitCode: 0, stdout: budget, stderr: '' },
    );
  },
);

test('#ram_budget_mib leaves the ZFS ARC cap out of the budget', () => {
  const script = new URL('host-env.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'ram_budget_mib', args: [String(64_000 * 1024), '6400'] })
      .stdout,
  ).toBe('48000\n');
});

test.each([
  [String(64_000 * 1024), '6400\n'],
  [String(8 * 1024 * 1024), '1024\n'],
  [String(256 * 1024 * 1024), '8192\n'],
])(
  '#zfs_arc_max_mib caps the ARC of %s KiB of RAM at 10 percent within 1 to 8 GiB, %p',
  (memTotalKib, cap) => {
    const script = new URL('host-env.sh', import.meta.url).pathname;

    expect(
      runSourcedFunction({ script, fn: 'zfs_arc_max_mib', args: [memTotalKib] }),
    ).toStrictEqual({ exitCode: 0, stdout: cap, stderr: '' });
  },
);

test('#check_ram_budget refuses a budget below 512 MiB, naming the RAM, the ARC cap and the setting', () => {
  const script = new URL('host-env.sh', import.meta.url).pathname;

  const result = runSourcedFunction({
    script,
    fn: 'check_ram_budget',
    args: ['-6144', String(3 * 1024 * 1024), '1024', 'IMP_RAM_BUDGET_MIB'],
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr).toMatch(
    /comes out at -6144 MiB, below the 512 MiB floor: RAM 3072 MiB.*ARC cap 1024 MiB.*Set IMP_RAM_BUDGET_MIB/u,
  );
});

test('#check_ram_budget accepts a budget of 512 MiB', () => {
  const script = new URL('host-env.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'check_ram_budget',
      args: ['512', String(3 * 1024 * 1024), '0', 'IMP_RAM_BUDGET_MIB'],
    }),
  ).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

// SSH, DHCP and ICMP only; a reload replaces our table in one transaction, never Docker's
test('#render_firewall renders a table of its own that opens only SSH, DHCP and ICMP', () => {
  const script = new URL('host-env.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'render_firewall', args: ['2222', '22', '22'] }).stdout)
    .toMatchInlineSnapshot(`
    "# imp host firewall, written by deploy/bootstrap.sh. Loaded by
    # imp-firewall.service. Inbound: SSH only.
    table inet imp_host
    delete table inet imp_host
    table inet imp_host {
    	chain input {
    		type filter hook input priority filter; policy drop;
    		iif "lo" accept
    		ct state established,related accept
    		ct state invalid drop
    		meta l4proto icmp accept
    		meta l4proto ipv6-icmp accept
    		udp dport 68 accept comment "DHCPv4 client"
    		udp dport 546 accept comment "DHCPv6 client"
    		tcp dport { 22, 2222 } accept comment "SSH"
    	}
    }
    "
  `);
});

// nft -c parses the ruleset against the kernel, which needs CAP_NET_ADMIN; an unprivileged
// user namespace gives it where the host allows one, and IMP_HOST_TESTS=required insists
test.skipIf(
  process.env['IMP_HOST_TESTS'] !== 'required' &&
    Bun.spawnSync(['unshare', '-rn', 'nft', '-c', 'list ruleset']).exitCode !== 0,
)('#render_firewall renders a ruleset nft accepts', () => {
  const ctx = setupTest();

  const script = new URL('host-env.sh', import.meta.url).pathname;

  writeFileSync(
    join(ctx.dir, 'firewall.nft'),
    runSourcedFunction({ script, fn: 'render_firewall', args: ['22'] }).stdout,
  );

  const result = Bun.spawnSync([
    'unshare',
    '-rn',
    'nft',
    '-c',
    '-f',
    join(ctx.dir, 'firewall.nft'),
  ]);

  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
});

test.each([
  ['fd12::1', 'fd12:0:0:0:0:0:0:1\n'],
  ['::', '0:0:0:0:0:0:0:0\n'],
  ['FD12:0034::', 'fd12:34:0:0:0:0:0:0\n'],
  ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8\n'],
])('#ipv6_expand writes the eight groups of %s, %p', (address, groups) => {
  const script = new URL('host-env.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'ipv6_expand', args: [address] })).toStrictEqual({
    exitCode: 0,
    stdout: groups,
    stderr: '',
  });
});

test.each([
  ['fd12::1::2'],
  ['1:2:3:4:5:6:7'],
  ['1:2:3:4:5:6:7:8:9'],
  ['fd12::12345'],
  ['10.0.0.1'],
])('#ipv6_expand refuses %p, which is no IPv6 address', (address) => {
  const script = new URL('host-env.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'ipv6_expand', args: [address] })).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: '',
  });
});

test.each([
  ['fd12:0034:0:0::/64', 'fd12:34::/64\n'],
  ['FD12:3456:789A:0001::', 'fd12:3456:789a:1::\n'],
  ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1\n'],
  ['fd12:0:0:1::/64', 'fd12:0:0:1::/64\n'],
  ['::1', '::1\n'],
  ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8\n'],
])('#ipv6_canon writes %s as Docker prints it, %p', (address, canonical) => {
  const script = new URL('host-env.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'ipv6_canon', args: [address] })).toStrictEqual({
    exitCode: 0,
    stdout: canonical,
    stderr: '',
  });
});

test('#subnet6 accepts a /64 with no host bits, written as Docker prints it', () => {
  const script = new URL('host-env.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'subnet6', args: ['FD12:3456:789a:0::/64'] }),
  ).toStrictEqual({ exitCode: 0, stdout: 'fd12:3456:789a::/64\n', stderr: '' });
});

test.each([['fd12::/56'], ['fd12::1/64'], ['fd12:::/64'], ['nope/64'], ['10.0.0.0/64']])(
  '#subnet6 refuses %p, which is no IPv6 /64 without host bits',
  (subnet) => {
    const script = new URL('host-env.sh', import.meta.url).pathname;

    expect(runSourcedFunction({ script, fn: 'subnet6', args: [subnet] })).toStrictEqual({
      exitCode: 1,
      stdout: '',
      stderr: '',
    });
  },
);

test.each([
  ['true br-imphost 172.18.0.0/16 fd12:3456:789a::/64', ''],
  ['false br-imphost 172.18.0.0/16', 'it has no IPv6\n'],
  ['true unnamed 172.18.0.0/16 fd12:3456:789a::/64', 'its bridge is unnamed, not br-imphost\n'],
  [
    'true br-imphost 172.18.0.0/16 fd00::/64',
    'its IPv6 subnet is fd00::/64, not fd12:3456:789a::/64\n',
  ],
])('#network_drift reads the network %p as differing by %p', (inspect, drift) => {
  const script = new URL('host-env.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'network_drift',
      args: ['fd12:3456:789a::/64', inspect],
    }).stdout,
  ).toBe(drift);
});

test('#network_others names the containers on the network other than imp-host', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', 'echo "imp-host pod-a pod-b "');

  const result = runSourcedFunction({
    script: new URL('host-env.sh', import.meta.url).pathname,
    fn: 'network_others',
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result).toStrictEqual({ exitCode: 0, stdout: 'pod-a pod-b\n', stderr: '' });
});

test("#host_addresses lists the host's global addresses with their prefixes, comma-separated", () => {
  const ctx = setupTest();

  const ip = createStubBin(
    ctx.dir,
    'ip',
    String.raw`printf '%s\n' \
      '2: eth0    inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0' \
      '2: eth0    inet6 2001:db8::10/64 scope global dynamic'`,
  );

  const result = runSourcedFunction({
    script: new URL('host-env.sh', import.meta.url).pathname,
    fn: 'host_addresses',
    env: { PATH: `${ip.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: '192.0.2.10/24,2001:db8::10/64\n',
    stderr: '',
  });

  expect(readFileSync(ip.calls, 'utf8')).toBe('ip -o addr show scope global\n');
});

test('#create_host_network creates the network with the arguments the unit uses', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker');

  runSourcedFunction({
    script: new URL('host-env.sh', import.meta.url).pathname,
    fn: 'create_host_network',
    args: ['fd12::/64'],
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  const unit = readFileSync(new URL('../imp-host.service', import.meta.url), 'utf8');

  expect(readFileSync(docker.calls, 'utf8')).toBe(
    'docker network create --ipv6 --subnet fd12::/64 -o com.docker.network.bridge.name=br-imphost imp-host\n',
  );

  expect(unit.replaceAll('"$$IMP_HOST_SUBNET6"', 'fd12::/64')).toInclude(
    '/usr/bin/docker network create --ipv6 --subnet fd12::/64 -o com.docker.network.bridge.name=br-imphost imp-host ;;',
  );
});

test('#trim_lines takes off a trailing CR, the blanks around a line and the quotes around a value', () => {
  const script = new URL('host-env.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'trim_lines',
      stdin: ' IMP_A=1 \r\nIMP_B="two words"\nIMP_C=\'x\'\nIMP_D="unmatched\n# a "comment"\n',
    }),
  ).toStrictEqual({
    exitCode: 0,
    stdout: 'IMP_A=1\nIMP_B=two words\nIMP_C=x\nIMP_D="unmatched\n# a "comment"\n',
    stderr: '',
  });
});

test('#trim_lines reads a file it is given', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_A="1"\r\n');

  expect(
    runSourcedFunction({
      script: new URL('host-env.sh', import.meta.url).pathname,
      fn: 'trim_lines',
      args: [join(ctx.dir, 'imp-host.env')],
    }),
  ).toStrictEqual({ exitCode: 0, stdout: 'IMP_A=1\n', stderr: '' });
});

test('#trim_lines prints nothing for a file that is missing', () => {
  const ctx = setupTest();

  expect(
    runSourcedFunction({
      script: new URL('host-env.sh', import.meta.url).pathname,
      fn: 'trim_lines',
      args: [join(ctx.dir, 'missing.env')],
    }),
  ).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('#strip_markers takes out the release-please marker lines only', () => {
  const script = new URL('host-env.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'strip_markers',
      stdin:
        '# x-release-please-start-version\nIMAGE=imp-host:1\n# x-release-please-end\n' +
        'TAG=1 # x-release-please-version\n',
    }),
  ).toStrictEqual({
    exitCode: 0,
    stdout: 'IMAGE=imp-host:1\nTAG=1 # x-release-please-version\n',
    stderr: '',
  });
});

test('#check_env_image refuses an env file whose last IMP_HOST_IMAGE is empty, naming the file', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_PORT=7070\nIMP_HOST_IMAGE=\n');

  const result = runSourcedFunction({
    script: new URL('host-env.sh', import.meta.url).pathname,
    fn: 'check_env_image',
    args: [join(ctx.dir, 'imp-host.env')],
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toStartWith(`${join(ctx.dir, 'imp-host.env')} sets IMP_HOST_IMAGE= empty`);
});

test.each([
  ['IMP_HOST_IMAGE=\nIMP_HOST_IMAGE=imp-host:1\n', 0],
  ['# IMP_HOST_IMAGE=imp-host:1\n', 0],
  ['IMP_HOST_IMAGE= \r\n', 1],
  ['IMP_HOST_IMAGE=""\n', 1],
])('#check_env_image answers the env file %p with exit %d', (env, exitCode) => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'imp-host.env'), env);

  const result = runSourcedFunction({
    script: new URL('host-env.sh', import.meta.url).pathname,
    fn: 'check_env_image',
    args: [join(ctx.dir, 'imp-host.env')],
  });

  expect(result.exitCode).toBe(exitCode);
});

test('#check_env_image accepts a file that is missing', () => {
  const ctx = setupTest();

  expect(
    runSourcedFunction({
      script: new URL('host-env.sh', import.meta.url).pathname,
      fn: 'check_env_image',
      args: [join(ctx.dir, 'missing.env')],
    }),
  ).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('#write_file writes the content and a newline with the mode it is given', () => {
  const ctx = setupTest();

  const result = runSourcedFunction({
    script: new URL('host-env.sh', import.meta.url).pathname,
    fn: 'write_file',
    args: [join(ctx.dir, 'etc/imp/imp-host.env'), '600', 'IMP_A=1'],
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.dir, 'etc/imp/imp-host.env'), 'utf8')).toBe('IMP_A=1\n');
  expect(statSync(join(ctx.dir, 'etc/imp/imp-host.env')).mode & 0o777).toBe(0o600);
});
