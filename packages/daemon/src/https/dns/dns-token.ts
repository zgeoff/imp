import { readFile } from 'node:fs/promises';
import { readErrorMessage } from '../../read-error-message';

const TOKEN_PATTERN = /^[\w.~+/-]+$/;

// Where the DNS provider's API token comes from: IMP_DNS_API_TOKEN, fixed at
// start, or IMP_DNS_API_TOKEN_FILE, read again at each use so a rotated
// token works without a restart
export type DnsTokenSource =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'file'; readonly path: string };

// whether the token file reads now, and holds a token
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
  // call would say nothing before the first, and stay stale between them.
  // null for a value from the env, which has nothing to check.
  readonly check: (() => Promise<DnsTokenStatus>) | null;
}

// how the token file's text is read; the filesystem by default
type ReadText = (path: string) => Promise<string>;

export function createDnsToken(
  source: DnsTokenSource,
  now: () => number,
  readText: ReadText = (path) => readFile(path, 'utf8'),
): DnsToken {
  if (source.kind === 'value') {
    return { read: () => Promise.resolve(source.value), check: null };
  }

  const read = (): Promise<string> => readTokenFile(source.path, readText);

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
async function readTokenFile(path: string, readText: ReadText): Promise<string> {
  let text: string;

  try {
    text = await readText(path);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';

    throw new Error(`cannot read the DNS API token from ${path}: ${code}`, { cause: error });
  }

  const token = text.trim();

  if (token === '') {
    throw new Error(`the DNS API token file ${path} is empty`);
  }

  // anything else is a mistake (a pasted `KEY=...` line, two tokens, a
  // UTF-16 file), and a byte a header refuses puts the token into fetch's
  // own error message
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(
      `the DNS API token file ${path} holds characters no token has, such as whitespace, '=' or a NUL byte`,
    );
  }

  return token;
}
