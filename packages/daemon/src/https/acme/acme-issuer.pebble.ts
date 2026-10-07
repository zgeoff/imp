// impd's ACME issuer against Pebble, Let's Encrypt's test CA, in Docker:
// `bun run test:pebble`. Plain `bun test` skips this file.
import { expect, test } from 'bun:test';
import { X509Certificate, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { server } from '@imp/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { startPebbleStack, stopPebbleStack } from '../../../../../test/e2e/lib/pebble';
import { createChalltestsrvProvider } from '../dns/challtestsrv-provider';
import { createCloudflareProvider } from '../dns/cloudflare-provider';
import { createAcmeIssuer } from './acme-issuer';
import { createCertStore } from './cert-store';

// A Pebble and challtestsrv of the test's own, under a second to start and
// about a second to stop, and a cert store in a temp dir.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  // per run and per test, so neither another run on this machine nor a stack
  // an earlier test left behind ever holds this test's container names
  const prefix = `imp-acme-it-${String(process.pid)}-${randomUUID().slice(0, 8)}`;

  stack.defer(() => stopPebbleStack(prefix));

  const pebble = await startPebbleStack(prefix);
  const dir = await mkdtemp(join(tmpdir(), 'imp-acme-it-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  return { pebble, dir, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it issues one certificate for the domain and its wildcard', async () => {
  await using ctx = await setupTest();

  const issue = createAcmeIssuer({
    directoryUrl: ctx.pebble.directoryUrl,
    email: null,
    caPem: ctx.pebble.minicaPem,
    store: createCertStore(ctx.dir),
    dns: createChalltestsrvProvider(ctx.pebble.challtestsrvUrl),
    log: () => {},
  });

  const certificate = await issue('imp.test');

  expect(new X509Certificate(certificate.chainPem).subjectAltName).toBe(
    'DNS:imp.test, DNS:*.imp.test',
  );

  expect(certificate.keyPem).toMatch(
    /^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n?$/u,
  );
});

test('it renews with the account the stored key already has', async () => {
  await using ctx = await setupTest();

  const issue = createAcmeIssuer({
    directoryUrl: ctx.pebble.directoryUrl,
    email: null,
    caPem: ctx.pebble.minicaPem,
    store: createCertStore(ctx.dir),
    dns: createChalltestsrvProvider(ctx.pebble.challtestsrvUrl),
    log: () => {},
  });

  const store = createCertStore(ctx.dir);

  const first = await issue('imp.test');

  const account = store.readAccount(ctx.pebble.directoryUrl);

  invariant(account);

  const second = await issue('imp.test');

  expect(second.chainPem).not.toBe(first.chainPem);
  expect(store.readAccount(ctx.pebble.directoryUrl)).toStrictEqual(account);
});

test('it opens a new account and still issues when the account file is lost', async () => {
  await using ctx = await setupTest();

  const first = createAcmeIssuer({
    directoryUrl: ctx.pebble.directoryUrl,
    email: null,
    caPem: ctx.pebble.minicaPem,
    store: createCertStore(ctx.dir),
    dns: createChalltestsrvProvider(ctx.pebble.challtestsrvUrl),
    log: () => {},
  });

  const store = createCertStore(ctx.dir);

  await first('imp.test');

  const lost = store.readAccount(ctx.pebble.directoryUrl);

  invariant(lost);

  // what the https e2e suite does between runs, when Pebble starts afresh
  await rm(join(ctx.dir, 'tls', 'account.json'));

  const second = createAcmeIssuer({
    directoryUrl: ctx.pebble.directoryUrl,
    email: null,
    caPem: ctx.pebble.minicaPem,
    store: createCertStore(ctx.dir),
    dns: createChalltestsrvProvider(ctx.pebble.challtestsrvUrl),
    log: () => {},
  });

  const certificate = await second('imp.test');

  const opened = store.readAccount(ctx.pebble.directoryUrl);

  invariant(opened);

  expect(opened.url).not.toBe(lost.url);
  expect(opened.keyPem).not.toBe(lost.keyPem);

  expect(new X509Certificate(certificate.chainPem).subjectAltName).toBe(
    'DNS:imp.test, DNS:*.imp.test',
  );
});

test('it rejects an untrusted ACME server in words, not as an axios crash', async () => {
  await using ctx = await setupTest();

  const issue = createAcmeIssuer({
    directoryUrl: ctx.pebble.directoryUrl,
    email: null,
    caPem: null,
    store: createCertStore(ctx.dir),
    dns: createChalltestsrvProvider(ctx.pebble.challtestsrvUrl),
    log: () => {},
  });

  expect(issue('imp.test')).rejects.toThrowWithMessage(
    Error,
    `cannot reach the ACME server at ${ctx.pebble.directoryUrl}: unable to verify the first certificate`,
  );
});

test('it rejects an ACME directory that answers with an error status', async () => {
  await using ctx = await setupTest();

  const issue = createAcmeIssuer({
    directoryUrl: `${ctx.pebble.directoryUrl}-missing`,
    email: null,
    caPem: ctx.pebble.minicaPem,
    store: createCertStore(ctx.dir),
    dns: createChalltestsrvProvider(ctx.pebble.challtestsrvUrl),
    log: () => {},
  });

  expect(issue('imp.test')).rejects.toThrowWithMessage(
    Error,
    `cannot reach the ACME server at ${ctx.pebble.directoryUrl}-missing: HTTP 404`,
  );
});

test('it rejects with the DNS provider reason, and no token, when the provider refuses the token', async () => {
  await using ctx = await setupTest();

  server.use(
    http.all('https://api.cloudflare.com/client/v4/*', () =>
      HttpResponse.json(
        { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] },
        { status: 403 },
      ),
    ),
  );

  const logs: string[] = [];

  const issue = createAcmeIssuer({
    directoryUrl: ctx.pebble.directoryUrl,
    email: null,
    caPem: ctx.pebble.minicaPem,
    store: createCertStore(ctx.dir),
    dns: createCloudflareProvider({ readToken: () => Promise.resolve('integration-secret-token') }),
    log: (message) => {
      logs.push(message);
    },
  });

  const issued = issue('imp.test');

  expect(issued).rejects.toThrowWithMessage(
    Error,
    'Cloudflare GET /zones: 403 Invalid access token',
  );

  expect(logs).toStrictEqual([]);
});
