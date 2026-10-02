import type { ImpContract, Scope } from '@imp/api';
import { formatCaller } from './caller';
import type { Caller } from './caller';
import { isImpAllowed } from './imp-patterns';
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
export type Access = HostAccess | ImpAccess | AnyAccess;

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
  'imps.fork': { scope: 'manage', on: 'imp', fields: ['source', 'name'] },

  // as imps.hold: a lease keeps the imp awake, and each caller touches only
  // its own; list may leave out the imp and shows the caller's imps only
  'leases.acquire': execImp,
  'leases.renew': execImp,
  'leases.release': execImp,
  'leases.list': { scope: 'exec', on: 'any', audit: false },

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

  'grants.add': manageHost,
  'grants.delete': manageHost,
  'grants.list': readImp,

  'audit.list': readAny,
  'audit.calls': readAny,
  'events.stream': readAny,
  'system.info': readAny,

  // gc removes what a crash left and, with orphans, every disk no row names
  'system.gc': manageHost,

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

// why the caller may not make the call, or null when it may
export function checkAccess(
  access: Readonly<Access> | null,
  caller: Readonly<Caller>,
  input: unknown,
): string | null {
  if (access === null) {
    return 'this call has no access rule';
  }

  if (!hasScope(caller.scope, access.scope)) {
    return `${formatCaller(caller)} has scope ${caller.scope}; this needs ${access.scope}`;
  }

  if (access.on === 'any' || caller.imps === null) {
    return null;
  }

  if (access.on === 'host') {
    return `${formatCaller(caller)} is limited to some imps; this call is host-wide`;
  }

  for (const field of access.fields) {
    const name = readField(input, field);

    if (name === null) {
      return `${formatCaller(caller)} is limited to some imps, so the call must name the imp (${field})`;
    }

    if (!isImpAllowed(caller.imps, name)) {
      return `${formatCaller(caller)} may not touch imp ${name}`;
    }
  }

  return null;
}

function readField(input: unknown, field: string): string | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const value: unknown = Reflect.get(input, field);

  return typeof value === 'string' ? value : null;
}
