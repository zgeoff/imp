import { readFile } from 'node:fs/promises';
import { readErrorMessage } from '../../read-error-message';

// Where the DNS provider's API token comes from: IMP_DNS_API_TOKEN, fixed at
// start, or IMP_DNS_API_TOKEN_FILE, read again at each use so a rotated
// token works without a restart
export type DnsTokenSource =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'file'; readonly path: string };

// whether the token reads now; a value from the env always does
export interface DnsTokenStatus {
  readonly isOk: boolean;

  // names the file and what is wrong with it, never the token
  readonly error: string | null;
  readonly at: number;
}

export interface DnsToken {
  // the token now; throws when the file has none
  readonly read: () => Promise<string>;

  // reads the file again, for system info: a status kept from the last DNS
  // call would say nothing before the first, and stay stale between them
  readonly check: () => Promise<DnsTokenStatus>;
}

export function createDnsToken(source: DnsTokenSource, now: () => number): DnsToken {
  const read = (): Promise<string> =>
    source.kind === 'value' ? Promise.resolve(source.value) : readTokenFile(source.path);

  return {
    read,
    check: async () => {
      try {
        await read();

        return { isOk: true, error: null, at: now() };
      } catch (error) {
        return { isOk: false, error: readErrorMessage(error), at: now() };
      }
    },
  };
}

// Every message names the file, never what it holds: a token with a stray
// character inside is still most of a secret.
async function readTokenFile(path: string): Promise<string> {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';

    throw new Error(`cannot read the DNS API token from ${path}: ${code}`, { cause: error });
  }

  const token = text.trim();

  if (token === '') {
    throw new Error(`the DNS API token file ${path} is empty`);
  }

  // `IMP_DNS_API_TOKEN=...` pasted into the file, or two tokens: either
  // would go to the provider as a bad token
  if (/[\s=]/.test(token)) {
    throw new Error(`the DNS API token file ${path} holds whitespace or '=' inside the token`);
  }

  return token;
}
