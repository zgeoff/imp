import type { ApiActor } from '@imp/api';
import { ORPCError } from '@orpc/server';
import type { ExecBackend } from './exec-session';

// What an `/exec` socket may start, recorded at the upgrade: any imp for the
// bearer token, one imp for a ticket, with the caller that asked for it. A
// socket with no grant starts nothing.
export type ExecGrant =
  | { readonly kind: 'any' }
  | { readonly kind: 'imp'; readonly name: string; readonly actor: ApiActor };

export const ANY_IMP_GRANT: ExecGrant = { kind: 'any' };

export function buildGrantedBackend(
  backend: ExecBackend,
  grant: ExecGrant | undefined,
): ExecBackend {
  if (grant?.kind === 'any') {
    return backend;
  }

  const checkGrant = (name: string): ORPCError<'FORBIDDEN', unknown> | null => {
    if (grant === undefined) {
      return new ORPCError('FORBIDDEN', { message: 'the exec socket was not authorized' });
    }

    if (name !== grant.name) {
      return new ORPCError('FORBIDDEN', { message: `the exec ticket is for imp ${grant.name}` });
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
