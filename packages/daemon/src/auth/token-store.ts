import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Scope, Token } from '@imp/api';
import { buildConflictError, buildNotFoundError } from '../api-errors';
import type { ImpDatabase } from '../db/open-database';
import { listTokenRecords, removeTokenRecord, writeTokenRecord } from '../db/tokens';
import type { TokenRecord } from '../db/tokens';
import type { Caller } from './caller';

// The root token in <dataDir>/token has every scope and is not in the
// database. Its id is one a made token can never get (those are 16
// characters), so a dashboard session can name it.
export const ROOT_TOKEN_ID = 'root';
const ROOT_NAME = 'root';

// A made token is `imp_<id>.<secret>`: the id finds the entry, and the
// secret's SHA-256 is compared in constant time. 256 random bits need no
// slow hash; that is for secrets a person picks.
const SECRET_PREFIX = 'imp_';

interface NewToken {
  readonly name: string;
  readonly scope: Scope;
  readonly imps: readonly string[] | null;
}

export interface TokenStore {
  readonly list: () => Token[];

  // the token, and its secret: the only time impd has it
  readonly create: (token: Readonly<NewToken>) => Promise<{ token: Token; secret: string }>;

  // NOT_FOUND for an unknown name; calls onRemove with the token's id
  readonly remove: (name: string) => Promise<void>;

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

  // after a token is removed: what it opened ends
  readonly onRemove: (id: string) => void;
}

// impd is the only writer, so the tokens live in memory and every change
// is written through
export async function loadTokenStore(deps: Readonly<TokenStoreDeps>): Promise<TokenStore> {
  const byId = new Map<string, TokenRecord>();

  for (const record of await listTokenRecords(deps.db)) {
    byId.set(record.id, record);
  }

  const rootHash = buildSecretHash(deps.rootToken);

  const rootCaller: Caller = {
    kind: 'token',
    name: ROOT_NAME,
    scope: 'manage',
    imps: null,
    tokenId: ROOT_TOKEN_ID,
    expiresAt: null,
  };

  const findByName = (name: string): TokenRecord | null =>
    [...byId.values()].find((record) => record.name === name) ?? null;

  return {
    list: () =>
      [...byId.values()]
        .map((record) => toToken(record))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    create: async (token) => {
      if (token.name === ROOT_NAME || findByName(token.name) !== null) {
        throw buildConflictError('token', token.name);
      }

      const id = randomBytes(12).toString('base64url');
      const secret = randomBytes(32).toString('base64url');

      const record: TokenRecord = {
        id,
        name: token.name,
        secretHash: buildSecretHash(secret).toString('hex'),
        scope: token.scope,
        imps: token.imps,
        createdAt: new Date(deps.now()),
      };

      await writeTokenRecord(deps.db, record);

      byId.set(id, record);

      return { token: toToken(record), secret: `${SECRET_PREFIX}${id}.${secret}` };
    },
    remove: async (name) => {
      const record = findByName(name);

      if (record === null) {
        throw buildNotFoundError('token', name);
      }

      await removeTokenRecord(deps.db, record.id);

      byId.delete(record.id);
      deps.onRemove(record.id);
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

function toToken(record: Readonly<TokenRecord>): Token {
  return {
    name: record.name,
    scope: record.scope,
    imps: record.imps,
    createdAt: record.createdAt,
  };
}

function toCaller(record: Readonly<TokenRecord>): Caller {
  return {
    kind: 'token',
    name: record.name,
    scope: record.scope,
    imps: record.imps,
    tokenId: record.id,
    expiresAt: null,
  };
}
