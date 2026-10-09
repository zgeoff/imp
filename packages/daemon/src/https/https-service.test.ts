import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { server } from '@imp/test-utils/mock-server';
import { waitFor } from '@imp/test-utils/wait-for';
import { HttpResponse, http } from 'msw';
import { buildMockCertificate } from '../test-utils/build-mock-certificate';
import { buildStubCloudflareApi } from '../test-utils/build-stub-cloudflare-api';
import { buildStubProxyListen } from '../test-utils/build-stub-proxy-listen';
import { buildStubTickerTimer } from '../test-utils/build-stub-ticker-timer';
import type { Certificate } from './acme/cert-store';
import { createCertStore } from './acme/cert-store';
import { createCloudflareProvider } from './dns/cloudflare-provider';
import { createDnsToken } from './dns/dns-token';
import { createHttpsService } from './https-service';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imp-https-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const logs: string[] = [];

  return {
    dir,
    store: createCertStore(dir),
    logs,
    log: (message: string) => {
      logs.push(message);
    },
    timer: buildStubTickerTimer(),
    proxy: buildStubProxyListen(),
  };
}

test('it serves nothing until the first certificate arrives', async () => {
  const ctx = await setupTest();

  const issued = Promise.withResolvers<Certificate>();
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => issued.promise,
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  onTestFinished(async () => {
    const arrived = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

    issued.resolve(arrived);
  });

  service.start();

  expect(service.readPorts().tailnet).toStrictEqual({ https: null, http: null });
});

test('it serves the certificate on loopback once it arrives', async () => {
  const ctx = await setupTest();

  const issued = Promise.withResolvers<Certificate>();
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => issued.promise,
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  const arrived = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  issued.resolve(arrived);

  const port = await waitFor(() => {
    const https = service.readPorts().tailnet.https;

    expect(https).toBeNumber();

    return https;
  });

  const response = await fetch(`https://127.0.0.1:${String(port)}/`, {
    headers: { host: 'imp.test' },
    tls: { rejectUnauthorized: false },
  });

  const body = await response.text();

  expect(body).toBe('served on 127.0.0.1');
});

test('it logs the certificate it got', async () => {
  const ctx = await setupTest();

  const certificate = await buildMockCertificate({
    names: ['imp.test', '*.imp.test'],
    notBefore: new Date('2030-01-01T00:00:00Z'),
    notAfter: new Date('2030-03-01T00:00:00Z'),
  });

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.resolve(certificate),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: () => Date.parse('2030-01-02T00:00:00Z'),
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.logs).toContain(
      'impd: https: got a certificate for imp.test, expiring 2030-03-01T00:00:00.000Z, in 0ms',
    );
  });
});

test('it says the domain answers only inside the host container when there is no tailnet', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  expect(ctx.logs).toContain(
    'impd: https: no tailnet; https://<imp>.imp.test answers only inside the host container',
  );
});

test('it serves an expired certificate on disk at start while renewal fails', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const expired = await buildMockCertificate({
    names: ['imp.test', '*.imp.test'],
    notBefore: new Date(Date.now() - 100 * 86_400_000),
    notAfter: new Date(Date.now() - 86_400_000),
  });

  ctx.store.writeCertificate(expired);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('the CA is down'));
  });

  const response = await fetch(`https://127.0.0.1:${String(service.readPorts().tailnet.https)}/`, {
    headers: { host: 'imp.test' },
    tls: { rejectUnauthorized: false },
  });

  const body = await response.text();

  expect(body).toBe('served on 127.0.0.1');
});

test('it says it serves an expired certificate until a renewal succeeds', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const expired = await buildMockCertificate({
    names: ['imp.test', '*.imp.test'],
    notBefore: new Date('2030-01-01T00:00:00Z'),
    notAfter: new Date('2030-02-01T00:00:00Z'),
  });

  ctx.store.writeCertificate(expired);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: () => Date.parse('2030-03-01T00:00:00Z'),
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  expect(ctx.logs).toContain(
    'impd: https: the stored certificate expired 2030-02-01T00:00:00.000Z; serving it until a renewal succeeds',
  );
});

