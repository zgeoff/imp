import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';
import { readEnvValues } from '../../scripts/test-utils/read-env-values';

// The NixOS module's env writer, run with bash as the module runs it, with a stub ip for the
// host's addresses. `nix flake check` covers the rest (deploy/nixos/tests).
function setupTest() {
  using stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'imp-host-env-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const owned = stack.move();

  return {
    dir,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it sizes a zfs host as bootstrap.sh does, and sets the ARC cap it leaves out', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '',
        IMP_SECRETS: '',
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  const env = readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8');

  expect(result.exitCode).toBe(0);
  expect(readEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toStrictEqual(['48000']);
  expect(readFileSync(join(ctx.dir, 'zfs_arc_max'), 'utf8')).toBe('6710886400\n');
});

test('it writes the module settings into an env file only its owner reads', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '',
        IMP_SECRETS: '',
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  const env = readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8');

  expect(result.exitCode).toBe(0);
  expect(readEnvValues(env, 'IMP_HOST_FIREWALL')).toStrictEqual(['none']);
  expect(statSync(join(ctx.dir, 'imp-host.env')).mode & 0o777).toBe(0o600);
});

test('it keeps an ARC cap already set, and leaves it out of the budget', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '2147483648\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '',
        IMP_SECRETS: '',
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  const env = readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8');

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.dir, 'zfs_arc_max'), 'utf8')).toBe('2147483648\n');
  expect(readEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toStrictEqual(['52352']);
  expect(result.stdout.toString()).toInclude('keeping the ZFS ARC cap already set, 2048 MiB');
});

test('it sets arcMaxMiB over an ARC cap already set', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '2147483648\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '4096',
        IMP_SECRETS: '',
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  const env = readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8');

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.dir, 'zfs_arc_max'), 'utf8')).toBe('4294967296\n');
  expect(readEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toStrictEqual(['50304']);
});

test('it sets no ARC cap on an xfs host, and leaves none out of the budget', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'xfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '',
        IMP_SECRETS: '',
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  const env = readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8');

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.dir, 'zfs_arc_max'), 'utf8')).toBe('0\n');
  expect(readEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toStrictEqual(['54400']);
});

test('it writes a set ramBudgetMiB over the formula', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '20000',
        IMP_ARC_MAX: '',
        IMP_SECRETS: '',
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  const env = readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8');

  expect(result.exitCode).toBe(0);
  expect(readEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toStrictEqual(['20000']);
});

test('it refuses a small host whose budget comes out below the floor, writing nothing', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(3 * 1024 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '1024',
        IMP_SECRETS: '',
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  expect(result.exitCode).toBe(1);
  expect(existsSync(join(ctx.dir, 'imp-host.env'))).toBeFalse();

  expect(result.stderr.toString()).toIncludeMultiple([
    'below the 512 MiB floor: RAM 3072 MiB',
    'Set services.imp.ramBudgetMiB',
    'imp-host-env: refusing to start imp-host',
  ]);
});

test('it starts a small host whose ramBudgetMiB is set', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(3 * 1024 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '1024',
        IMP_ARC_MAX: '1024',
        IMP_SECRETS: '',
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  const env = readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8');

  expect(result.exitCode).toBe(0);
  expect(readEnvValues(env, 'IMP_RAM_BUDGET_MIB')).toStrictEqual(['1024']);
});

test('it copies the secrets file in, where a later line replaces an earlier one', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');

  writeFileSync(
    join(ctx.dir, 'secrets'),
    'IMP_DNS_API_TOKEN=fake-token\nIMP_TAILSCALE_HOSTNAME=imp-other\nIMP_RAM_BUDGET_MIB=1\n',
  );

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '',
        IMP_SECRETS: join(ctx.dir, 'secrets'),
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8')).toBe(
    '# Written by imp-host-env.sh (the NixOS module) at each start; edits are lost.\n' +
      'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n' +
      'IMP_DNS_API_TOKEN=fake-token\nIMP_TAILSCALE_HOSTNAME=imp-other\n' +
      'IMP_RAM_BUDGET_MIB=48000\nIMP_HOST_ADDRESSES=\n',
  );
});

test('it refuses a secrets file it cannot read, writing nothing', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '',
        IMP_SECRETS: join(ctx.dir, 'no-secrets'),
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  expect(result.exitCode).toBe(1);
  expect(existsSync(join(ctx.dir, 'imp-host.env'))).toBeFalse();

  expect(result.stderr.toString()).toBe(
    `imp-host-env: cannot read ${join(ctx.dir, 'no-secrets')}\n`,
  );
});

