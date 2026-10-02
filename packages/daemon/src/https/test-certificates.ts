import * as x509 from '@peculiar/x509';
import type { Certificate } from './acme/cert-store';

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

// A self-signed certificate for tests: the names and the lifetime are the
// caller's, so expiry and renewal can be checked without a CA.
interface TestCertificateOptions {
  readonly names: readonly string[];
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}

export async function createTestCertificate(options: TestCertificateOptions): Promise<Certificate> {
  const keys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);

  const notBefore = options.notBefore ?? new Date(Date.now() - 60_000);

  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: crypto.randomUUID().replaceAll('-', ''),
    name: `CN=${options.names[0] ?? 'test'}`,
    notBefore,
    notAfter: options.notAfter ?? new Date(notBefore.getTime() + 86_400_000),
    keys,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.SubjectAlternativeNameExtension(
        options.names.map((name) => ({ type: 'dns' as const, value: name })),
      ),
    ],
  });

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);

  return {
    keyPem: x509.PemConverter.encode(pkcs8, 'PRIVATE KEY'),
    chainPem: certificate.toString('pem'),
  };
}
