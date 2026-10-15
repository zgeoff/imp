import type { BrokerRule, OAuthConfig, Secret, SecretAdded, SecretKind } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { buildConflictError, buildNotFoundError } from '../api-errors';
import type { ImpDatabase } from '../db/open-database';
import {
  createSecret,
  findSecret,
  listSecrets,
  removeFileRemoval,
  removeSecret,
  upsertSecret,
} from '../db/secrets';
import type { NewSecret, SecretRecord } from '../db/secrets';
import { readErrorMessage } from '../read-error-message';
import { SecretRulesError, resolveRules } from './connector-kinds';
import type { OAuthRefresher } from './oauth-refresher';
import { buildPendingState, formatOAuthState, parseOAuthState, readIdClaims } from './oauth-state';
import { buildValueFile } from './secret-files';
import type { SecretFiles } from './secret-files';

// The broker's secrets for the API: each value in the file its row names
// (docs/guides/connectors.md#rotate-or-rebind), and an oauth secret's state
// (docs/guides/connectors.md#oauth-secrets).

export interface AddSecretInput {
  readonly name: string;
  readonly kind: SecretKind;
  readonly value: string;
  readonly rules?: readonly BrokerRule[] | undefined;

  // required for kind oauth, whose value is then the refresh token
  readonly oauth?: OAuthConfig | undefined;
  readonly replace?: boolean | undefined;
  readonly rebind?: boolean | undefined;
}

export interface SecretStore {
  readonly addSecret: (input: AddSecretInput) => Promise<SecretAdded>;
  readonly listSecrets: () => Promise<Secret[]>;

  // forces one refresh of an oauth secret and answers after it ends
  readonly refreshSecret: (name: string) => Promise<Secret>;
  readonly deleteSecret: (name: string) => Promise<void>;
}

export interface SecretStoreDeps {
  readonly db: ImpDatabase;
  readonly files: SecretFiles;
  readonly log: (message: string) => void;
  readonly refresher: OAuthRefresher;

  // drops what a replace or a delete took from the grants
  readonly applyGrants: () => Promise<void>;
}

