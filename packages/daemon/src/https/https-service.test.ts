import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProxyListenOptions } from '../proxy/wake-proxy';
import { readRejection } from '../read-rejection';
import { findFreePorts } from '../test-utils/find-free-ports';
import type { Certificate } from './acme/cert-store';
import { createCertStore } from './acme/cert-store';
import { createCloudflareProvider } from './dns/cloudflare-provider';
import { buildPublicOwner } from './dns/dns-provider';
import type { DnsProvider } from './dns/dns-provider';
import { createDnsToken } from './dns/dns-token';
import type { HttpsConfig } from './https-config';
import { createHttpsService } from './https-service';
import { createTestCertificate } from './test-certificates';

const DOMAIN = 'imp.test';
const NAMES = [DOMAIN, `*.${DOMAIN}`];

// the address a test uses as the host's tailnet IP: any 127/8 address binds
const TAILNET_IP = '127.0.0.2';

interface ServiceTestOptions {
  readonly issue: (domain: string) => Promise<Certificate>;
  readonly dns?: DnsProvider;

  // the host's tailnet IP; unset, the host is on no tailnet
  readonly tailnetIp?: string;

  // tailscale serve holds the HTTPS port
  readonly serveHoldsHttps?: boolean;

  // public mode at this IP, and the public imps
  readonly publicIp?: string;
  readonly publicImps?: readonly string[];

  // how often the tailnet IP is read
  readonly addressIntervalMs?: number;
}

function buildConfig(publicIp?: string): HttpsConfig {
  const ports = findFreePorts(4);

  return {
    domain: DOMAIN,
    httpsPort: ports.take(),
    httpPort: ports.take(),
    dns: { provider: 'cloudflare', token: { kind: 'value', value: 'unused' }, apiUrl: null },
    acmeDirectory: 'https://acme.invalid/directory',
    acmeEmail: null,
    acmeCaFile: null,
    public:
      publicIp === undefined
        ? null
        : { ip: publicIp, httpsPort: ports.take(), httpPort: ports.take() },
  };
}

// a stand-in for the wake proxy: answers every request with its own
// listener's address
function startPlainListener(options: ProxyListenOptions) {
  return Bun.serve({
    port: options.port,
    ...(options.hostname !== undefined && { hostname: options.hostname }),
    ...(options.tls !== undefined && { tls: options.tls }),
    reusePort: true,
    fetch: () => new Response(`served on ${options.hostname ?? ''}`),
  });
}

// a DNS provider that keeps the A records it is given
// the owner of imp.test's public records
const PUBLIC_OWNER = buildPublicOwner(DOMAIN);

// a DNS provider that keeps the A records it is given, and their owners;
// a record seeded without an owner is the tailnet's
function createRecordingDns(): {
  readonly dns: DnsProvider;
  readonly records: Map<string, string>;
  readonly owners: Map<string, string>;
} {
  const records = new Map<string, string>();
  const owners = new Map<string, string>();

  const readOwner = (fqdn: string) => owners.get(fqdn) ?? 'managed by impd';

  const dns: DnsProvider = {
    addTxt: (fqdn, value) => Promise.resolve({ fqdn, value, id: value }),
    removeTxt: () => Promise.resolve(),
    waitForTxt: () => Promise.resolve(),
    setA: (fqdn, ip, owner = 'managed by impd') => {
      records.set(fqdn, ip);
      owners.set(fqdn, owner);

      return Promise.resolve();
    },
    listA: (domain, owner) => {
      const found = [...records].filter(
        ([fqdn]) => fqdn.endsWith(`.${domain}`) && readOwner(fqdn) === owner,
      );

      return Promise.resolve(new Map(found));
    },
    removeA: (fqdn, owner) => {
      if (readOwner(fqdn) === owner) {
        records.delete(fqdn);
      }

      return Promise.resolve();
    },
  };

  return { dns, records, owners };
}

