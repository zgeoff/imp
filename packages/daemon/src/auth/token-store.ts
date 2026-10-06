import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { MAX_SSH_KEYS } from '@imp/api';
import type { Scope, SshKey, Token } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { buildConflictError, buildNotFoundError } from '../api-errors';
import type { ImpDatabase } from '../db/open-database';
import { findSecret } from '../db/secrets';
import {
  listTokenRecords,
  listTokenSshKeyRecords,
  removeTokenRecord,
  removeTokenSshKeyRecord,
  updateTokenGrantable,
  writeTokenRecord,
  writeTokenSshKeyRecord,
} from '../db/tokens';
import type { GrantableSecret, TokenRecord, TokenSshKeyRecord } from '../db/tokens';
import { formatKeyFingerprint, parsePublicKey } from '../ssh/authorized-keys';
import type { AuthorizedKey } from '../ssh/authorized-keys';
import type { Caller } from './caller';

// The root token in <dataDir>/token has every scope and is not in the
// database. Its id is one a made token can never get (those are 16
// characters), so a dashboard session can name it.
export const ROOT_TOKEN_ID = 'root';
const ROOT_NAME = 'root';
const ROOT_PRINCIPAL = 'root';

// A made token is `imp_<id>.<secret>`: the id finds the entry, and the
// secret's SHA-256 is compared in constant time. 256 random bits need no
// slow hash; that is for secrets a person picks.
const SECRET_PREFIX = 'imp_';

interface NewToken {
  readonly name: string;
  readonly scope: Scope;
  readonly imps: readonly string[] | null;

  // public key lines to bind to it; none when left out
  readonly sshKeys?: readonly string[];

  // existing secrets it may grant to its imps; none when left out
  readonly grantable?: readonly string[];
}

// A key bound to a token, as the SSH gateway sees it. A login with it runs
// as the token's caller; the key id lets removing the key end the login.
export interface BoundSshKey {
  readonly key: AuthorizedKey;
  readonly keyId: string;
  readonly caller: Caller;
}

interface KeyEntry {
  readonly record: TokenSshKeyRecord;
  readonly key: AuthorizedKey;
}

export interface TokenStore {
  readonly list: () => Token[];

  // the token, and its secret: the only time impd has it. BAD_REQUEST for
  // a grantable list without manage and imps; NOT_FOUND for a name no
  // secret has.
  readonly create: (token: Readonly<NewToken>) => Promise<{ token: Token; secret: string }>;

  // a new grantable list at each secret's generation now; the secret hash
  // stays. Ends the grants of a secret left off on the token's imps.
  // NOT_FOUND for the token or a secret; BAD_REQUEST as create.
  readonly updateGrantable: (
    name: string,
    grantable: readonly string[],
  ) => Promise<{ token: Token; droppedGrants: number }>;

  // NOT_FOUND for an unknown name; CONFLICT while authorized_keys lists one
  // of its keys; calls onRemove with the token's id and its grants' ids
  readonly remove: (name: string) => Promise<void>;

  // CONFLICT for a key bound to any token or listed in authorized_keys
  readonly addKey: (name: string, line: string) => Promise<SshKey>;

  // CONFLICT while authorized_keys lists the key; calls onRemove with its id
  readonly removeKey: (name: string, fingerprint: string) => Promise<void>;

  // the token a key blob is bound to, for an SSH login; null for none
  readonly findSshKey: (blob: Buffer) => BoundSshKey | null;

  // the caller a bearer secret stands for, or null
  readonly authenticate: (secret: string) => Caller | null;

  // the caller behind a token id, such as a dashboard session's; null once
  // the token is gone
  readonly findById: (id: string) => Caller | null;
}

interface TokenStoreDeps {
  readonly db: ImpDatabase;
  readonly rootToken: string;
  readonly now: () => number;

  // after a token or a key is removed, by its id: what it opened ends
  readonly onRemove: (id: string) => void;

  // whether authorized_keys lists the key, whatever the file's mode. A key
  // there has every imp: a binding next to it would narrow nothing until
  // it was removed, and then hand the login back to the file.
  readonly isFileKey: (blob: Buffer) => boolean;
}

