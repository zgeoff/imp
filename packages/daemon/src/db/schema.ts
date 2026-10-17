// Written by kysely-codegen from the migrated database: run
// `bun run render:db-schema` after a migration, never edit it by hand.

import type { ApiActor, AuditRefusal, ColdBootCause, ImageSource, ImpKind, ImpState, MoveState, Scope } from "@impz/api";
import type { ColumnType } from "kysely";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export interface Account {
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  accountId: string;
  createdAt: string;
  id: string;
  idToken: string | null;
  password: string | null;
  providerId: string;
  refreshToken: string | null;
  refreshTokenExpiresAt: string | null;
  scope: string | null;
  updatedAt: string;
  userId: string;
}

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
  oops_hold: Generated<number>;
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

export interface OauthAccessToken {
  authorizationCodeId: string | null;
  clientId: string;
  confirmation: string | null;
  createdAt: string;
  expiresAt: string;
  id: string;
  referenceId: string | null;
  refreshId: string | null;
  requestedUserInfoClaims: string | null;
  resources: string | null;
  revoked: string | null;
  scopes: string;
  sessionId: string | null;
  token: string;
  userId: string | null;
}

export interface OauthClient {
  applicationType: string | null;
  backchannelLogoutSessionRequired: number | null;
  backchannelLogoutUri: string | null;
  clientCredentialsScopes: string | null;
  clientDiscoveryId: string | null;
  clientId: string;
  clientSecret: string | null;
  contacts: string | null;
  createdAt: string | null;
  disabled: number | null;
  dpopBoundAccessTokens: number | null;
  enableEndSession: number | null;
  grantTypes: string | null;
  icon: string | null;
  id: string;
  jwks: string | null;
  jwksUri: string | null;
  metadata: string | null;
  name: string | null;
  policy: string | null;
  postLogoutRedirectUris: string | null;
  redirectUris: string;
  referenceId: string | null;
  requirePKCE: number | null;
  responseTypes: string | null;
  scopes: string | null;
  skipConsent: number | null;
  softwareId: string | null;
  softwareStatement: string | null;
  softwareVersion: string | null;
  subjectType: string | null;
  tokenEndpointAuthMethod: string | null;
  tos: string | null;
  updatedAt: string | null;
  uri: string | null;
  userId: string | null;
}

export interface OauthClientAssertion {
  expiresAt: string;
  id: string;
}

export interface OauthClientResource {
  clientId: string;
  createdAt: string | null;
  id: string;
  metadata: string | null;
  resourceId: string;
}

export interface OauthClients {
  created_at: number;
  id: string;
  name: string;
  redirect_uris: string;
}

export interface OauthConsent {
  clientId: string;
  createdAt: string;
  id: string;
  referenceId: string | null;
  requestedUserInfoClaims: string | null;
  resources: string | null;
  scopes: string;
  updatedAt: string;
  userId: string | null;
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

export interface OauthRefreshToken {
  authorizationCodeId: string | null;
  authTime: string | null;
  clientId: string;
  confirmation: string | null;
  createdAt: string;
  expiresAt: string;
  id: string;
  referenceId: string | null;
  requestedUserInfoClaims: string | null;
  resources: string | null;
  revoked: string | null;
  rotatedAt: string | null;
  rotationReplayExpiresAt: string | null;
  rotationReplayResponse: string | null;
  scopes: string;
  sessionId: string | null;
  token: string;
  userId: string;
}

export interface OauthResource {
  accessTokenTtl: number | null;
  allowedScopes: string | null;
  createdAt: string | null;
  customClaims: string | null;
  disabled: number | null;
  dpopBoundAccessTokensRequired: number | null;
  id: string;
  identifier: string;
  metadata: string | null;
  name: string;
  policyVersion: number | null;
  refreshTokenTtl: number | null;
  signingAlgorithm: string | null;
  signingKeyId: string | null;
  updatedAt: string | null;
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

export interface Session {
  createdAt: string;
  expiresAt: string;
  id: string;
  ipAddress: string | null;
  token: string;
  updatedAt: string;
  userAgent: string | null;
  userId: string;
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

export interface User {
  createdAt: string;
  email: string;
  emailVerified: number;
  id: string;
  image: string | null;
  imps: string | null;
  lastUsedAt: string | null;
  name: string;
  tokenId: string;
  updatedAt: string;
}

export interface Verification {
  createdAt: string;
  expiresAt: string;
  id: string;
  identifier: string;
  updatedAt: string;
  value: string;
}

export interface DB {
  account: Account;
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
  oauthAccessToken: OauthAccessToken;
  oauthClient: OauthClient;
  oauthClientAssertion: OauthClientAssertion;
  oauthClientResource: OauthClientResource;
  oauthConsent: OauthConsent;
  oauthRefreshToken: OauthRefreshToken;
  oauthResource: OauthResource;
  secret_file_removals: SecretFileRemovals;
  secrets: Secrets;
  session: Session;
  token_ssh_keys: TokenSshKeys;
  tokens: Tokens;
  user: User;
  verification: Verification;
}
