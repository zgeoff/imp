import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockCertificate } from '../../test-utils/build-mock-certificate';
import { createDnsToken } from '../dns/dns-token';
import { createCertManager } from './cert-manager';
import type { Certificate } from './cert-store';
import { createCertStore } from './cert-store';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imp-certs-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir, store: createCertStore(dir) };
}

test('it loads no certificate before one is issued', async () => {
  const ctx = await setupTest();

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: mock(),
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log: () => {},
  });

  expect(manager.load()).toBeNull();
});

test('it issues and stores a certificate when there is none', async () => {
  const ctx = await setupTest();
  const fresh = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: () => Promise.resolve(fresh),
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log: () => {},
  });

  const renewed = await manager.renew();

  expect(renewed).toStrictEqual(fresh);

  expect(manager.load()).toStrictEqual({
    keyPem: fresh.keyPem.trimEnd(),
    chainPem: fresh.chainPem.trimEnd(),
  });

  expect(ctx.store.readAttempts()).toStrictEqual({
    failures: 0,
    lastAttemptAt: Date.parse('2030-01-10T00:00:00Z'),
    lastError: null,
  });
});

test('it logs what it asks the CA for and why', async () => {
  const ctx = await setupTest();
  const fresh = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  const log = mock<(message: string) => void>();

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: () => Promise.resolve(fresh),
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log,
  });

  await manager.renew();

  expect(log).toHaveBeenCalledWith(
    'impd: https: asking for a certificate for imp.test and *.imp.test: there is no certificate',
  );
});

test('it logs the new certificate’s expiry and how long the CA took', async () => {
  const ctx = await setupTest();

  const clock = { now: Date.parse('2030-01-10T00:00:00Z') };
  const log = mock<(message: string) => void>();

  const fresh = await buildMockCertificate({
    names: ['imp.test', '*.imp.test'],
    notBefore: new Date('2030-01-10T00:00:00Z'),
    notAfter: new Date('2030-04-10T00:00:00Z'),
  });

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: () => {
      clock.now += 1234;

      return Promise.resolve(fresh);
    },
    now: () => clock.now,
    log,
  });

  await manager.renew();

  expect(log).toHaveBeenLastCalledWith(
    'impd: https: got a certificate for imp.test, expiring 2030-04-10T00:00:00.000Z, in 1234ms',
  );
});

test('it asks the CA nothing while the stored certificate is fresh', async () => {
  const ctx = await setupTest();

  const issue = mock();

  const fresh = await buildMockCertificate({
    names: ['imp.test', '*.imp.test'],
    notBefore: new Date('2030-01-01T00:00:00Z'),
    notAfter: new Date('2030-04-01T00:00:00Z'),
  });

  ctx.store.writeCertificate(fresh);

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue,
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log: () => {},
  });

  const renewed = await manager.renew();

  expect(renewed).toBeNull();
  expect(issue).not.toHaveBeenCalled();
});

test('it records a failed attempt and logs when it tries next', async () => {
  const ctx = await setupTest();

  const log = mock<(message: string) => void>();

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: () => Promise.reject(new Error('Cloudflare POST /zones/z1/dns_records: 403 bad token')),
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log,
  });

  const renewed = await manager.renew();

  expect(renewed).toBeNull();

  expect(ctx.store.readAttempts()).toStrictEqual({
    failures: 1,
    lastAttemptAt: Date.parse('2030-01-10T00:00:00Z'),
    lastError: 'Cloudflare POST /zones/z1/dns_records: 403 bad token',
  });

  expect(log).toHaveBeenLastCalledWith(
    'impd: https: no certificate for imp.test: Cloudflare POST /zones/z1/dns_records: 403 bad token; the next try is after 2030-01-10T00:15:00.000Z',
  );
});

test('it counts an attempt as failed while it runs, so a crash still backs off', async () => {
  const ctx = await setupTest();

  const seen: number[] = [];

  const fresh = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: () => {
      seen.push(ctx.store.readAttempts().failures);

      return Promise.resolve(fresh);
    },
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log: () => {},
  });

  await manager.renew();

  expect(seen).toStrictEqual([1]);
});

test('it keeps a restarted manager to the backoff a failure stored', async () => {
  const ctx = await setupTest();

  const clock = { now: Date.parse('2030-01-10T00:00:00Z') };
  const issue = mock(() => Promise.reject(new Error('still failing')));

  await createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    now: () => clock.now,
    log: () => {},
  }).renew();

  const restarted = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue,
    now: () => clock.now,
    log: () => {},
  });

  clock.now += 14 * 60_000;

  const renewed = await restarted.renew();

  expect(renewed).toBeNull();
  expect(issue).not.toHaveBeenCalled();
});