// impd is the only writer, so the tokens live in memory and every change
// is written through
export async function loadTokenStore(deps: Readonly<TokenStoreDeps>): Promise<TokenStore> {
  const byId = new Map<string, TokenRecord>();
  const keysByFingerprint = new Map<string, KeyEntry>();

  for (const record of await listTokenRecords(deps.db)) {
    byId.set(record.id, record);
  }

  for (const record of await listTokenSshKeyRecords(deps.db)) {
    const key = parsePublicKey(record.publicKey);

    if (typeof key !== 'string') {
      keysByFingerprint.set(record.fingerprint, {
        record,
        key: { ...key, comment: record.comment },
      });
    }
  }

  const rootHash = buildSecretHash(deps.rootToken);

  const rootCaller: Caller = {
    kind: 'token',
    name: ROOT_NAME,
    scope: 'manage',
    imps: null,
    grantable: [],
    tokenId: ROOT_TOKEN_ID,
    grantId: null,
    expiresAt: null,

    // the root token and a root dashboard session
    principal: ROOT_PRINCIPAL,
    display: ROOT_NAME,
  };

  const findByName = (name: string): TokenRecord | null =>
    [...byId.values()].find((record) => record.name === name) ?? null;

  const requireByName = (name: string): TokenRecord => {
    const record = findByName(name);

    if (record === null) {
      throw buildNotFoundError('token', name);
    }

    return record;
  };

  const listKeys = (tokenId: string): KeyEntry[] =>
    [...keysByFingerprint.values()].filter((entry) => entry.record.tokenId === tokenId);

  // a key added to the file after it was bound: unbinding it would hand it
  // every imp, so the line goes first
  const requireNotInFile = (entries: readonly KeyEntry[]): void => {
    const listed = entries.find((entry) => deps.isFileKey(entry.key.blob));

    if (listed !== undefined) {
      const fingerprint = listed.record.fingerprint;

      throw buildConflictError(
        'ssh-key',
        fingerprint,
        `key ${fingerprint} is in authorized_keys too, where it has every imp; delete that line, then unbind it`,
      );
    }
  };

  const toFullToken = (record: Readonly<TokenRecord>): Token => ({
    ...toToken(record),
    sshKeys: listKeys(record.id).map((entry) => toSshKey(entry)),
  });

  // parsed and free to bind: no token holds it, nor authorized_keys
  const buildKeyEntry = (tokenId: string, line: string): KeyEntry => {
    const key = parsePublicKey(line);

    if (typeof key === 'string') {
      throw new ORPCError('BAD_REQUEST', { message: `not an SSH public key: ${key}` });
    }

    const fingerprint = formatKeyFingerprint(key.blob);

    if (keysByFingerprint.has(fingerprint)) {
      throw buildConflictError('ssh-key', fingerprint, `key ${fingerprint} is bound to a token`);
    }

    if (deps.isFileKey(key.blob)) {
      throw buildConflictError(
        'ssh-key',
        fingerprint,
        `key ${fingerprint} is in authorized_keys, where it has every imp; delete that line, then bind it`,
      );
    }

    const record: TokenSshKeyRecord = {
      id: randomBytes(12).toString('base64url'),
      tokenId,
      fingerprint,
      publicKey: `${key.type} ${key.blob.toString('base64')}`,
      comment: key.comment,
      createdAt: new Date(deps.now()),
    };

    return { record, key };
  };

  return {
    list: () =>
      [...byId.values()]
        .map((record) => toFullToken(record))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    create: async (token) => {
      if (token.name === ROOT_NAME || findByName(token.name) !== null) {
        throw buildConflictError('token', token.name);
      }

      const id = randomBytes(12).toString('base64url');
      const secret = randomBytes(32).toString('base64url');
      const entries = buildKeyEntries(token.sshKeys ?? [], (line) => buildKeyEntry(id, line));

      const grantable = await readGrantable(deps.db, token.grantable ?? [], token);

      const record: TokenRecord = {
        id,
        name: token.name,
        secretHash: buildSecretHash(secret).toString('hex'),
        scope: token.scope,
        imps: token.imps,
        grantable,
        createdAt: new Date(deps.now()),
      };

      await writeTokenRecord(
        deps.db,
        record,
        entries.map((entry) => entry.record),
      );

      byId.set(id, record);

      for (const entry of entries) {
        keysByFingerprint.set(entry.record.fingerprint, entry);
      }

      return { token: toFullToken(record), secret: `${SECRET_PREFIX}${id}.${secret}` };
    },
    updateGrantable: async (name, names) => {
      const record = requireByName(name);

      const written = await updateTokenGrantable(deps.db, record.id, (trx) =>
        readGrantable(trx, names, record),
      );

      // removed since requireByName
      if (written === null) {
        throw buildNotFoundError('token', name);
      }

      // a new record, not an edit: a caller built from the old one keeps
      // its view, and every request builds its caller again from this one
      const updated: TokenRecord = { ...record, grantable: written.grantable };

      byId.set(record.id, updated);

      return { token: toFullToken(updated), droppedGrants: written.dropped };
    },
    remove: async (name) => {
      const record = requireByName(name);

      requireNotInFile(listKeys(record.id));

      const grantIds = await removeTokenRecord(deps.db, record.id);

      byId.delete(record.id);

      for (const entry of listKeys(record.id)) {
        keysByFingerprint.delete(entry.record.fingerprint);
      }

      deps.onRemove(record.id);

      // the OAuth grants it approved end with it, by their own ids too
      for (const grantId of grantIds) {
        deps.onRemove(grantId);
      }
    },
    addKey: async (name, line) => {
      const record = requireByName(name);

      if (listKeys(record.id).length >= MAX_SSH_KEYS) {
        throw new ORPCError('BAD_REQUEST', {
          message: `token ${name} holds ${String(MAX_SSH_KEYS)} keys, the most it may`,
        });
      }

      const entry = buildKeyEntry(record.id, line);

      await writeTokenSshKeyRecord(deps.db, entry.record);

      keysByFingerprint.set(entry.record.fingerprint, entry);

      return toSshKey(entry);
    },
    removeKey: async (name, fingerprint) => {
      const record = requireByName(name);
      const entry = keysByFingerprint.get(fingerprint);

      if (entry === undefined || entry.record.tokenId !== record.id) {
        throw buildNotFoundError('ssh-key', fingerprint);
      }

      requireNotInFile([entry]);

      await removeTokenSshKeyRecord(deps.db, entry.record.id);

      keysByFingerprint.delete(fingerprint);
      deps.onRemove(entry.record.id);
    },
    findSshKey: (blob) => {
      const entry = keysByFingerprint.get(formatKeyFingerprint(blob));
      const record = entry === undefined ? undefined : byId.get(entry.record.tokenId);

      if (entry === undefined || record === undefined) {
        return null;
      }

      return {
        key: entry.key,
        keyId: entry.record.id,
        caller: { ...toCaller(record), kind: 'ssh' },
      };
    },
    authenticate: (secret) => {
      const parsed = parseSecret(secret);
      const record = parsed === null ? undefined : byId.get(parsed.id);

      if (parsed !== null && record !== undefined) {
        return isSameHash(buildSecretHash(parsed.secret), Buffer.from(record.secretHash, 'hex'))
          ? toCaller(record)
          : null;
      }

      return isSameHash(buildSecretHash(secret), rootHash) ? rootCaller : null;
    },
    findById: (id) => {
      if (id === ROOT_TOKEN_ID) {
        return rootCaller;
      }

      const record = byId.get(id);

      return record === undefined ? null : toCaller(record);
    },
  };
}

