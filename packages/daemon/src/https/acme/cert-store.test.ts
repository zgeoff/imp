import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestCertificate } from '../test-certificates';
import { createCertStore } from './cert-store';

function useTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-certs-'));

  return {
    dir,
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a certificate and its key come back as they went in, readable by root only', async () => {
  using temp = useTempDir();

  const store = createCertStore(temp.dir);

  const certificate = await createTestCertificate({ names: ['imp.test', '*.imp.test'] });

  expect(store.readCertificate()).toBeNull();

  store.writeCertificate(certificate);

  expect(store.readCertificate()).toEqual({
    keyPem: certificate.keyPem.trimEnd(),
    chainPem: certificate.chainPem.trimEnd(),
  });

  expect(statSync(join(temp.dir, 'tls', 'certificate.pem')).mode & 0o777).toBe(0o600);
  expect(statSync(join(temp.dir, 'tls')).mode & 0o777).toBe(0o700);
});

test('a chain keeps every certificate in order', async () => {
  using temp = useTempDir();

  const store = createCertStore(temp.dir);

  const leaf = await createTestCertificate({ names: ['imp.test'] });
  const issuer = await createTestCertificate({ names: ['ca.test'] });

  const chainPem = `${leaf.chainPem}\n${issuer.chainPem}`;

  store.writeCertificate({ keyPem: leaf.keyPem, chainPem });

  expect(store.readCertificate()?.chainPem).toBe(
    `${leaf.chainPem.trimEnd()}\n${issuer.chainPem.trimEnd()}`,
  );
});

test('the account key and the attempts persist; a damaged attempts file reads as none', () => {
  using temp = useTempDir();

  const store = createCertStore(temp.dir);

  expect(store.readAccountKey()).toBeNull();
  expect(store.readAttempts()).toEqual({ failures: 0, lastAttemptAt: null, lastError: null });

  store.writeAccountKey('-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n');
  store.writeAttempts({ failures: 2, lastAttemptAt: 1000, lastError: 'boom' });

  const reopened = createCertStore(temp.dir);

  expect(reopened.readAccountKey()).toContain('BEGIN PRIVATE KEY');
  expect(reopened.readAttempts()).toEqual({ failures: 2, lastAttemptAt: 1000, lastError: 'boom' });

  writeFileSync(join(temp.dir, 'tls', 'attempts.json'), '{not json');

  expect(reopened.readAttempts().failures).toBe(0);
});

test('the account URL is kept per ACME directory', () => {
  using temp = useTempDir();

  const store = createCertStore(temp.dir);

  expect(store.readAccountUrl('https://ca.test/dir')).toBeNull();

  store.writeAccountUrl('https://ca.test/dir', 'https://ca.test/acct/1');

  expect(store.readAccountUrl('https://ca.test/dir')).toBe('https://ca.test/acct/1');
  expect(store.readAccountUrl('https://other.test/dir')).toBeNull();
});
