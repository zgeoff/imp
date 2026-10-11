import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandLinks } from '@imp/test-utils/create-command-links';
import * as z from 'zod';
import { buildStubBlockDevices } from '../scripts/test-utils/build-stub-block-devices';
import { buildStubBootstrapDocker } from '../scripts/test-utils/build-stub-bootstrap-docker';
import { createStubBin } from '../scripts/test-utils/create-stub-bin';
import { readEnvValues } from '../scripts/test-utils/read-env-values';
import { runSourcedFunction } from '../scripts/test-utils/run-sourced-function';

// bootstrap.sh's functions; scripts/test-bootstrap.sh runs the whole script in a container.
// render_env's args: env file, template, budget, image, image set, storage, zfs root,
// firewall, ipv6, subnet6, ksm; it gets files through $(...), which drops trailing newlines.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-bootstrap-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
  };
}

test('#unit_imp_host prints deploy/imp-host.service unchanged', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'unit_imp_host' })).toStrictEqual({
    exitCode: 0,
    stdout: readFileSync(new URL('imp-host.service', import.meta.url), 'utf8'),
    stderr: '',
  });
});

test('#unit_imp_docker_proxy prints deploy/imp-docker-proxy.service unchanged', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'unit_imp_docker_proxy' })).toStrictEqual({
    exitCode: 0,
    stdout: readFileSync(new URL('imp-docker-proxy.service', import.meta.url), 'utf8'),
    stderr: '',
  });
});

test('#env_template prints deploy/imp-host.env.example unchanged', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'env_template' })).toStrictEqual({
    exitCode: 0,
    stdout: readFileSync(new URL('imp-host.env.example', import.meta.url), 'utf8'),
    stderr: '',
  });
});

// a 64 GB box reports about 62.5 GiB
test.each([
  [String(64_000 * 1024), '54400\n'],
  [String(32 * 1024 * 1024), '24576\n'],
  [String(128 * 1024 * 1024), '111412\n'],
])(
  '#ram_budget_mib keeps the larger of 8 GiB and 15 percent of %s KiB for the host, leaving %p',
  (memTotalKib, budget) => {
    const script = new URL('bootstrap.sh', import.meta.url).pathname;

    expect(runSourcedFunction({ script, fn: 'ram_budget_mib', args: [memTotalKib] })).toStrictEqual(
      { exitCode: 0, stdout: budget, stderr: '' },
    );
  },
);

test('#ram_budget_mib leaves the ZFS ARC cap out of the budget', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

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
    const script = new URL('bootstrap.sh', import.meta.url).pathname;

    expect(
      runSourcedFunction({ script, fn: 'zfs_arc_max_mib', args: [memTotalKib] }),
    ).toStrictEqual({ exitCode: 0, stdout: cap, stderr: '' });
  },
);

test('#check_ram_budget refuses a budget below 512 MiB, naming the RAM, the ARC cap and the setting', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

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
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'check_ram_budget',
      args: ['512', String(3 * 1024 * 1024), '0', 'IMP_RAM_BUDGET_MIB'],
    }),
  ).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

// Debian 13 and Ubuntu 24.04 on their own kernels; the WSL dev box with Debian's xfsprogs (the
// test container) and with Ubuntu's 6.6, which rejects exchange= and parent=; an old kernel
test.each([
  ['6.12.48+deb13-amd64', '6.13.0', '-m reflink=1\n'],
  ['6.8.0-85-generic', '6.6.0', '-m reflink=1\n'],
  ['6.6.87.2-microsoft-standard-WSL2', '6.13.0', '-m reflink=1 -i exchange=0 -n parent=0\n'],
  ['6.6.87.2-microsoft-standard-WSL2', '6.6.0', '-m reflink=1\n'],
  ['5.15.0-100-generic', '6.13.0', '-m reflink=1 -i nrext64=0,exchange=0 -n parent=0\n'],
])(
  '#mkfs_xfs_opts turns off what kernel %s cannot mount and mkfs.xfs %s knows',
  (kernel, progs, options) => {
    const script = new URL('bootstrap.sh', import.meta.url).pathname;

    expect(
      runSourcedFunction({ script, fn: 'mkfs_xfs_opts', args: [kernel, progs] }),
    ).toStrictEqual({ exitCode: 0, stdout: options, stderr: '' });
  },
);

// a 240 GB disk with the OS installed has about 220 GiB free
test.each([
  ['220', '187\n'],
  ['100', '70\n'],
  ['40', '10\n'],
])(
  '#loop_size_auto_gib leaves the larger of 30 GiB and 15 percent of %s GiB free, sizing %p',
  (freeGib, size) => {
    const script = new URL('bootstrap.sh', import.meta.url).pathname;

    expect(runSourcedFunction({ script, fn: 'loop_size_auto_gib', args: [freeGib] })).toStrictEqual(
      { exitCode: 0, stdout: size, stderr: '' },
    );
  },
);

test.each([
  ['UUID=1234', 'device', 'UUID=1234 /var/lib/imp xfs defaults,nosuid,nofail 0 2\n'],
  ['/srv/imp.xfs', 'loop', '/srv/imp.xfs /var/lib/imp xfs loop,nosuid,nofail 0 0\n'],
])('#fstab_line writes the entry of %s as a %s', (source, kind, line) => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'fstab_line', args: [source, kind] })).toStrictEqual({
    exitCode: 0,
    stdout: line,
    stderr: '',
  });
});

test.each([
  ['', 'UUID=1234 /var/lib/imp xfs defaults,nosuid,nofail 0 2', 'none\n'],
  [
    'UUID=1234 /var/lib/imp xfs defaults,nosuid,nofail 0 2\n',
    'UUID=1234 /var/lib/imp xfs defaults,nosuid,nofail 0 2',
    'same\n',
  ],
  [
    'UUID=1234 /var/lib/imp xfs defaults,nofail 0 2\n',
    'UUID=1234 /var/lib/imp xfs defaults,nosuid,nofail 0 2',
    'old\n',
  ],
  [
    '/srv/imp.xfs /var/lib/imp xfs loop,nofail 0 0\n',
    '/srv/imp.xfs /var/lib/imp xfs loop,nosuid,nofail 0 0',
    'old\n',
  ],
  [
    'UUID=9999 /var/lib/imp xfs defaults,nofail 0 2\n',
    'UUID=1234 /var/lib/imp xfs defaults,nosuid,nofail 0 2',
    'other\n',
  ],
])(
  '#fstab_entry_state reads the fstab lines %p against the entry %p as %p',
  (lines, entry, state) => {
    const ctx = setupTest();

    const script = new URL('bootstrap.sh', import.meta.url).pathname;

    writeFileSync(join(ctx.dir, 'fstab'), `UUID=abcd / ext4 defaults 0 1\n${lines}`);

    expect(
      runSourcedFunction({
        script,
        fn: 'fstab_entry_state',
        args: [join(ctx.dir, 'fstab'), entry],
      }),
    ).toStrictEqual({ exitCode: 0, stdout: state, stderr: '' });
  },
);

test('#ssh_ports_from_sshd_t reads the ports sshd -T prints', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'ssh_ports_from_sshd_t',
      stdin: 'port 22\nport 2222\naddressfamily any\nlistenaddress [::]:22\n',
    }).stdout,
  ).toBe('22\n2222\n');
});

test('#ssh_ports_from_listen reads the ports of socket units and ss', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'ssh_ports_from_listen',
      stdin: '[::]:22 (Stream)\n0.0.0.0:2200\n',
    }).stdout,
  ).toBe('22\n2200\n');
});

