import { expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateBrokerCa } from './broker-ca';

function setupDir() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-ca-'));

  return {
    dir,
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the CA is made once, its key owner-only, and kept across starts', async () => {
  using tmp = setupDir();

  const dir = join(tmp.dir, 'ca');

  const first = await loadOrCreateBrokerCa(dir);
  const again = await loadOrCreateBrokerCa(dir);

  expect(again.certPem).toBe(first.certPem);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'ca.key')).mode & 0o777).toBe(0o600);

  const ca = new X509Certificate(first.certPem);

  expect(ca.ca).toBe(true);
  expect(ca.checkIssued(ca)).toBe(true);
});

test('a leaf names its host, is signed by the CA, and passes strict checks', async () => {
  using tmp = setupDir();

  const authority = await loadOrCreateBrokerCa(join(tmp.dir, 'ca'));
  const leaf = await authority.issueLeaf('api.github.com');

  const cert = new X509Certificate(leaf.certPem);
  const ca = new X509Certificate(authority.certPem);

  expect(cert.subjectAltName).toBe('DNS:api.github.com');
  expect(cert.ca).toBe(false);
  expect(cert.checkIssued(ca)).toBe(true);
  expect(cert.verify(ca.publicKey)).toBe(true);
  expect(cert.checkHost('api.github.com')).toBe('api.github.com');
  expect(cert.checkHost('github.com')).toBeUndefined();
  expect(authority.isDue(leaf, Date.now())).toBe(false);
  expect(authority.isDue(leaf, leaf.notAfter.getTime() - 86_400_000)).toBe(true);

  // openssl's strict mode wants the AKI, serverAuth, and a critical
  // basicConstraints with keyCertSign on the CA (Python 3.13 asks the same)
  const caPath = join(tmp.dir, 'ca.pem');
  const leafPath = join(tmp.dir, 'leaf.pem');

  writeFileSync(caPath, authority.certPem);
  writeFileSync(leafPath, leaf.certPem);

  const verify = Bun.spawnSync([
    'openssl',
    'verify',
    '-x509_strict',
    '-purpose',
    'sslserver',
    '-CAfile',
    caPath,
    leafPath,
  ]);

  expect(verify.stdout.toString().trim()).toBe(`${leafPath}: OK`);
});