test('it asks again once the stored backoff has passed', async () => {
  const ctx = await setupTest();

  const clock = { now: Date.parse('2030-01-10T00:00:00Z') };
  const issue = mock(() => Promise.reject(new Error('still failing')));

  await createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    now: () => clock.now,
    log: () => {},
  }).renew();

  const restarted = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue,
    now: () => clock.now,
    log: () => {},
  });

  clock.now += 15 * 60_000;

  await restarted.renew();

  expect(issue).toHaveBeenCalledOnce();

  expect(ctx.store.readAttempts()).toStrictEqual({
    failures: 2,
    lastAttemptAt: Date.parse('2030-01-10T00:15:00Z'),
    lastError: 'still failing',
  });
});

test('it logs a wait for the backoff once, not at every try', async () => {
  const ctx = await setupTest();

  const log = mock<(message: string) => void>();

  ctx.store.writeAttempts({
    failures: 1,
    lastAttemptAt: Date.parse('2030-01-10T00:00:00Z'),
    lastError: 'the CA is down',
  });

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: mock(),
    now: () => Date.parse('2030-01-10T00:05:00Z'),
    log,
  });

  await manager.renew();
  await manager.renew();

  expect(log).toHaveBeenCalledExactlyOnceWith(
    'impd: https: there is no certificate; the next try is after 2030-01-10T00:15:00.000Z',
  );
});

test('it asks the CA once for two renewals at once', async () => {
  const ctx = await setupTest();
  const fresh = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  const answer = Promise.withResolvers<Certificate>();
  const issue = mock(() => answer.promise);

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue,
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log: () => {},
  });

  const first = manager.renew();
  const second = manager.renew();

  answer.resolve(fresh);

  const answers = await Promise.all([first, second]);

  expect(answers).toStrictEqual([fresh, fresh]);
  expect(issue).toHaveBeenCalledOnce();
});

test('it loads an expired certificate on disk, with a warning', async () => {
  const ctx = await setupTest();

  const log = mock<(message: string) => void>();

  const expired = await buildMockCertificate({
    names: ['imp.test', '*.imp.test'],
    notBefore: new Date('2029-10-01T00:00:00Z'),
    notAfter: new Date('2030-01-01T00:00:00Z'),
  });

  ctx.store.writeCertificate(expired);

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: mock(),
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log,
  });

  const loaded = manager.load();

  expect(loaded?.chainPem).toBe(expired.chainPem.trimEnd());

  expect(log).toHaveBeenCalledExactlyOnceWith(
    'impd: https: the stored certificate expired 2030-01-01T00:00:00.000Z; serving it until a renewal succeeds',
  );
});

test('it keeps serving an expired certificate after a renewal fails', async () => {
  const ctx = await setupTest();

  const expired = await buildMockCertificate({
    names: ['imp.test', '*.imp.test'],
    notBefore: new Date('2029-10-01T00:00:00Z'),
    notAfter: new Date('2030-01-01T00:00:00Z'),
  });

  ctx.store.writeCertificate(expired);

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: () => Promise.reject(new Error('the CA is down')),
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log: () => {},
  });

  await manager.renew();

  expect(manager.load()?.chainPem).toBe(expired.chainPem.trimEnd());
});

test('it replaces a certificate for another domain', async () => {
  const ctx = await setupTest();

  const log = mock<(message: string) => void>();

  const fresh = await buildMockCertificate({
    names: ['imp.test', '*.imp.test'],
    notBefore: new Date('2030-01-10T00:00:00Z'),
    notAfter: new Date('2030-04-10T00:00:00Z'),
  });

  // still valid for months at the manager's now: only its names are wrong
  const other = await buildMockCertificate({
    names: ['other.test', '*.other.test'],
    notBefore: new Date('2030-01-01T00:00:00Z'),
    notAfter: new Date('2030-04-01T00:00:00Z'),
  });

  ctx.store.writeCertificate(other);

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: () => Promise.resolve(fresh),
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log,
  });

  const renewed = await manager.renew();

  expect(renewed).toStrictEqual(fresh);

  expect(log).toHaveBeenCalledWith(
    'impd: https: asking for a certificate for imp.test and *.imp.test: the certificate does not cover imp.test, *.imp.test',
  );
});