// Each name with its secret's generation now, so the token is bound to that
// secret and not to one made later under the name. Only a manage token for
// some imps takes a list: a host-wide one grants anything already.
async function readGrantable(
  db: ImpDatabase,
  names: readonly string[],
  token: Readonly<Pick<NewToken, 'scope' | 'imps'>>,
): Promise<GrantableSecret[]> {
  if (names.length === 0) {
    return [];
  }

  if (token.imps === null || token.scope !== 'manage') {
    throw new ORPCError('BAD_REQUEST', {
      message: 'a token that may grant secrets needs scope manage and imp patterns',
    });
  }

  const grantable: GrantableSecret[] = [];

  for (const name of names) {
    const secret = await findSecret(db, name);

    if (secret === undefined) {
      throw buildNotFoundError('secret', name);
    }

    grantable.push({ name, generation: secret.generation });
  }

  return grantable;
}

// each line as a key entry; CONFLICT for the same key twice
function buildKeyEntries(lines: readonly string[], build: (line: string) => KeyEntry): KeyEntry[] {
  const entries = lines.map((line) => build(line));

  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.record.fingerprint)) {
      throw buildConflictError('ssh-key', entry.record.fingerprint, 'the same key is given twice');
    }

    seen.add(entry.record.fingerprint);
  }

  return entries;
}

// the secret of a bearer header, or null for none
export function readBearer(header: string | null): string | null {
  return header !== null && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

function parseSecret(text: string): { readonly id: string; readonly secret: string } | null {
  if (!text.startsWith(SECRET_PREFIX)) {
    return null;
  }

  const [id, secret, ...rest] = text.slice(SECRET_PREFIX.length).split('.');

  return id === undefined || secret === undefined || rest.length > 0 ? null : { id, secret };
}

function buildSecretHash(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

// both are SHA-256 digests, so the lengths match and the compare is constant
// time; the check guards a stored hash that is not one
function isSameHash(given: Buffer, expected: Buffer): boolean {
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function toToken(record: Readonly<TokenRecord>): Omit<Token, 'sshKeys'> {
  return {
    name: record.name,
    scope: record.scope,
    imps: record.imps,
    grantable: record.grantable.map((secret) => secret.name),
    createdAt: record.createdAt,
  };
}

function toSshKey(entry: Readonly<KeyEntry>): SshKey {
  return {
    fingerprint: entry.record.fingerprint,
    type: entry.key.type,
    comment: entry.record.comment,
  };
}

function toCaller(record: Readonly<TokenRecord>): Caller {
  return {
    kind: 'token',
    name: record.name,
    scope: record.scope,
    imps: record.imps,
    grantable: record.grantable,
    tokenId: record.id,
    grantId: null,
    expiresAt: null,

    // by id, not name: a deleted token's id never comes back, so a new token
    // with its name holds none of its leases
    principal: `token:${record.id}`,
    display: record.name,
  };
}
