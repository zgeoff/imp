import { expect, test } from 'bun:test';
import { loadConfig } from './config';

test('it fills every setting from its default when the env is empty', () => {
  const config = loadConfig({});

  expect(config).toEqual({
    dataDir: '/var/lib/imp',
    apiPort: 7070,
    proxyPort: 7080,
    portBase: 20_000,
    sshPort: 22,
    sshAuthorizedKeys: true,
    brokerPort: 7081,
    egressDnsPort: 7053,
    brokerTestUpstreams: null,
    ramBudgetMib: 16_384,
    idleTimeoutS: 60,
    idleCpuPercent: 10,
    bootReservePercent: 50,
    wakeReserveMib: 256,
    sleepMinGuestUptimeMs: 1500,
    defaultVcpus: 2,
    defaultMemoryMib: 2048,
    defaultDiskBytes: 32 * 1024 ** 3,
    diskReserveBytes: null,
    dns: ['1.1.1.1', '8.8.8.8'],
    subnet: { network: 0x0a_42_00_00, prefixLength: 16 },
    firecrackerBin: 'firecracker',
    kernelPath: '/var/lib/imp/system/vmlinux',
    kernelSource: null,
    systemDriveSource: '/var/lib/imp/system/imp-system.squashfs',
    defaultImage: 'base',
    storageBackend: 'xfs',
    zfsRoot: null,
    tailscaleAuthKey: null,
    tailscaleHostname: 'imp',
    tailnetRules: null,
    dashboardDir: null,
    backup: null,
    https: null,
  });
});

test('it reads and coerces values from the env', () => {
  const config = loadConfig({
    IMP_DATA_DIR: '/tmp/imp',
    IMP_API_PORT: '9000',
    IMP_DNS: '9.9.9.9 , 1.0.0.1',
    IMP_SUBNET: '10.99.0.0/24',
    IMP_KERNEL: '/src/kernel/out/vmlinux',
    IMP_SLEEP_MIN_GUEST_UPTIME_MS: '0',
    TAILSCALE_AUTHKEY: 'tskey-auth-test',
  });

  expect(config.dataDir).toBe('/tmp/imp');
  expect(config.apiPort).toBe(9000);
  expect(config.dns).toEqual(['9.9.9.9', '1.0.0.1']);
  expect(config.subnet.prefixLength).toBe(24);
  expect(config.kernelPath).toBe('/tmp/imp/system/vmlinux');
  expect(config.kernelSource).toBe('/src/kernel/out/vmlinux');
  expect(config.tailscaleAuthKey).toBe('tskey-auth-test');
  expect(config.sleepMinGuestUptimeMs).toBe(0);
});

test('it treats an empty variable as unset', () => {
  expect(loadConfig({ TAILSCALE_AUTHKEY: '', IMP_API_PORT: '' }).tailscaleAuthKey).toBeNull();
});

test('it rejects invalid values', () => {
  expect(() => loadConfig({ IMP_API_PORT: 'http' })).toThrow();
  expect(() => loadConfig({ IMP_DNS: 'one.one.one.one' })).toThrow();
  expect(() => loadConfig({ IMP_SUBNET: '10.66.0.0' })).toThrow();
});

test('IMP_SSH_PORT=0 turns the SSH gateway off', () => {
  expect(loadConfig({ IMP_SSH_PORT: '2222' }).sshPort).toBe(2222);
  expect(loadConfig({ IMP_SSH_PORT: '0' }).sshPort).toBeNull();
  expect(() => loadConfig({ IMP_SSH_PORT: '-1' })).toThrow();
});

test('IMP_SSH_AUTHORIZED_KEYS=false turns the authorized_keys file off', () => {
  expect(loadConfig({ IMP_SSH_AUTHORIZED_KEYS: 'false' }).sshAuthorizedKeys).toBeFalse();
  expect(loadConfig({ IMP_SSH_AUTHORIZED_KEYS: 'true' }).sshAuthorizedKeys).toBeTrue();
  expect(() => loadConfig({ IMP_SSH_AUTHORIZED_KEYS: 'no' })).toThrow();
});

test('it needs the root dataset with the zfs backend', () => {
  expect(() => loadConfig({ IMP_STORAGE_BACKEND: 'zfs' })).toThrow('needs IMP_ZFS_ROOT');
  expect(() => loadConfig({ IMP_STORAGE_BACKEND: 'btrfs' })).toThrow();

  const config = loadConfig({ IMP_STORAGE_BACKEND: 'zfs', IMP_ZFS_ROOT: 'tank/imp' });

  expect(config).toMatchObject({ storageBackend: 'zfs', zfsRoot: 'tank/imp' });
});

test('it rejects a port base that cannot fit every slot', () => {
  expect(() => loadConfig({ IMP_PORT_BASE: '60000' })).toThrow('IMP_PORT_BASE');
});