test('it logs Cloudflare’s refusal of a bad DNS token', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['the-right-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const dns = createCloudflareProvider({ readToken: () => Promise.resolve('cf-secret-token') });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'x' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,

    // the issuer's first DNS step, as the ACME flow takes it
    issue: async (domain) => {
      await dns.addTxt(`_acme-challenge.${domain}`, 'value');

      throw new Error('the issuer went on past a refused DNS step');
    },
    dns,
    proxy: ctx.proxy,
    readTailscale: () =>
      Promise.resolve({
        state: 'Running',
        hostname: 'imp',
        dnsName: null,
        ip: '127.0.0.2',
        ips: ['127.0.0.2'],
      }),
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('cannot point'));
  });

  expect(ctx.logs.filter((line) => line.includes('cannot point'))).toStrictEqual([
    'impd: https: cannot point imp.test at 127.0.0.2: Cloudflare GET /zones: 403 Invalid access token',
  ]);
});

test('it keeps a bad DNS token out of the log', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['the-right-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const dns = createCloudflareProvider({ readToken: () => Promise.resolve('cf-secret-token') });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'x' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,

    // the issuer's first DNS step, as the ACME flow takes it
    issue: async (domain) => {
      await dns.addTxt(`_acme-challenge.${domain}`, 'value');

      throw new Error('the issuer went on past a refused DNS step');
    },
    dns,
    proxy: ctx.proxy,
    readTailscale: () =>
      Promise.resolve({
        state: 'Running',
        hostname: 'imp',
        dnsName: null,
        ip: '127.0.0.2',
        ips: ['127.0.0.2'],
      }),
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('cannot point'));
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('no certificate for'));
  });

  expect(ctx.logs).toSatisfyAll((line: string) => !line.includes('cf-secret-token'));
});

test('it serves nothing on any port without a DNS token file', async () => {
  const ctx = await setupTest();

  const tokenPath = join(ctx.dir, 'dns-api-token');
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const dnsToken = createDnsToken({ kind: 'file', path: tokenPath }, Date.now);
  const dns = createCloudflareProvider({ readToken: dnsToken.read });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'file', path: tokenPath }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: { ip: '203.0.113.7', httpsPort: 0, httpPort: 0 },
    },
    store: ctx.store,

    // the issuer's first DNS step, as the ACME flow takes it
    issue: async (domain) => {
      await dns.addTxt(`_acme-challenge.${domain}`, 'value');

      throw new Error('the issuer went on past a DNS step with no token');
    },
    dns,
    proxy: ctx.proxy,
    readTailscale: () =>
      Promise.resolve({
        state: 'Running',
        hostname: 'imp',
        dnsName: null,
        ip: '127.0.0.2',
        ips: ['127.0.0.2'],
      }),
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve(['web']),
    findPublicImp: () =>
      Promise.resolve({
        id: 'i1',
        state: 'running',
        stored: { auth: 'none', user: null, hash: null },
      }),
    publicAddress: '127.0.0.1',
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('no certificate for imp.test'));
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('cannot point'));
  });

  expect(service.readPorts()).toStrictEqual({
    tailnet: { https: null, http: null },
    public: { https: null, http: null },
  });
});

test('it sends Cloudflare no call without a DNS token file', async () => {
  const ctx = await setupTest();

  const tokenPath = join(ctx.dir, 'dns-api-token');
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const dnsToken = createDnsToken({ kind: 'file', path: tokenPath }, Date.now);
  const dns = createCloudflareProvider({ readToken: dnsToken.read });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'file', path: tokenPath }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: { ip: '203.0.113.7', httpsPort: 0, httpPort: 0 },
    },
    store: ctx.store,

    // the issuer's first DNS step, as the ACME flow takes it
    issue: async (domain) => {
      await dns.addTxt(`_acme-challenge.${domain}`, 'value');

      throw new Error('the issuer went on past a DNS step with no token');
    },
    dns,
    proxy: ctx.proxy,
    readTailscale: () =>
      Promise.resolve({
        state: 'Running',
        hostname: 'imp',
        dnsName: null,
        ip: '127.0.0.2',
        ips: ['127.0.0.2'],
      }),
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve(['web']),
    findPublicImp: () => Promise.resolve(undefined),
    publicAddress: '127.0.0.1',
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('no certificate for imp.test'));
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('cannot point'));
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('public records'));
  });

  expect(api.requests).toStrictEqual([]);
});