// SSH, DHCP and ICMP only; a reload replaces our table in one transaction, never Docker's
test('#render_firewall renders a table of its own that opens only SSH, DHCP and ICMP', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

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

  const script = new URL('bootstrap.sh', import.meta.url).pathname;

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

test('#render_env writes a new env file from the template with the budget and the key, pinning no image', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const version = z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version;
  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [
      '',
      template,
      '54400',
      `ghcr.io/zgeoff/imp-host:${version}`,
      '',
      'xfs',
      '',
      'own',
      'off',
      '',
      '',
    ],
    env: { BOOTSTRAP_AUTHKEY: 'fake-key-for-tests' },
  }).stdout;

  expect(readEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toStrictEqual(['54400']);
  expect(readEnvValues(env, 'IMP_HOST_IMAGE')).toBeEmpty();
  expect(env).toInclude(`\n# IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:${version}\n`);
  expect(readEnvValues(env, 'TAILSCALE_AUTHKEY')).toStrictEqual(['fake-key-for-tests']);
  expect(readEnvValues(env, 'IMP_STORAGE_BACKEND')).toStrictEqual(['xfs']);
  expect(readEnvValues(env, 'IMP_ZFS_ROOT')).toStrictEqual(['']);
  expect(readEnvValues(env, 'IMP_HOST_FIREWALL')).toStrictEqual(['own']);
  expect(readEnvValues(env, 'IMP_IDLE_TIMEOUT_S')).toStrictEqual(['60']);
});

test('#render_env pins the image --image names in a new env file', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: ['', template, '54400', 'imp-host:1.2.3', '1', 'xfs', '', 'own', 'off', '', ''],
  }).stdout;

  expect(readEnvValues(env, 'IMP_HOST_IMAGE')).toStrictEqual(['imp-host:1.2.3']);
});

test('#render_env turns the old template image line into the commented pin', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const image = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;
  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const existing = template.replace(
    `# IMP_HOST_IMAGE=${image}`,
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest',
  );

  const migrated = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [existing, template, '54400', image, '', 'xfs', '', 'own', 'off', '', ''],
  });

  const fresh = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [template, template, '54400', image, '', 'xfs', '', 'own', 'off', '', ''],
  });

  expect(existing).toInclude('\nIMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n');
  expect(migrated).toStrictEqual(fresh);
});

test('#render_env turns the old template image line, with a CR and blanks around it, into the commented pin', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const image = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;
  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const existing = template.replace(
    `# IMP_HOST_IMAGE=${image}`,
    '  IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\r',
  );

  const migrated = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [existing, template, '54400', image, '', 'xfs', '', 'own', 'off', '', ''],
  });

  const fresh = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [template, template, '54400', image, '', 'xfs', '', 'own', 'off', '', ''],
  });

  expect(existing).toInclude('\n  IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\r\n');
  expect(migrated).toStrictEqual(fresh);
});

test('#render_env replaces the old template image line with the image --image names', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const image = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;
  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const existing = template.replace(
    `# IMP_HOST_IMAGE=${image}`,
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest',
  );

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [existing, template, '54400', 'imp-host:2.0.0', '1', 'xfs', '', 'own', 'off', '', ''],
  }).stdout;

  expect(readEnvValues(env, 'IMP_HOST_IMAGE')).toStrictEqual(['imp-host:2.0.0']);
});

test('#render_env keeps the operator values of an existing env file', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const image = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;
  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const existing = template
    .replace('IMP_RAM_BUDGET_MIB=16384', 'IMP_RAM_BUDGET_MIB=30000')
    .replace(`# IMP_HOST_IMAGE=${image}`, 'IMP_HOST_IMAGE=imp-host:pinned')
    .replace('TAILSCALE_AUTHKEY=', 'TAILSCALE_AUTHKEY=fake-old-key')
    .replace('IMP_IDLE_TIMEOUT_S=60', 'IMP_IDLE_TIMEOUT_S=300')
    .replace('IMP_HOST_IPV6=', 'IMP_HOST_IPV6=off');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [existing, template, '54400', image, '', 'xfs', '', 'own', 'off', '', ''],
  }).stdout;

  expect(readEnvValues(existing, 'IMP_HOST_IMAGE')).toStrictEqual(['imp-host:pinned']);
  expect(env).toBe(`${existing}\n`);
});

test('#render_env replaces the template budget, and writes --image and a new key over the file', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [template, template, '54400', 'imp-host:2.0.0', '1', 'xfs', '', 'own', 'off', '', ''],
    env: { BOOTSTRAP_AUTHKEY: 'fake-new-key' },
  }).stdout;

  expect(readEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toStrictEqual(['54400']);
  expect(readEnvValues(env, 'IMP_HOST_IMAGE')).toStrictEqual(['imp-host:2.0.0']);
  expect(readEnvValues(env, 'TAILSCALE_AUTHKEY')).toStrictEqual(['fake-new-key']);
});

test('#render_env sets the zfs backend and its dataset', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [template, template, '54400', 'imp-host:1', '', 'zfs', 'tank/imp', 'own', 'off', '', ''],
  }).stdout;

  expect(readEnvValues(env, 'IMP_STORAGE_BACKEND')).toStrictEqual(['zfs']);
  expect(readEnvValues(env, 'IMP_ZFS_ROOT')).toStrictEqual(['tank/imp']);
});

test('#render_env leaves a zfs env file as it is on the next render', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [template, template, '54400', 'imp-host:1', '', 'zfs', 'tank/imp', 'own', 'off', '', ''],
  }).stdout;

  expect(
    runSourcedFunction({
      script,
      fn: 'render_env',
      args: [
        env.replace(/\n+$/u, ''),
        template,
        '54400',
        'imp-host:1',
        '',
        'zfs',
        'tank/imp',
        'own',
        'off',
        '',
        '',
      ],
    }).stdout,
  ).toBe(env);
});

test('#render_env writes the host firewall none over own', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [template, template, '54400', 'imp-host:1', '', 'xfs', '', 'none', 'off', '', ''],
  }).stdout;

  expect(readEnvValues(env, 'IMP_HOST_FIREWALL')).toStrictEqual(['none']);
});

test('#render_env keeps the host firewall none on the next render', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [template, template, '54400', 'imp-host:1', '', 'xfs', '', 'none', 'off', '', ''],
  }).stdout;

  expect(
    runSourcedFunction({
      script,
      fn: 'render_env',
      args: [
        env.replace(/\n+$/u, ''),
        template,
        '54400',
        'imp-host:1',
        '',
        'xfs',
        '',
        'none',
        'off',
        '',
        '',
      ],
    }).stdout,
  ).toBe(env);
});

test('#render_env sets IMP_KSM=1 for --ksm', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [template, template, '54400', 'imp-host:1', '', 'xfs', '', 'own', 'off', '', 'on'],
  }).stdout;

  expect(readEnvValues(env, 'IMP_KSM')).toStrictEqual(['1']);
});

test('#render_env leaves an env file with IMP_KSM=1 as it is on the next render with --ksm', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [template, template, '54400', 'imp-host:1', '', 'xfs', '', 'own', 'off', '', 'on'],
  }).stdout;

  expect(
    runSourcedFunction({
      script,
      fn: 'render_env',
      args: [
        env.replace(/\n+$/u, ''),
        template,
        '54400',
        'imp-host:1',
        '',
        'xfs',
        '',
        'own',
        'off',
        '',
        'on',
      ],
    }).stdout,
  ).toBe(env);
});

test('#render_env sets IMP_KSM=0 for --no-ksm', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [
      template.replace(/^IMP_KSM=$/mu, 'IMP_KSM=1'),
      template,
      '54400',
      'imp-host:1',
      '',
      'xfs',
      '',
      'own',
      'off',
      '',
      'off',
    ],
  }).stdout;

  expect(readEnvValues(env, 'IMP_KSM')).toStrictEqual(['0']);
});

test("#render_env keeps the operator's IMP_KSM without --ksm or --no-ksm", () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');
  const existing = template.replace(/^IMP_KSM=$/mu, 'IMP_KSM=1');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [existing, template, '54400', 'imp-host:1', '', 'xfs', '', 'own', 'off', '', ''],
  }).stdout;

  expect(readEnvValues(env, 'IMP_KSM')).toStrictEqual(['1']);
});

