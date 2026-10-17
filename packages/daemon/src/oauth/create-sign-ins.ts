import { randomBytes } from 'node:crypto';
import { hasScope } from '@impz/api';
import type { OAuthApproval, Scope } from '@impz/api';
import { ORPCError } from '@orpc/server';
import { buildConflictError, buildForbiddenError, buildNotFoundError } from '../api-errors';
import type { Caller } from '../auth/caller';
import { ROOT_TOKEN_ID } from '../auth/token-store';
import { createBuckets } from '../https/public-limits';
import { isGrantPattern, isPatternsWithin } from './grant-limits';

// The sign-ins that wait on the public MCP route's login page until a named
// imp token approves their code (docs/guides/mcp.md#public-route). They live
// in memory, so a restart ends the ones in progress.

const MINUTE_MS = 60_000;
const SIGN_IN_MS = 10 * MINUTE_MS;

// sign-ins waiting at once, per client and in all. A new one drops the
// oldest of its own client's; one past the total waits for room.
const MAX_PENDING = 16;
const MAX_PENDING_PER_CLIENT = 3;

// sign-ins per client: with no client address, a flood with a client's
// public ID can hold back that client's sign-ins, and no other's
const START_BUCKET = { size: 10, refillMs: 6000 };

// approvals per token that match no sign-in, so codes cannot be tried fast
const APPROVE_FAILURE_BUCKET = { size: 20, refillMs: 3000 };

// 32 symbols, with no 0, O, 1 or I to misread: 8 of them are 40 bits,
// enough because only a holder of a named imp token can try one, at a
// limited rate, within its 10 minutes
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

// what the approver gave
export interface Approval {
  readonly tokenID: string;
  readonly tokenName: string;
  readonly scope: Scope;
  readonly imps: readonly string[] | null;
}

// one sign-in: everything but its approval is fixed when it starts
interface SignIn {
  // the signed authorization query better-auth sent to the login page
  readonly key: string;
  readonly clientID: string;
  readonly clientName: string;
  readonly redirectURI: string;

  // the highest scope the client asked for; an approval may give less
  readonly requestedScope: Scope;
  readonly approvalCode: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly approval: Approval | null;
}

type SignInState = 'waiting' | 'approved';

// a sign-in's states and its one move; `approve` is the only write
const SIGN_IN_MOVES: Readonly<Record<SignInState, readonly SignInState[]>> = {
  waiting: ['approved'],
  approved: [],
};

type StartOutcome =
  | { readonly kind: 'started'; readonly signIn: SignIn }
  | { readonly kind: 'too-many'; readonly retryS: number };

export interface SignIns {
  readonly start: (
    entry: Readonly<Omit<SignIn, 'approvalCode' | 'createdAt' | 'expiresAt' | 'approval'>>,
  ) => StartOutcome;

  // the live sign-in its signed query names; null once it ended
  readonly find: (key: string) => SignIn | null;
  readonly remove: (key: string) => void;
  readonly removeClient: (clientID: string) => void;
  readonly readApproval: (code: string, approver: Readonly<Caller>) => OAuthApproval;
  readonly approve: (
    code: string,
    approver: Readonly<Caller>,
    scope: Scope,
    imps: readonly string[] | undefined,
  ) => SignIn;
}

interface SignInsDeps {
  readonly now: () => number;
}

