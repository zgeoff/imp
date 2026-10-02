import type { ApiActor, ImpState, Scope } from '@imp/api';
import type { Generated } from 'kysely';

// Timestamps are integer milliseconds since the epoch.

interface ImagesTable {
  id: string;
  name: string;
  ref: string;
  digest: string;
  size_bytes: number;
  created_at: number;
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

  // what the broker does with a CONNECT to a host no grant covers: `open`
  // tunnels it; #26 adds the policies that refuse it
  egress_policy: Generated<string>;

  // the disk file's size; 32 GiB for an imp from before sizes
  disk_bytes: Generated<number>;

  // 1 while a sleeping imp's guest has not grown into a resize yet: its
  // next wake grows it, a cold boot grows it anyway
  disk_grow_pending: Generated<number>;
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

export interface DatabaseSchema {
  images: ImagesTable;
  imps: ImpsTable;
  checkpoints: CheckpointsTable;
  secrets: SecretsTable;
  grants: GrantsTable;
  broker_audit: BrokerAuditTable;
  api_audit: ApiAuditTable;
  tokens: TokensTable;
}
