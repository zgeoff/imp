// impd's ACME issuer against Pebble, Let's Encrypt's test CA, in Docker:
// `bun run test:pebble`. Plain `bun test` skips this file.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcmeIssuer } from '../../packages/daemon/src/https/acme/acme-issuer';
import type { AcmeIssuerOptions } from '../../packages/daemon/src/https/acme/acme-issuer';
import { createCertStore } from '../../packages/daemon/src/https/acme/cert-store';
import { createChalltestsrvProvider } from '../../packages/daemon/src/https/dns/challtestsrv-provider';
import { createCloudflareProvider } from '../../packages/daemon/src/https/dns/cloudflare-provider';
import type { PebbleEndpoints } from '../e2e/lib/pebble';
import { startPebbleStack, stopPebbleStack } from '../e2e/lib/pebble';
import { readRejection } from '../e2e/lib/read-rejection';

// per run, so two runs on one machine never remove each other's containers
const PREFIX = `imp-acme-it-${String(process.pid)}`;

// an issuance; the renewal test makes two, and a slow runner needs the room
const ISSUE_TIMEOUT_MS = 60_000;
const dir = mkdtempSync(join(tmpdir(), 'imp-acme-it-'));
const logs: string[] = [];
const state: { endpoints: PebbleEndpoints | null } = { endpoints: null };

beforeAll(async () => {
  state.endpoints = await startPebbleStack(PREFIX);
}, 120_000);

afterAll(async () => {
  await stopPebbleStack(PREFIX);

  rmSync(dir, { recursive: true, force: true });
});

function requireEndpoints(): PebbleEndpoints {
  if (state.endpoints === null) {
    throw new Error('Pebble did not start');
  }

  return state.endpoints;
}

function buildOptions(overrides: Partial<AcmeIssuerOptions>): AcmeIssuerOptions {
  const endpoints = requireEndpoints();

  return {
    directoryUrl: endpoints.directoryUrl,
    email: null,
    caPem: endpoints.minicaPem,
    store: createCertStore(dir),
    dns: createChalltestsrvProvider(endpoints.challtestsrvUrl),
    log: (message) => {
      logs.push(message);
    },
    ...overrides,
  };
}

function readMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

test(
  'it issues one certificate for the domain and its wildcard',
  async () => {
    const issue = createAcmeIssuer(buildOptions({}));

    const certificate = await issue('imp.test');

    const leaf = new X509Certificate(certificate.chainPem);

    expect(leaf.subjectAltName).toContain('DNS:imp.test');
    expect(leaf.subjectAltName).toContain('DNS:*.imp.test');
    expect(certificate.keyPem).toContain('PRIVATE KEY');
  },
  ISSUE_TIMEOUT_MS,
);

test(
  'a renewal uses the account the stored key already has',
  async () => {
    const issue = createAcmeIssuer(buildOptions({}));

    const first = await issue('imp.test');
    const second = await issue('imp.test');

    expect(second.chainPem).not.toBe(first.chainPem);
  },
  ISSUE_TIMEOUT_MS,
);

test(
  'a lost account file means a new account, and still a certificate',
  async () => {
    const first = createAcmeIssuer(buildOptions({}));

    await first('imp.test');

    // what the https e2e suite does between runs, when Pebble starts afresh
    rmSync(join(dir, 'tls', 'account.json'), { force: true });

    const second = createAcmeIssuer(buildOptions({}));

    const certificate = await second('imp.test');

    expect(certificate.chainPem).toContain('BEGIN CERTIFICATE');
  },
  ISSUE_TIMEOUT_MS,
);

test('an untrusted ACME server fails in words, not as an axios crash', async () => {
  const issue = createAcmeIssuer(buildOptions({ caPem: null }));

  const error = await readRejection(issue('imp.test'));

  const message = readMessage(error);

  expect(message).toContain(`cannot reach the ACME server at ${requireEndpoints().directoryUrl}`);
  expect(message).not.toContain('response.config');
});

test('a DNS provider that refuses the token fails with its reason, and no token', async () => {
  const token = 'integration-secret-token';

  const cloudflare = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      Response.json(
        { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] },
        { status: 403 },
      ),
  });

  try {
    const dns = createCloudflareProvider({
      token,
      apiUrl: `http://127.0.0.1:${String(cloudflare.port)}`,
    });

    const issue = createAcmeIssuer(buildOptions({ dns }));

    // a domain of its own: Pebble may reuse the account's valid imp.test
    // authorizations, and then never asks for a TXT record
    const error = await readRejection(issue('refused.test'));

    const message = readMessage(error);

    expect(message).toContain('403 Invalid access token');
    expect(message).not.toContain(token);
    expect(logs.join('\n')).not.toContain(token);
  } finally {
    await cloudflare.stop(true);
  }
});