test('it names the missing DNS token file in the log', async () => {
  const ctx = await setupTest();

  const tokenPath = join(ctx.dir, 'dns-api-token');
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const dnsToken = createDnsToken({ kind: 'file', path: tokenPath }, Date.now);
  const dns = createCloudflareProvider({ readToken: dnsToken.read });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'file', path: tokenPath }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns,
    proxy: ctx.proxy,
    readTailscale: () =>
      Promise.resolve({
        state: 'Running',
        hostname: 'imp',
        dnsName: null,
        ip: '127.0.0.2',
        ips: ['127.0.0.2'],
      }),
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.logs).toContain(
      `impd: https: cannot point imp.test at 127.0.0.2: cannot read the DNS API token from ${tokenPath}: ENOENT`,
    );
  });
});

test('it logs a records failure that repeats once, until it changes', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });
  const failure: { message: string | null } = { message: 'DNS down' };

  // Cloudflare fails each list of the zone's records while `failure` holds
  // a message, then answers again
  server.use(
    http.get('https://api.cloudflare.com/client/v4/zones/:zoneId/dns_records', () =>
      failure.message === null
        ? undefined
        : HttpResponse.json(
            { success: false, errors: [{ code: 1000, message: failure.message }], result: null },
            { status: 500 },
          ),
    ),
    ...api.handlers,
  );

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: () =>
      Promise.resolve({
        state: 'Running',
        hostname: 'imp',
        dnsName: null,
        ip: '127.0.0.2',
        ips: ['127.0.0.2'],
      }),
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('cannot point'));
  });

  await ctx.timer.fire('https addresses');

  failure.message = 'DNS still down';

  await ctx.timer.fire('https addresses');
  await ctx.timer.fire('https addresses');

  failure.message = null;

  await ctx.timer.fire('https addresses');

  expect(ctx.logs.filter((line) => line.includes('point'))).toStrictEqual([
    'impd: https: cannot point imp.test at 127.0.0.2: Cloudflare GET /zones/z1/dns_records: 500 DNS down',
    'impd: https: cannot point imp.test at 127.0.0.2: Cloudflare GET /zones/z1/dns_records: 500 DNS still down',
    'impd: https: imp.test and *.imp.test point at 127.0.0.2',
  ]);
});

test('it points the domain and its wildcard at the tailnet IP', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: () =>
      Promise.resolve({
        state: 'Running',
        hostname: 'imp',
        dnsName: null,
        ip: '127.0.0.2',
        ips: ['127.0.0.2'],
      }),
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.logs).toContain('impd: https: imp.test and *.imp.test point at 127.0.0.2');
  });

  expect(
    api.readRecords().map((record) => [record.name, record.type, record.content, record.comment]),
  ).toIncludeSameMembers([
    ['imp.test', 'A', '127.0.0.2', 'managed by impd'],
    ['*.imp.test', 'A', '127.0.0.2', 'managed by impd'],
  ]);
});

test('it serves the domain on the tailnet IP', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  ctx.store.writeCertificate(certificate);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: () =>
      Promise.resolve({
        state: 'Running',
        hostname: 'imp',
        dnsName: null,
        ip: '127.0.0.2',
        ips: ['127.0.0.2'],
      }),
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.proxy.events).toContain('start 127.0.0.2');
  });

  const response = await fetch(`https://127.0.0.2:${String(service.readPorts().tailnet.https)}/`, {
    headers: { host: 'imp.test' },
    tls: { rejectUnauthorized: false },
  });

  const body = await response.text();

  expect(body).toBe('served on 127.0.0.2');
});