test('#render_env leaves the template IMP_KSM empty without --ksm or --no-ksm', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [template, template, '54400', 'imp-host:1', '', 'xfs', '', 'own', 'off', '', ''],
  }).stdout;

  expect(readEnvValues(env, 'IMP_KSM')).toStrictEqual(['']);
});

test('#render_env appends each missing key once', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  expect(
    runSourcedFunction({
      script,
      fn: 'render_env',
      args: [
        'IMP_IDLE_TIMEOUT_S=30',
        template,
        '54400',
        'imp-host:1',
        '1',
        'xfs',
        '',
        'own',
        'off',
        '',
        '',
      ],
    }).stdout,
  ).toBe(
    'IMP_IDLE_TIMEOUT_S=30\nIMP_HOST_IMAGE=imp-host:1\nIMP_RAM_BUDGET_MIB=54400\n' +
      'IMP_STORAGE_BACKEND=xfs\nIMP_HOST_FIREWALL=own\nIMP_HOST_IPV6=off\nIMP_HOST_NETWORK=\n',
  );
});

test('#render_env changes nothing on a second render of an env file it appended keys to', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const once = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [
      'IMP_IDLE_TIMEOUT_S=30',
      template,
      '54400',
      'imp-host:1',
      '1',
      'xfs',
      '',
      'own',
      'off',
      '',
      '',
    ],
  }).stdout;

  expect(
    runSourcedFunction({
      script,
      fn: 'render_env',
      args: [
        once.replace(/\n+$/u, ''),
        template,
        '54400',
        'imp-host:1',
        '1',
        'xfs',
        '',
        'own',
        'off',
        '',
        '',
      ],
    }).stdout,
  ).toBe(once);
});

test('#render_env names the network and keeps the subnet with ipv6 on', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [
      template,
      template,
      '54400',
      'imp-host:1',
      '',
      'xfs',
      '',
      'own',
      'on',
      'fd12:3456:789a::/64',
      '',
    ],
  }).stdout;

  expect(readEnvValues(env, 'IMP_HOST_IPV6')).toStrictEqual(['on']);
  expect(readEnvValues(env, 'IMP_HOST_NETWORK')).toStrictEqual(['--network imp-host']);
  expect(readEnvValues(env, 'IMP_HOST_SUBNET6')).toStrictEqual(['fd12:3456:789a::/64']);
});

test('#render_env leaves an ipv6 env file as it is on the next render with ipv6 on', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const on = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [
      template,
      template,
      '54400',
      'imp-host:1',
      '',
      'xfs',
      '',
      'own',
      'on',
      'fd12:3456:789a::/64',
      '',
    ],
  }).stdout;

  expect(
    runSourcedFunction({
      script,
      fn: 'render_env',
      args: [
        on.replace(/\n+$/u, ''),
        template,
        '54400',
        'imp-host:1',
        '',
        'xfs',
        '',
        'own',
        'on',
        'fd12:3456:789a::/64',
        '',
      ],
    }).stdout,
  ).toBe(on);
});

test('#render_env drops the network but keeps the subnet for later with ipv6 off', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const template = runSourcedFunction({ script, fn: 'env_template' }).stdout.replace(/\n+$/u, '');

  const existing = template
    .replace(/^IMP_HOST_IPV6=$/mu, 'IMP_HOST_IPV6=on')
    .replace(/^IMP_HOST_NETWORK=$/mu, 'IMP_HOST_NETWORK=--network imp-host')
    .replace(/^IMP_HOST_SUBNET6=$/mu, 'IMP_HOST_SUBNET6=fd12:3456:789a::/64');

  const env = runSourcedFunction({
    script,
    fn: 'render_env',
    args: [existing, template, '54400', 'imp-host:1', '', 'xfs', '', 'own', 'off', '', ''],
  }).stdout;

  expect(readEnvValues(existing, 'IMP_HOST_SUBNET6')).toStrictEqual(['fd12:3456:789a::/64']);
  expect(readEnvValues(env, 'IMP_HOST_IPV6')).toStrictEqual(['off']);
  expect(readEnvValues(env, 'IMP_HOST_NETWORK')).toStrictEqual(['']);
  expect(readEnvValues(env, 'IMP_HOST_SUBNET6')).toStrictEqual(['fd12:3456:789a::/64']);
});

test.each([
  ['1', '0', 0],
  ['0', '12', 0],
  ['0', '0', 1],
  ['2', '0', 1],
])(
  '#ksm_merges sees ksmd merging, with run %s and %s pages shared, as exit %d',
  (run, shared, exitCode) => {
    const ctx = setupTest();

    const script = new URL('bootstrap.sh', import.meta.url).pathname;

    writeFileSync(join(ctx.dir, 'run'), `${run}\n`);
    writeFileSync(join(ctx.dir, 'pages_shared'), `${shared}\n`);

    expect(
      runSourcedFunction({ script, fn: 'ksm_merges', env: { KSM_DIR: ctx.dir } }),
    ).toStrictEqual({ exitCode, stdout: '', stderr: '' });
  },
);

test.each([
  ['6.10.0-1-amd64', 0],
  ['6.17.0-1022-azure', 0],
  ['7.0.0', 0],
  ['6.9.12', 1],
  ['6.6.87.2-microsoft-standard-WSL2', 1],
  ['5.15.0', 1],
])(
  '#kernel_supports_ksm answers kernel %s, which needs 6.10, with exit %d',
  (release, exitCode) => {
    const script = new URL('bootstrap.sh', import.meta.url).pathname;

    expect(
      runSourcedFunction({ script, fn: 'kernel_supports_ksm', args: [release] }),
    ).toStrictEqual({ exitCode, stdout: '', stderr: '' });
  },
);

test('#ksm_tmpfiles starts ksmd with zero-page merging at boot', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'ksm_tmpfiles' }).stdout).toBe(
    '# Written by deploy/bootstrap.sh --ksm.\n' +
      'w /sys/kernel/mm/ksm/use_zero_pages - - - - 1\n' +
      'w /sys/kernel/mm/ksm/run - - - - 1\n',
  );
});

test.each([
  ['fd12:0034:0:0::/64', 'fd12:34::/64\n'],
  ['FD12:3456:789A:0001::', 'fd12:3456:789a:1::\n'],
  ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1\n'],
  ['fd12:0:0:1::/64', 'fd12:0:0:1::/64\n'],
  ['::1', '::1\n'],
  ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8\n'],
])('#ipv6_canon writes %s as Docker prints it, %p', (address, canonical) => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'ipv6_canon', args: [address] })).toStrictEqual({
    exitCode: 0,
    stdout: canonical,
    stderr: '',
  });
});

test('#subnet6 accepts a /64 with no host bits, written as Docker prints it', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'subnet6', args: ['FD12:3456:789a:0::/64'] }),
  ).toStrictEqual({ exitCode: 0, stdout: 'fd12:3456:789a::/64\n', stderr: '' });
});

test.each([['fd12::/56'], ['fd12::1/64'], ['fd12:::/64'], ['nope/64'], ['10.0.0.0/64']])(
  '#subnet6 refuses %p, which is no IPv6 /64 without host bits',
  (subnet) => {
    const script = new URL('bootstrap.sh', import.meta.url).pathname;

    expect(runSourcedFunction({ script, fn: 'subnet6', args: [subnet] })).toStrictEqual({
      exitCode: 1,
      stdout: '',
      stderr: '',
    });
  },
);

test('#random_ula64 picks a unique local /64', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const result = runSourcedFunction({ script, fn: 'random_ula64' });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/^fd[0-9a-f]{2}:[0-9a-f:]+\/64\n$/u);
});

test('#subnet6 accepts the subnet random_ula64 picks as it is', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const subnet = runSourcedFunction({ script, fn: 'random_ula64' }).stdout.trim();
  const checked = runSourcedFunction({ script, fn: 'subnet6', args: [subnet] });

  expect(checked).toStrictEqual({ exitCode: 0, stdout: `${subnet}\n`, stderr: '' });
});

