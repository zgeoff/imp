import { expect, test } from 'bun:test';
import { loadConfig } from './config';
import { createRangeChecker } from './net/range-checker';

test('it fills every setting from its default when the env is empty', () => {
  const config = loadConfig({});

  expect(config).toStrictEqual({
    dataDir: '/var/lib/imp',
    apiPort: 7070,
    proxyPort: 7080,
    portBase: 20_000,
    sshPort: 22,
    sshAuthorizedKeys: true,
    brokerPort: 7081,
    egressDnsPort: 7053,
    egressDeny: [],
    hostAddresses: [],
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
    build: {
      isolation: 'imp',
      memoryMib: 2048,
      diskBytes: 20 * 1024 ** 3,
      imageMaxBytes: 8192 * 1024 ** 2,
      imageMaxFiles: 1_000_000,
      image:
        'ghcr.io/zgeoff/imp-base:0.29.0@sha256:1851f631ea77f3a99b6f1f9af8ca8868434f4cd066158bcf9def8678c29b0c21',
    },
    sessionLog: {
      generationMaxBytes: 16 * 1024 ** 2,
      impMaxBytes: 64 * 1024 ** 2,
      impMaxLive: 8,
      maxAgeMs: 7 * 86_400_000,
    },
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
    publicMcp: null,
    tailnetNames: null,
    moves: { peerUrl: null, testCidr: null },
    warnings: [],
  });
});

test('it refuses a move test range off the tailnet on a host that is not an e2e host', () => {
  expect(() => loadConfig({ IMP_MOVE_TEST_CIDR: '172.30.0.0/16' })).toThrow(
    'IMP_MOVE_TEST_CIDR opens moves off the tailnet, and only an e2e host may set it',
  );
});

test('it reads a move test range on an e2e host', () => {
  const config = loadConfig({ IMP_MOVE_TEST_CIDR: '172.30.0.0/16', IMP_E2E: '1' });

  expect(config.moves.testCidr).toBe('172.30.0.0/16');
});

test.each(['0.0.0.0/0', '10.0.0.0/8', '8.8.0.0/16'])(
  'it refuses the move test range %s, which is not private or is wider than /16',
  (testCidr) => {
    expect(() => loadConfig({ IMP_MOVE_TEST_CIDR: testCidr, IMP_E2E: '1' })).toThrow(
      `IMP_MOVE_TEST_CIDR must be a private range of /16 or narrower: ${testCidr}`,
    );
  },
);

test('it refuses a peer URL off the tailnet on a host that is not an e2e host', () => {
  expect(() => loadConfig({ IMP_PEER_URL: 'http://10.70.0.3:7070' })).toThrow(
    'IMP_PEER_URL must name a tailnet address: http://10.70.0.3:7070',
  );
});

test('it refuses a peer URL off the tailnet on an e2e host without a test range', () => {
  expect(() => loadConfig({ IMP_PEER_URL: 'http://10.70.0.3:7070', IMP_E2E: '1' })).toThrow(
    'IMP_PEER_URL must name a tailnet address or one in IMP_MOVE_TEST_CIDR: http://10.70.0.3:7070',
  );
});

test('it refuses a peer URL that names a host rather than an address', () => {
  expect(() => loadConfig({ IMP_PEER_URL: 'http://imp-b:7070' })).toThrow(
    'IMP_PEER_URL must name a literal address, not a name: http://imp-b:7070',
  );
});

test('it reads a peer URL on the tailnet', () => {
  const config = loadConfig({ IMP_PEER_URL: 'http://100.80.1.2:7070' });

  expect(config.moves.peerUrl).toBe('http://100.80.1.2:7070');
});

