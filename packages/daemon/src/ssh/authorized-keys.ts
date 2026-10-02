import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { utils } from 'ssh2';

// One public key from authorized_keys, or one bound to a token.
export interface AuthorizedKey {
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

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const parsed = parsePublicKey(line);

    if (typeof parsed === 'string') {
      problems.push(`line ${String(index + 1)}: ${parsed}`);
      continue;
    }

    keys.push(parsed);
  }

  return { keys, problems };
}

// one key line, or why it grants nothing
export function parsePublicKey(line: string): AuthorizedKey | string {
  const [type = '', data = '', ...rest] = line.trim().split(/\s+/);

  if (!KEY_TYPE.test(type)) {
    return /^(?:sk-|ssh-dss)/.test(type)
      ? `${type} keys are not supported`
      : 'options are not supported; put the key type first';
  }

  const parsed = utils.parseKey(`${type} ${data}`);

  if (parsed instanceof Error) {
    return parsed.message;
  }

  return {
    type: parsed.type,
    blob: parsed.getPublicSSH(),
    comment: rest.join(' '),
    verify: (signed, signature, hashAlgo) => parsed.verify(signed, signature, hashAlgo),
  };
}

// `SHA256:<base64>` without padding, as `ssh-keygen -l` prints it
export function formatKeyFingerprint(blob: Buffer): string {
  const digest = createHash('sha256').update(blob).digest('base64');

  return `SHA256:${digest.replace(/=+$/, '')}`;
}

export interface AuthorizedKeys {
  // the key a client offers, if the file authorizes it
  readonly findKey: (blob: Buffer) => AuthorizedKey | null;

  // whether the file lists the key, even while its mode grants nothing: a
  // fixed mode would grant it again
  readonly isListed: (blob: Buffer) => boolean;
}

interface FileState {
  readonly stamp: string;

  // every key line, and whether the file's mode lets them log in
  readonly keys: readonly AuthorizedKey[];
  readonly isSafe: boolean;
}

// Read again whenever it changes, so a key added on the host works on the
// next connection. A file or directory that group or others can write grants
// nothing: whoever can write it can add a key.
export function createAuthorizedKeys(path: string, log: (message: string) => void): AuthorizedKeys {
  const state: { current: FileState | null } = { current: null };

  const load = (): FileState => {
    const stamp = readStamp(path);

    if (state.current?.stamp === stamp) {
      return state.current;
    }

    state.current = readFileState(path, stamp, log);

    return state.current;
  };

  const findListed = (blob: Buffer): AuthorizedKey | null =>
    load().keys.find((key) => key.blob.equals(blob)) ?? null;

  return {
    findKey: (blob) => (load().isSafe ? findListed(blob) : null),
    isListed: (blob) => findListed(blob) !== null,
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

function readFileState(path: string, stamp: string, log: (message: string) => void): FileState {
  if (stamp === 'missing') {
    log(`impd: ssh: no ${path}; no key can log in`);

    return { stamp, keys: [], isSafe: true };
  }

  const unsafe = [path, dirname(path)].find((each) => (statSync(each).mode & 0o022) !== 0);

  if (unsafe !== undefined) {
    log(`impd: ssh: ${unsafe} is writable by group or others; no key can log in until it is not`);
  }

  const parsed = parseAuthorizedKeys(readFileSync(path, 'utf8'));

  for (const problem of parsed.problems) {
    log(`impd: ssh: ${path} ${problem}; skipped`);
  }

  return { stamp, keys: parsed.keys, isSafe: unsafe === undefined };
}