export function createSecretStore(deps: SecretStoreDeps): SecretStore {
  const db = deps.db;
  const files = deps.files;
  const log = deps.log;
  const refresher = deps.refresher;

  const toApiSecret = async (secret: SecretRecord): Promise<Secret> => {
    const listed = await listSecrets(db);

    const imps = listed.find((entry) => entry.secret.name === secret.name)?.imps ?? [];

    return buildSecretView(secret, imps);
  };

  // what the API shows of a secret; for kind oauth, its state from the value
  // file, with no token in it
  const buildSecretView = (secret: SecretRecord, imps: readonly string[]): Secret => {
    const shown: Secret = {
      name: secret.name,
      kind: secret.kind,
      rules: secret.rules,
      imps,
      createdAt: secret.createdAt,
    };

    if (secret.kind !== 'oauth' || secret.oauth === null) {
      return shown;
    }

    const text = files.read(secret.valueFile);
    const stored = text === null ? null : parseOAuthState(text);

    return {
      ...shown,
      oauth: {
        ...secret.oauth,
        status: stored?.status ?? 'needs_login',
        expiresAt: toDate(stored?.expiresAt),
        refreshedAt: toDate(stored?.refreshedAt),
        error: stored === null ? 'value file missing or unreadable' : stored.error,
        idClaims: readIdClaims(stored?.idToken ?? null),
      },
    };
  };

  // The row for a value just written to its file, which goes again when no
  // row names it; with replace, the file the row named before.
  const writeSecretRow = async (
    secret: Readonly<NewSecret>,
    input: Readonly<AddSecretInput>,
  ): Promise<{
    readonly secret: SecretRecord;
    readonly oldValueFile: string | null;
    readonly droppedGrants: number;
  }> => {
    try {
      if (input.replace !== true) {
        const made = await createSecret(db, secret);

        if (made === null) {
          throw buildConflictError('secret', secret.name);
        }

        return { secret: made, oldValueFile: null, droppedGrants: 0 };
      }

      const outcome = await upsertSecret(db, secret, input.rebind === true);

      if (outcome.kind === 'binding-changed') {
        throw buildBindingChangedError(secret.name);
      }

      return outcome;
    } catch (error) {
      files.remove(secret.valueFile);
      throw error;
    }
  };

  // the exact file the commit displaced, then its record; a failure leaves
  // both to the next start
  const removeDisplacedFile = async (file: string): Promise<void> => {
    try {
      files.remove(file);

      await removeFileRemoval(db, file);
    } catch (error) {
      log(`impd: broker: could not remove an old secret value file: ${readErrorMessage(error)}`);
    }
  };

  return {
    addSecret: async (input) => {
      let rules: readonly BrokerRule[];

      try {
        rules = resolveRules(input.kind, input.rules);
      } catch (error) {
        if (error instanceof SecretRulesError) {
          throw new ORPCError('BAD_REQUEST', { message: error.message });
        }

        throw error;
      }

      if (input.kind === 'oauth' && input.oauth === undefined) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'kind oauth needs a token URL and a client id',
        });
      }

      if (input.kind !== 'oauth' && input.oauth !== undefined) {
        throw new ORPCError('BAD_REQUEST', {
          message: `kind ${input.kind} has no token URL or client id; they are for kind oauth`,
        });
      }

      const oauth = input.kind === 'oauth' ? (input.oauth ?? null) : null;

      // under the secret's lock, so a replace never lands in the middle of a
      // refresh, which rewrites the file the row names
      const saved = await refresher.withLock(input.name, async () => {
        const valueFile = buildValueFile(input.name);

        const content =
          input.kind === 'oauth' ? formatOAuthState(buildPendingState(input.value)) : input.value;

        // the value first, so no row ever names a file that is not there
        files.write(valueFile, content);

        const written = await writeSecretRow(
          { name: input.name, kind: input.kind, rules, oauth, valueFile },
          input,
        );

        if (written.oldValueFile !== null) {
          await removeDisplacedFile(written.oldValueFile);

          await deps.applyGrants();
        }

        return written;
      });

      // Only now, with the row committed: a refresh before it could rotate
      // the token, and a failed commit removes the file that holds the result.
      // A first refresh that fails still answers; the secret shows why.
      if (input.kind === 'oauth') {
        await refresher.refresh(input.name, true);
      }

      const latest = await findSecret(db, input.name);
      const shown = await toApiSecret(latest ?? saved.secret);

      return { ...shown, droppedGrants: saved.droppedGrants };
    },

    listSecrets: async () => {
      const listed = await listSecrets(db);

      return listed.map((entry) => buildSecretView(entry.secret, entry.imps));
    },

    refreshSecret: async (name) => {
      const secret = await findSecret(db, name);

      if (secret === undefined) {
        throw buildNotFoundError('secret', name);
      }

      if (secret.kind !== 'oauth') {
        throw new ORPCError('BAD_REQUEST', { message: `secret ${name} is not an oauth secret` });
      }

      await refresher.refresh(name, true);

      const current = await findSecret(db, name);

      if (current === undefined) {
        throw buildNotFoundError('secret', name);
      }

      return toApiSecret(current);
    },

    deleteSecret: async (name) => {
      await refresher.withLock(name, async () => {
        const valueFile = await removeSecret(db, name);

        if (valueFile === null) {
          throw buildNotFoundError('secret', name);
        }

        await removeDisplacedFile(valueFile);

        await deps.applyGrants();
      });
    },
  };
}

function toDate(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms);
}

// a replace with another kind or rules, without rebind
function buildBindingChangedError(name: string) {
  return new ORPCError('CONFLICT', {
    message: `secret ${name} would get other hosts or headers; a rebind (--rebind) drops its grants`,
    data: { kind: 'secret', name, reason: 'binding_changed' },
  });
}