test('it reads a peer URL in the test range on an e2e host', () => {
  const config = loadConfig({
    IMP_PEER_URL: 'http://10.70.0.3:7070',
    IMP_MOVE_TEST_CIDR: '10.70.0.0/24',
    IMP_E2E: '1',
  });

  expect(config.moves).toStrictEqual({
    peerUrl: 'http://10.70.0.3:7070',
    testCidr: '10.70.0.0/24',
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
  expect(config.dns).toStrictEqual(['9.9.9.9', '1.0.0.1']);
  expect(config.subnet).toStrictEqual({ network: 0x0a_63_00_00, prefixLength: 24 });
  expect(config.kernelPath).toBe('/tmp/imp/system/vmlinux');
  expect(config.kernelSource).toBe('/src/kernel/out/vmlinux');
  expect(config.tailscaleEnabled).toBeTrue();
  expect(config.sleepMinGuestUptimeMs).toBe(0);
});

test('it counts a node started from saved state as on the tailnet, with no key', () => {
  expect(loadConfig({ IMP_TAILSCALE_NODE: '1' }).tailscaleEnabled).toBeTrue();
});

test('it treats an empty variable as unset', () => {
  const config = loadConfig({ TAILSCALE_AUTHKEY: '', IMP_TAILSCALE_NODE: '', IMP_API_PORT: '' });

  expect(config.tailscaleEnabled).toBeFalse();
  expect(config.apiPort).toBe(7070);
});

test.each([
  ['IMP_API_PORT', 'http'],
  ['IMP_DNS', 'one.one.one.one'],
  ['IMP_SUBNET', '10.66.0.0'],
  ['IMP_JAILER', 'no'],
  ['IMP_SSH_PORT', '-1'],
  ['IMP_SSH_AUTHORIZED_KEYS', 'no'],
  ['IMP_STORAGE_BACKEND', 'btrfs'],
  ['IMP_KSM', 'yes'],
])('it refuses %s=%s', (name, value) => {
  expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(`"path": \\[\\s*"${name}"`));
});

test('it runs Firecracker without the jailer when IMP_JAILER is false', () => {
  expect(loadConfig({ IMP_JAILER: 'false' }).jailerBin).toBeNull();
});

test('it runs the jailer from IMP_JAILER_BIN', () => {
  expect(loadConfig({ IMP_JAILER_BIN: '/opt/jailer' }).jailerBin).toBe('/opt/jailer');
});

test('it reads the SSH gateway port', () => {
  expect(loadConfig({ IMP_SSH_PORT: '2222' }).sshPort).toBe(2222);
});

test('it turns the SSH gateway off when IMP_SSH_PORT is 0', () => {
  expect(loadConfig({ IMP_SSH_PORT: '0' }).sshPort).toBeNull();
});

test.each([
  ['false', false],
  ['true', true],
])('it reads IMP_SSH_AUTHORIZED_KEYS=%s as %p', (value, expected) => {
  expect(loadConfig({ IMP_SSH_AUTHORIZED_KEYS: value }).sshAuthorizedKeys).toBe(expected);
});

test('it refuses the zfs backend without its root dataset', () => {
  expect(() => loadConfig({ IMP_STORAGE_BACKEND: 'zfs' })).toThrow(
    'IMP_STORAGE_BACKEND=zfs needs IMP_ZFS_ROOT, the dataset mounted on IMP_DATA_DIR',
  );
});

test('it reads the zfs backend with its root dataset', () => {
  const config = loadConfig({ IMP_STORAGE_BACKEND: 'zfs', IMP_ZFS_ROOT: 'tank/imp' });

  expect(config.storageBackend).toBe('zfs');
  expect(config.zfsRoot).toBe('tank/imp');
});

test('it rejects a port base that cannot fit every slot', () => {
  expect(() => loadConfig({ IMP_PORT_BASE: '60000' })).toThrow(
    'IMP_PORT_BASE 60000 leaves no port for every slot of 10.66.0.0/16',
  );
});

test('it reads the HTTPS settings when IMP_DOMAIN is set', () => {
  const config = loadConfig({
    IMP_DOMAIN: 'Imp.Example.com.',
    IMP_DNS_PROVIDER: 'cloudflare',
    IMP_DNS_API_TOKEN: 'cf-token',
    IMP_ACME_EMAIL: 'ops@example.com',
  });

  expect(config.https).toStrictEqual({
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

test('it turns on the public listeners on ports of their own when IMP_PUBLIC_IP is set', () => {
  const config = loadConfig({
    IMP_DOMAIN: 'imp.example.com',
    IMP_DNS_PROVIDER: 'cloudflare',
    IMP_DNS_API_TOKEN: 'cf-token',
    IMP_PUBLIC_IP: '203.0.113.7',
  });

  expect(config.https?.public).toStrictEqual({
    ip: '203.0.113.7',
    httpsPort: 7443,
    httpPort: 7480,
  });
});

test('it refuses a public HTTPS port that another listener holds', () => {
  expect(() =>
    loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'cf-token',
      IMP_PUBLIC_IP: '203.0.113.7',
      IMP_PUBLIC_HTTPS_PORT: '443',
    }),
  ).toThrow('IMP_PUBLIC_HTTPS_PORT 443 is also IMP_HTTPS_PORT; give it a port of its own');
});

test('it refuses a public HTTP port that the API holds', () => {
  expect(() =>
    loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'cf-token',
      IMP_PUBLIC_IP: '203.0.113.7',
      IMP_PUBLIC_HTTP_PORT: '7070',
    }),
  ).toThrow('IMP_PUBLIC_HTTP_PORT 7070 is also IMP_API_PORT; give it a port of its own');
});

test('it refuses a public port among the imp ports', () => {
  expect(() =>
    loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'cf-token',
      IMP_PUBLIC_IP: '203.0.113.7',
      IMP_PUBLIC_HTTPS_PORT: '20005',
    }),
  ).toThrow("IMP_PUBLIC_HTTPS_PORT 20005 is one of the imps' ports, 20000 to 36383");
});

