import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Migration, MigrationProvider, MigrationResultSet } from 'kysely/migration';

// every disk before sizes was a 32 GiB sparse file
const LEGACY_DISK_BYTES = 32 * 1024 ** 3;

// Each migration types the database as it stood when the migration ran, never
// as today's schema.ts, so a later column change cannot break an older
// migration. Timestamps are integer milliseconds since the epoch.
type NoTables = Record<string, never>;

// 013 copies each imp's hold into a lease of its own
interface ImpLeasesSnapshot {
  imps: { id: string; hold_until: number | null };
  imp_leases: {
    imp_id: string;
    principal: string;
    label: string;
    display: string;
    until: number | null;
    created_at: number;
  };
}

// 016 numbers the jail uids in creation order
interface JailUidSnapshot {
  imps: { id: string; created_at: number; jail_uid: number | null };
}

// 020 gives each secret a generation and value file, and each grant its
// secret's generation
interface GrantableSecretsSnapshot {
  secrets: { name: string; generation: string; value_file: string };
  grants: { secret_name: string; secret_generation: string };
}

export const MIGRATIONS: Record<string, Migration> = {
  '001_create_initial_schema': {
    async up(db: Kysely<NoTables>) {
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

        // the latest end of the imp's leases, kept with each lease write
        // (db/leases.ts); null while it has none
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
    async up(db: Kysely<NoTables>) {
      await db.schema
        .alterTable('imps')
        .addColumn('http_port', 'integer', (c) => c.notNull().defaultTo(8080))
        .execute();
    },
  },

  // the credential broker: secrets, grants, the audit log, and the egress
  // policy for hosts no grant covers
  '003_add_broker': {
    async up(db: Kysely<NoTables>) {
      await db.schema
        .alterTable('imps')

        // the egress mode, `open`, `box` or `none` (docs/architecture/networking.md),
        // and a box's allow-list as a JSON array
        .addColumn('egress_policy', 'text', (c) => c.notNull().defaultTo('open'))
        .execute();

      // A secret's metadata. Its value is a file in <dataDir>/secrets, never a row.
      await db.schema
        .createTable('secrets')
        .addColumn('name', 'text', (c) => c.primaryKey())
        .addColumn('kind', 'text', (c) => c.notNull())

        // BrokerRule[] as JSON
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
    async up(db: Kysely<NoTables>) {
      await db.schema
        .createTable('api_audit')
        .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('at', 'integer', (c) => c.notNull())
        .addColumn('procedure', 'text', (c) => c.notNull())
        .addColumn('actor', 'text', (c) => c.notNull())

        // the name, not a reference: a destroyed imp's rows stay
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
    async up(db: Kysely<NoTables>) {
      await db.schema
        .alterTable('imps')

        // the disk file's size; 32 GiB for an imp from before sizes
        .addColumn('disk_bytes', 'integer', (c) => c.notNull().defaultTo(LEGACY_DISK_BYTES))
        .execute();

      await db.schema
        .alterTable('imps')

        // 1 while a sleeping imp's guest has not grown into a resize yet: its
        // next wake grows it, a cold boot grows it anyway
        .addColumn('disk_grow_pending', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();

      await db.schema
        .alterTable('checkpoints')

        // the imp's disk size when the checkpoint was taken
        .addColumn('disk_bytes', 'integer', (c) => c.notNull().defaultTo(LEGACY_DISK_BYTES))
        .execute();
    },
  },

  // named API tokens with scopes (#29), and who made each audited call
  '006_add_tokens': {
    async up(db: Kysely<NoTables>) {
      await db.schema
        .createTable('tokens')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull().unique())

        // SHA-256 of the secret, in hex; the secret itself is never stored
        .addColumn('secret_hash', 'text', (c) => c.notNull())
        .addColumn('scope', 'text', (c) => c.notNull())

        // a JSON array of imp patterns; null for every imp and the host
        .addColumn('imps', 'text')
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .execute();

      // null on rows from before named tokens
      await db.schema.alterTable('api_audit').addColumn('actor_name', 'text').execute();
    },
  },

  // the allow-list of a `box` egress policy, as a JSON array
  '007_add_egress_allow': {
    async up(db: Kysely<NoTables>) {
      await db.schema
        .alterTable('imps')
        .addColumn('egress_allow', 'text', (c) => c.notNull().defaultTo('[]'))
        .execute();
    },
  },

  // SSH keys bound to tokens (#63); impd deletes a token's keys with it
  '008_add_token_ssh_keys': {
    async up(db: Kysely<NoTables>) {
      // an SSH key bound to a token (docs/guides/ssh.md#keys-bound-to-tokens)
      await db.schema
        .createTable('token_ssh_keys')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('token_id', 'text', (c) => c.notNull().references('tokens.id'))

        // `SHA256:<base64>` of the key blob; a key binds to one token at most
        .addColumn('fingerprint', 'text', (c) => c.notNull().unique())

        // `<type> <base64>`, without the comment
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
    async up(db: Kysely<NoTables>) {
      // cores the VM may use, null for no limit; its share under contention
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

        // awake time before awake_since, which is set while the imp runs
        .addColumn('awake_ms', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();

      // set while the imp runs; a crash leaves it, so the time still counts
      await db.schema.alterTable('imps').addColumn('awake_since', 'integer').execute();
    },
  },

  // templates: images made from an imp's disk (#22), and the identity reset
  // an imp from one owes its first boot
  '010_add_image_source': {
    async up(db: Kysely<NoTables>) {
      await db.schema
        .alterTable('images')

        // `oci` from docker, `imp` a template from an imp's disk
        .addColumn('source', 'text', (c) => c.notNull().defaultTo('oci'))
        .execute();

      // a template's source imp, by name: a token must reach it to copy its disk
      await db.schema.alterTable('images').addColumn('source_imp', 'text').execute();

      await db.schema
        .alterTable('imps')

        // 1 until the first cold boot of an imp from a template gives it its own
        // machine-id and ssh host keys
        .addColumn('identity_reset_pending', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
    },
  },

  // public imps (#52): who reaches https://<name>.<domain>, and the hash of
  // the token or password a public imp asks for
  '011_add_public_exposure': {
    async up(db: Kysely<NoTables>) {
      await db.schema
        .alterTable('imps')

        // `tailnet` or `public` (docs/guides/https.md#public-imps); a public imp's
        // auth (`none`, `token`, `basic`), basic's user, and the sha256 of the
        // token or password, base64url
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
    async up(db: Kysely<NoTables>) {
      // a private network between imps (docs/guides/networks.md)
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
    async up(db: Kysely<ImpLeasesSnapshot>) {
      // one owner's hold on an imp (docs/guides/leases.md): the principal impd
      // derived for the caller, and a label the caller picked
      await db.schema
        .createTable('imp_leases')
        .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
        .addColumn('principal', 'text', (c) => c.notNull())
        .addColumn('label', 'text', (c) => c.notNull())

        // the owner as a person reads it, when the lease was written
        .addColumn('display', 'text', (c) => c.notNull())

        // null holds with no end
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
    async up(db: Kysely<NoTables>) {
      // set while the imp moves between hosts: nothing wakes or changes it
      await db.schema.alterTable('imps').addColumn('move_state', 'text').execute();

      // The target's side of a move: one receive ticket. Only the ticket's sha256
      // is kept. The stream must start by stream_by; the commit is good until
      // commit_until, set at the receipt.
      await db.schema
        .createTable('move_tickets')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('secret_sha256', 'text', (c) => c.notNull().unique())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('bytes', 'integer', (c) => c.notNull())

        // the imp the stream staged, once it started
        .addColumn('imp_id', 'text')
        .addColumn('issued_at', 'integer', (c) => c.notNull())
        .addColumn('stream_by', 'integer', (c) => c.notNull())
        .addColumn('stream_used_at', 'integer')

        // the receipt as sent, JSON
        .addColumn('receipt', 'text')
        .addColumn('commit_until', 'integer')
        .addColumn('committed_at', 'integer')
        .execute();

      // The source's side of a move: the target's URL and ticket, kept so a
      // restart can finish the commit, and the receipt once it came
      await db.schema
        .createTable('move_sends')
        .addColumn('imp_id', 'text', (c) => c.primaryKey())
        .addColumn('peer_url', 'text')
        .addColumn('ticket', 'text')
        .addColumn('total_bytes', 'integer', (c) => c.notNull())

        // how the disk goes: `files`, or `zfs` streams to a ZFS target
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
    async up(db: Kysely<NoTables>) {
      // an imp's last cold boots (docs/architecture/daemon.md#output-offsets)
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

      // the cause the next cold boot records, when impd knew it before the
      // boot: `recovery`, `wake_fallback` or `restore`
      await db.schema.alterTable('imps').addColumn('next_boot_cause', 'text').execute();
    },
  },

  // a uid per imp for its jailed Firecracker (#27), in order of creation,
  // from the start of db/imps.ts JAIL_UIDS
  '016_add_imp_jail_uid': {
    async up(db: Kysely<JailUidSnapshot>) {
      // the uid and gid its jailed Firecracker runs as (docs/architecture/daemon.md#the-jailer)
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
    async up(db: Kysely<NoTables>) {
      // a warm move's slot, which no other imp takes until the commit
      await db.schema.alterTable('move_tickets').addColumn('slot', 'integer').execute();
    },
  },

  // warm moves (#86): which sends carry the memory, and an imp whose first
  // wake on its new host installs this host's broker CA
  '018_add_warm_moves': {
    async up(db: Kysely<NoTables>) {
      await db.schema
        .alterTable('move_sends')

        // 1 when the memory snapshot goes too: a warm move
        .addColumn('warm', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();

      await db.schema
        .alterTable('imps')

        // 1 from a warm move's commit to the imp's first wake here, which installs
        // this host's broker CA in the guest
        .addColumn('trust_pending', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
    },
  },

  // elastic memory (#35): the most an imp's guest may grow to; null is no
  // growth, the guest stays at memory_mib
  '019_add_imp_max_memory': {
    async up(db: Kysely<NoTables>) {
      // the most the guest may grow to with hot-plugged memory; null when it
      // stays at memory_mib (docs/architecture/memory.md)
      await db.schema.alterTable('imps').addColumn('max_memory_mib', 'integer').execute();
    },
  },

  // tokens that may grant (#126): the secrets, each by name and generation;
  // each grant's generation; and the file with each value. Existing values
  // are in files named after their secrets.
  '020_add_grantable_secrets': {
    async up(db: Kysely<GrantableSecretsSnapshot>) {
      await db.schema
        .alterTable('tokens')

        // a JSON array of { name, generation }: the secrets it may grant to its
        // imps. Set at create, and changed only by tokens.update; a non-empty
        // list also marks a token able to grant.
        .addColumn('grantable', 'text', (c) => c.notNull().defaultTo('[]'))
        .execute();

      await db.schema
        .alterTable('secrets')

        // random, set on create and kept by a rotation; a rebind or a delete and
        // create gives another (docs/guides/connectors.md#rotate-or-rebind)
        .addColumn('generation', 'text', (c) => c.notNull().defaultTo(''))
        .execute();

      await db.schema
        .alterTable('secrets')

        // the file in <dataDir>/secrets that holds the value; a replace writes a
        // new one and switches to it with the rules
        .addColumn('value_file', 'text', (c) => c.notNull().defaultTo(''))
        .execute();

      await db.schema
        .alterTable('grants')

        // the secret's generation at the grant: a rebind gives the secret another,
        // and a grant counts only while the two match
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

  // the sessions started with `require: ['broker']`, by execution generation
  // (docs/guides/connectors.md#requiring-the-broker)
  '021_add_broker_sessions': {
    async up(db: Kysely<NoTables>) {
      await db.schema
        .createTable('broker_sessions')
        .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
        .addColumn('generation', 'text', (c) => c.notNull())
        .addColumn('at', 'integer', (c) => c.notNull())
        .addPrimaryKeyConstraint('broker_sessions_pk', ['imp_id', 'generation'])
        .execute();
    },
  },

  // OAuth for the public MCP route (#127): the clients an operator adds,
  // the grants people approve, and each grant's access and refresh tokens.
  // 021 is #177's broker sessions.
  '022_add_mcp_oauth': {
    async up(db: Kysely<NoTables>) {
      // a public client of the MCP route (docs/guides/mcp.md#public-route)
      await db.schema
        .createTable('oauth_clients')

        // the client_id a connector holds
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull().unique())

        // a JSON array, each matched exactly
        .addColumn('redirect_uris', 'text', (c) => c.notNull())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .execute();

      // what one approval gave one client: never wider than token_id, whose
      // removal removes it
      await db.schema
        .createTable('oauth_grants')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('client_id', 'text', (c) => c.notNull().references('oauth_clients.id'))
        .addColumn('token_id', 'text', (c) => c.notNull().references('tokens.id'))
        .addColumn('scope', 'text', (c) => c.notNull())

        // a JSON array of grant patterns; null for every imp and the host
        .addColumn('imps', 'text')

        // the resource its tokens are bound to, `<origin>/mcp`
        .addColumn('resource', 'text', (c) => c.notNull())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .addColumn('last_used_at', 'integer')
        .execute();

      // an access or refresh token; a spent refresh token stays until it expires,
      // so a second use of it is known for a replay
      await db.schema
        .createTable('oauth_tokens')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('grant_id', 'text', (c) => c.notNull().references('oauth_grants.id'))
        .addColumn('kind', 'text', (c) => c.notNull())

        // SHA-256 of the secret, in hex
        .addColumn('secret_hash', 'text', (c) => c.notNull())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .addColumn('expires_at', 'integer', (c) => c.notNull())
        .addColumn('spent_at', 'integer')
        .execute();

      await db.schema
        .createIndex('oauth_grants_token_id')
        .on('oauth_grants')
        .column('token_id')
        .execute();

      await db.schema
        .createIndex('oauth_grants_client_id')
        .on('oauth_grants')
        .column('client_id')
        .execute();

      await db.schema
        .createIndex('oauth_tokens_grant_id')
        .on('oauth_tokens')
        .column('grant_id')
        .execute();

      await db.schema
        .createIndex('oauth_tokens_expires_at')
        .on('oauth_tokens')
        .column('expires_at')
        .execute();
    },
  },

  // each value file a delete or a replace displaced, written in its
  // transaction and cleared once the file is gone, so a crash between the
  // two leaves a record the next start finishes
  '023_add_secret_file_removals': {
    async up(db: Kysely<NoTables>) {
      // A value file a committed delete or replace displaced, until it is removed
      await db.schema
        .createTable('secret_file_removals')
        .addColumn('value_file', 'text', (c) => c.primaryKey())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .execute();
    },
  },

  // image builders (#156): an imp impd made for one build, which only rm
  // reaches and which goes at the build's end or impd's next start
  '024_add_imp_kind': {
    async up(db: Kysely<NoTables>) {
      await db.schema
        .alterTable('imps')
        .addColumn('kind', 'text', (c) => c.notNull().defaultTo('user'))
        .execute();
    },
  },

  // image adds in builder imps (#169): the reference a pull resolved, so an
  // add of a moving tag can be traced to the bytes it took
  '025_add_api_audit_detail': {
    async up(db: Kysely<NoTables>) {
      // what the call resolved that its name does not show: an image add's
      // pulled reference, by digest; null for most calls and older rows
      await db.schema.alterTable('api_audit').addColumn('detail', 'text').execute();
    },
  },

  // a refreshing oauth secret kind (GEO-121): the token endpoint and client
  // its refresh token belongs to; null for every other kind
  '026_add_secret_oauth': {
    async up(db: Kysely<NoTables>) {
      // OAuthConfig as JSON ({ tokenUrl, clientId, tokenFormat }); null unless kind
      // is oauth
      await db.schema.alterTable('secrets').addColumn('oauth', 'text').execute();
    },
  },

  // an imp left out of every backup run (GEO-534): 0 keeps its disk and
  // checkpoints out of the backup tree, so no restic snapshot holds them
  '027_add_imp_backup': {
    async up(db: Kysely<NoTables>) {
      await db.schema
        .alterTable('imps')

        // 0 for an imp left out of every backup run (docs/architecture/storage/backups.md)
        .addColumn('backup', 'integer', (c) => c.notNull().defaultTo(1))
        .execute();
    },
  },

  // a grant's delete takes its OAuth tokens with it. SQLite cannot add ON
  // DELETE CASCADE in place, so a copy of the table replaces it, in its own
  // transaction: Kysely runs a SQLite migration outside one.
  '028_cascade_oauth_tokens': {
    async up(db: Kysely<NoTables>) {
      await db.transaction().execute(async (trx) => {
        await trx.schema
          .createTable('oauth_tokens_cascade')
          .addColumn('id', 'text', (c) => c.primaryKey())
          .addColumn('grant_id', 'text', (c) =>
            c.notNull().references('oauth_grants.id').onDelete('cascade'),
          )
          .addColumn('kind', 'text', (c) => c.notNull())
          .addColumn('secret_hash', 'text', (c) => c.notNull())
          .addColumn('created_at', 'integer', (c) => c.notNull())
          .addColumn('expires_at', 'integer', (c) => c.notNull())
          .addColumn('spent_at', 'integer')
          .execute();

        await sql`
          INSERT INTO oauth_tokens_cascade
            (id, grant_id, kind, secret_hash, created_at, expires_at, spent_at)
          SELECT id, grant_id, kind, secret_hash, created_at, expires_at, spent_at
          FROM oauth_tokens
        `.execute(trx);

        await trx.schema.dropTable('oauth_tokens').execute();
        await trx.schema.alterTable('oauth_tokens_cascade').renameTo('oauth_tokens').execute();

        await trx.schema
          .createIndex('oauth_tokens_grant_id')
          .on('oauth_tokens')
          .column('grant_id')
          .execute();

        await trx.schema
          .createIndex('oauth_tokens_expires_at')
          .on('oauth_tokens')
          .column('expires_at')
          .execute();
      });
    },
  },
};

const PROVIDER: MigrationProvider = {
  getMigrations: () => Promise.resolve(MIGRATIONS),
};

export async function runMigrations<T>(db: Kysely<T>): Promise<void> {
  await requireKnownMigrations(db);

  const migrator = new Migrator({ db, provider: PROVIDER });

  const result = await migrator.migrateToLatest();

  requireMigrated(result);
}

// up to and including `name`, for a test that writes rows as an older impd
// did; a test of a failed migration passes its own `migrations`
export async function runMigrationsTo<T>(
  db: Kysely<T>,
  name: string,
  migrations: Readonly<Record<string, Readonly<Migration>>> = MIGRATIONS,
): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve({ ...migrations }) },
  });

  const result = await migrator.migrateTo(name);

  requireMigrated(result);
}

// A database a newer impd migrated holds migrations this one lacks: refused
// before anything runs, naming both schema versions, where kysely's own
// refusal names only the missing migration
async function requireKnownMigrations<T>(db: Kysely<T>): Promise<void> {
  const table = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kysely_migration'
  `.execute(db);

  if (table.rows.length === 0) {
    return;
  }

  const executed = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(db);

  const unknown = executed.rows
    .map((row) => row.name)
    .filter((name) => !Object.hasOwn(MIGRATIONS, name));

  if (unknown.length === 0) {
    return;
  }

  const newest = unknown.toSorted().at(-1) ?? '';
  const known = Object.keys(MIGRATIONS).toSorted().at(-1) ?? '';

  throw new Error(
    `the database is at migration ${newest}, newer than this impd's last, ${known}: start the impd that wrote it or a newer one, or restore an older database copy (docs/guides/operations.md#database-copy-and-restore)`,
  );
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
