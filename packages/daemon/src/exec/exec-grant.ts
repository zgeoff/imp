import { ORPCError } from '@orpc/server';
import type { ExecBackend } from './exec-session';

// What an `/exec` socket may start, recorded at the upgrade: any imp for the
// bearer token, one imp for a ticket. A socket with no grant starts nothing.
export type ExecGrant = { readonly kind: 'any' } | { readonly kind: 'imp'; readonly name: string };

export const ANY_IMP_GRANT: ExecGrant = { kind: 'any' };

export function buildGrantedBackend(
  backend: ExecBackend,
  grant: ExecGrant | undefined,
): ExecBackend {
  if (grant?.kind === 'any') {
    return backend;
  }

  return {
    openExec: (name, request) => {
      if (grant === undefined) {
        return Promise.reject(
          new ORPCError('FORBIDDEN', { message: 'the exec socket was not authorized' }),
        );
      }

      if (name !== grant.name) {
        return Promise.reject(
          new ORPCError('FORBIDDEN', { message: `the exec ticket is for imp ${grant.name}` }),
        );
      }

      return backend.openExec(name, request);
    },
    recordActivity: (name) => backend.recordActivity(name),
  };
}