test('it refuses the same port for public HTTPS and public HTTP', () => {
  expect(() =>
    loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'cf-token',
      IMP_PUBLIC_IP: '203.0.113.7',
      IMP_PUBLIC_HTTPS_PORT: '8443',
      IMP_PUBLIC_HTTP_PORT: '8443',
    }),
  ).toThrow('IMP_PUBLIC_HTTPS_PORT and IMP_PUBLIC_HTTP_PORT must differ');
});

test('it refuses IMP_PUBLIC_IP without IMP_DOMAIN', () => {
  expect(() => loadConfig({ IMP_PUBLIC_IP: '203.0.113.7' })).toThrow(
    'IMP_PUBLIC_IP needs IMP_DOMAIN',
  );
});

test('it refuses an IMP_PUBLIC_IP that is a name', () => {
  expect(() =>
    loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'cf-token',
      IMP_PUBLIC_IP: 'example.com',
    }),
  ).toThrow(/"path": \[\s*"IMP_PUBLIC_IP"/);
});

test('it takes egress deny addresses and CIDRs of both families', () => {
  const config = loadConfig({
    IMP_EGRESS_DENY: '198.51.100.7, 44.0.0.9/24,2001:DB8::1/64,2a01:4f8::7',
  });

  expect(config.egressDeny).toStrictEqual([
    '198.51.100.7/32',
    '44.0.0.0/24',
    '2001:db8::/64',
    '2a01:4f8::7/128',
  ]);
});

test('it denies egress to IMP_PUBLIC_IP once, when the deny list names it too', () => {
  const config = loadConfig({
    IMP_DOMAIN: 'imp.example.com',
    IMP_DNS_PROVIDER: 'cloudflare',
    IMP_DNS_API_TOKEN: 'cf-token',
    IMP_PUBLIC_IP: '203.0.113.7',
    IMP_EGRESS_DENY: '203.0.113.7',
  });

  expect(config.egressDeny).toStrictEqual(['203.0.113.7/32']);
});

