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

// what a checked grant did: made it (or found it made), or why not
export type GrantOutcome =
  | { readonly kind: 'granted' }
  | { readonly kind: 'no-secret' }
  | { readonly kind: 'not-grantable' }
  | { readonly kind: 'clash'; readonly clash: GrantClash };

export type RevokeOutcome =
  | { readonly kind: 'revoked' }
  | { readonly kind: 'no-grant' }
  | { readonly kind: 'not-grantable' };

// what a replace did: the record and the file it no longer names, or the
// first grant whose imp the new rules would give two credentials for a host
export type ReplaceOutcome =
  | { readonly kind: 'saved'; readonly secret: SecretRecord; readonly oldValueFile: string | null }
  | { readonly kind: 'clash'; readonly impName: string; readonly clash: GrantClash };

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

// The kind, rules and value file in one write: a request reads the old host
// with the old value, or the new with the new. Checked in the transaction
// against every imp it is granted to; a secret that does not exist is made.
export function upsertSecret(
  db: ImpDatabase,
  secret: Readonly<NewSecret>,
): Promise<ReplaceOutcome> {
  return db.transaction().execute(async (trx) => {
    const existing = await findSecret(trx, secret.name);

    if (existing === undefined) {
      const made = await createSecret(trx, secret);

      if (made === null) {
        throw new Error(`secret ${secret.name} was not saved`);
      }

      return { kind: 'saved', secret: made, oldValueFile: null };
    }

    const grantedTo = await trx
      .selectFrom('grants')
      .innerJoin('imps', 'imps.id', 'grants.imp_id')
      .select(['imps.id', 'imps.name'])
      .where('grants.secret_name', '=', secret.name)
      .orderBy('imps.name')
      .execute();

    for (const imp of grantedTo) {
      const clash = await findClash(trx, imp.id, secret.name, secret.rules);

      if (clash !== null) {
        return { kind: 'clash', impName: imp.name, clash };
      }
    }

    const row = await trx
      .updateTable('secrets')
      .set({
        kind: secret.kind,
        rules: JSON.stringify(secret.rules),
        value_file: secret.valueFile,
      })
      .where('name', '=', secret.name)
      .returningAll()
      .executeTakeFirstOrThrow();

    return { kind: 'saved', secret: toSecretRecord(row), oldValueFile: existing.valueFile };
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

// cascades to its grants; the file that held its value, or null when there
// was no such secret
export async function removeSecret(db: ImpDatabase, name: string): Promise<string | null> {
  const row = await db
    .deleteFrom('secrets')
    .where('name', '=', name)
    .returning('value_file')
    .executeTakeFirst();

  return row?.value_file ?? null;
}

// A no-op when the grant exists. The clash check and the insert are one
// transaction, so two clashing grants cannot both pass. With a generation,
// the secret must still be the one a grantable list named.
export function createCheckedGrant(
  db: ImpDatabase,
  impId: string,
  secretName: string,
  generation: string | null,
): Promise<GrantOutcome> {
  return db.transaction().execute(async (trx) => {
    const secret = await findSecret(trx, secretName);

    if (secret === undefined) {
      return { kind: 'no-secret' };
    }

    if (generation !== null && secret.generation !== generation) {
      return { kind: 'not-grantable' };
    }

    const clash = await findClash(trx, impId, secret.name, secret.rules);

    if (clash !== null) {
      return { kind: 'clash', clash };
    }

    await writeGrant(trx, impId, secret.name);

    return { kind: 'granted' };
  });
}

// with a generation, as createCheckedGrant
export function removeCheckedGrant(
  db: ImpDatabase,
  impId: string,
  secretName: string,
  generation: string | null,
): Promise<RevokeOutcome> {
  return db.transaction().execute(async (trx) => {
    if (generation !== null) {
      const secret = await findSecret(trx, secretName);

      if (secret?.generation !== generation) {
        return { kind: 'not-grantable' };
      }
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
  const rows = await db
    .selectFrom('grants')
    .select('secret_name')
    .where('imp_id', '=', impId)
    .orderBy('secret_name')
    .execute();

  return rows.map((row) => row.secret_name);
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
        await writeGrant(trx, toImpId, name);
      } else {
        skipped.push(name);
      }
    }

    return skipped;
  });
}

// every rule of every secret granted to the imp
export async function listGrantedRules(db: ImpDatabase, impId: string): Promise<GrantedRule[]> {
  const rows = await db
    .selectFrom('grants')
    .innerJoin('secrets', 'secrets.name', 'grants.secret_name')
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

async function writeGrant(db: ImpDatabase, impId: string, secretName: string): Promise<void> {
  await db
    .insertInto('grants')
    .values({ imp_id: impId, secret_name: secretName })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}

function createGeneration(): string {
  return randomBytes(12).toString('hex');
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
