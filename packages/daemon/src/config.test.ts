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
    egressDeny: [],
    brokerTestUpstreams: null,
    ramBudgetMib: 16_384,
    idleTimeoutS: 60,
    idleCpuPercent: 10,
    bootReservePercent: 50,
    wakeReserveMib: 256,
    sleepMinGuestUptimeMs: 1500,
    bootTemplates: true,
    watchdogTimeoutS: 60,
    watchdogAction: 'report',
    defaultVcpus: 2,
    defaultMemoryMib: 2048,
    defaultDiskBytes: 32 * 1024 ** 3,
    diskReserveBytes: null,
    buildContextMaxBytes: 1024 ** 3,
    dockerHost: null,
    dns: ['1.1.1.1', '8.8.8.8'],
    subnet: { network: 0x0a_42_00_00, prefixLength: 16 },
    ipv6: { kind: 'auto' },
    firecrackerBin: 'firecracker',
    jailerBin: 'jailer',
    jailDir: '/var/lib/imp/jail',
    ksm: null,
    kernelPath: '/var/lib/imp/system/vmlinux',
    kernelSource: null,
    systemDriveSource: '/var/lib/imp/system/imp-system.squashfs',
    defaultImage: 'base',
    storageBackend: 'xfs',
    zfsRoot: null,
    tailscaleEnabled: false,
    tailscaleHostname: 'imp',
    tailnetRules: null,
    dashboardDir: null,
    backup: null,
    https: null,
    tailnetNames: null,
    moves: { peerUrl: null, testCidr: null },
    warnings: [],
  });
});

test('a move test range off the tailnet needs an e2e host', () => {
  expect(() => loadConfig({ IMP_MOVE_TEST_CIDR: '172.30.0.0/16' })).toThrow(/only an e2e host/);

  const config = loadConfig({ IMP_MOVE_TEST_CIDR: '172.30.0.0/16', IMP_E2E: '1' });

  expect(config.moves.testCidr).toBe('172.30.0.0/16');
});

test('a move test range must be private and no wider than /16', () => {
  for (const testCidr of ['0.0.0.0/0', '10.0.0.0/8', '8.8.0.0/16']) {
    expect(() => loadConfig({ IMP_MOVE_TEST_CIDR: testCidr, IMP_E2E: '1' })).toThrow(
      /private range of \/16 or narrower/,
    );
  }
});

test('a peer URL off the tailnet needs an e2e host and its test range', () => {
  const offTailnet = 'http://10.70.0.3:7070';

  expect(() => loadConfig({ IMP_PEER_URL: offTailnet })).toThrow(/must name a tailnet address/);
  expect(() => loadConfig({ IMP_PEER_URL: offTailnet, IMP_E2E: '1' })).toThrow(/tailnet address/);
  expect(() => loadConfig({ IMP_PEER_URL: 'http://imp-b:7070' })).toThrow(/not a name/);

  expect(loadConfig({ IMP_PEER_URL: 'http://100.80.1.2:7070' }).moves.peerUrl).toBe(
    'http://100.80.1.2:7070',
  );

  const e2e = loadConfig({
    IMP_PEER_URL: offTailnet,
    IMP_MOVE_TEST_CIDR: '10.70.0.0/24',
    IMP_E2E: '1',
  });

  expect(e2e.moves).toEqual({ peerUrl: offTailnet, testCidr: '10.70.0.0/24' });
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
  expect(config.tailscaleEnabled).toBeTrue();
  expect(config.sleepMinGuestUptimeMs).toBe(0);
});

test('a node started from saved state counts as the tailnet, with no key', () => {
  expect(loadConfig({ IMP_TAILSCALE_NODE: '1' }).tailscaleEnabled).toBeTrue();

  expect(
    loadConfig({ TAILSCALE_AUTHKEY: '', IMP_TAILSCALE_NODE: '' }).tailscaleEnabled,
  ).toBeFalse();
});

