// Written by kysely-codegen from the migrated database: run
// `bun run render:db-schema` after a migration, never edit it by hand.

import type { ApiActor, AuditRefusal, ColdBootCause, ImageSource, ImpKind, ImpState, MoveState, Scope } from "@imp/api";
import type { ColumnType } from "kysely";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export interface ApiAudit {
  actor: ApiActor;
  actor_name: string | null;
  at: number;
  detail: string | null;
  duration_ms: number;
  id: Generated<number>;
  imp_name: string | null;
  outcome: string;
  procedure: string;
}

export interface BrokerAudit {
  at: number;
  duration_ms: number;
  host: string | null;
  id: Generated<number>;
  imp_id: string;
  method: string | null;
  path: string | null;
  reason: AuditRefusal | null;
  request_bytes: number;
  response_bytes: number;
  secret_name: string | null;
  status: number;
}

export interface BrokerSessions {
  at: number;
  generation: string;
  imp_id: string;
}

export interface Checkpoints {
  created_at: number;
  disk_bytes: Generated<number>;
  id: string;
  imp_id: string;
  label: string | null;
  size_bytes: number | null;
}

export interface Grants {
  filter: string | null;
  imp_id: string;
  secret_generation: Generated<string>;
  secret_name: string;
}

export interface Images {
  created_at: number;
  digest: string;
  id: string;
  name: string;
  ref: string;
  size_bytes: number;
  source: Generated<ImageSource>;
  source_imp: string | null;
}

export interface ImpColdBoots {
  at: number;
  boot_id: string;
  cause: ColdBootCause;
  imp_id: string;
  seq: Generated<number>;
}

export interface ImpLeases {
  created_at: number;
  display: string;
  imp_id: string;
  label: string;
  principal: string;
  until: number | null;
}

export interface Imps {
  awake_ms: Generated<number>;
  awake_since: number | null;
  backup: Generated<number>;
  cpu_limit: number | null;
  cpu_weight: Generated<number>;
  created_at: number;
  disk_bytes: Generated<number>;
  disk_grow_pending: Generated<number>;
  egress_allow: Generated<string>;
  egress_policy: Generated<string>;
  error: string | null;
  exposure: Generated<string>;
  firecracker_version: string | null;
  hold_until: number | null;
  http_port: Generated<number>;
  id: string;
  identity_reset_pending: Generated<number>;
  image_id: string;
  ip: string;
  jail_uid: number | null;
  kind: Generated<ImpKind>;
  last_active_at: number;
  max_memory_mib: number | null;
  memory_mib: number;
  move_state: MoveState | null;
  name: string;
  next_boot_cause: ColdBootCause | null;
  oops_boot_id: string | null;
  pid: number | null;
  public_auth: string | null;
  public_hash: string | null;
  public_user: string | null;
  slept_at: number | null;
  slot: number;
  state: ImpState;
  trust_pending: Generated<number>;
  vcpus: number;
  wake_count: Generated<number>;
}

export interface MoveSends {
  created_at: number;
  error: string | null;
  imp_id: string;
  mode: Generated<"files" | "zfs">;
  peer_url: string | null;
  receipt: string | null;
  ticket: string | null;
  total_bytes: number;
  warm: Generated<number>;
}

export interface MoveTickets {
  bytes: number;
  commit_until: number | null;
  committed_at: number | null;
  id: string;
  imp_id: string | null;
  issued_at: number;
  name: string;
  receipt: string | null;
  secret_sha256: string;
  slot: number | null;
  stream_by: number;
  stream_used_at: number | null;
}

export interface NetworkMembers {
  imp_id: string;
  network_id: string;
}

export interface Networks {
  created_at: number;
  id: string;
  name: string;
}

export interface OauthClients {
  created_at: number;
  id: string;
  name: string;
  redirect_uris: string;
}

export interface OauthGrants {
  client_id: string;
  created_at: number;
  id: string;
  imps: string | null;
  last_used_at: number | null;
  resource: string;
  scope: Scope;
  token_id: string;
}

export interface OauthTokens {
  created_at: number;
  expires_at: number;
  grant_id: string;
  id: string;
  kind: "access" | "refresh";
  secret_hash: string;
  spent_at: number | null;
}

export interface SecretFileRemovals {
  created_at: number;
  value_file: string;
}

export interface Secrets {
  created_at: number;
  generation: Generated<string>;
  kind: string;
  name: string;
  oauth: string | null;
  rules: string;
  value_file: Generated<string>;
}

export interface Tokens {
  created_at: number;
  grantable: Generated<string>;
  id: string;
  image_ref_prefix: string | null;
  imps: string | null;
  name: string;
  scope: Scope;
  secret_hash: string;
}

export interface TokenSshKeys {
  comment: string;
  created_at: number;
  fingerprint: string;
  id: string;
  public_key: string;
  token_id: string;
}

export interface DB {
  api_audit: ApiAudit;
  broker_audit: BrokerAudit;
  broker_sessions: BrokerSessions;
  checkpoints: Checkpoints;
  grants: Grants;
  images: Images;
  imp_cold_boots: ImpColdBoots;
  imp_leases: ImpLeases;
  imps: Imps;
  move_sends: MoveSends;
  move_tickets: MoveTickets;
  network_members: NetworkMembers;
  networks: Networks;
  oauth_clients: OauthClients;
  oauth_grants: OauthGrants;
  oauth_tokens: OauthTokens;
  secret_file_removals: SecretFileRemovals;
  secrets: Secrets;
  token_ssh_keys: TokenSshKeys;
  tokens: Tokens;
}