test.each([
  ['true br-imphost 172.18.0.0/16 fd12:3456:789a::/64', ''],
  ['false br-imphost 172.18.0.0/16', 'it has no IPv6\n'],
  ['true unnamed 172.18.0.0/16 fd12:3456:789a::/64', 'its bridge is unnamed, not br-imphost\n'],
  [
    'true br-imphost 172.18.0.0/16 fd00::/64',
    'its IPv6 subnet is fd00::/64, not fd12:3456:789a::/64\n',
  ],
])('#network_drift reads the network %p as differing by %p', (inspect, drift) => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'network_drift',
      args: ['fd12:3456:789a::/64', inspect],
    }).stdout,
  ).toBe(drift);
});

// an existing right network gives its subnet to an env file without one
test('#network_subnet6 reads the subnet of a network that is right', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'network_subnet6',
      args: ['true br-imphost 172.18.0.0/16 fd12:0:0:1::/64'],
    }).stdout,
  ).toBe('fd12:0:0:1::/64\n');
});

test('#network_subnet6 reads no subnet from a network whose bridge is unnamed', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'network_subnet6', args: ['true unnamed fd12::/64'] }),
  ).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('#route_uplink reads the uplink of an IPv6 default route', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'route_uplink',
      args: ['default via fe80::1 dev eth0.100 proto ra metric 1024 expires 1797sec pref medium'],
    }).stdout,
  ).toBe('eth0.100\n');
});

test('#route_is_ra accepts a default route from a router advert', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'route_is_ra',
      args: ['default via fe80::1 dev eth0.100 proto ra metric 1024 expires 1797sec pref medium'],
    }).exitCode,
  ).toBe(0);
});

test('#route_is_ra refuses a static default route', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'route_is_ra',
      args: ['default via fe80::1 dev eth0 proto static'],
    }),
  ).toStrictEqual({ exitCode: 1, stdout: '', stderr: '' });
});

test('#render_ra_file keeps a dotted interface name whole', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'render_ra_file', args: ['eth0.100'] }).stdout)
    .toMatchInlineSnapshot(`
      "# Written by deploy/bootstrap.sh (docs/guides/install.md#ipv6). Docker turns on
      # IPv6 forwarding for imp-host's network; with forwarding on, the kernel
      # takes router adverts on eth0.100 only with accept_ra=2.
      net/ipv6/conf/eth0.100/accept_ra = 2
      "
    `);
});

test('#ra_file_uplink reads the dotted interface name back from the accept_ra file', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const file = runSourcedFunction({ script, fn: 'render_ra_file', args: ['eth0.100'] }).stdout;

  expect(runSourcedFunction({ script, fn: 'ra_file_uplink', stdin: file })).toStrictEqual({
    exitCode: 0,
    stdout: 'eth0.100\n',
    stderr: '',
  });
});

test('#create_host_network creates the network with the arguments the unit uses', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker');

  runSourcedFunction({
    script: new URL('bootstrap.sh', import.meta.url).pathname,
    fn: 'eval',
    args: ['ipv6_subnet=fd12::/64 create_host_network'],
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  const unit = readFileSync(new URL('imp-host.service', import.meta.url), 'utf8');

  expect(readFileSync(docker.calls, 'utf8')).toBe(
    'docker network create --ipv6 --subnet fd12::/64 -o com.docker.network.bridge.name=br-imphost imp-host\n',
  );

  expect(unit.replaceAll('"$$IMP_HOST_SUBNET6"', 'fd12::/64')).toInclude(
    '/usr/bin/docker network create --ipv6 --subnet fd12::/64 -o com.docker.network.bridge.name=br-imphost imp-host ;;',
  );
});

test('#blank_env_key blanks the key and leaves every other line alone', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'blank_env_key',
      stdin:
        'IMP_HOST_IMAGE=imp-host:1\nTAILSCALE_AUTHKEY=fake-key-for-tests\nIMP_TAILSCALE_HOSTNAME=imp\n',
    }).stdout,
  ).toBe('IMP_HOST_IMAGE=imp-host:1\nTAILSCALE_AUTHKEY=\nIMP_TAILSCALE_HOSTNAME=imp\n');
});

test('#check_image_contract refuses an image from before the proxy, with how to get the new one', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', "echo 'unprivileged'");

  const result = runSourcedFunction({
    script: new URL('bootstrap.sh', import.meta.url).pathname,
    fn: 'check_image_contract',
    args: ['imp-host:1'],
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toInclude('pull the new image (docker pull imp-host:1)');
});

test.each([
  ['', 1],
  ['socket-proxy', 0],
])('#check_image_contract answers an image labelled %p with exit %d', (label, exitCode) => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', `echo '${label}'`);

  const result = runSourcedFunction({
    script: new URL('bootstrap.sh', import.meta.url).pathname,
    fn: 'check_image_contract',
    args: ['imp-host:1'],
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(exitCode);
});

test('#check_env_image refuses an env file whose last IMP_HOST_IMAGE is empty, naming the file', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_PORT=7070\nIMP_HOST_IMAGE=\n');

  const result = runSourcedFunction({
    script: new URL('bootstrap.sh', import.meta.url).pathname,
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
])('#check_env_image answers the env file %p with exit %d', (env, exitCode) => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'imp-host.env'), env);

  const result = runSourcedFunction({
    script: new URL('bootstrap.sh', import.meta.url).pathname,
    fn: 'check_env_image',
    args: [join(ctx.dir, 'imp-host.env')],
  });

  expect(result.exitCode).toBe(exitCode);
});

test.each([['unit_imp_host'], ['unit_imp_docker_proxy'], ['env_template']])(
  '#strip_markers takes the release-please markers out of what %s installs',
  (fn) => {
    const script = new URL('bootstrap.sh', import.meta.url).pathname;

    const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const version = z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version;
    const raw = runSourcedFunction({ script, fn }).stdout;
    const installed = runSourcedFunction({ script, fn: 'strip_markers', stdin: raw }).stdout;

    expect(raw).toInclude('x-release-please-start-version');
    expect(installed).not.toInclude('x-release-please');
    expect(installed).toInclude(`ghcr.io/zgeoff/imp-host:${version}`);
  },
);

test.each([
  ['6.10', '6.10', 0],
  ['6.10.1', '6.10', 0],
  ['6.13.0', '6.6.0', 0],
  ['6.9.12', '6.10', 1],
  ['5.15.0', '6.6.0', 1],
])('#version_ge answers whether %s is at least %s with exit %d', (version, least, exitCode) => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'version_ge', args: [version, least] })).toStrictEqual({
    exitCode,
    stdout: '',
    stderr: '',
  });
});

test.each([
  ['100', '30\n'],
  ['220', '33\n'],
])('#loop_reserve_gib keeps the larger of 30 GiB and 15 percent of %s GiB, %p', (freeGib, keep) => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'loop_reserve_gib', args: [freeGib] }).stdout).toBe(keep);
});

test.each([
  ['fd12::1', 'fd12:0:0:0:0:0:0:1\n'],
  ['::', '0:0:0:0:0:0:0:0\n'],
  ['FD12:0034::', 'fd12:34:0:0:0:0:0:0\n'],
  ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8\n'],
])('#ipv6_expand writes the eight groups of %s, %p', (address, groups) => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

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
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(runSourcedFunction({ script, fn: 'ipv6_expand', args: [address] })).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: '',
  });
});

test('#parse_args reads the mode and the flags', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'eval',
      args: [
        'parse_args --dry-run --storage zfs --image imp-host:1 --ksm && echo "$mode $storage $image $image_set $ksm"',
      ],
    }),
  ).toStrictEqual({ exitCode: 0, stdout: 'dry-run zfs imp-host:1 1 on\n', stderr: '' });
});

