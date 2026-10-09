import { faker } from '@faker-js/faker';
import * as x509 from '@peculiar/x509';
import type { Certificate } from '../https/acme/cert-store';

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

interface MockCertificateOptions {
  readonly names: readonly string[];
  readonly notBefore: Date;
  readonly notAfter: Date;
}

// A real self-signed certificate and its key, as the cert store holds them:
// valid from a minute ago for a day unless the dates are given, for one
// arbitrary domain unless the names are. The first name is its subject.
export async function buildMockCertificate(
  overrides: Partial<MockCertificateOptions> = {},
): Promise<Certificate> {
  const names = overrides.names ?? [faker.internet.domainName()];
  const notBefore = overrides.notBefore ?? new Date(Date.now() - 60_000);
  const notAfter = overrides.notAfter ?? new Date(notBefore.getTime() + 86_400_000);

  const keys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);

  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: crypto.randomUUID().replaceAll('-', ''),
    name: `CN=${names[0] ?? 'test'}`,
    notBefore,
    notAfter,
    keys,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.SubjectAlternativeNameExtension(
        names.map((name) => ({ type: 'dns' as const, value: name })),
      ),
    ],
  });

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);

  return {
    keyPem: x509.PemConverter.encode(pkcs8, 'PRIVATE KEY'),
    chainPem: certificate.toString('pem'),
  };
}