export function createSignIns(deps: Readonly<SignInsDeps>): SignIns {
  const pending = new Map<string, SignIn>();
  const byCode = new Map<string, string>();

  const tryStart = createBuckets(START_BUCKET, deps.now);
  const tryApproveFailure = createBuckets(APPROVE_FAILURE_BUCKET, deps.now);

  const removeEntry = (entry: Readonly<SignIn>): void => {
    pending.delete(entry.key);
    byCode.delete(entry.approvalCode);
  };

  const removeStale = (): void => {
    const at = deps.now();

    for (const entry of pending.values()) {
      if (entry.expiresAt <= at) {
        removeEntry(entry);
      }
    }
  };

  // the sign-in an approver names by its code; a miss counts against the
  // token's burst
  const requirePending = (code: string, approver: Readonly<Caller>): SignIn => {
    const tokenID = requireNamedToken(approver);

    removeStale();

    const key = byCode.get(code);
    const entry = key === undefined ? undefined : pending.get(key);

    if (entry === undefined) {
      if (!tryApproveFailure(tokenID)) {
        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: 'too many codes that match no sign-in; wait a few seconds',
        });
      }

      throw buildNotFoundError('oauth-approval', formatApprovalCode(code));
    }

    return entry;
  };

  return {
    start: (entry) => {
      removeStale();

      if (!tryStart(entry.clientID)) {
        return { kind: 'too-many', retryS: START_BUCKET.refillMs / 1000 };
      }

      // a new sign-in makes room by dropping the oldest unapproved one of
      // its own client's, so a flood under other clients drops none of it
      const ofClient = [...pending.values()].filter((other) => other.clientID === entry.clientID);

      if (ofClient.length >= MAX_PENDING_PER_CLIENT) {
        const evicted = ofClient.find((other) => other.approval === null) ?? ofClient[0];

        if (evicted !== undefined) {
          removeEntry(evicted);
        }
      }

      if (pending.size >= MAX_PENDING) {
        return { kind: 'too-many', retryS: SIGN_IN_MS / 1000 };
      }

      const at = deps.now();

      const signIn: SignIn = {
        ...entry,
        approvalCode: createUniqueApprovalCode(byCode),
        createdAt: at,
        expiresAt: at + SIGN_IN_MS,
        approval: null,
      };

      pending.set(signIn.key, signIn);
      byCode.set(signIn.approvalCode, signIn.key);

      return { kind: 'started', signIn };
    },

    find: (key) => {
      removeStale();

      return pending.get(key) ?? null;
    },

    remove: (key) => {
      const entry = pending.get(key);

      if (entry !== undefined) {
        removeEntry(entry);
      }
    },

    removeClient: (clientID) => {
      for (const entry of pending.values()) {
        if (entry.clientID === clientID) {
          removeEntry(entry);
        }
      }
    },

    readApproval: (code, approver) => {
      const entry = requirePending(code, approver);

      return {
        client: entry.clientName,
        redirectUri: entry.redirectURI,
        requestedScope: entry.requestedScope,
        requestedAt: new Date(entry.createdAt),
        expiresAt: new Date(entry.expiresAt),
      };
    },

    // checked and set with no await, so two approvals of one code cannot
    // both land
    approve: (code, approver, scope, imps) => {
      const entry = requirePending(code, approver);

      if (!SIGN_IN_MOVES[entry.approval === null ? 'waiting' : 'approved'].includes('approved')) {
        throw buildConflictError(
          'oauth-approval',
          formatApprovalCode(code),
          'this sign-in is approved already',
        );
      }

      if (!hasScope(entry.requestedScope, scope)) {
        throw new ORPCError('BAD_REQUEST', {
          message: `the client asked for ${entry.requestedScope}; approve that or less`,
        });
      }

      if (!hasScope(approver.scope, scope)) {
        throw buildForbiddenError(
          `token ${approver.name} has ${approver.scope}, so it may approve that or less`,
        );
      }

      const patterns = imps ?? approver.imps;

      if (patterns !== null && !patterns.every((pattern) => isGrantPattern(pattern))) {
        throw new ORPCError('BAD_REQUEST', {
          message: `token ${approver.name}'s patterns are not all an imp name or a prefix and *; name the imps with --imps`,
        });
      }

      if (!isPatternsWithin(patterns, approver.imps)) {
        throw buildForbiddenError(
          `the imps must stay within token ${approver.name}'s: ${(approver.imps ?? []).join(', ')}`,
        );
      }

      const approved: SignIn = {
        ...entry,
        approval: {
          tokenID: requireNamedToken(approver),
          tokenName: approver.name,
          scope,
          imps: patterns,
        },
      };

      pending.set(entry.key, approved);

      return approved;
    },
  };
}

export function formatApprovalCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// Only a named token approves: root and tailnet identities cannot be removed
// one by one, so a grant from them could not be ended with its approver.
// Returns the token's id.
function requireNamedToken(approver: Readonly<Caller>): string {
  const isNamedKind = approver.kind === 'token' || approver.kind === 'dashboard';

  if (!isNamedKind || approver.tokenId === null || approver.tokenId === ROOT_TOKEN_ID) {
    throw buildForbiddenError(
      'only a named token approves a sign-in; make one with impz token new and use it',
    );
  }

  return approver.tokenId;
}

function createUniqueApprovalCode(taken: ReadonlyMap<string, string>): string {
  for (;;) {
    const bytes = randomBytes(CODE_LENGTH);
    const code = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');

    if (!taken.has(code)) {
      return code;
    }
  }
}