test('it reads the HTTPS settings when IMP_DOMAIN is set', () => {
  const config = loadConfig({
    IMP_DOMAIN: 'Imp.Example.com.',
    IMP_DNS_PROVIDER: 'cloudflare',
    IMP_DNS_API_TOKEN: 'cf-token',
    IMP_ACME_EMAIL: 'ops@example.com',
  });

  expect(config.https).toEqual({
    domain: 'imp.example.com',
    httpsPort: 443,
    httpPort: 80,
    dns: { provider: 'cloudflare', apiToken: 'cf-token', apiUrl: null },
    acmeDirectory: 'https://acme-v02.api.letsencrypt.org/directory',
    acmeEmail: 'ops@example.com',
    acmeCaFile: null,
  });
});

test('it leaves HTTPS off without IMP_DOMAIN, whatever else is set', () => {
  expect(loadConfig({ IMP_DNS_PROVIDER: 'cloudflare' }).https).toBeNull();
});

test('it refuses a domain it cannot get a certificate for', () => {
  expect(() => loadConfig({ IMP_DOMAIN: 'imp.example.com' })).toThrow('IMP_DNS_PROVIDER');

  expect(() =>
    loadConfig({ IMP_DOMAIN: 'imp.example.com', IMP_DNS_PROVIDER: 'cloudflare' }),
  ).toThrow('IMP_DNS_API_TOKEN');

  expect(() =>
    loadConfig({ IMP_DOMAIN: 'imp.example.com', IMP_DNS_PROVIDER: 'challtestsrv', IMP_E2E: '1' }),
  ).toThrow('IMP_DNS_API_URL');

  expect(() => loadConfig({ IMP_DOMAIN: '*.example.com', IMP_DNS_PROVIDER: 'cloudflare' })).toThrow(
    'domain name',
  );

  expect(() => loadConfig({ IMP_DOMAIN: 'localhost', IMP_DNS_PROVIDER: 'cloudflare' })).toThrow(
    'domain name',
  );
});

const CLOUDFLARE = {
  IMP_DOMAIN: 'imp.example.com',
  IMP_DNS_PROVIDER: 'cloudflare',
  IMP_DNS_API_TOKEN: 'cf-token',
};

test('the challtestsrv provider needs the test flag', () => {
  const challtestsrv = {
    IMP_DOMAIN: 'imp.test',
    IMP_DNS_PROVIDER: 'challtestsrv',
    IMP_DNS_API_URL: 'http://challtestsrv:8055',
  };

  expect(() => loadConfig(challtestsrv)).toThrow('for tests only and needs IMP_E2E=1');
  expect(loadConfig({ ...challtestsrv, IMP_E2E: '1' }).https?.dns.provider).toBe('challtestsrv');
});

test('the token goes to an https API, or one on loopback', () => {
  expect(() => loadConfig({ ...CLOUDFLARE, IMP_DNS_API_URL: 'http://dns.example.com' })).toThrow(
    'IMP_DNS_API_URL must be https',
  );

  expect(
    loadConfig({ ...CLOUDFLARE, IMP_DNS_API_URL: 'https://dns.example.com' }).https,
  ).not.toBeNull();

  expect(
    loadConfig({ ...CLOUDFLARE, IMP_DNS_API_URL: 'http://127.0.0.1:9000' }).https,
  ).not.toBeNull();
});

test('a CA file that does not exist is refused by name', () => {
  expect(() => loadConfig({ ...CLOUDFLARE, IMP_ACME_CA_FILE: '/nonexistent/ca.pem' })).toThrow(
    'IMP_ACME_CA_FILE /nonexistent/ca.pem does not exist',
  );
});

test('it reads tailnet identity rules and refuses bad ones', () => {
  const config = loadConfig({
    IMP_TAILNET_IDENTITIES: '[{"match":"tag:ci","scope":"exec","imps":["ci-*"]}]',
  });

  expect(config.tailnetRules).toEqual([{ match: 'tag:ci', scope: 'exec', imps: ['ci-*'] }]);
  expect(() => loadConfig({ IMP_TAILNET_IDENTITIES: 'not json' })).toThrow('is not JSON');

  expect(() => loadConfig({ IMP_TAILNET_IDENTITIES: '[{"match":"x"}]' })).toThrow(
    'IMP_TAILNET_IDENTITIES',
  );
});

test('it refuses an imp subnet that overlaps the tailnet', () => {
  expect(() => loadConfig({ IMP_SUBNET: '100.100.0.0/16' })).toThrow('overlaps');
  expect(() => loadConfig({ IMP_SUBNET: '100.127.240.0/20' })).toThrow('overlaps');
  expect(loadConfig({ IMP_SUBNET: '100.128.0.0/16' }).subnet.prefixLength).toBe(16);
});
