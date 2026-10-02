import { BrokerRuleSchema, SecretKindSchema } from '@imp/api';
import type { BrokerRule, SecretKind } from '@imp/api';
import type { Selectable } from 'kysely';
import * as z from 'zod';
import type { ImpDatabase } from './open-database';
import type { DatabaseSchema } from './schema';

// Secrets and grants: what the credential broker may add, and for which
// imps. Values are not here; broker/secret-files.ts keeps them.

type SecretRow = Selectable<DatabaseSchema['secrets']>;

export interface SecretRecord {
  readonly name: string;
  readonly kind: SecretKind;
  readonly rules: readonly BrokerRule[];
  readonly createdAt: Date;
}

export interface NewSecret {
  readonly name: string;
  readonly kind: SecretKind;
  readonly rules: readonly BrokerRule[];
}

// one granted rule: the broker's view of what an imp may send to a host
export interface GrantedRule {
  readonly secretName: string;
  readonly kind: SecretKind;
  readonly rule: BrokerRule;
}

// the imp behind a broker connection
export interface BrokerPeer {
  readonly id: string;
  readonly name: string;
  readonly egressPolicy: string;
}

const RulesSchema = z.array(BrokerRuleSchema);

// Insert, or with `replace` overwrite a secret by that name. False when it
// exists and `replace` is not set.
export async function writeSecret(
  db: ImpDatabase,
  secret: NewSecret,
  replace: boolean,
): Promise<SecretRecord | null> {
  const values = {
    name: secret.name,
    kind: secret.kind,
    rules: JSON.stringify(secret.rules),
    created_at: Date.now(),
  };

  const insert = db.insertInto('secrets').values(values);

  const query = replace
    ? insert.onConflict((conflict) =>
        conflict.column('name').doUpdateSet({ kind: values.kind, rules: values.rules }),
      )
    : insert.onConflict((conflict) => conflict.column('name').doNothing());

  const row = await query.returningAll().executeTakeFirst();

  return row === undefined ? null : toSecretRecord(row);
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

  const grants = await db
    .selectFrom('grants')
    .innerJoin('imps', 'imps.id', 'grants.imp_id')
    .select(['grants.secret_name', 'imps.name'])
    .orderBy('imps.name')
    .execute();

  return rows.map((row) => ({
    secret: toSecretRecord(row),
    imps: grants.filter((grant) => grant.secret_name === row.name).map((grant) => grant.name),
  }));
}

// cascades to its grants
export async function removeSecret(db: ImpDatabase, name: string): Promise<boolean> {
  const result = await db.deleteFrom('secrets').where('name', '=', name).executeTakeFirst();

  return result.numDeletedRows > 0n;
}

// a no-op when the grant exists
export async function createGrant(
  db: ImpDatabase,
  impId: string,
  secretName: string,
): Promise<void> {
  await db
    .insertInto('grants')
    .values({ imp_id: impId, secret_name: secretName })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}

export async function removeGrant(
  db: ImpDatabase,
  impId: string,
  secretName: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('grants')
    .where('imp_id', '=', impId)
    .where('secret_name', '=', secretName)
    .executeTakeFirst();

  return result.numDeletedRows > 0n;
}

export async function listGrantNames(db: ImpDatabase, impId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('grants')
    .select('secret_name')
    .where('imp_id', '=', impId)
    .orderBy('secret_name')
    .execute();

  return rows.map((row) => row.secret_name);
}

// a fork gets the grants of the imp it was forked from
export async function createForkGrants(
  db: ImpDatabase,
  fromImpId: string,
  toImpId: string,
): Promise<void> {
  const names = await listGrantNames(db, fromImpId);

  if (names.length === 0) {
    return;
  }

  await db
    .insertInto('grants')
    .values(names.map((name) => ({ imp_id: toImpId, secret_name: name })))
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}

// every rule of every secret granted to the imp
export async function listGrantedRules(db: ImpDatabase, impId: string): Promise<GrantedRule[]> {
  const rows = await db
    .selectFrom('grants')
    .innerJoin('secrets', 'secrets.name', 'grants.secret_name')
    .select(['secrets.name', 'secrets.kind', 'secrets.rules'])
    .where('grants.imp_id', '=', impId)
    .orderBy('secrets.name')
    .execute();

  return rows.flatMap((row) =>
    parseRules(row.rules).map((rule) => ({
      secretName: row.name,
      kind: parseKind(row.kind),
      rule,
    })),
  );
}

// every granted rule of every imp, for the broker to drop terminators that
// no grant covers any more
export async function listAllGrantedRules(
  db: ImpDatabase,
): Promise<{ readonly impId: string; readonly rule: BrokerRule }[]> {
  const rows = await db
    .selectFrom('grants')
    .innerJoin('secrets', 'secrets.name', 'grants.secret_name')
    .select(['grants.imp_id', 'secrets.rules'])
    .execute();

  return rows.flatMap((row) => parseRules(row.rules).map((rule) => ({ impId: row.imp_id, rule })));
}

export async function findBrokerPeer(
  db: ImpDatabase,
  slot: number,
): Promise<BrokerPeer | undefined> {
  const row = await db
    .selectFrom('imps')
    .select(['id', 'name', 'egress_policy'])
    .where('slot', '=', slot)
    .executeTakeFirst();

  return row === undefined
    ? undefined
    : { id: row.id, name: row.name, egressPolicy: row.egress_policy };
}

function toSecretRecord(row: Readonly<SecretRow>): SecretRecord {
  return {
    name: row.name,
    kind: parseKind(row.kind),
    rules: parseRules(row.rules),
    createdAt: new Date(row.created_at),
  };
}

function parseRules(json: string): BrokerRule[] {
  return RulesSchema.parse(JSON.parse(json));
}

function parseKind(kind: string): SecretKind {
  return SecretKindSchema.parse(kind);
}
