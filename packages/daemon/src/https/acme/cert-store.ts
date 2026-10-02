import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';

// One key and its certificate chain, as the TLS listener takes them.
export interface Certificate {
  readonly keyPem: string;
  readonly chainPem: string;
}

// The last issuance attempts, so a restart does not retry at once and run
// into the CA's limit on failed validations.
export interface AttemptState {
  // attempts that failed in a row; an attempt counts as failed until it
  // succeeds, so a crash in the middle of one counts too
  readonly failures: number;
  readonly lastAttemptAt: number | null;
  readonly lastError: string | null;
}

const AttemptStateSchema = z.object({
  failures: z.int().nonnegative(),
  lastAttemptAt: z.number().nullable(),
  lastError: z.string().nullable(),
});

// the account URL the CA gave the stored key, per ACME directory
const AccountSchema = z.object({ directoryUrl: z.string(), url: z.string() });
const NO_ATTEMPTS: AttemptState = { failures: 0, lastAttemptAt: null, lastError: null };
const PEM_BLOCK = /-----BEGIN (?<label>[A-Z ]+)-----[\s\S]+?-----END \k<label>-----\n?/g;

export interface CertStore {
  readonly readCertificate: () => Certificate | null;
  readonly writeCertificate: (certificate: Certificate) => void;
  readonly readAccountKey: () => string | null;
  readonly writeAccountKey: (pem: string) => void;

  // null when the key has no account at this directory yet
  readonly readAccountUrl: (directoryUrl: string) => string | null;
  readonly writeAccountUrl: (directoryUrl: string, url: string) => void;
  readonly readAttempts: () => AttemptState;
  readonly writeAttempts: (state: AttemptState) => void;
}

// <dataDir>/tls (docs/architecture/storage.md), every file 0600 and replaced
// by a rename. The key and its certificate share one file, so a crash never
// pairs a key with the wrong certificate.
export function createCertStore(dataDir: string): CertStore {
  const dir = join(dataDir, 'tls');
  const certificatePath = join(dir, 'certificate.pem');
  const accountKeyPath = join(dir, 'account.key');
  const attemptsPath = join(dir, 'attempts.json');
  const accountPath = join(dir, 'account.json');

  const write = (path: string, content: string): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const temporary = `${path}.tmp`;

    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  };

  return {
    readCertificate: () => {
      const pem = readIfExists(certificatePath);

      return pem === null ? null : splitCertificate(pem);
    },
    writeCertificate: (certificate) => {
      write(
        certificatePath,
        `${certificate.keyPem.trimEnd()}\n${certificate.chainPem.trimEnd()}\n`,
      );
    },
    readAccountKey: () => readIfExists(accountKeyPath),
    writeAccountKey: (pem) => {
      write(accountKeyPath, pem);
    },
    readAccountUrl: (directoryUrl) => {
      const text = readIfExists(accountPath);

      try {
        const account = text === null ? null : AccountSchema.parse(JSON.parse(text));

        return account?.directoryUrl === directoryUrl ? account.url : null;
      } catch {
        return null;
      }
    },
    writeAccountUrl: (directoryUrl, url) => {
      write(accountPath, `${JSON.stringify({ directoryUrl, url })}\n`);
    },
    readAttempts: () => {
      const text = readIfExists(attemptsPath);

      // a damaged file only forgets the backoff
      try {
        return text === null ? NO_ATTEMPTS : AttemptStateSchema.parse(JSON.parse(text));
      } catch {
        return NO_ATTEMPTS;
      }
    },
    writeAttempts: (state) => {
      write(attemptsPath, `${JSON.stringify(state)}\n`);
    },
  };
}

// the key block, then every certificate block in order; null for a file
// with no key or no certificate
function splitCertificate(pem: string): Certificate | null {
  const blocks = [...pem.matchAll(PEM_BLOCK)];
  const key = blocks.find((block) => block.groups?.['label']?.endsWith('PRIVATE KEY') === true);
  const chain = blocks.filter((block) => block.groups?.['label'] === 'CERTIFICATE');

  if (key === undefined || chain.length === 0) {
    return null;
  }

  return {
    keyPem: key[0].trimEnd(),
    chainPem: chain.map((block) => block[0].trimEnd()).join('\n'),
  };
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