test('#parse_args refuses more than one mode', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'parse_args', args: ['--yes', '--check'] }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: give one of --yes, --dry-run and --check\n',
  });
});

test('#parse_args refuses an unknown argument', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const result = runSourcedFunction({ script, fn: 'parse_args', args: ['--frobnicate'] });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toEndWith('bootstrap: unknown argument: --frobnicate\n');
});

test('#parse_args refuses a Tailscale key file it cannot read', () => {
  const ctx = setupTest();

  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'parse_args',
      args: ['--tailscale-authkey-file', join(ctx.dir, 'no-key')],
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `bootstrap: --tailscale-authkey-file: cannot read ${join(ctx.dir, 'no-key')}\n`,
  });
});

test('#parse_args reads the Tailscale key from its file without blanks', () => {
  const ctx = setupTest();

  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  writeFileSync(join(ctx.dir, 'key'), ' fake-key-for-tests \n');

  expect(
    runSourcedFunction({
      script,
      fn: 'eval',
      args: [
        `parse_args --yes --tailscale-authkey-file '${join(ctx.dir, 'key')}' && echo "$authkey"`,
      ],
    }).stdout,
  ).toBe('fake-key-for-tests\n');
});

test.each([
  ['--storage zfs', 'give one of --yes, --dry-run and --check'],
  [
    '--yes --data-device /dev/sdb --loop-file /srv/imp.xfs',
    'give --data-device or --loop-file, not both',
  ],
  ['--yes --loop-size 0', '--loop-size must be a whole number of GiB, or auto'],
  ['--yes --storage btrfs', '--storage must be xfs or zfs'],
  ['--yes --host-firewall ufw', '--host-firewall must be own or none'],
  ['--yes --ipv6 maybe', '--ipv6 must be auto, on or off'],
  ['--yes --zfs-pool 1tank', '--zfs-pool must be a pool name: 1tank'],
  ['--yes --ssh-port ssh', '--ssh-port must be a port number: ssh'],
])('#parse_args refuses %p, saying %p', (args, message) => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  const result = runSourcedFunction({ script, fn: 'parse_args', args: args.split(' ') });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toEndWith(`bootstrap: ${message}\n`);
});

// the value an env file gave, set as resolve_* sees it after reading the file
test('#resolve_host_firewall refuses a host firewall other than own or none', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'eval', args: ['host_firewall=ufw; resolve_host_firewall'] }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: /etc/imp/imp-host.env says IMP_HOST_FIREWALL=ufw; want own or none\n',
  });
});

test('#resolve_host_firewall keeps none', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'eval',
      args: ['host_firewall=none; resolve_host_firewall; echo "$host_firewall"'],
    }),
  ).toStrictEqual({ exitCode: 0, stdout: 'bootstrap: host firewall: none\nnone\n', stderr: '' });
});

test('#resolve_ipv6 refuses an IPv6 choice other than on, off or auto', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'eval', args: ['ipv6=maybe; resolve_ipv6'] }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: /etc/imp/imp-host.env says IMP_HOST_IPV6=maybe; want on or off\n',
  });
});

test('#resolve_ipv6 keeps on', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'eval', args: ['ipv6=on; resolve_ipv6; echo "$ipv6"'] }),
  ).toStrictEqual({ exitCode: 0, stdout: 'bootstrap: ipv6: on\non\n', stderr: '' });
});

