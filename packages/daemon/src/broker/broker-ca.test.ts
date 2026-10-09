import { expect, onTestFinished, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { rmSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateBrokerCa } from './broker-ca';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imp-ca-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it keeps the same CA across starts on one directory', async () => {
  const ctx = await setupTest();
  const first = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));
  const again = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));

  expect(again.certPem).toBe(first.certPem);
});

test('it makes the CA directory owner-only', async () => {
  const ctx = await setupTest();

  await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));

  expect(statSync(join(ctx.dir, 'ca')).mode & 0o777).toBe(0o700);
});

test('it writes the CA key owner-only', async () => {
  const ctx = await setupTest();

  await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));

  expect(statSync(join(ctx.dir, 'ca', 'ca.key')).mode & 0o777).toBe(0o600);
});

test('it makes a certificate authority', async () => {
  const ctx = await setupTest();
  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));

  expect(new X509Certificate(authority.certPem).ca).toBeTrue();
});

test('it signs the CA certificate with its own key', async () => {
  const ctx = await setupTest();
  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));

  const ca = new X509Certificate(authority.certPem);

  expect(ca.checkIssued(ca)).toBeTrue();
});

test('it makes a new CA when only its certificate is left', async () => {
  const ctx = await setupTest();
  const first = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));

  rmSync(join(ctx.dir, 'ca', 'ca.key'));

  const again = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));

  expect(again.certPem).not.toBe(first.certPem);
});

test('it makes a new CA when only its key is left', async () => {
  const ctx = await setupTest();
  const first = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));

  rmSync(join(ctx.dir, 'ca', 'ca.pem'));

  const again = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));

  expect(again.certPem).not.toBe(first.certPem);
});

test('it names only its host in a leaf', async () => {
  const ctx = await setupTest();
  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));
  const leaf = await authority.issueLeaf('api.github.com');

  expect(new X509Certificate(leaf.certPem).subjectAltName).toBe('DNS:api.github.com');
});

test('it issues a leaf that is no certificate authority', async () => {
  const ctx = await setupTest();
  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));
  const leaf = await authority.issueLeaf('api.github.com');

  expect(new X509Certificate(leaf.certPem).ca).toBeFalse();
});

test('it issues a leaf under the CA', async () => {
  const ctx = await setupTest();
  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));
  const leaf = await authority.issueLeaf('api.github.com');

  expect(
    new X509Certificate(leaf.certPem).checkIssued(new X509Certificate(authority.certPem)),
  ).toBeTrue();
});

test('it signs a leaf with the CA key', async () => {
  const ctx = await setupTest();
  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));
  const leaf = await authority.issueLeaf('api.github.com');

  const ca = new X509Certificate(authority.certPem);

  expect(new X509Certificate(leaf.certPem).verify(ca.publicKey)).toBeTrue();
});

test('it issues a leaf that matches its own host', async () => {
  const ctx = await setupTest();
  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));
  const leaf = await authority.issueLeaf('api.github.com');

  expect(new X509Certificate(leaf.certPem).checkHost('api.github.com')).toBe('api.github.com');
});

test('it issues a leaf that does not match another host', async () => {
  const ctx = await setupTest();
  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));
  const leaf = await authority.issueLeaf('api.github.com');

  expect(new X509Certificate(leaf.certPem).checkHost('github.com')).toBeUndefined();
});

test('it ends a leaf 365 days after the clock it is given', async () => {
  const ctx = await setupTest();

  const at = Date.UTC(2030, 0, 1);

  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'), () => at);
  const leaf = await authority.issueLeaf('api.github.com');

  expect(leaf.notAfter).toStrictEqual(new Date(Date.UTC(2031, 0, 1)));
});

test('it writes the leaf end date it reports into the certificate', async () => {
  const ctx = await setupTest();

  const at = Date.UTC(2030, 0, 1);

  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'), () => at);
  const leaf = await authority.issueLeaf('api.github.com');

  expect(new Date(new X509Certificate(leaf.certPem).validTo)).toStrictEqual(
    new Date(Date.UTC(2031, 0, 1)),
  );
});

test('it starts a leaf one day before the clock it is given', async () => {
  const ctx = await setupTest();

  const at = Date.UTC(2030, 0, 1);

  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'), () => at);
  const leaf = await authority.issueLeaf('api.github.com');

  expect(new Date(new X509Certificate(leaf.certPem).validFrom)).toStrictEqual(
    new Date(Date.UTC(2029, 11, 31)),
  );
});

test('it holds a fresh leaf not due', async () => {
  const ctx = await setupTest();

  const at = Date.UTC(2030, 0, 1);

  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'), () => at);
  const leaf = await authority.issueLeaf('api.github.com');

  expect(authority.isDue(leaf, at)).toBeFalse();
});

test('it holds a leaf due with 29 days left', async () => {
  const ctx = await setupTest();

  const at = Date.UTC(2030, 0, 1);

  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'), () => at);
  const leaf = await authority.issueLeaf('api.github.com');

  expect(authority.isDue(leaf, Date.UTC(2030, 11, 3))).toBeTrue();
});

test('it holds a leaf with 30 days left not due', async () => {
  const ctx = await setupTest();

  const at = Date.UTC(2030, 0, 1);

  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'), () => at);
  const leaf = await authority.issueLeaf('api.github.com');

  expect(authority.isDue(leaf, Date.UTC(2030, 11, 2))).toBeFalse();
});

// openssl's strict mode wants the AKI, serverAuth, and a critical
// basicConstraints with keyCertSign on the CA (Python 3.13 asks the same)
test('it issues a leaf that openssl verifies in strict mode', async () => {
  const ctx = await setupTest();
  const authority = await loadOrCreateBrokerCa(join(ctx.dir, 'ca'));
  const leaf = await authority.issueLeaf('api.github.com');

  await Bun.write(join(ctx.dir, 'leaf.pem'), leaf.certPem);

  const verify = Bun.spawnSync([
    'openssl',
    'verify',
    '-x509_strict',
    '-purpose',
    'sslserver',
    '-CAfile',
    join(ctx.dir, 'ca', 'ca.pem'),
    join(ctx.dir, 'leaf.pem'),
  ]);

  expect(verify.stdout.toString()).toBe(`${join(ctx.dir, 'leaf.pem')}: OK\n`);
});
