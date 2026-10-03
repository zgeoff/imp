import { randomBytes } from 'node:crypto';
import { BrokerRuleSchema, SecretKindSchema } from '@imp/api';
import type { BrokerRule, EgressPolicy, SecretKind } from '@imp/api';
import type { Selectable } from 'kysely';
import * as z from 'zod';
import { parseStoredPolicy } from './egress';
import type { ImpDatabase } from './open-database';
import type { DatabaseSchema } from './schema';

// Secrets and grants: what the credential broker may add, and for which
// imps. Values are not here; broker/secret-files.ts keeps them.

type SecretRow = Selectable<DatabaseSchema['secrets']>;

export interface SecretRecord {
  readonly name: string;
  readonly kind: SecretKind;
  readonly rules: readonly BrokerRule[];

  // random, kept by a replace; a secret made again under the name gets
  // another (docs/guides/tokens.md#granting-secrets)
  readonly generation: string;

  // the file in <dataDir>/secrets that holds the value
  readonly valueFile: string;
  readonly createdAt: Date;
}

export interface NewSecret {
  readonly name: string;
  readonly kind: SecretKind;
  readonly rules: readonly BrokerRule[];

  // written before the row, so a row never names a file that is not there
  readonly valueFile: string;
}

// one granted rule: the broker's view of what an imp may send to a host,
// and the file with the value, read with it so the two always match
export interface GrantedRule {
  readonly secretName: string;
  readonly kind: SecretKind;
  readonly rule: BrokerRule;
  readonly valueFile: string;
}

// another secret that already gives the imp a credential for the host
export interface GrantClash {
  readonly secretName: string;
  readonly host: string;
}

// A grant or revoke through a token's grantable list: the token must still
// exist, and the secret must still be the one its list named
export interface GrantAuthority {
  readonly tokenId: string;
  readonly generation: string;
}

// what a checked grant did: made it (or found it made), or why not
export type GrantOutcome =
  | { readonly kind: 'granted' }
  | { readonly kind: 'no-secret' }
  | { readonly kind: 'no-token' }
  | { readonly kind: 'not-grantable' }
  | { readonly kind: 'clash'; readonly clash: GrantClash };

export type RevokeOutcome =
  | { readonly kind: 'revoked' }
  | { readonly kind: 'no-grant' }
  | { readonly kind: 'no-token' }
  | { readonly kind: 'not-grantable' };

// What a replace did: the record, the file it no longer names, and the
// grants a rebind dropped; or a changed binding without rebind
export type ReplaceOutcome =
  | {
      readonly kind: 'saved';
      readonly secret: SecretRecord;
      readonly oldValueFile: string | null;
      readonly droppedGrants: number;
    }
  | { readonly kind: 'binding-changed' };

// the imp behind a broker connection
export interface BrokerPeer {
  readonly id: string;
  readonly name: string;
  readonly egress: EgressPolicy;
}

const RulesSchema = z.array(BrokerRuleSchema);

// Insert a new secret with a new generation; null when the name is taken.
export async function createSecret(
  db: ImpDatabase,
  secret: Readonly<NewSecret>,
): Promise<SecretRecord | null> {
  const row = await db
    .insertInto('secrets')
    .values({
      name: secret.name,
      kind: secret.kind,
      rules: JSON.stringify(secret.rules),
      generation: createGeneration(),
      value_file: secret.valueFile,
      created_at: Date.now(),
    })
    .onConflict((conflict) => conflict.column('name').doNothing())
    .returningAll()
    .executeTakeFirst();

  return row === undefined ? null : toSecretRecord(row);
}

// The value file, and with rebind the kind and rules, in one write: a
// request reads the old binding with the old value, or the new with the new.
// The same binding is a rotation: generation and grants stay.
export function upsertSecret(
  db: ImpDatabase,
  secret: Readonly<NewSecret>,
  rebind: boolean,
): Promise<ReplaceOutcome> {
  return db.transaction().execute(async (trx) => {
    const existing = await findSecret(trx, secret.name);

    if (existing === undefined) {
      const made = await createSecret(trx, secret);

      if (made === null) {
        throw new Error(`secret ${secret.name} was not saved`);
      }

      return { kind: 'saved', secret: made, oldValueFile: null, droppedGrants: 0 };
    }

    const isRotation = isSameBinding(existing, secret);

    if (!isRotation && !rebind) {
      return { kind: 'binding-changed' };
    }

    // a rebind is another secret to every grant and grantable list
    const dropped = isRotation
      ? null
      : await trx.deleteFrom('grants').where('secret_name', '=', secret.name).executeTakeFirst();

    const row = await trx
      .updateTable('secrets')
      .set({
        kind: secret.kind,
        rules: JSON.stringify(secret.rules),
        value_file: secret.valueFile,
        ...(!isRotation && { generation: createGeneration() }),
      })
      .where('name', '=', secret.name)
      .returningAll()
      .executeTakeFirstOrThrow();

    await createFileRemoval(trx, existing.valueFile);

    return {
      kind: 'saved',
      secret: toSecretRecord(row),
      oldValueFile: existing.valueFile,
      droppedGrants: Number(dropped?.numDeletedRows ?? 0n),
    };
  });
}

