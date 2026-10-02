import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFreePorts } from '../net/test-free-ports';
import type { ProxyListenOptions } from '../proxy/wake-proxy';
import { readRejection } from '../read-rejection';
import type { Certificate } from './acme/cert-store';
import { createCertStore } from './acme/cert-store';
import { createCloudflareProvider } from './dns/cloudflare-provider';
import type { DnsProvider } from './dns/dns-provider';
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
}

function buildConfig(): HttpsConfig {
  const ports = findFreePorts(2);

  return {
    domain: DOMAIN,
    httpsPort: ports.take(),
    httpPort: ports.take(),
    dns: { provider: 'cloudflare', apiToken: 'unused', apiUrl: null },
    acmeDirectory: 'https://acme.invalid/directory',
    acmeEmail: null,
    acmeCaFile: null,
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
function createRecordingDns(): {
  readonly dns: DnsProvider;
  readonly records: Map<string, string>;
} {
  const records = new Map<string, string>();

  const dns: DnsProvider = {
    addTxt: (fqdn, value) => Promise.resolve({ fqdn, value, id: value }),
    removeTxt: () => Promise.resolve(),
    waitForTxt: () => Promise.resolve(),
    setA: (fqdn, ip) => {
      records.set(fqdn, ip);

      return Promise.resolve();
    },
  };

  return { dns, records };
}

function setup(options: ServiceTestOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-https-'));
  const config = buildConfig();
  const store = createCertStore(dir);
  const logs: string[] = [];
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
  });

  return {
    config,
    store,
    logs,
    records: recording.records,
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
    token,
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