test('it keeps the public records in line with the public imps, and leaves the rest', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  // one left by an imp that is gone, a deeper name impd never clears, and
  // the bare domain of an impd on dev.imp.test, which is not this impd's
  await api.records.create({
    zone_id: 'z1',
    name: 'old.imp.test',
    content: '203.0.113.7',
    comment: 'impd public imps of imp.test',
  });

  await api.records.create({
    zone_id: 'z1',
    name: 'a.b.imp.test',
    content: '198.51.100.1',
    comment: 'impd public imps of imp.test',
  });

  await api.records.create({
    zone_id: 'z1',
    name: 'dev.imp.test',
    content: '100.64.0.9',
    comment: 'managed by impd',
  });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: { ip: '203.0.113.7', httpsPort: 0, httpPort: 0 },
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve(['web']),
    findPublicImp: () => Promise.resolve(undefined),
    publicAddress: '127.0.0.1',
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  const status = await service.updatePublicRecords();

  expect(status.isOk).toBeTrue();

  expect(
    api.readRecords().map((record) => [record.name, record.content, record.comment]),
  ).toIncludeSameMembers([
    ['a.b.imp.test', '198.51.100.1', 'impd public imps of imp.test'],
    ['dev.imp.test', '100.64.0.9', 'managed by impd'],
    ['web.imp.test', '203.0.113.7', 'impd public imps of imp.test'],
  ]);
});

test('it removes the record of an imp that is no longer public, and says so', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  await api.records.create({
    zone_id: 'z1',
    name: 'web.imp.test',
    content: '203.0.113.7',
    comment: 'impd public imps of imp.test',
  });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: { ip: '203.0.113.7', httpsPort: 0, httpPort: 0 },
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    publicAddress: '127.0.0.1',
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  await service.updatePublicRecords();

  expect(api.readRecords()).toStrictEqual([]);
  expect(ctx.logs).toContain('impd: https: removed web.imp.test (no longer public)');
});

test('it serves the public listener on its own port', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  ctx.store.writeCertificate(certificate);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: { ip: '203.0.113.7', httpsPort: 0, httpPort: 0 },
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve(['web']),
    findPublicImp: () => Promise.resolve(undefined),
    publicAddress: '127.0.0.1',
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  const ports = service.readPorts();

  invariant(ports.public?.https);

  const response = await fetch(`https://127.0.0.1:${String(ports.public.https)}/`, {
    headers: { host: 'web.imp.test' },
    tls: { rejectUnauthorized: false },
  });

  expect(ports.public.https).not.toBe(ports.tailnet.https);

  const body = await response.text();

  expect(body).toBe('served on 127.0.0.1');
});

test('it takes the public records impd left when public mode is off', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  await api.records.create({
    zone_id: 'z1',
    name: 'web.imp.test',
    content: '203.0.113.7',
    comment: 'impd public imps of imp.test',
  });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve(['web']),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  await service.updatePublicRecords();

  expect(api.readRecords()).toStrictEqual([]);
});

test('it logs a DNS failure on the public records', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(
    http.get('https://api.cloudflare.com/client/v4/zones/:zoneId/dns_records', () =>
      HttpResponse.json(
        { success: false, errors: [{ code: 1000, message: 'DNS API down' }], result: null },
        { status: 500 },
      ),
    ),
    ...api.handlers,
  );

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: { ip: '203.0.113.7', httpsPort: 0, httpPort: 0 },
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve(['web']),
    findPublicImp: () => Promise.resolve(undefined),
    publicAddress: '127.0.0.1',
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  await service.updatePublicRecords();

  expect(ctx.logs).toContain(
    'impd: https: public records: Cloudflare GET /zones/z1/dns_records: 500 DNS API down',
  );
});

test('it reports a failed pass over the public records', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(
    http.get('https://api.cloudflare.com/client/v4/zones/:zoneId/dns_records', () =>
      HttpResponse.json(
        { success: false, errors: [{ code: 1000, message: 'DNS API down' }], result: null },
        { status: 500 },
      ),
    ),
    ...api.handlers,
  );

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: { ip: '203.0.113.7', httpsPort: 0, httpPort: 0 },
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: () => 1_800_000_000_000,
    log: ctx.log,
    listPublicImps: () => Promise.resolve(['web']),
    findPublicImp: () => Promise.resolve(undefined),
    publicAddress: '127.0.0.1',
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  await service.updatePublicRecords();

  expect(service.readRecordsStatus()).toStrictEqual({
    isOk: false,
    error: 'Cloudflare GET /zones/z1/dns_records: 500 DNS API down',
    at: 1_800_000_000_000,
  });
});