test('#resolve_storage refuses to switch a zfs host to xfs, naming the env file', () => {
  const ctx = setupTest();

  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_STORAGE_BACKEND=zfs\nIMP_ZFS_ROOT=tank/imp\n');

  expect(
    runSourcedFunction({
      script,
      fn: 'eval',
      args: [`storage=xfs; resolve_storage '${join(ctx.dir, 'imp-host.env')}'`],
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `bootstrap: ${join(ctx.dir, 'imp-host.env')} says IMP_STORAGE_BACKEND=zfs on tank/imp; switching backends would leave every imp behind\n`,
  });
});

test('#resolve_storage refuses a ZFS pool whose dataset is not the env file one', () => {
  const ctx = setupTest();

  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_STORAGE_BACKEND=zfs\nIMP_ZFS_ROOT=tank/imp\n');

  expect(
    runSourcedFunction({
      script,
      fn: 'eval',
      args: [`zfs_pool=other; resolve_storage '${join(ctx.dir, 'imp-host.env')}'`],
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: 'bootstrap: storage: zfs\n',
    stderr: `bootstrap: ${join(ctx.dir, 'imp-host.env')} says IMP_ZFS_ROOT=tank/imp, not other/imp\n`,
  });
});

test('#resolve_storage refuses --loop-file with zfs', () => {
  const ctx = setupTest();

  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({
      script,
      fn: 'eval',
      args: [`storage=zfs; loop_file=/srv/imp.xfs; resolve_storage '${join(ctx.dir, 'no-env')}'`],
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: 'bootstrap: storage: zfs\n',
    stderr: 'bootstrap: --loop-file is XFS only; ZFS needs --data-device or an existing pool\n',
  });
});

test('#resolve_subnet6 refuses an env file IMP_HOST_SUBNET6 that is no IPv6 /64', () => {
  const ctx = setupTest();

  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_HOST_SUBNET6=fd12::/56\n');

  expect(
    runSourcedFunction({
      script,
      fn: 'resolve_subnet6',
      args: ['', join(ctx.dir, 'imp-host.env')],
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `bootstrap: ${join(ctx.dir, 'imp-host.env')} says IMP_HOST_SUBNET6=fd12::/56; want an IPv6 /64\n`,
  });
});

test('#resolve_subnet6 takes the env file IMP_HOST_SUBNET6 as Docker prints it', () => {
  const ctx = setupTest();

  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_HOST_SUBNET6=FD12:0:0:1::/64\n');

  expect(
    runSourcedFunction({
      script,
      fn: 'eval',
      args: [`resolve_subnet6 '' '${join(ctx.dir, 'imp-host.env')}'; echo "$ipv6_subnet"`],
    }).stdout,
  ).toBe('fd12:0:0:1::/64\n');
});

test('#preflight refuses to run as a user other than root', () => {
  const ctx = setupTest();
  const id = createStubBin(ctx.dir, 'id', 'echo 1000');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'preflight',
      env: { PATH: `${id.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '== preflight\n',
    stderr: 'bootstrap: run as root\n',
  });
});

test('#check_platform refuses a WSL kernel outside a container', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'osrelease'), '6.6.87.2-microsoft-standard-WSL2\n');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_platform',
      args: [join(ctx.dir, 'osrelease')],
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: refusing to run on WSL; this script is for a bare-metal server\n',
  });
});

test('#check_platform refuses an OS other than Ubuntu 24.04 or 26.04 or Debian 13, naming it', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'osrelease'), '6.8.0-85-generic\n');

  writeFileSync(
    join(ctx.dir, 'os-release'),
    'ID=fedora\nVERSION_ID=41\nPRETTY_NAME="Fedora Linux 41"\n',
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_platform',
      args: [join(ctx.dir, 'osrelease'), join(ctx.dir, 'os-release')],
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: unsupported OS Fedora Linux 41; use Ubuntu 24.04 or 26.04, or Debian 13\n',
  });
});

test('#check_platform refuses a machine other than x86_64', () => {
  const ctx = setupTest();
  const uname = createStubBin(ctx.dir, 'uname', 'echo aarch64');

  writeFileSync(join(ctx.dir, 'osrelease'), '6.8.0-85-generic\n');

  writeFileSync(
    join(ctx.dir, 'os-release'),
    'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n',
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_platform',
      args: [join(ctx.dir, 'osrelease'), join(ctx.dir, 'os-release')],
      env: { PATH: `${uname.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: 'bootstrap: OS: Ubuntu 24.04.3 LTS\n',
    stderr: 'bootstrap: the host image is x86_64 only\n',
  });
});

test('#check_platform refuses a host without the KVM device, naming it', () => {
  const ctx = setupTest();
  const uname = createStubBin(ctx.dir, 'uname', 'echo x86_64');

  writeFileSync(join(ctx.dir, 'osrelease'), '6.8.0-85-generic\n');

  writeFileSync(
    join(ctx.dir, 'os-release'),
    'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n',
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_platform',
      args: [join(ctx.dir, 'osrelease'), join(ctx.dir, 'os-release'), join(ctx.dir, 'kvm')],
      env: { PATH: `${uname.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: 'bootstrap: OS: Ubuntu 24.04.3 LTS\n',
    stderr: `bootstrap: ${join(ctx.dir, 'kvm')} is missing; enable VT-x/AMD-V in the firmware\n`,
  });
});

// /dev/null stands in for /dev/kvm: the check wants a character device
test('#check_platform refuses a CPU that reports neither vmx nor svm', () => {
  const ctx = setupTest();
  const uname = createStubBin(ctx.dir, 'uname', 'echo x86_64');

  writeFileSync(join(ctx.dir, 'osrelease'), '6.8.0-85-generic\n');

  writeFileSync(
    join(ctx.dir, 'os-release'),
    'ID=debian\nVERSION_ID="13"\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n',
  );

  writeFileSync(join(ctx.dir, 'cpuinfo'), 'flags\t\t: fpu vme sse2 hypervisor\n');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_platform',
      args: [
        join(ctx.dir, 'osrelease'),
        join(ctx.dir, 'os-release'),
        '/dev/null',
        join(ctx.dir, 'cpuinfo'),
      ],
      env: { PATH: `${uname.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: 'bootstrap: OS: Debian GNU/Linux 13 (trixie)\n',
    stderr: 'bootstrap: the CPU reports neither vmx nor svm\n',
  });
});

test('#check_platform accepts Debian 13 on x86_64 with KVM and vmx', () => {
  const ctx = setupTest();
  const uname = createStubBin(ctx.dir, 'uname', 'echo x86_64');

  writeFileSync(join(ctx.dir, 'osrelease'), '6.12.48+deb13-amd64\n');

  writeFileSync(
    join(ctx.dir, 'os-release'),
    'ID=debian\nVERSION_ID="13"\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n',
  );

  writeFileSync(join(ctx.dir, 'cpuinfo'), 'flags\t\t: fpu vme vmx sse2\n');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_platform',
      args: [
        join(ctx.dir, 'osrelease'),
        join(ctx.dir, 'os-release'),
        '/dev/null',
        join(ctx.dir, 'cpuinfo'),
      ],
      env: { PATH: `${uname.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 0,
    stdout: 'bootstrap: OS: Debian GNU/Linux 13 (trixie)\n',
    stderr: '',
  });
});

test('#check_data_source refuses XFS with no device, no loop file and nothing mounted', () => {
  const ctx = setupTest();
  const mountpoint = createStubBin(ctx.dir, 'mountpoint', 'exit 1');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['storage=xfs; check_data_source'],
      env: { PATH: `${mountpoint.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: /var/lib/imp is not mounted; give --data-device DEV or --loop-file PATH\n',
  });
});

test('#resolve_storage refuses zfs where /var/lib/imp is a mount on the host', () => {
  const ctx = setupTest();
  const mountpoint = createStubBin(ctx.dir, 'mountpoint', 'exit 0');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: [`storage=zfs; resolve_storage '${join(ctx.dir, 'no-env')}'`],
      env: { PATH: `${mountpoint.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: 'bootstrap: storage: zfs\n',
    stderr:
      'bootstrap: /var/lib/imp is a mount on the host; with ZFS the container mounts tank/imp there itself\n',
  });
});

test('#apt_install refuses a failed install with the tail of the log and where the log is', () => {
  const ctx = setupTest();

  const aptGet = createStubBin(
    ctx.dir,
    'apt-get',
    "echo 'E: Unable to locate package nope'; exit 100",
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'apt_install',
      args: [join(ctx.dir, 'apt.log'), 'nope'],
      env: { PATH: `${aptGet.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `E: Unable to locate package nope\nbootstrap: apt-get install nope failed; the whole log is in ${join(ctx.dir, 'apt.log')}\n`,
  });
});

test("#check_docker_key refuses a key file that holds another key than Docker's", () => {
  const ctx = setupTest();

  const gpg = createStubBin(
    ctx.dir,
    'gpg',
    String.raw`printf '%s\n' 'pub:-:4096:1:7EA0A9C3F273FCD8:1487788586:::-:::scESA:::::::23::0:' 'fpr:::::::::1111222233334444555566667777888899990000:'`,
  );

  writeFileSync(join(ctx.dir, 'docker.asc'), 'not the key\n');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_docker_key',
      args: [join(ctx.dir, 'docker.asc')],
      env: { PATH: `${gpg.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `bootstrap: ${join(ctx.dir, 'docker.asc')} is not Docker's apt key (want 9DC858229FC7DD38854AE2D88D81803C0EBFCD88, got 1111222233334444555566667777888899990000)\n`,
  });
});

test('#check_xfs_reflink refuses a mount on /var/lib/imp that is not XFS', () => {
  const ctx = setupTest();
  const findmnt = createStubBin(ctx.dir, 'findmnt', 'echo ext4');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_xfs_reflink',
      env: { PATH: `${findmnt.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: /var/lib/imp is mounted but not XFS; imp needs XFS with reflink\n',
  });
});

test('#check_xfs_reflink refuses an XFS on /var/lib/imp without reflink', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'findmnt', 'echo xfs');

  const xfsInfo = createStubBin(
    ctx.dir,
    'xfs_info',
    "echo 'meta-data=/dev/vdb isize=512 agcount=4, crc=1 finobt=1, sparse=1, rmapbt=0, reflink=0'",
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_xfs_reflink',
      env: { PATH: `${xfsInfo.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'bootstrap: /var/lib/imp is XFS without reflink; recreate it with mkfs.xfs -m reflink=1\n',
  });
});

test('#check_device_free refuses a path that is not a block device', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/imp-test-sda2', disk: '/dev/imp-test-sda' },
    devices: {},
  });

  const stat = createStubBin(ctx.dir, 'stat', scripts.stat);

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_device_free',
      args: ['/dev/imp-test-vdb'],
      env: { PATH: `${stat.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: /dev/imp-test-vdb is not a block device\n',
  });
});

test('#check_device_free refuses the disk that holds the root filesystem', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/imp-test-sda2', disk: '/dev/imp-test-sda' },
    devices: {},
  });

  createStubBin(ctx.dir, 'stat', scripts.stat);
  createStubBin(ctx.dir, 'findmnt', scripts.findmnt);

  const lsblk = createStubBin(ctx.dir, 'lsblk', scripts.lsblk);

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_device_free',
      args: ['/dev/imp-test-sda'],
      env: { PATH: `${lsblk.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: /dev/imp-test-sda holds the root filesystem\n',
  });
});

test('#check_device_free refuses a device with partitions', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/imp-test-sda2', disk: '/dev/imp-test-sda' },
    devices: { '/dev/imp-test-vdb': { partitions: ['/dev/imp-test-vdb1'] } },
  });

  createStubBin(ctx.dir, 'stat', scripts.stat);
  createStubBin(ctx.dir, 'findmnt', scripts.findmnt);

  const lsblk = createStubBin(ctx.dir, 'lsblk', scripts.lsblk);

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_device_free',
      args: ['/dev/imp-test-vdb'],
      env: { PATH: `${lsblk.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'bootstrap: /dev/imp-test-vdb has partitions or holders (RAID, LVM); give an empty disk or partition\n',
  });
});

test('#prepare_device refuses a device that carries a signature but no filesystem', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/imp-test-sda2', disk: '/dev/imp-test-sda' },
    devices: { '/dev/imp-test-vdb': { signature: true } },
  });

  createStubBin(ctx.dir, 'stat', scripts.stat);
  createStubBin(ctx.dir, 'findmnt', scripts.findmnt);
  createStubBin(ctx.dir, 'lsblk', scripts.lsblk);

  const blkid = createStubBin(ctx.dir, 'blkid', scripts.blkid);

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'prepare_device',
      args: ['/dev/imp-test-vdb'],
      env: { PATH: `${blkid.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'bootstrap: /dev/imp-test-vdb carries a signature (a partition table?); wipe it by hand if it is free\n',
  });
});