function setup(options: ServiceTestOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-https-'));
  const config = buildConfig(options.publicIp);
  const store = createCertStore(dir);
  const logs: string[] = [];
  const publicImps = [...(options.publicImps ?? [])];
  const recording = createRecordingDns();
  const tailnetIp = options.tailnetIp;
  const servePorts = options.serveHoldsHttps === true ? [config.httpsPort] : [];

  const service = createHttpsService({
    config,
    store,
    issue: options.issue,
    dns: options.dns ?? recording.dns,
    proxy: { startListener: startPlainListener },
    readTailscale:
      tailnetIp === undefined
        ? null
        : () =>
            Promise.resolve({
              state: 'Running',
              hostname: 'imp',
              dnsName: null,
              ip: tailnetIp,
              ips: [tailnetIp],
            }),
    readServePorts: () => Promise.resolve(servePorts),
    now: Date.now,
    log: (message) => {
      logs.push(message);
    },
    listPublicImps: () => Promise.resolve([...publicImps]),
    findPublicImp: (name) => {
      const found = publicImps.includes(name)
        ? {
            id: name,
            state: 'running' as const,
            stored: { auth: 'none' as const, user: null, hash: null },
          }
        : undefined;

      return Promise.resolve(found);
    },
    publicAddress: '127.0.0.1',
    ...(options.addressIntervalMs !== undefined && {
      addressIntervalMs: options.addressIntervalMs,
    }),
  });

  return {
    config,
    store,
    logs,
    records: recording.records,
    owners: recording.owners,
    publicImps,
    service,
    [Symbol.asyncDispose]: async () => {
      await service.stop();

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function readBody(address: string, port: number): Promise<string> {
  const response = await fetch(`https://${address}:${String(port)}/`, {
    headers: { host: DOMAIN },
    tls: { rejectUnauthorized: false },
    signal: AbortSignal.timeout(5000),
  });

  return response.text();
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;

  for (;;) {
    const done = await check();

    if (done) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error('timed out');
    }

    await Bun.sleep(10);
  }
}

test('start returns at once and serves the certificate when it arrives', async () => {
  const fresh = await createTestCertificate({ names: NAMES });

  const gate = Promise.withResolvers<undefined>();

  await using ctx = setup({
    issue: async () => {
      await gate.promise;

      return fresh;
    },
  });

  ctx.service.start();

  const early = await readRejection(readBody('127.0.0.1', ctx.config.httpsPort));

  expect(early).not.toBeNull();

  gate.resolve(undefined);

  await waitFor(async () => {
    const error = await readRejection(readBody('127.0.0.1', ctx.config.httpsPort));

    return error === null;
  });

  expect(ctx.logs.some((line) => line.includes('got a certificate for imp.test'))).toBe(true);

  expect(ctx.logs).toContain(
    'impd: https: no tailnet; https://<imp>.imp.test answers only inside the host container',
  );
});

test('an expired certificate on disk serves at start while renewal fails', async () => {
  const expired = await createTestCertificate({
    names: NAMES,
    notBefore: new Date(Date.now() - 100 * 86_400_000),
    notAfter: new Date(Date.now() - 86_400_000),
  });

  await using ctx = setup({ issue: () => Promise.reject(new Error('the CA is down')) });

  ctx.store.writeCertificate(expired);
  ctx.service.start();

  await waitFor(() => ctx.logs.some((line) => line.includes('the CA is down')));

  const body = await readBody('127.0.0.1', ctx.config.httpsPort);

  expect(body).toBe('served on 127.0.0.1');
  expect(ctx.logs.some((line) => line.includes('serving it until a renewal succeeds'))).toBe(true);
});

test('a bad DNS token leaves impd running and stays out of the log', async () => {
  const token = 'cf-secret-token-value';

  const cloudflare = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] },
        { status: 403 },
      ),
  });

  const dns = createCloudflareProvider({
    readToken: () => Promise.resolve(token),
    apiUrl: `http://127.0.0.1:${String(cloudflare.port)}`,
  });

  try {
    // the issuer's first DNS step, as the ACME flow takes it
    await using ctx = setup({
      dns,
      tailnetIp: TAILNET_IP,
      issue: async (domain) => {
        await dns.addTxt(`_acme-challenge.${domain}`, 'value');

        throw new Error('unreachable');
      },
    });

    ctx.service.start();

    await waitFor(
      () =>
        ctx.logs.some((line) => line.includes('no certificate for')) &&
        ctx.logs.some((line) => line.includes('cannot point')),
    );

    expect(ctx.logs.join('\n')).toContain('403 Invalid access token');
    expect(ctx.logs.join('\n')).not.toContain(token);
  } finally {
    await cloudflare.stop(true);
  }
});

