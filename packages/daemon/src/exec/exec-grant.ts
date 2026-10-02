import { buildForbiddenError } from '../api-errors';
import { formatCaller, isCallerAllowed } from '../auth/caller';
import type { Caller } from '../auth/caller';
import { toCallerError } from '../auth/caller-view';
import { hasScope } from '../auth/scopes';
import type { ExecBackend } from './exec-session';

// What an `/exec` socket may start: its caller, and a ticket's one imp. Each
// start checks the scope, so a client reads FORBIDDEN on the socket, not a
// refused upgrade it cannot read. No grant starts nothing.
export interface ExecGrant {
  readonly caller: Caller;

  // the ticket's imp; null for a bearer token or a tailnet identity
  readonly name: string | null;
}

export function buildGrantedBackend(
  backend: ExecBackend,
  grant: Readonly<ExecGrant> | undefined,
): ExecBackend {
  const checkGrant = (name: string): Error | null => {
    if (grant === undefined) {
      return buildForbiddenError('the exec socket was not authorized');
    }

    if (grant.name !== null && name !== grant.name) {
      return buildForbiddenError(`the exec ticket is for imp ${grant.name}`);
    }

    if (!isCallerAllowed(grant.caller, 'exec', name)) {
      return buildForbiddenError(`${formatCaller(grant.caller)} may not exec in imp ${name}`);
    }

    return null;
  };

  const checkOuter = (): Error | null => {
    if (grant === undefined || grant.name !== null) {
      return buildForbiddenError('an exec ticket cannot run an exec in the agent');
    }

    if (grant.caller.imps !== null || !hasScope(grant.caller.scope, 'manage')) {
      return buildForbiddenError(
        `${formatCaller(grant.caller)} needs host-wide scope manage to exec in the agent`,
      );
    }

    return null;
  };

  // a refusal to boot names only the imps the caller may read
  const openAsCaller = async <T>(opening: Promise<T>): Promise<T> => {
    try {
      return await opening;
    } catch (error) {
      throw toCallerError(error, grant?.caller ?? null);
    }
  };

  return {
    // A tool runs as root, which `exec` scope must not reach (a forward runs
    // as the image user), so it needs `manage`; a ticket never starts one.
    // An outer exec, whatever its feature, needs host-wide `manage`.
    openExec: (name, request, feature) => {
      const refused = checkGrant(name) ?? (request.outer === true ? checkOuter() : null);

      if (refused !== null) {
        return Promise.reject(refused);
      }

      if (feature === undefined || request.outer === true) {
        return openAsCaller(backend.openExec(name, request, feature));
      }

      if (grant?.name !== null) {
        return Promise.reject(buildForbiddenError('an exec ticket cannot run a tool'));
      }

      if (!isCallerAllowed(grant.caller, 'manage', name)) {
        return Promise.reject(
          buildForbiddenError(`${formatCaller(grant.caller)} needs scope manage to copy as root`),
        );
      }

      return openAsCaller(backend.openExec(name, request, feature));
    },
    openAttach: (name, request) => {
      const refused = checkGrant(name);

      return refused === null
        ? openAsCaller(backend.openAttach(name, request))
        : Promise.reject(refused);
    },
    recordActivity: (name) => backend.recordActivity(name),
  };
}