test('it names the backup password file, never the password, when one is staged', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');
  writeFileSync(join(ctx.dir, 'secrets'), 'IMP_BACKUP_REPOSITORY=s3:https://example.invalid/imp\n');
  writeFileSync(join(ctx.dir, 'backup-password'), 'fake-password\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '',
        IMP_SECRETS: join(ctx.dir, 'secrets'),
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: join(ctx.dir, 'backup-password'),
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  const env = readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8');

  expect(result.exitCode).toBe(0);

  expect(readEnvValues(env, 'IMP_BACKUP_PASSWORD_FILE')).toStrictEqual([
    '/run/imp/backup-password',
  ]);

  expect(readEnvValues(env, 'IMP_BACKUP_REPOSITORY')).toStrictEqual([
    's3:https://example.invalid/imp',
  ]);

  expect(env).not.toInclude('fake-password');
});

test('it keeps backups off when the staged backup password is empty', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');
  writeFileSync(join(ctx.dir, 'secrets'), 'IMP_BACKUP_REPOSITORY=s3:https://example.invalid/imp\n');
  writeFileSync(join(ctx.dir, 'backup-password'), '');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '',
        IMP_SECRETS: join(ctx.dir, 'secrets'),
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: join(ctx.dir, 'backup-password'),
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  const env = readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8');

  expect(result.exitCode).toBe(0);
  expect(readEnvValues(env, 'IMP_BACKUP_REPOSITORY')).toStrictEqual(['']);
  expect(readEnvValues(env, 'IMP_BACKUP_PASSWORD_FILE')).toStrictEqual([]);
  expect(result.stderr.toString()).toInclude('backups stay off');
});

test("it writes the host's own global addresses last, over the secrets file's", () => {
  using ctx = setupTest();

  const ip = createStubBin(
    ctx.dir,
    'ip',
    `cat <<'EOF'
2: eth0    inet 203.0.113.7/24 brd 203.0.113.255 scope global eth0\\       valid_lft forever
2: eth0    inet6 2001:db8::7/64 scope global \\       valid_lft forever
EOF`,
  );

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');
  writeFileSync(join(ctx.dir, 'secrets'), 'IMP_HOST_ADDRESSES=10.9.9.9\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '',
        IMP_SECRETS: join(ctx.dir, 'secrets'),
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  const env = readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8');

  expect(result.exitCode).toBe(0);
  expect(readEnvValues(env, 'IMP_HOST_ADDRESSES')).toStrictEqual(['203.0.113.7/24,2001:db8::7/64']);
  expect(readFileSync(ip.calls, 'utf8')).toBe('ip -o addr show scope global\n');
});

test('it leaves the host addresses empty, with a warning, when ip fails', () => {
  using ctx = setupTest();

  const ip = createStubBin(ctx.dir, 'ip', 'exit 1');

  writeFileSync(join(ctx.dir, 'settings'), 'IMP_HOST_FIREWALL=none\nIMP_STORAGE_BACKEND=zfs\n');
  writeFileSync(join(ctx.dir, 'meminfo'), `MemTotal: ${String(64_000 * 1024)} kB\n`);
  writeFileSync(join(ctx.dir, 'zfs_arc_max'), '0\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('imp-host-env.sh', import.meta.url).pathname,
      new URL('../bootstrap.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${ip.bin}:${process.env['PATH'] ?? ''}`,
        IMP_SETTINGS: join(ctx.dir, 'settings'),
        IMP_STORAGE: 'zfs',
        IMP_RAM_BUDGET: '',
        IMP_ARC_MAX: '',
        IMP_SECRETS: '',
        IMP_ENV_OUT: join(ctx.dir, 'imp-host.env'),
        IMP_MEMINFO: join(ctx.dir, 'meminfo'),
        IMP_ARC_PARAM: join(ctx.dir, 'zfs_arc_max'),
        IMP_BACKUP_STAGED: '',
        IMP_BACKUP_IN_CONTAINER: '/run/imp/backup-password',
      },
    },
  );

  const env = readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8');

  expect(result.exitCode).toBe(0);
  expect(readEnvValues(env, 'IMP_HOST_ADDRESSES')).toStrictEqual(['']);
  expect(result.stderr.toString()).toInclude("cannot read the host's addresses");
});
