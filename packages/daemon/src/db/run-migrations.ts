import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Migration, MigrationProvider, MigrationResultSet } from 'kysely/migration';
import type { DatabaseSchema } from './schema';

// every disk before sizes was a 32 GiB sparse file
const LEGACY_DISK_BYTES = 32 * 1024 ** 3;

export const MIGRATIONS: Record<string, Migration> = {
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

  // templates: images made from an imp's disk (#22), and the identity reset
  // an imp from one owes its first boot
  '010_add_image_source': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .alterTable('images')
        .addColumn('source', 'text', (c) => c.notNull().defaultTo('oci'))
        .execute();

      await db.schema.alterTable('images').addColumn('source_imp', 'text').execute();

      await db.schema
        .alterTable('imps')
        .addColumn('identity_reset_pending', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
    },
  },

  // public imps (#52): who reaches https://<name>.<domain>, and the hash of
  // the token or password a public imp asks for
  '011_add_public_exposure': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .alterTable('imps')
        .addColumn('exposure', 'text', (c) => c.notNull().defaultTo('tailnet'))
        .execute();

      await db.schema.alterTable('imps').addColumn('public_auth', 'text').execute();
      await db.schema.alterTable('imps').addColumn('public_user', 'text').execute();
      await db.schema.alterTable('imps').addColumn('public_hash', 'text').execute();
    },
  },

  // private networks between imps (#31); a destroyed imp or network takes
  // its memberships with it
  '012_add_networks': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .createTable('networks')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull().unique())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('network_members')
        .addColumn('network_id', 'text', (c) =>
          c.notNull().references('networks.id').onDelete('cascade'),
        )
        .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
        .addPrimaryKeyConstraint('network_members_pk', ['network_id', 'imp_id'])
        .execute();

      await db.schema
        .createIndex('network_members_imp_id')
        .on('network_members')
        .column('imp_id')
        .execute();
    },
  },

  // leases (#96): each owner's own hold on an imp. A hold still live moves to
  // the owner `legacy`; hold_until stays, as the latest lease's end.
  '013_add_imp_leases': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .createTable('imp_leases')
        .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
        .addColumn('principal', 'text', (c) => c.notNull())
        .addColumn('label', 'text', (c) => c.notNull())
        .addColumn('display', 'text', (c) => c.notNull())
        .addColumn('until', 'integer')
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .addPrimaryKeyConstraint('imp_leases_pk', ['imp_id', 'principal', 'label'])
        .execute();

      const now = Date.now();

      await db
        .insertInto('imp_leases')
        .columns(['imp_id', 'principal', 'label', 'display', 'until', 'created_at'])
        .expression((eb) =>
          eb
            .selectFrom('imps')
            .select([
              'id',
              eb.val('legacy').as('principal'),
              eb.val('hold').as('label'),
              eb.val('legacy').as('display'),
              'hold_until',
              eb.val(now).as('created_at'),
            ])
            .where('hold_until', '>', now),
        )
        .execute();

      await db
        .updateTable('imps')
        .set({ hold_until: null })
        .where('hold_until', '<=', now)
        .execute();
    },
  },

  // moves between hosts (docs/guides/hosts.md#moves)
  '014_add_moves': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema.alterTable('imps').addColumn('move_state', 'text').execute();

      await db.schema
        .createTable('move_tickets')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('secret_sha256', 'text', (c) => c.notNull().unique())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('bytes', 'integer', (c) => c.notNull())
        .addColumn('imp_id', 'text')
        .addColumn('issued_at', 'integer', (c) => c.notNull())
        .addColumn('stream_by', 'integer', (c) => c.notNull())
        .addColumn('stream_used_at', 'integer')
        .addColumn('receipt', 'text')
        .addColumn('commit_until', 'integer')
        .addColumn('committed_at', 'integer')
        .execute();

      await db.schema
        .createTable('move_sends')
        .addColumn('imp_id', 'text', (c) => c.primaryKey())
        .addColumn('peer_url', 'text')
        .addColumn('ticket', 'text')
        .addColumn('total_bytes', 'integer', (c) => c.notNull())
        .addColumn('mode', 'text', (c) => c.notNull().defaultTo('files'))
        .addColumn('receipt', 'text')
        .addColumn('error', 'text')
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .execute();
    },
  },

  // the last cold boots of each imp, which end its sessions' output
  // generations, and the cause its next one has when impd knows it early
  '015_add_cold_boots': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .createTable('imp_cold_boots')

        // the order impd recorded them in: `at` can tie within a millisecond
        .addColumn('seq', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
        .addColumn('boot_id', 'text', (c) => c.notNull())
        .addColumn('cause', 'text', (c) => c.notNull())
        .addColumn('at', 'integer', (c) => c.notNull())
        .addUniqueConstraint('imp_cold_boots_imp_boot', ['imp_id', 'boot_id'])
        .execute();

      await db.schema.alterTable('imps').addColumn('next_boot_cause', 'text').execute();
    },
  },

  // a uid per imp for its jailed Firecracker (#27), in order of creation,
  // from the start of db/imps.ts JAIL_UIDS
  '016_add_imp_jail_uid': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema.alterTable('imps').addColumn('jail_uid', 'integer').execute();
      await db.schema.createIndex('imps_jail_uid').on('imps').column('jail_uid').unique().execute();

      const rows = await db.selectFrom('imps').select('id').orderBy('created_at').execute();

      for (const [index, row] of rows.entries()) {
        await db
          .updateTable('imps')
          .set({ jail_uid: 900_000 + index })
          .where('id', '=', row.id)
          .execute();
      }
    },
  },

  // warm moves (#86): the slot a ticket keeps for the imp it brings
  '017_add_move_slots': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema.alterTable('move_tickets').addColumn('slot', 'integer').execute();
    },
  },

  // warm moves (#86): which sends carry the memory, and an imp whose first
  // wake on its new host installs this host's broker CA
  '018_add_warm_moves': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .alterTable('move_sends')
        .addColumn('warm', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();

      await db.schema
        .alterTable('imps')
        .addColumn('trust_pending', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
    },
  },

  // elastic memory (#35): the most an imp's guest may grow to; null is no
  // growth, the guest stays at memory_mib
  '019_add_imp_max_memory': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema.alterTable('imps').addColumn('max_memory_mib', 'integer').execute();
    },
  },

  // tokens that may grant (#126): the secrets, each by name and generation;
  // each grant's generation; and the file with each value. Existing values
  // are in files named after their secrets.
  '020_add_grantable_secrets': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .alterTable('tokens')
        .addColumn('grantable', 'text', (c) => c.notNull().defaultTo('[]'))
        .execute();

      await db.schema
        .alterTable('secrets')
        .addColumn('generation', 'text', (c) => c.notNull().defaultTo(''))
        .execute();

      await db.schema
        .alterTable('secrets')
        .addColumn('value_file', 'text', (c) => c.notNull().defaultTo(''))
        .execute();

      await db.schema
        .alterTable('grants')
        .addColumn('secret_generation', 'text', (c) => c.notNull().defaultTo(''))
        .execute();

      // randomblob runs once per row
      await db
        .updateTable('secrets')
        .set({ generation: sql`lower(hex(randomblob(16)))`, value_file: sql.ref('name') })
        .execute();

      await db
        .updateTable('grants')
        .set({
          secret_generation: (eb) =>
            eb
              .selectFrom('secrets')
              .select('secrets.generation')
              .whereRef('secrets.name', '=', 'grants.secret_name'),
        })
        .execute();
    },
  },

  // image builders (#156): an imp impd made for one build, which only rm
  // reaches and which goes at the build's end or impd's next start
  '024_add_imp_kind': {
    async up(db: Kysely<DatabaseSchema>) {
      await db.schema
        .alterTable('imps')
        .addColumn('kind', 'text', (c) => c.notNull().defaultTo('user'))
        .execute();
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

// up to and including `name`, for a test that writes rows as an older impd did
export async function runMigrationsTo(db: Kysely<DatabaseSchema>, name: string): Promise<void> {
  const migrator = new Migrator({ db, provider: PROVIDER });

  const result = await migrator.migrateTo(name);

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
