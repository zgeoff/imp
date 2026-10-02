import { expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcmeIssuer } from '../../../packages/daemon/src/https/acme/acme-issuer';
import { createCertStore } from '../../../packages/daemon/src/https/acme/cert-store';
import { createChalltestsrvProvider } from '../../../packages/daemon/src/https/dns/challtestsrv-provider';
import { createCloudflareProvider } from '../../../packages/daemon/src/https/dns/cloudflare-provider';
import { resolveImageName } from '../lib/fixtures';
import { assertState, runImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { readImpdLoggedMs, runDevScript, runInContainer } from '../lib/instance';
import { PEBBLE_DOMAIN, readPebbleEndpoints, writePebbleRoot } from '../lib/pebble';
import { readRejection } from '../lib/read-rejection';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('https');
const TINY = resolveImageName('e2e-tiny');
const name = `${prefix}a`;
const host = `${name}.${PEBBLE_DOMAIN}`;

// the root as the dev container sees it: the repo is mounted at /src
const ROOT_IN_CONTAINER = '/src/.cache/e2e/pebble-root.pem';

interface ContainerResponse {
  readonly status: number;
  readonly headers: string;
  readonly body: string;
}

// A request from inside the host container, where the listeners answer on
// loopback. The certificate must chain to Pebble's root and cover the URL's
// name; `hostHeader` can send another Host on that connection.
async function readInContainer(url: string, hostHeader?: string): Promise<ContainerResponse> {
  const target = new URL(url);

  const defaultPort = target.protocol === 'https:' ? '443' : '80';
  const port = target.port === '' ? defaultPort : target.port;

  const result = await runInContainer([
    'curl',
    '-sS',
    '--max-time',
    '30',
    '--cacert',
    ROOT_IN_CONTAINER,
    '--resolve',
    `${target.hostname}:${port}:127.0.0.1`,
    '-D',
    '/dev/stderr',
    '-o',
    '/dev/stdout',
    ...(hostHeader === undefined ? [] : ['-H', `Host: ${hostHeader}`]),
    url,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`curl ${url} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  const status = /^HTTP\/[\d.]+ (?<status>\d{3})/m.exec(result.stderr)?.groups?.['status'];

  return { status: Number(status ?? 0), headers: result.stderr, body: result.stdout.trim() };
}

test.skipIf(process.env['IMP_DOMAIN'] !== PEBBLE_DOMAIN)(
  'impd gets a wildcard certificate from Pebble and serves imps at https://<name>.<domain>',
  async () => {
    await writePebbleRoot();

    // Pebble makes a new root on every start, so a certificate from an
    // earlier run's Pebble does not chain to it: impd starts without one
    await runInContainer(['rm', '-f', '/var/lib/imp/tls/certificate.pem']);
    await runInContainer(['rm', '-f', '/var/lib/imp/tls/attempts.json']);
    await runDevScript('restart');

    // the bare domain is the API
    const health = await waitFor(
      `https://${PEBBLE_DOMAIN}/health`,
      async () => {
        const response = await readInContainer(`https://${PEBBLE_DOMAIN}/health`);

        expect(response.status).toBe(200);

        return response;
      },
      { timeoutMs: 120_000, intervalMs: 1000 },
    );

    expect(health.body).toContain('"status":"ok"');

    const issueMs = await readImpdLoggedMs(`got a certificate for ${PEBBLE_DOMAIN}`);

    writeMetric('https_issue_ms', issueMs);

    // the stored certificate: both names, root-only
    // the key in the same file never leaves this process
    const pem = await runInContainer(['cat', '/var/lib/imp/tls/certificate.pem']);

    const leafPem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem.stdout);

    const leaf = new X509Certificate(leafPem?.[0] ?? '');

    const mode = await runInContainer(['stat', '-c', '%a', '/var/lib/imp/tls/certificate.pem']);

    expect(leaf.subjectAltName).toContain(`DNS:${PEBBLE_DOMAIN}`);
    expect(leaf.subjectAltName).toContain(`DNS:*.${PEBBLE_DOMAIN}`);
    expect(mode.stdout.trim()).toBe('600');

    await createImp(name, '--image', TINY, '--memory', '512');
    await holdImp(name);

    const urls = await runImp('url', name);

    expect(urls.split('\n')[0]).toBe(`https://${host}`);

    const served = await waitFor(`https://${host}/`, async () => {
      const response = await readInContainer(`https://${host}/`);

      expect(response.status).toBe(200);

      return response;
    });

    expect(served.body).toBe('e2e-tiny-ok');

    // a request over https wakes a sleeping imp
    await runImp('hold', name, '0');
    await runImp('sleep', name);
    await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'));

    const woken = await readInContainer(`https://${host}/`);

    const wakeMs = /^x-imp-wake-ms: (?<ms>\d+)/im.exec(woken.headers)?.groups?.['ms'];

    expect(woken.body).toBe('e2e-tiny-ok');
    expect(wakeMs).toBeDefined();

    writeMetric('https_wake_ms', Number(wakeMs));

    // only one label names an imp; the certificate does not cover a.<host>
    // either, so the Host header carries it
    const nested = await readInContainer(`https://${host}/`, `a.${host}`);

    expect(nested.status).toBe(404);

    // plain http on the domain goes to https
    const redirect = await readInContainer(`http://${host}/path?q=1`);

    expect(redirect.status).toBe(308);
    expect(redirect.headers.toLowerCase()).toContain(`location: https://${host}/path?q=1`);
  },
);

test.skipIf(process.env['IMP_DOMAIN'] !== PEBBLE_DOMAIN)(
  'the issuer reports an untrusted CA and a bad DNS token in words, with no token',
  async () => {
    const endpoints = await readPebbleEndpoints();

    const dir = mkdtempSync(join(tmpdir(), 'imp-e2e-acme-'));
    const store = createCertStore(dir);
    const logs: string[] = [];

    const writeLog = (message: string): void => {
      logs.push(message);
    };

    // no CA: Pebble's TLS is not trusted
    const untrusted = createAcmeIssuer({
      directoryUrl: endpoints.directoryUrl,
      email: null,
      caPem: null,
      store,
      dns: createChalltestsrvProvider(endpoints.challtestsrvUrl),
      log: writeLog,
    });

    const tlsRejection = await readRejection(untrusted('other.test'));

    const tlsError = readMessage(tlsRejection);

    expect(tlsError).toContain(`cannot reach the ACME server at ${endpoints.directoryUrl}`);
    expect(tlsError).not.toContain('response.config');

    // a Cloudflare that refuses the token
    const token = 'e2e-secret-token';

    const cloudflare = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] },
          { status: 403 },
        ),
    });

    try {
      const refused = createAcmeIssuer({
        directoryUrl: endpoints.directoryUrl,
        email: null,
        caPem: endpoints.minicaPem,
        store,
        dns: createCloudflareProvider({
          token,
          apiUrl: `http://127.0.0.1:${String(cloudflare.port)}`,
        }),
        log: writeLog,
      });

      const dnsRejection = await readRejection(refused('other.test'));

      const dnsError = readMessage(dnsRejection);

      expect(dnsError).toContain('403 Invalid access token');
      expect(dnsError).not.toContain(token);
      expect(logs.join('\n')).not.toContain(token);
    } finally {
      await cloudflare.stop(true);

      rmSync(dir, { recursive: true, force: true });
    }
  },
);

function readMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