test.each([
  ['IMP_EGRESS_DENY', 'host.example.com'],
  ['IMP_EGRESS_DENY', '10.0.0.0/33'],
  ['IMP_HOST_ADDRESSES', 'inet6'],
])('it refuses %s=%s, which is not an address or CIDR', (name, value) => {
  expect(() => loadConfig({ [name]: value })).toThrow(
    `IMP_EGRESS_DENY or IMP_HOST_ADDRESSES: ${value} is not an IPv4 or IPv6 address or CIDR`,
  );
});

test("it adds the networks of the host's own addresses to the deny list, prefixes kept", () => {
  const config = loadConfig({
    IMP_EGRESS_DENY: '198.51.100.7',
    IMP_HOST_ADDRESSES: '203.0.113.9/24,172.17.0.1/16,2001:db8:1::5/64,198.51.100.7/32',
  });

  expect(config.egressDeny).toStrictEqual([
    '198.51.100.7/32',
    '203.0.113.0/24',
    '172.17.0.0/16',
    '2001:db8:1::/64',
  ]);

  expect(config.hostAddresses).toStrictEqual([
    '203.0.113.0/24',
    '172.17.0.0/16',
    '2001:db8:1::/64',
    '198.51.100.7/32',
  ]);
});

test.each([
  ['2001:db8:1::9', true],
  ['203.0.113.200', true],
  ['2001:db8:2::9', false],
  ['203.0.114.1', false],
])('it denies %s beside the host on its LAN: %p', (address, expected) => {
  const config = loadConfig({ IMP_HOST_ADDRESSES: '203.0.113.9/24,2001:db8:1::5/64' });

  const isDenied = createRangeChecker(
    config.egressDeny.filter((cidr) => !cidr.includes(':')),
    config.egressDeny.filter((cidr) => cidr.includes(':')),
  );

  expect(isDenied(address)).toBe(expected);
});

test('it leaves HTTPS off without IMP_DOMAIN, whatever else is set', () => {
  expect(loadConfig({ IMP_DNS_PROVIDER: 'cloudflare' }).https).toBeNull();
});

test('it refuses a domain without a DNS provider', () => {
  expect(() => loadConfig({ IMP_DOMAIN: 'imp.example.com' })).toThrow('IMP_DNS_PROVIDER');
});

test('it refuses the cloudflare provider without an API token', () => {
  expect(() =>
    loadConfig({ IMP_DOMAIN: 'imp.example.com', IMP_DNS_PROVIDER: 'cloudflare' }),
  ).toThrow('IMP_DNS_PROVIDER=cloudflare needs IMP_DNS_API_TOKEN or IMP_DNS_API_TOKEN_FILE');
});

test('it refuses the challtestsrv provider without its API URL', () => {
  expect(() =>
    loadConfig({ IMP_DOMAIN: 'imp.example.com', IMP_DNS_PROVIDER: 'challtestsrv', IMP_E2E: '1' }),
  ).toThrow('IMP_DNS_API_URL');
});

test.each(['*.example.com', 'localhost'])(
  'it refuses %s, which is not a domain name it can get a certificate for',
  (domain) => {
    expect(() => loadConfig({ IMP_DOMAIN: domain, IMP_DNS_PROVIDER: 'cloudflare' })).toThrow(
      'domain name',
    );
  },
);

test('it reads the DNS API token file at each use, so the file need not exist at start', () => {
  const config = loadConfig({
    IMP_DOMAIN: 'imp.example.com',
    IMP_DNS_PROVIDER: 'cloudflare',
    IMP_DNS_API_TOKEN_FILE: '/run/imp/dns/token',
  });

  expect(config.https?.dns.token).toStrictEqual({ kind: 'file', path: '/run/imp/dns/token' });
});

test('it refuses both a DNS API token and a token file', () => {
  expect(() =>
    loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN_FILE: '/run/imp/dns/token',
      IMP_DNS_API_TOKEN: 'cf-token',
    }),
  ).toThrow('set IMP_DNS_API_TOKEN or IMP_DNS_API_TOKEN_FILE, not both');
});

