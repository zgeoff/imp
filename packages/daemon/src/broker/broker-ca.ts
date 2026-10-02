// @peculiar/x509 resolves its parts through tsyringe, which needs the
// Reflect metadata API in place before it loads
// oxlint-disable-next-line import/no-unassigned-import -- a polyfill, loaded for its effect
import 'reflect-metadata';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';

// The broker's CA: one per host, not per imp. impd holds every key either
// way, so one per imp adds no isolation; one survives forks and restores
// (docs/guides/connectors.md has the reasoning).

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY_MS = 86_400_000;
const CA_DAYS = 3650;
const LEAF_DAYS = 365;

// a leaf this close to its end is issued again
const LEAF_RENEW_MS = 30 * DAY_MS;

export interface LeafCertificate {
  readonly certPem: string;
  readonly keyPem: string;
  readonly notAfter: Date;
}

export interface BrokerCa {
  readonly certPem: string;

  // for this hostname: a SAN, serverAuth and the CA's key id, so strict
  // verifiers (Python 3.13, OpenSSL -x509_strict) accept it
  readonly issueLeaf: (host: string) => Promise<LeafCertificate>;

  // true when the leaf ends within the renewal window
  readonly isDue: (leaf: LeafCertificate, now: number) => boolean;
}

// The CA in <dir>: ca.pem (the certificate) and ca.key (0600), made on the
// first start.
export async function loadOrCreateBrokerCa(dir: string): Promise<BrokerCa> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const certPath = join(dir, 'ca.pem');
  const keyPath = join(dir, 'ca.key');

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    const created = await createCa();

    writeFileSync(keyPath, created.keyPem, { mode: 0o600 });
    writeFileSync(certPath, created.certPem, { mode: 0o644 });
  }

  const certPem = readFileSync(certPath, 'utf8');

  const ca = new x509.X509Certificate(certPem);

  const signingKey = await parsePrivateKey(readFileSync(keyPath, 'utf8'));
  const authorityKeyId = await x509.AuthorityKeyIdentifierExtension.create(ca);

  return {
    certPem,
    issueLeaf: async (host) => {
      const keys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);

      const notBefore = new Date(Date.now() - DAY_MS);
      const notAfter = new Date(Date.now() + LEAF_DAYS * DAY_MS);

      const leaf = await x509.X509CertificateGenerator.create({
        serialNumber: createSerialNumber(),
        subject: `CN=${host}`,
        issuer: ca.subject,
        notBefore,
        notAfter,
        publicKey: keys.publicKey,
        signingKey,
        signingAlgorithm: ALGORITHM,
        extensions: [
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
          new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
          new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: host }]),
          authorityKeyId,
          await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
        ],
      });

      const der = await crypto.subtle.exportKey('pkcs8', keys.privateKey);

      return {
        certPem: leaf.toString('pem'),
        keyPem: formatPrivateKey(new Uint8Array(der)),
        notAfter,
      };
    },
    isDue: (leaf, now) => leaf.notAfter.getTime() - now < LEAF_RENEW_MS,
  };
}

async function createCa(): Promise<{ readonly certPem: string; readonly keyPem: string }> {
  const keys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: createSerialNumber(),
    name: 'CN=imp credential broker CA, O=imp',
    notBefore: new Date(Date.now() - DAY_MS),
    notAfter: new Date(Date.now() + CA_DAYS * DAY_MS),
    keys,
    signingAlgorithm: ALGORITHM,
    extensions: [
      // a CA that signs leaves only, never another CA
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });

  const der = await crypto.subtle.exportKey('pkcs8', keys.privateKey);

  return { certPem: cert.toString('pem'), keyPem: formatPrivateKey(new Uint8Array(der)) };
}

// 16 random bytes with the top bit clear: a positive DER integer
function createSerialNumber(): string {
  const bytes = randomBytes(16);

  bytes[0] = (bytes[0] ?? 0) & 0x7f;

  return bytes.toString('hex');
}

function formatPrivateKey(der: Uint8Array): string {
  const key = createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' });

  return key.export({ format: 'pem', type: 'pkcs8' });
}

function parsePrivateKey(pem: string): Promise<CryptoKey> {
  const der = createPrivateKey(pem).export({ format: 'der', type: 'pkcs8' });

  return crypto.subtle.importKey('pkcs8', der, ALGORITHM, false, ['sign']);
}