export async function findSecret(db: ImpDatabase, name: string): Promise<SecretRecord | undefined> {
  const row = await db
    .selectFrom('secrets')
    .selectAll()
    .where('name', '=', name)
    .executeTakeFirst();

  return row === undefined ? undefined : toSecretRecord(row);
}

// by name, each with the names of the imps it is granted to
export async function listSecrets(
  db: ImpDatabase,
): Promise<{ readonly secret: SecretRecord; readonly imps: readonly string[] }[]> {
  const rows = await db.selectFrom('secrets').selectAll().orderBy('name').execute();

  const grants = await useLiveGrants(db)
    .innerJoin('imps', 'imps.id', 'grants.imp_id')
    .select(['grants.secret_name', 'imps.name'])
    .orderBy('imps.name')
    .execute();

  return rows.map((row) => ({
    secret: toSecretRecord(row),
    imps: grants.filter((grant) => grant.secret_name === row.name).map((grant) => grant.name),
  }));
}

// cascades to its grants; the file that held its value, or null when there
// was no such secret. The file is recorded for removal in the same write.
export function removeSecret(db: ImpDatabase, name: string): Promise<string | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .deleteFrom('secrets')
      .where('name', '=', name)
      .returning('value_file')
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    await createFileRemoval(trx, row.value_file);

    return row.value_file;
  });
}

async function createFileRemoval(db: ImpDatabase, valueFile: string): Promise<void> {
  await db
    .insertInto('secret_file_removals')
    .values({ value_file: valueFile, created_at: Date.now() })
    .onConflict((conflict) => conflict.column('value_file').doNothing())
    .execute();
}

// the value files a committed delete or replace displaced, not yet removed
export async function listFileRemovals(db: ImpDatabase): Promise<string[]> {
  const rows = await db.selectFrom('secret_file_removals').select('value_file').execute();

  return rows.map((row) => row.value_file);
}

export async function removeFileRemoval(db: ImpDatabase, valueFile: string): Promise<void> {
  await db.deleteFrom('secret_file_removals').where('value_file', '=', valueFile).execute();
}

// A no-op when the grant exists. The clash check and the insert are one
// transaction, so two clashing grants cannot both pass. The grant carries
// the secret's generation now.
export function createCheckedGrant(
  db: ImpDatabase,
  impId: string,
  secretName: string,
  authority: Readonly<GrantAuthority> | null,
): Promise<GrantOutcome> {
  return db.transaction().execute(async (trx) => {
    const secret = await findSecret(trx, secretName);
    const refusal = await checkAuthority(trx, authority, secret);

    if (refusal !== null) {
      return { kind: refusal };
    }

    if (secret === undefined) {
      return { kind: 'no-secret' };
    }

    const clash = await findClash(trx, impId, secret.name, secret.rules);

    if (clash !== null) {
      return { kind: 'clash', clash };
    }

    await writeGrant(trx, impId, secret);

    return { kind: 'granted' };
  });
}

// with an authority, as createCheckedGrant
export function removeCheckedGrant(
  db: ImpDatabase,
  impId: string,
  secretName: string,
  authority: Readonly<GrantAuthority> | null,
): Promise<RevokeOutcome> {
  return db.transaction().execute(async (trx) => {
    const secret = await findSecret(trx, secretName);
    const refusal = await checkAuthority(trx, authority, secret);

    if (refusal !== null) {
      return { kind: refusal };
    }

    const result = await trx
      .deleteFrom('grants')
      .where('imp_id', '=', impId)
      .where('secret_name', '=', secretName)
      .executeTakeFirst();

    return result.numDeletedRows > 0n ? { kind: 'revoked' } : { kind: 'no-grant' };
  });
}

export async function listGrantNames(db: ImpDatabase, impId: string): Promise<string[]> {
  const rows = await useLiveGrants(db)
    .select('grants.secret_name')
    .where('grants.imp_id', '=', impId)
    .orderBy('grants.secret_name')
    .execute();

  return rows.map((row) => row.secret_name);
}

// every file a secret's row names, for impd to remove the rest at start
export async function listValueFiles(db: ImpDatabase): Promise<Set<string>> {
  const rows = await db.selectFrom('secrets').select('value_file').execute();

  return new Set(rows.map((row) => row.value_file));
}

// A fork gets its source's grants, checked in one transaction against what
// it holds by then: one that clashes with a grant made on the fork since is
// skipped. The names of the skipped secrets.
export function createForkGrants(
  db: ImpDatabase,
  fromImpId: string,
  toImpId: string,
): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    const names = await listGrantNames(trx, fromImpId);

    const skipped: string[] = [];

    for (const name of names) {
      const secret = await findSecret(trx, name);

      if (secret === undefined) {
        continue;
      }

      if ((await findClash(trx, toImpId, name, secret.rules)) === null) {
        await writeGrant(trx, toImpId, secret);
      } else {
        skipped.push(name);
      }
    }

    return skipped;
  });
}

