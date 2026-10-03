import { SecretNameSchema, isImpAllowed } from '@imp/api';
import type { ForbiddenReason, ImpContract, Scope } from '@imp/api';
import type { GrantAuthority } from '../db/secrets';
import { formatCaller } from './caller';
import type { Caller } from './caller';
import { hasScope } from './scopes';

// host-wide: only a caller with no imp patterns
interface HostAccess {
  readonly scope: Scope;
  readonly on: 'host';
  readonly audit?: false;
}

// the imps these input fields name, each within the caller's patterns; a
// caller with patterns must name them
interface ImpAccess {
  readonly scope: Scope;
  readonly on: 'imp';
  readonly fields: readonly string[];

  // refused to a token made able to grant secrets: the call could carry
  // grants it may not make to an imp, and v1 does not follow them there
  readonly noGrantable?: true;
  readonly audit?: false;
}

// a grant or a revoke (docs/guides/tokens.md#granting-secrets): host-wide,
// or the imp within the caller's patterns and the secret one its grantable
// list names, the same secret now as when the token was made
interface GrantAccess {
  readonly scope: Scope;
  readonly on: 'grant';
  readonly fields: readonly string[];
  readonly secretField: string;
  readonly audit?: false;
}

// any caller with the scope; the handler shows only the caller's imps
interface AnyAccess {
  readonly scope: Scope;
  readonly on: 'any';
  readonly audit?: false;
}

// What each procedure needs (docs/guides/tokens.md#scopes). The map covers
// every contract path, so a procedure without an entry fails the typecheck;
// a path missing at run time is refused all the same.
export type Access = HostAccess | ImpAccess | GrantAccess | AnyAccess;

// why the caller may not make the call; a reason when it is one a client
// can act on
export interface Refusal {
  readonly message: string;
  readonly reason: ForbiddenReason | null;
}

// the secret's generation now, or null when there is no such secret
export type ReadSecretGeneration = (name: string) => Promise<string | null>;

// `imps.create`, `audit.calls` and so on
type ProcedurePath<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends { readonly '~orpc': unknown }
    ? `${Prefix}${K}`
    : ProcedurePath<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type ImpProcedurePath = ProcedurePath<ImpContract>;

const IMP = ['name'] as const;
const readAny: Access = { scope: 'read', on: 'any' };
const readImp: Access = { scope: 'read', on: 'imp', fields: IMP };
const execImp: Access = { scope: 'exec', on: 'imp', fields: IMP };
const manageImp: Access = { scope: 'manage', on: 'imp', fields: IMP };
const manageHost: Access = { scope: 'manage', on: 'host' };
const manageImpNoGrantable: Access = { ...manageImp, noGrantable: true };
const manageGrant: Access = { scope: 'manage', on: 'grant', fields: IMP, secretField: 'secret' };

export const PROCEDURE_ACCESS: Readonly<Record<ImpProcedurePath, Access>> = {
  'imps.create': manageImp,
  'imps.list': readAny,
  'imps.get': readImp,
  'imps.destroy': manageImp,
  'imps.start': execImp,
  'imps.stop': execImp,
  'imps.sleep': execImp,
  'imps.wake': execImp,
  'imps.hold': execImp,
  'imps.url': readImp,

  // what the imp may reach: a change is the imp's to manage
  'imps.policy': readImp,
  'imps.setPolicy': manageImp,

  // who reaches an imp from the internet is the host's call, either way: a
  // token for one imp must not publish it, nor change what another set up
  'imps.expose': manageHost,
  'imps.unexpose': manageHost,

  // a bigger disk spends the host's disk budget, as a create does
  'imps.resizeDisk': manageImp,

  // a CPU limit or weight takes from, or gives back to, the other imps, and
  // a new HTTP port moves the imp's URL to another service
  'imps.update': manageImp,
  'imps.fork': { scope: 'manage', on: 'imp', fields: ['source', 'name'], noGrantable: true },

  // as imps.hold: a lease keeps the imp awake, and each caller touches only
  // its own; list may leave out the imp and shows the caller's imps only
  'leases.acquire': execImp,
  'leases.renew': execImp,
  'leases.release': execImp,
  'leases.list': { scope: 'exec', on: 'any', audit: false },

  // a move hands the whole imp, its disk and checkpoints, to another host;
  // on the target a ticket takes in an image and grants, which are
  // host-wide. A token that may grant moves nothing, as it forks nothing.
  'moves.prepare': manageImpNoGrantable,
  'moves.facts': manageHost,
  'moves.receive': manageHost,
  'moves.send': manageImpNoGrantable,
  'moves.status': readImp,
  'moves.reissue': manageHost,
  'moves.resume': manageImpNoGrantable,
  'moves.abort': manageImp,

  'checkpoints.create': manageImp,
  'checkpoints.list': readImp,
  'checkpoints.restore': manageImp,
  'checkpoints.delete': manageImp,

  // a backup holds every imp; a restore can replace any of them
  'backups.run': manageHost,
  'backups.list': { scope: 'read', on: 'host' },
  'backups.restore': manageHost,
  'backups.check': manageHost,

  'images.list': readAny,
  'images.add': manageHost,
  'images.build': manageHost,
  'images.delete': manageHost,

  // the exec it is for is audited as the socket opens
  'exec.ticket': { ...execImp, audit: false },

  'sessions.list': readImp,
  'sessions.kill': execImp,

  // a service runs a command as an exec does, and its log can hold
  // anything the command prints
  'services.list': readImp,
  'services.add': execImp,
  'services.remove': execImp,
  'services.restart': execImp,
  'services.logs': execImp,

  // secrets belong to the host: a grant hands one to an imp, so a token
  // limited to some imps could grant itself any secret
  'secrets.add': manageHost,
  'secrets.list': readAny,
  'secrets.delete': manageHost,

  // a member reaches every other imp on the network, so a token limited to
  // some imps could reach past them; list shows the caller's imps only
  'networks.list': readAny,
  'networks.create': manageHost,
  'networks.delete': manageHost,
  'networks.join': manageHost,
  'networks.leave': manageHost,
  'networks.warnings': readImp,

  // a token for some imps grants only the secrets its list names
  'grants.add': manageGrant,
  'grants.delete': manageGrant,
  'grants.list': readImp,

  'audit.list': readAny,
  'audit.calls': readAny,
  'events.stream': readAny,
  'system.info': readAny,

  // gc removes what a crash left and, with orphans, every disk no row names
  'system.gc': manageHost,

  // the approver's own checks are the handler's: a named token, never
  // wider than itself (docs/guides/mcp.md#public-route)
  'oauth.clients.list': manageHost,
  'oauth.clients.add': manageHost,
  'oauth.clients.update': manageHost,
  'oauth.clients.delete': manageHost,
  'oauth.grants.list': manageHost,
  'oauth.grants.delete': manageHost,
  'oauth.approvals.get': readAny,
  'oauth.approvals.approve': readAny,
  'tokens.list': manageHost,
  'tokens.create': manageHost,
  'tokens.delete': manageHost,
  'tokens.addKey': manageHost,
  'tokens.removeKey': manageHost,
  'tokens.whoami': readAny,
};