test('it reads the token file when the token is set but empty, as an env file sets it', () => {
  const config = loadConfig({
    IMP_DOMAIN: 'imp.example.com',
    IMP_DNS_PROVIDER: 'cloudflare',
    IMP_DNS_API_TOKEN_FILE: '/run/imp/dns/token',
    IMP_DNS_API_TOKEN: '',
  });

  expect(config.https?.dns.token).toStrictEqual({ kind: 'file', path: '/run/imp/dns/token' });
});

test('it warns of a token file without IMP_DOMAIN and leaves HTTPS off', () => {
  const config = loadConfig({ IMP_DNS_API_TOKEN_FILE: '/run/imp/dns/token' });

  expect(config.https).toBeNull();

  expect(config.warnings).toStrictEqual([
    'IMP_DNS_API_TOKEN_FILE is set without IMP_DOMAIN; HTTPS is off and the file is unused',
  ]);
});

test.each([
  '10.1.2.3',
  '100.101.102.103',
  '127.0.0.1',
  '169.254.169.254',
  '172.20.0.5',
  '192.168.1.10',
])('it warns that the internet cannot reach IMP_PUBLIC_IP %s', (ip) => {
  const config = loadConfig({
    IMP_DOMAIN: 'imp.example.com',
    IMP_DNS_PROVIDER: 'cloudflare',
    IMP_DNS_API_TOKEN: 'cf-token',
    IMP_PUBLIC_IP: ip,
  });

  expect(config.warnings).toStrictEqual([
    `IMP_PUBLIC_IP ${ip} is not an internet address; public imps' records point at it, so the internet cannot reach them`,
  ]);
});

test.each(['203.0.113.7', '100.63.255.1', '100.128.0.1', '172.15.0.1', '172.32.0.1', '8.8.8.8'])(
  'it gives no warning for the internet address %s as IMP_PUBLIC_IP',
  (ip) => {
    const config = loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'cf-token',
      IMP_PUBLIC_IP: ip,
    });

    expect(config.warnings).toStrictEqual([]);
  },
);

test('it refuses the challtestsrv provider on a host that is not an e2e host', () => {
  expect(() =>
    loadConfig({
      IMP_DOMAIN: 'imp.test',
      IMP_DNS_PROVIDER: 'challtestsrv',
      IMP_DNS_API_URL: 'http://challtestsrv:8055',
    }),
  ).toThrow('for tests only and needs IMP_E2E=1');
});

test('it reads the challtestsrv provider on an e2e host', () => {
  const config = loadConfig({
    IMP_DOMAIN: 'imp.test',
    IMP_DNS_PROVIDER: 'challtestsrv',
    IMP_DNS_API_URL: 'http://challtestsrv:8055',
    IMP_E2E: '1',
  });

  expect(config.https?.dns.provider).toBe('challtestsrv');
});

test('it refuses a plain http DNS API off loopback', () => {
  expect(() =>
    loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'cf-token',
      IMP_DNS_API_URL: 'http://dns.example.com',
    }),
  ).toThrow('IMP_DNS_API_URL must be https');
});

test.each(['https://dns.example.com', 'http://127.0.0.1:9000'])(
  'it sends the DNS API token to %s',
  (apiUrl) => {
    const config = loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'cf-token',
      IMP_DNS_API_URL: apiUrl,
    });

    expect(config.https?.dns.apiUrl).toBe(apiUrl);
  },
);

test('it refuses a CA file that does not exist, by name', () => {
  expect(() =>
    loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'cf-token',
      IMP_ACME_CA_FILE: '/nonexistent/ca.pem',
    }),
  ).toThrow('IMP_ACME_CA_FILE /nonexistent/ca.pem does not exist');
});

test('it reads tailnet identity rules', () => {
  const config = loadConfig({
    IMP_TAILNET_IDENTITIES: '[{"match":"tag:ci","scope":"exec","imps":["ci-*"]}]',
  });

  expect(config.tailnetRules).toStrictEqual([{ match: 'tag:ci', scope: 'exec', imps: ['ci-*'] }]);
});