// every rule of every secret granted to the imp
export async function listGrantedRules(db: ImpDatabase, impId: string): Promise<GrantedRule[]> {
  const rows = await useLiveGrants(db)
    .select(['secrets.name', 'secrets.kind', 'secrets.rules', 'secrets.value_file'])
    .where('grants.imp_id', '=', impId)
    .orderBy('secrets.name')
    .execute();

  return rows.flatMap((row) =>
    parseRules(row.rules).map((rule) => ({
      secretName: row.name,
      kind: parseKind(row.kind),
      rule,
      valueFile: row.value_file,
    })),
  );
}

// every granted rule of every imp, for the broker to drop terminators that
// no grant covers any more
export async function listAllGrantedRules(
  db: ImpDatabase,
): Promise<{ readonly impId: string; readonly rule: BrokerRule }[]> {
  const rows = await useLiveGrants(db).select(['grants.imp_id', 'secrets.rules']).execute();

  return rows.flatMap((row) => parseRules(row.rules).map((rule) => ({ impId: row.imp_id, rule })));
}

export async function findBrokerPeer(
  db: ImpDatabase,
  slot: number,
): Promise<BrokerPeer | undefined> {
  const row = await db
    .selectFrom('imps')
    .select(['id', 'name', 'egress_policy', 'egress_allow'])
    .where('slot', '=', slot)
    .executeTakeFirst();

  return row === undefined
    ? undefined
    : {
        id: row.id,
        name: row.name,
        egress: parseStoredPolicy(row.egress_policy, row.egress_allow),
      };
}

// A host has one credential per imp: two would leave the header
// ambiguous. The imp's other grant that covers one of the hosts, or null.
async function findClash(
  db: ImpDatabase,
  impId: string,
  secretName: string,
  rules: readonly BrokerRule[],
): Promise<GrantClash | null> {
  const granted = await listGrantedRules(db, impId);

  const clash = granted.find(
    (other) =>
      other.secretName !== secretName && rules.some((rule) => rule.host === other.rule.host),
  );

  return clash === undefined ? null : { secretName: clash.secretName, host: clash.rule.host };
}

// Grants whose generation is the secret's now: only these give a credential.
// A rebind drops the others in its transaction, so none should be left.
function useLiveGrants(db: ImpDatabase) {
  return db
    .selectFrom('grants')
    .innerJoin('secrets', (join) =>
      join
        .onRef('secrets.name', '=', 'grants.secret_name')
        .onRef('secrets.generation', '=', 'grants.secret_generation'),
    );
}

// Read in the grant's transaction: the token may have been removed, or the
// secret deleted or rebound, since the access check
async function checkAuthority(
  db: ImpDatabase,
  authority: Readonly<GrantAuthority> | null,
  secret: Readonly<SecretRecord> | undefined,
): Promise<'no-token' | 'not-grantable' | null> {
  if (authority === null) {
    return null;
  }

  const token = await db
    .selectFrom('tokens')
    .select('id')
    .where('id', '=', authority.tokenId)
    .executeTakeFirst();

  if (token === undefined) {
    return 'no-token';
  }

  return secret?.generation === authority.generation ? null : 'not-grantable';
}

// a grant made again takes the secret's generation now
async function writeGrant(
  db: ImpDatabase,
  impId: string,
  secret: Readonly<SecretRecord>,
): Promise<void> {
  await db
    .insertInto('grants')
    .values({ imp_id: impId, secret_name: secret.name, secret_generation: secret.generation })
    .onConflict((conflict) =>
      conflict
        .columns(['imp_id', 'secret_name'])
        .doUpdateSet({ secret_generation: secret.generation }),
    )
    .execute();
}

// 128 random bits
function createGeneration(): string {
  return randomBytes(16).toString('hex');
}

// What a request depends on besides the value: the kind and the rules, with
// the rules in host order, so a reorder is the same binding
function isSameBinding(
  a: Readonly<Pick<NewSecret, 'kind' | 'rules'>>,
  b: Readonly<Pick<NewSecret, 'kind' | 'rules'>>,
): boolean {
  return a.kind === b.kind && toBindingKey(a.rules) === toBindingKey(b.rules);
}

function toBindingKey(rules: readonly BrokerRule[]): string {
  const canonical = rules
    .map((rule) => [rule.host, rule.header.toLowerCase(), rule.scheme, rule.user ?? null] as const)
    .toSorted((x, y) => `${x[0]}\n${x[1]}`.localeCompare(`${y[0]}\n${y[1]}`));

  return JSON.stringify(canonical);
}

function toSecretRecord(row: Readonly<SecretRow>): SecretRecord {
  return {
    name: row.name,
    kind: parseKind(row.kind),
    rules: parseRules(row.rules),
    generation: row.generation,
    valueFile: row.value_file,
    createdAt: new Date(row.created_at),
  };
}

function parseRules(json: string): BrokerRule[] {
  return RulesSchema.parse(JSON.parse(json));
}

function parseKind(kind: string): SecretKind {
  return SecretKindSchema.parse(kind);
}