test('it loads no certificate it cannot read, and logs why', async () => {
  const ctx = await setupTest();

  const log = mock<(message: string) => void>();

  const certificate = await buildMockCertificate();

  // a certificate block whose body is not a certificate
  await mkdir(join(ctx.dir, 'tls'), { recursive: true });

  await writeFile(
    join(ctx.dir, 'tls', 'certificate.pem'),
    `${certificate.keyPem}\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n`,
  );

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: mock(),
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log,
  });

  const loaded = manager.load();

  expect(loaded).toBeNull();

  expect(log).toHaveBeenCalledExactlyOnceWith(
    expect.toStartWith('impd: https: cannot read the stored certificate: '),
  );
});

test('it asks for a new certificate when the stored one cannot be read', async () => {
  const ctx = await setupTest();
  const certificate = await buildMockCertificate();
  const fresh = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  await mkdir(join(ctx.dir, 'tls'), { recursive: true });

  await writeFile(
    join(ctx.dir, 'tls', 'certificate.pem'),
    `${certificate.keyPem}\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n`,
  );

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: () => Promise.resolve(fresh),
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log: () => {},
  });

  const renewed = await manager.renew();

  expect(renewed).toStrictEqual(fresh);
});

test('it logs a renewal that fails outside the CA call, and answers no certificate', async () => {
  const ctx = await setupTest();

  const log = mock<(message: string) => void>();
  const issue = mock();

  // a directory where the attempts file's temporary copy goes: the first
  // write of the attempts fails
  await mkdir(join(ctx.dir, 'tls', 'attempts.json.tmp'), { recursive: true });

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue,
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log,
  });

  const renewed = await manager.renew();

  expect(renewed).toBeNull();
  expect(issue).not.toHaveBeenCalled();

  expect(log).toHaveBeenLastCalledWith(
    expect.stringMatching(/^impd: https: renewal failed: .*EISDIR/v),
  );
});

test('it runs a new renewal after one that failed outside the CA call', async () => {
  const ctx = await setupTest();
  const fresh = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  const blocker = join(ctx.dir, 'tls', 'attempts.json.tmp');

  await mkdir(blocker, { recursive: true });

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: () => Promise.resolve(fresh),
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log: () => {},
  });

  await manager.renew();

  await rm(blocker, { recursive: true });

  const renewed = await manager.renew();

  expect(renewed).toStrictEqual(fresh);
});

test('it backs off when the DNS token file holds no token', async () => {
  const ctx = await setupTest();

  const tokenPath = join(ctx.dir, 'token');
  const log = mock<(message: string) => void>();
  const dnsToken = createDnsToken({ kind: 'file', path: tokenPath }, () => 0);

  await writeFile(tokenPath, '');

  // the issuer reads the token for each DNS call, as the Cloudflare
  // provider does
  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: async () => {
      await dnsToken.read();

      return buildMockCertificate();
    },
    now: () => Date.parse('2030-01-10T00:00:00Z'),
    log,
  });

  const renewed = await manager.renew();

  expect(renewed).toBeNull();
  expect(ctx.store.readAttempts().failures).toBe(1);

  expect(log).toHaveBeenLastCalledWith(
    `impd: https: no certificate for imp.test: the DNS API token file ${tokenPath} is empty; the next try is after 2030-01-10T00:15:00.000Z`,
  );
});

test('it uses a token put in place once the backoff has passed, and never logs it', async () => {
  const ctx = await setupTest();

  const tokenPath = join(ctx.dir, 'token');
  const clock = { now: Date.parse('2030-01-10T00:00:00Z') };
  const log = mock<(message: string) => void>();
  const tokens: string[] = [];
  const dnsToken = createDnsToken({ kind: 'file', path: tokenPath }, () => clock.now);

  const fresh = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  const manager = createCertManager({
    domain: 'imp.test',
    store: ctx.store,
    issue: async () => {
      const token = await dnsToken.read();

      tokens.push(token);

      return fresh;
    },
    now: () => clock.now,
    log,
  });

  await writeFile(tokenPath, '');

  await manager.renew();

  // the operator drops the token in place; the backoff still holds
  await writeFile(tokenPath, 'cf-new-token\n');

  await manager.renew();

  clock.now += 15 * 60_000;

  const renewed = await manager.renew();

  expect(renewed).toStrictEqual(fresh);
  expect(tokens).toStrictEqual(['cf-new-token']);

  expect(log.mock.calls.flat()).toSatisfyAll(
    (message: string) => !message.includes('cf-new-token'),
  );
});
