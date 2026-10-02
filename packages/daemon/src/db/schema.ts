import type { ApiActor, ImageSource, ImpState, Scope } from '@imp/api';
import type { Generated } from 'kysely';

// Timestamps are integer milliseconds since the epoch.

interface ImagesTable {
  id: string;
  name: string;
  ref: string;
  digest: string;
  size_bytes: number;
  created_at: number;

  // `oci` from docker, `imp` a template from an imp's disk
  source: Generated<ImageSource>;

  // a template's source imp, by name: a token must reach it to copy its disk
  source_imp: string | null;
}

interface ImpsTable {
  id: string;
  name: string;
  image_id: string;
  state: ImpState;
  vcpus: number;
  memory_mib: number;
  slot: number;
  ip: string;
  created_at: number;
  last_active_at: number;
  slept_at: number | null;
  hold_until: number | null;
  error: string | null;
  pid: number | null;
  firecracker_version: string | null;
  http_port: Generated<number>;

  // the egress mode, `open`, `box` or `none` (docs/architecture/networking.md),
  // and a box's allow-list as a JSON array
  egress_policy: Generated<string>;

  // the disk file's size; 32 GiB for an imp from before sizes
  disk_bytes: Generated<number>;

  // 1 while a sleeping imp's guest has not grown into a resize yet: its
  // next wake grows it, a cold boot grows it anyway
  disk_grow_pending: Generated<number>;
  egress_allow: Generated<string>;

  // cores the VM may use, null for no limit; its share under contention
  cpu_limit: number | null;
  cpu_weight: Generated<number>;
  wake_count: Generated<number>;

  // awake time before awake_since, which is set while the imp runs
  awake_ms: Generated<number>;
  awake_since: number | null;

  // 1 until the first cold boot of an imp from a template gives it its own
  // machine-id and ssh host keys
  identity_reset_pending: Generated<number>;

  // `tailnet` or `public` (docs/guides/https.md#public-imps); a public imp's
  // auth (`none`, `token`, `basic`), basic's user, and the sha256 of the
  // token or password, base64url
  exposure: Generated<string>;
  public_auth: string | null;
  public_user: string | null;
  public_hash: string | null;
}

interface CheckpointsTable {
  id: string;
  imp_id: string;
  label: string | null;
  created_at: number;
  size_bytes: number | null;

  // the imp's disk size when the checkpoint was taken
  disk_bytes: Generated<number>;
}

// A secret's metadata. Its value is a file in <dataDir>/secrets, never a row.
interface SecretsTable {
  name: string;
  kind: string;

  // BrokerRule[] as JSON
  rules: string;
  created_at: number;
}

interface GrantsTable {
  imp_id: string;
  secret_name: string;
}

interface BrokerAuditTable {
  id: Generated<number>;
  imp_id: string;
  secret_name: string;
  at: number;
  method: string;
  host: string;
  path: string;
  status: number;
  request_bytes: number;
  response_bytes: number;
  duration_ms: number;
}

export interface ApiAuditTable {
  id: Generated<number>;
  at: number;
  procedure: string;
  actor: ApiActor;

  // null on rows from before named tokens
  actor_name: string | null;

  // the name, not a reference: a destroyed imp's rows stay
  imp_name: string | null;
  outcome: string;
  duration_ms: number;
}

export interface TokensTable {
  id: string;
  name: string;

  // SHA-256 of the secret, in hex; the secret itself is never stored
  secret_hash: string;
  scope: Scope;

  // a JSON array of imp patterns; null for every imp and the host
  imps: string | null;
  created_at: number;
}

// an SSH key bound to a token (docs/guides/ssh.md#keys-bound-to-tokens)
export interface TokenSshKeysTable {
  id: string;
  token_id: string;

  // `SHA256:<base64>` of the key blob; a key binds to one token at most
  fingerprint: string;

  // `<type> <base64>`, without the comment
  public_key: string;
  comment: string;
  created_at: number;
}

// a private network between imps (docs/guides/networks.md)
interface NetworksTable {
  id: string;
  name: string;
  created_at: number;
}

interface NetworkMembersTable {
  network_id: string;
  imp_id: string;
}

export interface DatabaseSchema {
  images: ImagesTable;
  imps: ImpsTable;
  checkpoints: CheckpointsTable;
  secrets: SecretsTable;
  grants: GrantsTable;
  broker_audit: BrokerAuditTable;
  api_audit: ApiAuditTable;
  tokens: TokensTable;
  token_ssh_keys: TokenSshKeysTable;
  networks: NetworksTable;
  network_members: NetworkMembersTable;
}
