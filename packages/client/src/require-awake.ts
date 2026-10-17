import type { Imp, ImpContract } from '@impz/api';
import { ORPCError } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import pRetry from 'p-retry';

export interface RequireAwakeOptions {
  // wake also restarts an imp in the error state, which loses what it was
  // doing; without this, impd refuses such an imp with INVALID_STATE
  readonly restartError?: boolean;

  // impd answers SERVICE_UNAVAILABLE while it stops, and cannot be reached
  // while it restarts; a caller that expects it back can wait for it
  readonly retryUnavailable?: { readonly attempts: number; readonly delayMs: number };

  readonly signal?: Readonly<AbortSignal>;
}

// One wake call: impd wakes, boots or returns a running imp under the imp's
// lock, so nothing polls and no state can change between a check and the
// wake. A RAM_BUDGET_EXCEEDED retry would fail again, so it never retries.
export async function requireAwake(
  rpc: Readonly<ContractRouterClient<ImpContract>>,
  name: string,
  options: Readonly<RequireAwakeOptions> = {},
): Promise<Imp> {
  const signal = options.signal;
  const callOptions = signal === undefined ? {} : { signal };
  const retry = options.retryUnavailable ?? { attempts: 0, delayMs: 0 };
  const input = { name, restartError: options.restartError === true };

  // p-retry gives up on a TypeError it does not know as a network failure,
  // and Bun's is one of those, so each failure travels wrapped
  const wake = async (): Promise<Imp> => {
    try {
      return await rpc.imps.wake(input, callOptions);
    } catch (error) {
      throw new WakeFailureError(error);
    }
  };

  try {
    return await pRetry(wake, {
      retries: retry.attempts,
      minTimeout: retry.delayMs,
      factor: 1,
      ...(signal !== undefined && { signal }),
      shouldRetry: (context) =>
        context.error instanceof WakeFailureError && isUnavailable(context.error.failure),
    });
  } catch (error) {
    throw error instanceof WakeFailureError ? error.failure : error;
  }
}

// one wake call's failure, as it came
class WakeFailureError extends Error {
  override name = 'WakeFailureError';

  readonly failure: unknown;

  constructor(failure: unknown) {
    const message = failure instanceof Error ? failure.message : String(failure);

    super(message);

    this.failure = failure;
  }
}

// fetch rejects with a TypeError when it cannot connect, in browsers, Bun and
// Node alike
function isUnavailable(error: unknown): boolean {
  if (error instanceof ORPCError) {
    return error.code === 'SERVICE_UNAVAILABLE';
  }

  return error instanceof TypeError;
}
