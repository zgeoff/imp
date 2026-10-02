import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

test('the attempts persist; a damaged attempts file reads as none', () => {
  using temp = useTempDir();

  const store = createCertStore(temp.dir);

  expect(store.readAttempts()).toEqual({ failures: 0, lastAttemptAt: null, lastError: null });

  store.writeAttempts({ failures: 2, lastAttemptAt: 1000, lastError: 'boom' });

  const reopened = createCertStore(temp.dir);

  expect(reopened.readAttempts()).toEqual({ failures: 2, lastAttemptAt: 1000, lastError: 'boom' });

  writeFileSync(join(temp.dir, 'tls', 'attempts.json'), '{not json');

  expect(reopened.readAttempts().failures).toBe(0);
});

test('the account, key and URL together, is kept per ACME directory', () => {
  using temp = useTempDir();

  const store = createCertStore(temp.dir);

  const account = {
    directoryUrl: 'https://ca.test/dir',
    url: 'https://ca.test/acct/1',
    keyPem: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n',
  };

  expect(store.readAccount(account.directoryUrl)).toBeNull();

  store.writeAccount(account);

  expect(createCertStore(temp.dir).readAccount(account.directoryUrl)).toEqual(account);
  expect(store.readAccount('https://other.test/dir')).toBeNull();
  expect(statSync(join(temp.dir, 'tls', 'account.json')).mode & 0o777).toBe(0o600);
});

const V011_KEY = '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n';

// v0.1.1's layout: the key in account.key, the URL alone in account.json
function writeV011Account(dir: string, directoryUrl: string): void {
  mkdirSync(join(dir, 'tls'), { recursive: true });
  writeFileSync(join(dir, 'tls', 'account.key'), V011_KEY);

  writeFileSync(
    join(dir, 'tls', 'account.json'),
    JSON.stringify({ directoryUrl, url: 'https://ca.test/acct/1' }),
  );
}

test('the v0.1.1 key and URL at the same directory become one account file', () => {
  using temp = useTempDir();

  writeV011Account(temp.dir, 'https://ca.test/dir');

  const expected = {
    directoryUrl: 'https://ca.test/dir',
    url: 'https://ca.test/acct/1',
    keyPem: V011_KEY,
  };

  expect(createCertStore(temp.dir).readAccount('https://ca.test/dir')).toEqual(expected);
  expect(existsSync(join(temp.dir, 'tls', 'account.key'))).toBeFalse();
  expect(createCertStore(temp.dir).readAccount('https://ca.test/dir')).toEqual(expected);
  expect(statSync(join(temp.dir, 'tls', 'account.json')).mode & 0o777).toBe(0o600);
});

test('a v0.1.1 key for another directory, or with no URL, is removed', () => {
  using temp = useTempDir();

  writeV011Account(temp.dir, 'https://old.test/dir');

  expect(createCertStore(temp.dir).readAccount('https://ca.test/dir')).toBeNull();
  expect(existsSync(join(temp.dir, 'tls', 'account.key'))).toBeFalse();

  writeV011Account(temp.dir, 'https://ca.test/dir');
  rmSync(join(temp.dir, 'tls', 'account.json'));

  expect(createCertStore(temp.dir).readAccount('https://ca.test/dir')).toBeNull();
  expect(existsSync(join(temp.dir, 'tls', 'account.key'))).toBeFalse();
});

test('an account file that does not parse is logged once', () => {
  using temp = useTempDir();

  const logs: string[] = [];

  const store = createCertStore(temp.dir, (message) => {
    logs.push(message);
  });

  mkdirSync(join(temp.dir, 'tls'), { recursive: true });
  writeFileSync(join(temp.dir, 'tls', 'account.json'), '{"directoryUrl":');

  expect(store.readAccount('https://ca.test/dir')).toBeNull();
  expect(store.readAccount('https://ca.test/dir')).toBeNull();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('account.json does not parse; making a new ACME account');
});
