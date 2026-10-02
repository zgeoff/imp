import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Migration, MigrationProvider, MigrationResultSet } from 'kysely/migration';
import type { DatabaseSchema } from './schema';

// every disk before sizes was a 32 GiB sparse file
const LEGACY_DISK_BYTES = 32 * 1024 ** 3;

const MIGRATIONS: Record<string, Migration> = {
  '001_create_initial_schema': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .createTable('images')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull().unique())
        .addColumn('ref', 'text', (c) => c.notNull())
        .addColumn('digest', 'text', (c) => c.notNull())
        .addColumn('size_bytes', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('imps')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull().unique())
        .addColumn('image_id', 'text', (c) => c.notNull().references('images.id'))
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('vcpus', 'integer', (c) => c.notNull())
        .addColumn('memory_mib', 'integer', (c) => c.notNull())
        .addColumn('slot', 'integer', (c) => c.notNull().unique())
        .addColumn('ip', 'text', (c) => c.notNull().unique())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .addColumn('last_active_at', 'integer', (c) => c.notNull())
        .addColumn('slept_at', 'integer')
        .addColumn('hold_until', 'integer')
        .addColumn('error', 'text')
        .addColumn('pid', 'integer')
        .addColumn('firecracker_version', 'text')
        .execute();

      await db.schema
        .createTable('checkpoints')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
        .addColumn('label', 'text')
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .addColumn('size_bytes', 'integer')
        .addUniqueConstraint('checkpoints_imp_id_label_unique', ['imp_id', 'label'])
        .execute();
    },
  },

  // the guest port the wake proxy forwards to
  '002_add_imp_http_port': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .alterTable('imps')
        .addColumn('http_port', 'integer', (c) => c.notNull().defaultTo(8080))
        .execute();
    },
  },

  // the credential broker: secrets, grants, the audit log, and the egress
  // policy for hosts no grant covers
  '003_add_broker': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .alterTable('imps')
        .addColumn('egress_policy', 'text', (c) => c.notNull().defaultTo('open'))
        .execute();

      await db.schema
        .createTable('secrets')
        .addColumn('name', 'text', (c) => c.primaryKey())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('rules', 'text', (c) => c.notNull())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('grants')
        .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
        .addColumn('secret_name', 'text', (c) =>
          c.notNull().references('secrets.name').onDelete('cascade'),
        )
        .addPrimaryKeyConstraint('grants_pk', ['imp_id', 'secret_name'])
        .execute();

      await db.schema
        .createTable('broker_audit')
        .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
        .addColumn('secret_name', 'text', (c) => c.notNull())
        .addColumn('at', 'integer', (c) => c.notNull())
        .addColumn('method', 'text', (c) => c.notNull())
        .addColumn('host', 'text', (c) => c.notNull())
        .addColumn('path', 'text', (c) => c.notNull())
        .addColumn('status', 'integer', (c) => c.notNull())
        .addColumn('request_bytes', 'integer', (c) => c.notNull())
        .addColumn('response_bytes', 'integer', (c) => c.notNull())
        .addColumn('duration_ms', 'integer', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('broker_audit_imp_id')
        .on('broker_audit')
        .columns(['imp_id', 'id'])
        .execute();
    },
  },

  // the API audit log: calls that change something, and sessions opened
  '004_add_api_audit': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .createTable('api_audit')
        .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('at', 'integer', (c) => c.notNull())
        .addColumn('procedure', 'text', (c) => c.notNull())
        .addColumn('actor', 'text', (c) => c.notNull())
        .addColumn('imp_name', 'text')
        .addColumn('outcome', 'text', (c) => c.notNull())
        .addColumn('duration_ms', 'integer', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('api_audit_imp_name')
        .on('api_audit')
        .columns(['imp_name', 'id'])
        .execute();
    },
  },

  // a disk size per imp and per checkpoint (docs/architecture/storage.md)
  '005_add_disk_sizes': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .alterTable('imps')
        .addColumn('disk_bytes', 'integer', (c) => c.notNull().defaultTo(LEGACY_DISK_BYTES))
        .execute();

      await db.schema
        .alterTable('imps')
        .addColumn('disk_grow_pending', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();

      await db.schema
        .alterTable('checkpoints')
        .addColumn('disk_bytes', 'integer', (c) => c.notNull().defaultTo(LEGACY_DISK_BYTES))
        .execute();
    },
  },

  // named API tokens with scopes (#29), and who made each audited call
  '006_add_tokens': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .createTable('tokens')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull().unique())
        .addColumn('secret_hash', 'text', (c) => c.notNull())
        .addColumn('scope', 'text', (c) => c.notNull())
        .addColumn('imps', 'text')
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .execute();

      await db.schema.alterTable('api_audit').addColumn('actor_name', 'text').execute();
    },
  },

  // the allow-list of a `box` egress policy, as a JSON array
  '007_add_egress_allow': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .alterTable('imps')
        .addColumn('egress_allow', 'text', (c) => c.notNull().defaultTo('[]'))
        .execute();
    },
  },

  // SSH keys bound to tokens (#63); impd deletes a token's keys with it
  '008_add_token_ssh_keys': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .createTable('token_ssh_keys')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('token_id', 'text', (c) => c.notNull().references('tokens.id'))
        .addColumn('fingerprint', 'text', (c) => c.notNull().unique())
        .addColumn('public_key', 'text', (c) => c.notNull())
        .addColumn('comment', 'text', (c) => c.notNull())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('token_ssh_keys_token_id')
        .on('token_ssh_keys')
        .column('token_id')
        .execute();
    },
  },

  // CPU limits, and how often and how long each imp was awake
  '009_add_imp_cpu': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema.alterTable('imps').addColumn('cpu_limit', 'real').execute();

      await db.schema
        .alterTable('imps')
        .addColumn('cpu_weight', 'integer', (c) => c.notNull().defaultTo(100))
        .execute();

      await db.schema
        .alterTable('imps')
        .addColumn('wake_count', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();

      await db.schema
        .alterTable('imps')
        .addColumn('awake_ms', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();

      // set while the imp runs; a crash leaves it, so the time still counts
      await db.schema.alterTable('imps').addColumn('awake_since', 'integer').execute();
    },
  },
};

const PROVIDER: MigrationProvider = {
  getMigrations: () => Promise.resolve(MIGRATIONS),
};

export async function runMigrations(db: Kysely<DatabaseSchema>): Promise<void> {
  const migrator = new Migrator({ db, provider: PROVIDER });

  const result = await migrator.migrateToLatest();

  requireMigrated(result);
}

function requireMigrated(result: MigrationResultSet): void {
  if (result.error === undefined) {
    return;
  }

  if (result.error instanceof Error) {
    throw result.error;
  }

  throw new Error('kysely migration failed', { cause: result.error });
}