test('it treats an empty variable as unset', () => {
  expect(loadConfig({ TAILSCALE_AUTHKEY: '', IMP_API_PORT: '' }).tailscaleEnabled).toBeFalse();
});

test('it rejects invalid values', () => {
  expect(() => loadConfig({ IMP_API_PORT: 'http' })).toThrow();
  expect(() => loadConfig({ IMP_DNS: 'one.one.one.one' })).toThrow();
  expect(() => loadConfig({ IMP_SUBNET: '10.66.0.0' })).toThrow();
});

test('IMP_JAILER=false runs Firecracker without the jailer', () => {
  expect(loadConfig({ IMP_JAILER: 'false' }).jailerBin).toBeNull();
  expect(loadConfig({ IMP_JAILER_BIN: '/opt/jailer' }).jailerBin).toBe('/opt/jailer');
  expect(() => loadConfig({ IMP_JAILER: 'no' })).toThrow();
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
    dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
    acmeDirectory: 'https://acme-v02.api.letsencrypt.org/directory',
    acmeEmail: 'ops@example.com',
    acmeCaFile: null,
    public: null,
  });
});

test('IMP_PUBLIC_IP turns on the public listeners, on ports of their own', () => {
  const env = {
    IMP_DOMAIN: 'imp.example.com',
    IMP_DNS_PROVIDER: 'cloudflare',
    IMP_DNS_API_TOKEN: 'cf-token',
    IMP_PUBLIC_IP: '203.0.113.7',
  };

  expect(loadConfig(env).https?.public).toEqual({
    ip: '203.0.113.7',
    httpsPort: 7443,
    httpPort: 7480,
  });

  expect(() => loadConfig({ ...env, IMP_PUBLIC_HTTPS_PORT: '443' })).toThrow(
    'IMP_PUBLIC_HTTPS_PORT 443 is also IMP_HTTPS_PORT',
  );

  expect(() => loadConfig({ ...env, IMP_PUBLIC_HTTP_PORT: '7070' })).toThrow('IMP_API_PORT');
  expect(() => loadConfig({ ...env, IMP_PUBLIC_HTTPS_PORT: '20005' })).toThrow("imps' ports");

  expect(() => loadConfig({ IMP_PUBLIC_IP: '203.0.113.7' })).toThrow(
    'IMP_PUBLIC_IP needs IMP_DOMAIN',
  );

  expect(() => loadConfig({ ...env, IMP_PUBLIC_IP: 'example.com' })).toThrow();
});