test('#storage_zfs refuses a device that belongs to another ZFS pool', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/imp-test-sda2', disk: '/dev/imp-test-sda' },
    devices: { '/dev/imp-test-vdb': { type: 'zfs_member', label: 'other' } },
  });

  createStubBin(ctx.dir, 'stat', scripts.stat);
  createStubBin(ctx.dir, 'findmnt', scripts.findmnt);
  createStubBin(ctx.dir, 'lsblk', scripts.lsblk);
  createStubBin(ctx.dir, 'blkid', scripts.blkid);

  const zpool = createStubBin(ctx.dir, 'zpool', 'exit 1');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['zfs_pool=tank; data_device=/dev/imp-test-vdb; storage_zfs'],
      env: { PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: /dev/imp-test-vdb belongs to another ZFS pool\n',
  });
});

test('#storage_zfs refuses a device that carries a signature but no filesystem', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/imp-test-sda2', disk: '/dev/imp-test-sda' },
    devices: { '/dev/imp-test-vdb': { signature: true } },
  });

  createStubBin(ctx.dir, 'stat', scripts.stat);
  createStubBin(ctx.dir, 'findmnt', scripts.findmnt);
  createStubBin(ctx.dir, 'lsblk', scripts.lsblk);
  createStubBin(ctx.dir, 'blkid', scripts.blkid);

  const zpool = createStubBin(ctx.dir, 'zpool', 'exit 1');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['zfs_pool=tank; data_device=/dev/imp-test-vdb; storage_zfs'],
      env: { PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'bootstrap: /dev/imp-test-vdb carries a signature (a partition table?); wipe it by hand if it is free\n',
  });
});

test('#storage_zfs refuses a device that holds a filesystem, naming it', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/imp-test-sda2', disk: '/dev/imp-test-sda' },
    devices: { '/dev/imp-test-vdb': { type: 'ext4' } },
  });

  createStubBin(ctx.dir, 'stat', scripts.stat);
  createStubBin(ctx.dir, 'findmnt', scripts.findmnt);
  createStubBin(ctx.dir, 'lsblk', scripts.lsblk);
  createStubBin(ctx.dir, 'blkid', scripts.blkid);

  const zpool = createStubBin(ctx.dir, 'zpool', 'exit 1');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['zfs_pool=tank; data_device=/dev/imp-test-vdb; storage_zfs'],
      env: { PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: /dev/imp-test-vdb holds ext4; give an empty disk or partition\n',
  });
});

test('#storage_zfs refuses a pool that is not there without a device to create it on', () => {
  const ctx = setupTest();
  const zpool = createStubBin(ctx.dir, 'zpool', 'exit 1');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['zfs_pool=tank; storage_zfs'],
      env: { PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: no pool tank; give --data-device DEV to create it\n',
  });
});

test('#prepare_loop_file refuses a loop file off the root filesystem', () => {
  const ctx = setupTest();
  const findmnt = createStubBin(ctx.dir, 'findmnt', 'echo /srv');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['loop_file=/srv/imp/imp.xfs; prepare_loop_file'],
      env: { PATH: `${findmnt.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'bootstrap: --loop-file must be on the root filesystem, which mounts before /var/lib/imp\n',
  });
});

test('#prepare_loop_file refuses an existing loop file that holds no XFS', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'findmnt', 'echo /');

  const blkid = createStubBin(ctx.dir, 'blkid', 'exit 2');

  writeFileSync(join(ctx.dir, 'imp.xfs'), 'not a filesystem\n');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: [`loop_file='${join(ctx.dir, 'imp.xfs')}'; prepare_loop_file`],
      env: { PATH: `${blkid.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `bootstrap: ${join(ctx.dir, 'imp.xfs')} exists and is not XFS\n`,
  });
});

// df prints 100 GiB free on /, in KiB
test('#prepare_loop_file refuses a loop size below 20 GiB, naming the free space', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'findmnt', 'echo /');

  const df = createStubBin(ctx.dir, 'df', String.raw`printf '%s\n' Avail 104857600`);

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: [`loop_file='${join(ctx.dir, 'imp.xfs')}'; loop_size_gib=15; prepare_loop_file`],
      env: { PATH: `${df.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: a 15 GiB loop file is too small (100 GiB free on /); imp needs 20\n',
  });
});

test('#ensure_fstab refuses an fstab with another entry for /var/lib/imp', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fstab'), 'UUID=abc /var/lib/imp ext4 defaults 0 2\n');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'ensure_fstab',
      args: ['UUID=def /var/lib/imp xfs defaults,nosuid,nofail 0 2', join(ctx.dir, 'fstab')],
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `bootstrap: ${join(ctx.dir, 'fstab')} has another entry for /var/lib/imp; fix or remove it first\n`,
  });
});

test('#ensure_ksm refuses --ksm in a container', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'eval', args: ['ksm=on; in_container=1; ensure_ksm'] }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '== ksm\n',
    stderr: "bootstrap: --ksm cannot run in a container: KSM is global to the host's kernel\n",
  });
});

test('#ensure_ksm refuses --ksm on a kernel older than 6.10, naming it', () => {
  const ctx = setupTest();
  const uname = createStubBin(ctx.dir, 'uname', 'echo 6.6.87');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['ksm=on; ensure_ksm'],
      env: { PATH: `${uname.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '== ksm\n',
    stderr: 'bootstrap: --ksm needs Linux 6.10 or later; this host runs 6.6.87\n',
  });
});

test('#ensure_ksm refuses --ksm on a kernel without KSM in sysfs', () => {
  const ctx = setupTest();
  const uname = createStubBin(ctx.dir, 'uname', 'echo 6.12.48');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: [`ksm=on; ensure_ksm '${join(ctx.dir, 'ksm')}'`],
      env: { PATH: `${uname.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '== ksm\n',
    stderr: 'bootstrap: --ksm needs a kernel built with CONFIG_KSM\n',
  });
});

test('#ensure_firewall refuses its own firewall while nftables.service is enabled', () => {
  const ctx = setupTest();
  const systemctl = createStubBin(ctx.dir, 'systemctl', 'exit 0');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['host_firewall=own; ensure_firewall'],
      env: { PATH: `${systemctl.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '== firewall\n',
    stderr:
      "bootstrap: nftables.service is enabled; its /etc/nftables.conf flushes every ruleset (Docker's too). Disable it first\n",
  });
});

test('#ensure_firewall refuses a host where it finds no SSH port', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'systemctl', 'exit 1');
  createStubBin(ctx.dir, 'ufw', "echo 'Status: inactive'");
  createStubBin(ctx.dir, 'sshd', 'exit 1');

  const ss = createStubBin(ctx.dir, 'ss');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['host_firewall=own; ensure_firewall'],
      env: { PATH: `${ss.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '== firewall\n',
    stderr: 'bootstrap: found no SSH port; give --ssh-port\n',
  });
});

test('#ensure_firewall refuses a sudo run that dropped SSH_CONNECTION', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'systemctl', 'exit 1');
  createStubBin(ctx.dir, 'ufw', "echo 'Status: inactive'");
  createStubBin(ctx.dir, 'sshd', "echo 'port 22'");

  const ss = createStubBin(ctx.dir, 'ss');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['host_firewall=own; SUDO_USER=ops; ensure_firewall'],
      env: { PATH: `${ss.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '== firewall\n',
    stderr:
      "bootstrap: run as root, or with sudo --preserve-env=SSH_CONNECTION, so the firewall phase can check this SSH session's port\n",
  });
});

