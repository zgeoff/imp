import { buildForbiddenError } from '../api-errors';
import { formatCaller, isCallerAllowed } from '../auth/caller';
import type { Caller } from '../auth/caller';
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

  return {
    openExec: (name, request) => {
      const refused = checkGrant(name);

      return refused === null ? backend.openExec(name, request) : Promise.reject(refused);
    },
    openAttach: (name, request) => {
      const refused = checkGrant(name);

      return refused === null ? backend.openAttach(name, request) : Promise.reject(refused);
    },
    recordActivity: (name) => backend.recordActivity(name),
  };
}
