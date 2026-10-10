import { expect, test } from 'bun:test';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { buildMockCertificate } from './build-mock-certificate';

test('it builds a default certificate', async () => {
  const certificate = await buildMockCertificate();

  expect(certificate).toStrictEqual({
    keyPem: expect.toStartWith('-----BEGIN PRIVATE KEY-----'),
    chainPem: expect.toStartWith('-----BEGIN CERTIFICATE-----'),
  });

  // the key is the certificate's own
  expect(
    new X509Certificate(certificate.chainPem).checkPrivateKey(createPrivateKey(certificate.keyPem)),
  ).toBeTrue();
});

test('it signs the default certificate for one name, valid from a minute ago for a day', async () => {
  const before = Date.now();

  const certificate = await buildMockCertificate();

  const parsed = new X509Certificate(certificate.chainPem);

  expect(parsed.subjectAltName).toMatch(/^DNS:[^,]+$/v);
  expect(parsed.validFromDate.getTime()).toBeWithin(before - 61_000, Date.now() - 59_000);
  expect(parsed.validToDate.getTime() - parsed.validFromDate.getTime()).toBe(86_400_000);
});

test('it applies overrides on top of the defaults', async () => {
  const certificate = await buildMockCertificate({
    names: ['imp.test', '*.imp.test'],
    notBefore: new Date('2030-01-01T00:00:00Z'),
    notAfter: new Date('2030-02-01T00:00:00Z'),
  });

  const parsed = new X509Certificate(certificate.chainPem);

  expect(parsed.subject).toBe('CN=imp.test');
  expect(parsed.subjectAltName).toBe('DNS:imp.test, DNS:*.imp.test');
  expect(parsed.validFromDate).toStrictEqual(new Date('2030-01-01T00:00:00Z'));
  expect(parsed.validToDate).toStrictEqual(new Date('2030-02-01T00:00:00Z'));
});
