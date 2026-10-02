import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
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

// An ACME account: its key and the URL the CA gave it, at one directory.
// The two are kept together: a key without its URL cannot be used again.
interface AcmeAccount {
  readonly directoryUrl: string;
  readonly url: string;
  readonly keyPem: string;
}

const AccountSchema = z.object({ directoryUrl: z.string(), url: z.string(), keyPem: z.string() });

// v0.1.1 kept the key in account.key and only the URL in account.json
const LegacyAccountSchema = z.object({ directoryUrl: z.string(), url: z.string() });
const NO_ATTEMPTS: AttemptState = { failures: 0, lastAttemptAt: null, lastError: null };
const PEM_BLOCK = /-----BEGIN (?<label>[A-Z ]+)-----[\s\S]+?-----END \k<label>-----\n?/g;

export interface CertStore {
  readonly readCertificate: () => Certificate | null;
  readonly writeCertificate: (certificate: Certificate) => void;

  // null when there is no account at this directory yet
  readonly readAccount: (directoryUrl: string) => AcmeAccount | null;
  readonly writeAccount: (account: AcmeAccount) => void;
  readonly readAttempts: () => AttemptState;
  readonly writeAttempts: (state: AttemptState) => void;
}

// <dataDir>/tls (docs/architecture/storage.md), every file 0600, synced and
// replaced by a rename. The key and its certificate share one file, so a
// crash never pairs a key with the wrong certificate.
export function createCertStore(
  dataDir: string,
  log: (message: string) => void = () => {},
): CertStore {
  const dir = join(dataDir, 'tls');
  const certificatePath = join(dir, 'certificate.pem');
  const attemptsPath = join(dir, 'attempts.json');
  const accountPath = join(dir, 'account.json');
  const legacyKeyPath = join(dir, 'account.key');
  const warned = { account: false };

  const write = (path: string, content: string): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const temporary = `${path}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);

    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(temporary, path);
  };

  // the stored account, whatever its directory; null when there is none.
  // v0.1.1's pair of files at this directory becomes one account.json.
  const readStoredAccount = (directoryUrl: string): AcmeAccount | null => {
    const text = readIfExists(accountPath);

    if (text === null) {
      return null;
    }

    const json = parseJson(text);
    const account = AccountSchema.safeParse(json);

    if (account.success) {
      return account.data;
    }

    const legacy = LegacyAccountSchema.safeParse(json);
    const legacyKey = readIfExists(legacyKeyPath);

    if (legacy.success && legacyKey !== null && legacy.data.directoryUrl === directoryUrl) {
      const migrated = { ...legacy.data, keyPem: legacyKey };

      write(accountPath, `${JSON.stringify(migrated)}\n`);

      return migrated;
    }

    // a damaged file means a new account, which costs nothing, but say so
    // once: a file that never parses would make one at every start
    if (!legacy.success && !warned.account) {
      warned.account = true;

      log(`impd: https: ${accountPath} does not parse; making a new ACME account`);
    }

    return null;
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
    readAccount: (directoryUrl) => {
      const account = readStoredAccount(directoryUrl);

      // v0.1.1's key file: moved into account.json above, or of no use now
      rmSync(legacyKeyPath, { force: true });

      return account?.directoryUrl === directoryUrl ? account : null;
    },
    writeAccount: (account) => {
      write(accountPath, `${JSON.stringify(account)}\n`);
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