test('#ensure_firewall refuses an SSH session on a port sshd does not report, naming it', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'systemctl', 'exit 1');
  createStubBin(ctx.dir, 'ufw', "echo 'Status: inactive'");
  createStubBin(ctx.dir, 'sshd', "echo 'port 22'");

  const ss = createStubBin(ctx.dir, 'ss');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ["host_firewall=own; SSH_CONNECTION='10.0.0.2 50000 10.0.0.1 2222'; ensure_firewall"],
      env: { PATH: `${ss.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '== firewall\n',
    stderr:
      'bootstrap: this SSH session uses port 2222, which sshd does not report; give --ssh-port 2222\n',
  });
});

test('#check_ruleset refuses a run that makes changes without nft', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'bin'));
  createCommandLinks({ bin: join(ctx.dir, 'bin'), names: ['bash'] });

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ["mode=yes; check_ruleset 'table inet imp_host {}'"],
      env: { PATH: join(ctx.dir, 'bin') },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: nft is missing\n',
  });
});

test('#check_ruleset refuses a ruleset nft rejects', () => {
  const ctx = setupTest();
  const nft = createStubBin(ctx.dir, 'nft', "echo 'Error: syntax error' >&2; exit 1");

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ["mode=yes; check_ruleset 'table inet imp_host {'"],
      env: { PATH: `${nft.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'Error: syntax error\nbootstrap: nft rejects the firewall ruleset; nothing was loaded\n',
  });
});

// /etc/docker/daemon.json and /etc/imp/imp-host.env are the host's: neither may turn ip6tables
// off or name a subnet
test('#ensure_ipv6 refuses to recreate a network that differs while other containers use it', () => {
  const ctx = setupTest();

  createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({
      serverVersion: '27.3.1',
      hostNetwork: 'true unnamed 172.18.0.0/16 fd12::/64',
      networkContainers: ['imp-host', 'web'],
    }),
  );

  const ip = createStubBin(ctx.dir, 'ip');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['ipv6=on; ensure_ipv6'],
      env: { PATH: `${ip.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '== ipv6\nbootstrap: router adverts: the host has no IPv6 default route\n',
    stderr:
      'bootstrap: the imp-host network differs (its bridge is unnamed, not br-imphost), and web use it; move them off it, then run again\n',
  });
});

test('#check_docker_ipv6 refuses a Docker daemon whose version it cannot read', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubBootstrapDocker({}));

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_docker_ipv6',
      args: [join(ctx.dir, 'daemon.json')],
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "bootstrap: cannot read the Docker daemon's version\n",
  });
});

test('#check_docker_ipv6 refuses IPv6 on with a Docker older than 27.0, naming it', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({ serverVersion: '26.1.4' }),
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_docker_ipv6',
      args: [join(ctx.dir, 'daemon.json')],
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'bootstrap: Docker 26.1.4 predates 27.0, which writes IPv6 NAT and forward rules by default; fix that, or give --ipv6 off\n',
  });
});

test('#check_docker_ipv6 refuses IPv6 on with ip6tables off in the daemon config, naming it', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({ serverVersion: '27.3.1' }),
  );

  writeFileSync(join(ctx.dir, 'daemon.json'), '{"ip6tables": false}\n');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_docker_ipv6',
      args: [join(ctx.dir, 'daemon.json')],
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `bootstrap: ${join(ctx.dir, 'daemon.json')} sets ip6tables to false, so imp-host's network would have no NAT66; fix that, or give --ipv6 off\n`,
  });
});

// /etc/sysctl.d/90-imp-ipv6.conf is the host's, which bootstrap.sh never ran on
test('#remove_ipv6 refuses to remove the network while other containers use it', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({
      hostNetwork: 'true br-imphost 172.18.0.0/16 fd12::/64',
      networkContainers: ['imp-host', 'web'],
    }),
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['ipv6_set=1; remove_ipv6'],
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: web use the imp-host network; move them off it, then run again\n',
  });
});

test('#read_seccomp refuses an image without the seccomp profile', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({ images: ['imp-host:1'] }),
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'read_seccomp',
      args: ['imp-host:1'],
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'cat: /usr/local/share/imp/deploy/imp-host.seccomp.json: No such file or directory\n' +
      'bootstrap: imp-host:1 has no /usr/local/share/imp/deploy/imp-host.seccomp.json; it predates the unprivileged host\n',
  });
});

test('#read_seccomp prints the seccomp profile of an image that carries one', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({ images: ['imp-host:1'], seccompImages: ['imp-host:1'] }),
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'read_seccomp',
      args: ['imp-host:1'],
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({ exitCode: 0, stdout: '{}\n', stderr: '' });
});

test('#ensure_image refuses an image archive it cannot read', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubBootstrapDocker({}));

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: [`image_archive='${join(ctx.dir, 'imp-host.tar')}'; ensure_image imp-host:1`],
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `bootstrap: cannot read ${join(ctx.dir, 'imp-host.tar')}\n`,
  });
});

test('#load_image refuses an archive that does not hold the image', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubBootstrapDocker({}));

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['image_archive=/srv/imp-host.tar; load_image imp-host:1'],
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: /srv/imp-host.tar does not hold imp-host:1\n',
  });
});

test('#health refuses imp-host publishing a port beyond loopback', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({ impInfo: 'imp 0.40.4', published: '7070/tcp -> 0.0.0.0:7070' }),
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'health',
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '== health\nimp 0.40.4\n',
    stderr: 'bootstrap: imp-host publishes a port beyond loopback: 7070/tcp -> 0.0.0.0:7070\n',
  });
});

test('#check_storage_live refuses impd on another storage backend than the bootstrap set up', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({ impInfo: '{"storage":{"backend":"xfs"}}' }),
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['storage=zfs; check_storage_live'],
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "bootstrap: impd reports storage backend 'xfs', not zfs\n",
  });
});

test('#check_storage_live refuses a ZFS pool that is not ONLINE', () => {
  const ctx = setupTest();

  createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({ impInfo: '{"storage":{"backend":"zfs"}}' }),
  );

  const zpool = createStubBin(ctx.dir, 'zpool', 'echo DEGRADED');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['storage=zfs; zfs_pool=tank; zfs_root=tank/imp; check_storage_live'],
      env: { PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: pool tank is not ONLINE\n',
  });
});

test('#check_storage_live refuses a container with another dataset on /var/lib/imp', () => {
  const ctx = setupTest();

  createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({
      impInfo: '{"storage":{"backend":"zfs"}}',
      dataMount: 'tank/other zfs',
    }),
  );

  const zpool = createStubBin(ctx.dir, 'zpool', 'echo ONLINE');

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['storage=zfs; zfs_pool=tank; zfs_root=tank/imp; check_storage_live'],
      env: { PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "bootstrap: the container has 'tank/other zfs' on /var/lib/imp, not tank/imp\n",
  });
});

test('#check_ipv6_live refuses imp-host without an IPv6 default route', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubBootstrapDocker({}));

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_ipv6_live',
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: imp-host has no IPv6 default route on the imp-host network\n',
  });
});

test('#check_ipv6_live refuses an impd that logs IPv6 off, quoting its line', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({
      ipv6Route: 'default via fd12::1 dev eth0 metric 1024',
      logs: 'impd: ipv6: off (no default route)',
    }),
  );

  expect(
    runSourcedFunction({
      script: new URL('bootstrap.sh', import.meta.url).pathname,
      fn: 'check_ipv6_live',
      env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: IPv6 is on, but impd: ipv6: off (no default route)\n',
  });
});

// one second is one try, with no sleep after it
test('#wait_for gives up once its seconds pass without the command succeeding', () => {
  const script = new URL('bootstrap.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'wait_for', args: ['the ubuntu image', '1', 'false'] }),
  ).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'bootstrap: gave up waiting 1 s for the ubuntu image; see journalctl -u imp-host\n',
  });
});