test('it refuses tailnet identity rules that are not JSON', () => {
  expect(() => loadConfig({ IMP_TAILNET_IDENTITIES: 'not json' })).toThrow(
    'IMP_TAILNET_IDENTITIES is not JSON',
  );
});

test('it refuses a tailnet identity rule without a scope', () => {
  expect(() => loadConfig({ IMP_TAILNET_IDENTITIES: '[{"match":"x"}]' })).toThrow(
    /^IMP_TAILNET_IDENTITIES: .*scope/s,
  );
});

test.each(['100.100.0.0/16', '100.127.240.0/20'])(
  'it refuses the imp subnet %s, which overlaps the tailnet',
  (subnet) => {
    expect(() => loadConfig({ IMP_SUBNET: subnet })).toThrow(
      `IMP_SUBNET ${subnet} overlaps Tailscale's 100.64.0.0/10`,
    );
  },
);

test('it takes an imp subnet just past the tailnet', () => {
  expect(loadConfig({ IMP_SUBNET: '100.128.0.0/16' }).subnet).toStrictEqual({
    network: 0x64_80_00_00,
    prefixLength: 16,
  });
});

test('it refuses tailnet names without the tailnet', () => {
  expect(() => loadConfig({ IMP_TAILNET_NAMES: '1' })).toThrow('needs the host on the tailnet');
});

test('it keeps the tailnet names OAuth file in the data dir by default', () => {
  const config = loadConfig({
    IMP_DATA_DIR: '/tmp/imp',
    TAILSCALE_AUTHKEY: 'tskey-auth-test',
    IMP_TAILNET_NAMES: '1',
  });

  expect(config.tailnetNames).toStrictEqual({
    prefix: '',
    oauthFile: '/tmp/imp/tailnet-names/oauth.json',
  });
});

test('it refuses a tailnet name prefix that is not a DNS label', () => {
  expect(() =>
    loadConfig({
      TAILSCALE_AUTHKEY: 'tskey-auth-test',
      IMP_TAILNET_NAMES: '1',
      IMP_TAILNET_NAME_PREFIX: 'Imp_',
    }),
  ).toThrow('IMP_TAILNET_NAME_PREFIX');
});

test.each([
  ['IMP_API_PORT', '20005'],
  ['IMP_PROXY_PORT', '20000'],
])('it refuses %s=%s among the imp ports', (name, port) => {
  expect(() => loadConfig({ [name]: port })).toThrow(
    `${name} ${port} falls in the imp ports 20000-36383`,
  );
});

test('it starts Firecracker through ksm-exec and keeps all of the saving free when IMP_KSM is on', () => {
  expect(loadConfig({ IMP_KSM: '1' }).ksm).toStrictEqual({
    execBin: 'ksm-exec',
    headroomPercent: 100,
  });
});

test('it reads the ksm-exec path and headroom', () => {
  const config = loadConfig({
    IMP_KSM: '1',
    IMP_KSM_EXEC: '/usr/local/bin/ksm-exec',
    IMP_KSM_HEADROOM_PERCENT: '0',
  });

  expect(config.ksm).toStrictEqual({ execBin: '/usr/local/bin/ksm-exec', headroomPercent: 0 });
});

test('it refuses a KSM headroom above 100 percent', () => {
  expect(() => loadConfig({ IMP_KSM: '1', IMP_KSM_HEADROOM_PERCENT: '101' })).toThrow(
    'IMP_KSM_HEADROOM_PERCENT 101 is not a whole number from 0 to 100',
  );
});

test('it leaves KSM off and reads no headroom when IMP_KSM is 0', () => {
  const config = loadConfig({ IMP_KSM: '0', IMP_KSM_HEADROOM_PERCENT: 'lots' });

  expect(config.ksm).toBeNull();
});
