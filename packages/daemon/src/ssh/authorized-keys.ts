import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { utils } from 'ssh2';

// One public key from authorized_keys.
interface AuthorizedKey {
  readonly type: string;

  // the key in SSH wire format, as a client sends it
  readonly blob: Buffer;
  readonly comment: string;
  readonly verify: (data: Buffer, signature: Buffer, hashAlgo: string | undefined) => boolean;
}

export interface ParsedAuthorizedKeys {
  readonly keys: readonly AuthorizedKey[];

  // lines that grant nothing, and why ("line 3: ...")
  readonly problems: readonly string[];
}

// A key line starts with its type. Anything else starts with options
// (`from=`, `command=`, `restrict`...), which the gateway does not enforce,
// so it refuses the line rather than grant more than it says.
const KEY_TYPE = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/;

export function parseAuthorizedKeys(text: string): ParsedAuthorizedKeys {
  const keys: AuthorizedKey[] = [];
  const problems: string[] = [];

  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    const where = `line ${String(index + 1)}`;

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const [type = '', data = '', ...rest] = line.split(/\s+/);

    if (!KEY_TYPE.test(type)) {
      const reason = /^(?:sk-|ssh-dss)/.test(type)
        ? `${type} keys are not supported`
        : 'options are not supported; put the key type first';

      problems.push(`${where}: ${reason}`);
      continue;
    }

    const parsed = utils.parseKey(`${type} ${data}`);

    if (parsed instanceof Error) {
      problems.push(`${where}: ${parsed.message}`);
      continue;
    }

    keys.push({
      type: parsed.type,
      blob: parsed.getPublicSSH(),
      comment: rest.join(' '),
      verify: (signed, signature, hashAlgo) => parsed.verify(signed, signature, hashAlgo),
    });
  }

  return { keys, problems };
}

export interface AuthorizedKeys {
  // the key a client offers, if the file authorizes it
  readonly find: (blob: Buffer) => AuthorizedKey | null;
}

interface FileState {
  readonly stamp: string;
  readonly keys: readonly AuthorizedKey[];
}

// Read again whenever it changes, so a key added on the host works on the
// next connection. A file or directory that group or others can write grants
// nothing: whoever can write it can add a key.
export function createAuthorizedKeys(path: string, log: (message: string) => void): AuthorizedKeys {
  const state: { current: FileState | null } = { current: null };

  const load = (): readonly AuthorizedKey[] => {
    const stamp = readStamp(path);

    if (state.current?.stamp === stamp) {
      return state.current.keys;
    }

    const keys = readKeys(path, stamp, log);

    state.current = { stamp, keys };

    return keys;
  };

  return {
    find: (blob) => load().find((key) => key.blob.equals(blob)) ?? null,
  };
}

// what changes when the file or its directory's mode changes
function readStamp(path: string): string {
  try {
    const file = statSync(path);
    const dir = statSync(dirname(path));

    return [file.mtimeMs, file.size, file.mode, file.ino, dir.mode].join(':');
  } catch {
    return 'missing';
  }
}

function readKeys(path: string, stamp: string, log: (message: string) => void) {
  if (stamp === 'missing') {
    log(`impd: ssh: no ${path}; no key can log in`);

    return [];
  }

  const unsafe = [path, dirname(path)].find((each) => (statSync(each).mode & 0o022) !== 0);

  if (unsafe !== undefined) {
    log(`impd: ssh: ${unsafe} is writable by group or others; no key can log in until it is not`);

    return [];
  }

  const parsed = parseAuthorizedKeys(readFileSync(path, 'utf8'));

  for (const problem of parsed.problems) {
    log(`impd: ssh: ${path} ${problem}; skipped`);
  }

  return parsed.keys;
}