test('it writes the public records on the pass after one that failed', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });
  const outage = { isDown: true };

  // Cloudflare fails each list of the zone's records until the outage ends
  server.use(
    http.get('https://api.cloudflare.com/client/v4/zones/:zoneId/dns_records', () =>
      outage.isDown
        ? HttpResponse.json(
            { success: false, errors: [{ code: 1000, message: 'DNS API down' }], result: null },
            { status: 500 },
          )
        : undefined,
    ),
    ...api.handlers,
  );

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: { ip: '203.0.113.7', httpsPort: 0, httpPort: 0 },
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: () => 1_800_000_000_000,
    log: ctx.log,
    listPublicImps: () => Promise.resolve(['web']),
    findPublicImp: () => Promise.resolve(undefined),
    publicAddress: '127.0.0.1',
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  const failed = await service.updatePublicRecords();

  outage.isDown = false;

  const status = await service.updatePublicRecords();

  expect(failed.isOk).toBeFalse();
  expect(status).toStrictEqual({ isOk: true, error: null, at: 1_800_000_000_000 });

  expect(api.readRecords().map((record) => [record.name, record.content])).toStrictEqual([
    ['web.imp.test', '203.0.113.7'],
  ]);
});

test('it warns that tailscale serve holds the tailnet HTTPS port', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 8443,
      httpPort: 8080,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: () =>
      Promise.resolve({
        state: 'Running',
        hostname: 'imp',
        dnsName: null,
        ip: '127.0.0.2',
        ips: ['127.0.0.2'],
      }),
    readServePorts: () => Promise.resolve([8443]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.logs).toContain(
      'impd: https: warning: tailscale serve holds tailnet port 8443, so impd never sees that traffic; remove it with `tailscale serve --https=8443 off` or `tailscale serve reset`',
    );
  });
});

test('it keeps the tailnet listener and its connections when a tailscale status fails', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });
  const answers: (string | null)[] = ['127.0.0.2', null, null, '127.0.0.2'];

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  ctx.store.writeCertificate(certificate);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,

    // the tailnet IP, then two failed reads, then the IP again
    readTailscale: () => {
      const ip = answers.shift() ?? null;

      return Promise.resolve({
        state: 'Running',
        hostname: 'imp',
        dnsName: null,
        ip,
        ips: ip === null ? [] : [ip],
      });
    },
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.proxy.events).toContain('start 127.0.0.2');
  });

  await ctx.timer.fire('https addresses');
  await ctx.timer.fire('https addresses');
  await ctx.timer.fire('https addresses');

  expect(answers).toStrictEqual([]);

  expect(ctx.proxy.events.filter((event) => event.endsWith('127.0.0.2'))).toStrictEqual([
    'start 127.0.0.2',
  ]);
});

test('it logs an address pass that fails', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: () => Promise.reject(new Error('tailscaled is not running')),
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await waitFor(() => {
    expect(ctx.logs).toContain('impd: https: addresses: tailscaled is not running');
  });
});

test('it runs renewal and the public records every 10 minutes, and the addresses every 30 seconds', async () => {
  const ctx = await setupTest();

  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  expect(ctx.timer.readDelays()).toStrictEqual({
    'https renewal': 600_000,
    'https public records': 600_000,
    'https addresses': 30_000,
  });
});

test('it starts no listener for a certificate that arrives after it stopped', async () => {
  const ctx = await setupTest();

  const issued = Promise.withResolvers<Certificate>();
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const service = createHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
      acmeDirectory: 'https://acme.invalid/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    store: ctx.store,
    issue: () => issued.promise,
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') }),
    proxy: ctx.proxy,
    readTailscale: null,
    readServePorts: () => Promise.resolve([]),
    now: Date.now,
    log: ctx.log,
    listPublicImps: () => Promise.resolve([]),
    findPublicImp: () => Promise.resolve(undefined),
    timer: ctx.timer.timer,
  });

  onTestFinished(() => service.stop());

  service.start();

  await service.stop();

  const arrived = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  issued.resolve(arrived);

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('got a certificate'));
  });

  expect(ctx.proxy.events).toStrictEqual([]);
});
