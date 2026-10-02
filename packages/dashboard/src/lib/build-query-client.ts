import { ORPCError } from '@orpc/client';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

// A 401 means the session ended (expired, logged out, a new token), so any
// query or mutation that sees one sends the browser to the login page.
export function buildQueryClient(onUnauthorized: () => void): QueryClient {
  const handleError = (error: Error): void => {
    if (isUnauthorized(error)) {
      onUnauthorized();
    }
  };

  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry },
    },
    queryCache: new QueryCache({ onError: handleError }),
    mutationCache: new MutationCache({ onError: handleError }),
  });
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ORPCError && error.status === 401;
}

// an answer from impd (NOT_FOUND, INVALID_STATE, 401) does not change on a retry
function shouldRetry(failureCount: number, error: Error): boolean {
  if (failureCount >= 2) {
    return false;
  }

  return !(error instanceof ORPCError && error.status < 500);
}