test('with no DNS token, nothing serves on the HTTPS, redirect or public ports, not even plain HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-dns-token-'));
  const tokenPath = join(dir, 'dns-api-token');
  const calls: string[] = [];

  const cloudflare = Bun.serve({
    port: 0,
    fetch: (request) => {
      calls.push(request.url);

      return Response.json({ success: true, errors: [], result: [] });
    },
  });

  const dnsToken = createDnsToken({ kind: 'file', path: tokenPath }, Date.now);

  const dns = createCloudflareProvider({
    readToken: dnsToken.read,
    apiUrl: `http://127.0.0.1:${String(cloudflare.port)}`,
  });

  try {
    await using ctx = setup({
      dns,
      tailnetIp: TAILNET_IP,
      publicIp: '203.0.113.7',
      publicImps: ['web'],
      issue: async (domain) => {
        await dns.addTxt(`_acme-challenge.${domain}`, 'value');

        throw new Error('unreachable');
      },
    });

    ctx.service.start();

    await waitFor(
      () =>
        ctx.logs.some((line) => line.includes(`no certificate for imp.test: cannot read`)) &&
        ctx.logs.some((line) => line.includes('cannot point')),
    );

    const publicPorts =
      ctx.config.public === null ? [] : [ctx.config.public.httpsPort, ctx.config.public.httpPort];

    const targets = [
      ...[ctx.config.httpsPort, ctx.config.httpPort].flatMap((port) => [
        ['127.0.0.1', port] as const,
        [TAILNET_IP, port] as const,
      ]),
      ...publicPorts.map((port) => ['127.0.0.1', port] as const),
    ];

    for (const [address, port] of targets) {
      for (const scheme of ['http', 'https']) {
        const refused = await readRejection(
          fetch(`${scheme}://${address}:${String(port)}/`, {
            headers: { host: 'web.imp.test' },
            tls: { rejectUnauthorized: false },
            signal: AbortSignal.timeout(2000),
          }),
        );

        expect(refused).not.toBeNull();
      }
    }

    // no API call went out without a token, and the path, never a value,
    // is in the log
    expect(calls).toEqual([]);

    expect(ctx.logs.join('\n')).toContain(
      `cannot read the DNS API token from ${tokenPath}: ENOENT`,
    );
  } finally {
    await cloudflare.stop(true);

    rmSync(dir, { recursive: true, force: true });
  }
});

test('a records failure that repeats is logged once, until it changes', async () => {
  const recording = createRecordingDns();
  const failure = { message: 'DNS down' as string | null };
  let attempts = 0;

  const dns: DnsProvider = {
    ...recording.dns,
    setA: async (fqdn, ip, owner) => {
      attempts += 1;

      if (failure.message !== null) {
        throw new Error(failure.message);
      }

      await recording.dns.setA(fqdn, ip, owner);
    },
  };

  await using ctx = setup({
    dns,
    tailnetIp: TAILNET_IP,
    addressIntervalMs: 5,
    issue: () => Promise.reject(new Error('the CA is down')),
  });

  const readPointLogs = () => ctx.logs.filter((line) => line.includes('point'));

  ctx.service.start();

  await waitFor(() => attempts >= 5);

  failure.message = 'DNS still down';
  attempts = 0;

  await waitFor(() => attempts >= 5);

  failure.message = null;

  await waitFor(() => recording.records.get(DOMAIN) === TAILNET_IP);

  expect(readPointLogs()).toEqual([
    `impd: https: cannot point imp.test at ${TAILNET_IP}: DNS down`,
    `impd: https: cannot point imp.test at ${TAILNET_IP}: DNS still down`,
    `impd: https: imp.test and *.imp.test point at ${TAILNET_IP}`,
  ]);
});

test('the domain points at the tailnet IP, and the listeners bind it', async () => {
  const fresh = await createTestCertificate({ names: NAMES });

  await using ctx = setup({ issue: () => Promise.resolve(fresh), tailnetIp: TAILNET_IP });

  ctx.store.writeCertificate(fresh);
  ctx.service.start();

  await waitFor(() => ctx.records.size === 2);

  expect(Object.fromEntries(ctx.records)).toEqual({
    'imp.test': TAILNET_IP,
    '*.imp.test': TAILNET_IP,
  });

  const body = await readBody(TAILNET_IP, ctx.config.httpsPort);

  expect(body).toBe(`served on ${TAILNET_IP}`);
});