test('IMP_EGRESS_DENY takes addresses and CIDRs of both families, with IMP_PUBLIC_IP', () => {
  const deny = loadConfig({
    IMP_EGRESS_DENY: '198.51.100.7, 44.0.0.9/24,2001:DB8::1/64,2a01:4f8::7',
  });

  expect(deny.egressDeny).toEqual([
    '198.51.100.7/32',
    '44.0.0.0/24',
    '2001:db8::/64',
    '2a01:4f8::7/128',
  ]);

  const withPublic = loadConfig({
    IMP_DOMAIN: 'imp.example.com',
    IMP_DNS_PROVIDER: 'cloudflare',
    IMP_DNS_API_TOKEN: 'cf-token',
    IMP_PUBLIC_IP: '203.0.113.7',
    IMP_EGRESS_DENY: '203.0.113.7',
  });

  expect(withPublic.egressDeny).toEqual(['203.0.113.7/32']);

  expect(() => loadConfig({ IMP_EGRESS_DENY: 'host.example.com' })).toThrow(
    'IMP_EGRESS_DENY: host.example.com is not an IPv4 or IPv6 address or CIDR',
  );

  expect(() => loadConfig({ IMP_EGRESS_DENY: '10.0.0.0/33' })).toThrow('IMP_EGRESS_DENY');
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

test('the DNS API token may come from a file, read at each use, not at start', () => {
  const file = {
    IMP_DOMAIN: 'imp.example.com',
    IMP_DNS_PROVIDER: 'cloudflare',
    IMP_DNS_API_TOKEN_FILE: '/run/imp/dns/token',
  };

  // the file need not exist yet: impd starts and says so until it does
  expect(loadConfig(file).https?.dns.token).toEqual({ kind: 'file', path: '/run/imp/dns/token' });

  expect(() => loadConfig({ ...file, IMP_DNS_API_TOKEN: 'cf-token' })).toThrow(
    'set IMP_DNS_API_TOKEN or IMP_DNS_API_TOKEN_FILE, not both',
  );

  // an empty value is unset, as an env file's `IMP_DNS_API_TOKEN=` line is
  expect(loadConfig({ ...file, IMP_DNS_API_TOKEN: '' }).https?.dns.token).toEqual({
    kind: 'file',
    path: '/run/imp/dns/token',
  });

  expect(() => loadConfig({ ...file, IMP_DNS_API_TOKEN_FILE: '', IMP_DNS_API_TOKEN: '' })).toThrow(
    'IMP_DNS_PROVIDER=cloudflare needs IMP_DNS_API_TOKEN or IMP_DNS_API_TOKEN_FILE',
  );
});

test('a token file without IMP_DOMAIN is a warning, not an error', () => {
  const config = loadConfig({ IMP_DNS_API_TOKEN_FILE: '/run/imp/dns/token' });

  expect(config.https).toBeNull();

  expect(config.warnings).toEqual([
    'IMP_DNS_API_TOKEN_FILE is set without IMP_DOMAIN; HTTPS is off and the file is unused',
  ]);

  expect(loadConfig({}).warnings).toEqual([]);
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

test('tailnet names need the tailnet, and keep the OAuth file in the data dir by default', () => {
  expect(() => loadConfig({ IMP_TAILNET_NAMES: '1' })).toThrow('needs the host on the tailnet');

  const config = loadConfig({
    IMP_DATA_DIR: '/tmp/imp',
    TAILSCALE_AUTHKEY: 'tskey-auth-test',
    IMP_TAILNET_NAMES: '1',
  });

  expect(config.tailnetNames).toEqual({
    prefix: '',
    oauthFile: '/tmp/imp/tailnet-names/oauth.json',
  });

  expect(() =>
    loadConfig({
      TAILSCALE_AUTHKEY: 'tskey-auth-test',
      IMP_TAILNET_NAMES: '1',
      IMP_TAILNET_NAME_PREFIX: 'Imp_',
    }),
  ).toThrow('IMP_TAILNET_NAME_PREFIX');
});

test('the API and proxy ports must not fall in the imp ports', () => {
  expect(() => loadConfig({ IMP_API_PORT: '20005' })).toThrow('IMP_API_PORT 20005');
  expect(() => loadConfig({ IMP_PROXY_PORT: '20000' })).toThrow('IMP_PROXY_PORT 20000');
});

test('IMP_KSM starts Firecracker through ksm-exec and keeps all of the saving free', () => {
  const config = loadConfig({ IMP_KSM: '1' });

  expect(config.ksm).toEqual({ execBin: 'ksm-exec', headroomPercent: 100 });

  const custom = loadConfig({
    IMP_KSM: '1',
    IMP_KSM_EXEC: '/usr/local/bin/ksm-exec',
    IMP_KSM_HEADROOM_PERCENT: '0',
  });

  expect(custom.ksm).toEqual({ execBin: '/usr/local/bin/ksm-exec', headroomPercent: 0 });

  expect(() => loadConfig({ IMP_KSM: '1', IMP_KSM_HEADROOM_PERCENT: '101' })).toThrow(
    'IMP_KSM_HEADROOM_PERCENT 101',
  );

  expect(() => loadConfig({ IMP_KSM: 'yes' })).toThrow();
});

test('IMP_KSM=0 is off, and then the headroom setting is not read', () => {
  const config = loadConfig({ IMP_KSM: '0', IMP_KSM_HEADROOM_PERCENT: 'lots' });

  expect(config.ksm).toBeNull();
});
