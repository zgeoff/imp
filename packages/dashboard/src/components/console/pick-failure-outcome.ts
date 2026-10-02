import { isUnauthorized } from '../../lib/build-query-client';

export type FailureOutcome =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'login' }
  | { readonly kind: 'show'; readonly message: string };

// What the console does when opening a connection fails: nothing once it is
// unmounted (the abort), the login page when the session ended (the ticket
// call got impd's 401), else it shows the error.
export function pickFailureOutcome(error: unknown, aborted: boolean): FailureOutcome {
  if (aborted) {
    return { kind: 'ignore' };
  }

  if (isUnauthorized(error)) {
    return { kind: 'login' };
  }

  return { kind: 'show', message: error instanceof Error ? error.message : String(error) };
}