test('a public imp gets a record at the public IP, and loses it once it is not public', async () => {
  const fresh = await createTestCertificate({ names: NAMES });

  const publicIp = '203.0.113.7';

  await using ctx = setup({
    issue: () => Promise.resolve(fresh),
    tailnetIp: TAILNET_IP,
    publicIp,
    publicImps: ['web'],
  });

  // one left by an imp that is gone, a deeper name impd never clears, and
  // the bare domain of an impd on dev.imp.test, which is not this impd's
  ctx.records.set('old.imp.test', publicIp);
  ctx.owners.set('old.imp.test', PUBLIC_OWNER);
  ctx.records.set('a.b.imp.test', '198.51.100.1');
  ctx.owners.set('a.b.imp.test', PUBLIC_OWNER);
  ctx.records.set('dev.imp.test', '100.64.0.9');
  ctx.store.writeCertificate(fresh);
  ctx.service.start();

  await waitFor(() => ctx.records.has('web.imp.test') && !ctx.records.has('old.imp.test'));

  expect(Object.fromEntries(ctx.records)).toEqual({
    'imp.test': TAILNET_IP,
    '*.imp.test': TAILNET_IP,
    'web.imp.test': publicIp,
    'a.b.imp.test': '198.51.100.1',
    'dev.imp.test': '100.64.0.9',
  });

  expect(ctx.owners.get('web.imp.test')).toBe('impd public imps of imp.test');

  // the public listener answers on its own port
  const body = await readBody('127.0.0.1', ctx.config.public?.httpsPort ?? 0);

  expect(body).toBe('served on 127.0.0.1');

  ctx.publicImps.splice(0);

  await ctx.service.updatePublicRecords();

  expect(ctx.records.has('web.imp.test')).toBe(false);
  expect(ctx.logs).toContain('impd: https: removed web.imp.test (no longer public)');
});

test('with public mode off, the public records impd left go', async () => {
  const fresh = await createTestCertificate({ names: NAMES });

  await using ctx = setup({ issue: () => Promise.resolve(fresh), publicImps: ['web'] });

  ctx.records.set('web.imp.test', '203.0.113.7');
  ctx.owners.set('web.imp.test', PUBLIC_OWNER);
  ctx.service.start();

  await waitFor(() => !ctx.records.has('web.imp.test'));
});

test('a DNS failure on the public records is logged, and the next pass tries again', async () => {
  const fresh = await createTestCertificate({ names: NAMES });

  const recording = createRecordingDns();
  let isDown = true;

  await using ctx = setup({
    issue: () => Promise.resolve(fresh),
    dns: {
      ...recording.dns,
      listA: (domain, owner) =>
        isDown ? Promise.reject(new Error('DNS API down')) : recording.dns.listA(domain, owner),
    },
    publicIp: '203.0.113.7',
    publicImps: ['web'],
  });

  ctx.service.start();

  await waitFor(() => ctx.logs.some((line) => line.includes('public records: DNS API down')));

  expect(ctx.service.readRecordsStatus()).toMatchObject({ isOk: false, error: 'DNS API down' });

  isDown = false;

  const status = await ctx.service.updatePublicRecords();

  expect(status).toMatchObject({ isOk: true, error: null });
  expect(recording.records.get('web.imp.test')).toBe('203.0.113.7');
});

test('a tailscale serve on the HTTPS port is a warning', async () => {
  const fresh = await createTestCertificate({ names: NAMES });

  await using ctx = setup({
    issue: () => Promise.resolve(fresh),
    tailnetIp: TAILNET_IP,
    serveHoldsHttps: true,
  });

  ctx.service.start();

  await waitFor(() => ctx.logs.some((line) => line.includes('tailscale serve holds')));
});

test('a failed tailscale status keeps the tailnet listener and its connections', async () => {
  const fresh = await createTestCertificate({ names: NAMES });

  const answers: (string | null)[] = [TAILNET_IP, null, null, TAILNET_IP];
  const events: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'imp-https-'));
  const config = buildConfig();
  const store = createCertStore(dir);

  store.writeCertificate(fresh);

  const service = createHttpsService({
    config,
    store,
    issue: () => Promise.resolve(fresh),
    dns: createRecordingDns().dns,
    proxy: {
      startListener: (options) => {
        const server = startPlainListener(options);

        events.push(`start ${options.hostname ?? ''}`);

        return {
          stop: async (closeActiveConnections) => {
            events.push(`stop ${options.hostname ?? ''}`);

            await server.stop(closeActiveConnections);
          },
        };
      },
    },
    readTailscale: () => {
      const ip = answers.length === 0 ? TAILNET_IP : (answers.shift() ?? null);
      const ips = ip === null ? [] : [ip];

      return Promise.resolve({ state: 'Running', hostname: 'imp', dnsName: null, ip, ips });
    },
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: () => {},
    addressIntervalMs: 5,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
  });

  try {
    service.start();

    await waitFor(() => answers.length === 0);

    await Bun.sleep(20);

    expect(events.filter((event) => event.endsWith(TAILNET_IP))).toEqual([`start ${TAILNET_IP}`]);
  } finally {
    await service.stop();

    rmSync(dir, { recursive: true, force: true });
  }
});
