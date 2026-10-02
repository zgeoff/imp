import type { Imp, ImpContract } from '@imp/api';
import { ORPCError } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';

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

  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc.imps.wake(input, callOptions);
    } catch (error) {
      if (!isUnavailable(error) || attempt >= retry.attempts) {
        throw error;
      }

      await waitFor(retry.delayMs, signal);
    }
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

function waitFor(ms: number, signal: Readonly<AbortSignal> | undefined): Promise<void> {
  signal?.throwIfAborted();
  const done = Promise.withResolvers<void>();

  const onAbort = (): void => {
    clearTimeout(timer);

    done.reject(signal?.reason);
  };

  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    done.resolve();
  }, ms);

  signal?.addEventListener('abort', onAbort, { once: true });

  return done.promise;
}