const ACCESS_BY_PATH: ReadonlyMap<string, Access> = new Map(Object.entries(PROCEDURE_ACCESS));

// null for a path the map does not have, which no caller may call
export function findAccess(procedure: string): Access | null {
  return ACCESS_BY_PATH.get(procedure) ?? null;
}

// calls that change something leave an audit row; an unknown one does too
export function isAuditedProcedure(procedure: string): boolean {
  const access = findAccess(procedure);

  return access === null || (access.scope !== 'read' && access.audit !== false);
}

// Why the caller may not make the call, or null when it may. The checks
// run before the handler, so a refusal leaves nothing behind, and a grant
// refused for its secret never says whether the secret exists.
export async function checkAccess(
  access: Readonly<Access> | null,
  caller: Readonly<Caller>,
  input: unknown,
  readSecretGeneration: ReadSecretGeneration,
): Promise<Refusal | null> {
  if (access === null) {
    return { message: 'this call has no access rule', reason: null };
  }

  if (!hasScope(caller.scope, access.scope)) {
    return {
      message: `${formatCaller(caller)} has scope ${caller.scope}; this needs ${access.scope}`,
      reason: 'scope',
    };
  }

  if (access.on === 'imp' && access.noGrantable === true && caller.grantable.length > 0) {
    return {
      message: `${formatCaller(caller)} may grant secrets, so it may not fork or move an imp`,
      reason: null,
    };
  }

  if (access.on === 'any' || caller.imps === null) {
    return null;
  }

  if (access.on === 'host') {
    return {
      message: `${formatCaller(caller)} is limited to some imps; this call is host-wide`,
      reason: null,
    };
  }

  const outside = findOutsideImp(access.fields, caller, caller.imps, input);

  if (outside !== null || access.on === 'imp') {
    return outside;
  }

  const refusal = await checkGrantable(
    caller,
    readField(input, access.secretField),
    readSecretGeneration,
  );

  return refusal;
}

// What a grant or a revoke checks again in its transaction: null for a
// host-wide caller, which grants any secret; else the token and the secret's
// generation its list names
export function findGrantAuthority(
  caller: Readonly<Caller>,
  secret: string,
): GrantAuthority | null {
  if (caller.imps === null) {
    return null;
  }

  const entry = caller.grantable.find((each) => each.name === secret);

  // the access check refused the call before it got here
  if (entry === undefined || caller.tokenId === null) {
    throw new Error(`${formatCaller(caller)} reached a grant of ${secret} it may not make`);
  }

  return { tokenId: caller.tokenId, generation: entry.generation };
}

function findOutsideImp(
  fields: readonly string[],
  caller: Readonly<Caller>,
  patterns: readonly string[],
  input: unknown,
): Refusal | null {
  for (const field of fields) {
    const name = readField(input, field);

    if (name === null) {
      return {
        message: `${formatCaller(caller)} is limited to some imps, so the call must name the imp (${field})`,
        reason: 'imp_out_of_scope',
      };
    }

    if (!isImpAllowed(patterns, name)) {
      return {
        message: `${formatCaller(caller)} may not touch imp ${name}`,
        reason: 'imp_out_of_scope',
      };
    }
  }

  return null;
}

// The secret must be on the caller's list, and the secret by that name now
// must be the one it was given. A missing secret reads as a stale entry, so
// the refusal is the same whether it exists or not.
async function checkGrantable(
  caller: Readonly<Caller>,
  secret: string | null,
  readSecretGeneration: ReadSecretGeneration,
): Promise<Refusal | null> {
  const entry = secret === null ? undefined : caller.grantable.find((each) => each.name === secret);
  const current = entry === undefined ? null : await readSecretGeneration(entry.name);

  if (entry !== undefined && current === entry.generation) {
    return null;
  }

  // the input is not checked yet: it is named only when it has a name's form
  const named = SecretNameSchema.safeParse(secret);
  const what = named.success ? `secret ${named.data}` : 'that secret';

  return {
    message: `${formatCaller(caller)} may not grant or revoke ${what}`,
    reason: 'not_grantable',
  };
}

function readField(input: unknown, field: string): string | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const value: unknown = Reflect.get(input, field);

  return typeof value === 'string' ? value : null;
}
