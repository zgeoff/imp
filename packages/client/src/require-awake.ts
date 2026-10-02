import type { Imp, ImpContract } from '@imp/api';
import { ORPCError } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';

export interface RequireAwakeOptions {
  // wake also restarts an imp in the error state, which loses what it was
  // doing; without this, such an imp is an error
  readonly restartError?: boolean;

  // impd answers SERVICE_UNAVAILABLE while it stops; a caller that expects it
  // back (a restart) can wait for it
  readonly retryUnavailable?: { readonly attempts: number; readonly delayMs: number };

  readonly signal?: Readonly<AbortSignal>;
}

// One wake call: it wakes, boots or returns a running imp, and waits for the
// imp's lock, so nothing polls. A RAM_BUDGET_EXCEEDED retry would fail again.
export async function requireAwake(
  rpc: Readonly<ContractRouterClient<ImpContract>>,
  name: string,
  options: Readonly<RequireAwakeOptions> = {},
): Promise<Imp> {
  const signal = options.signal;
  const callOptions = signal === undefined ? {} : { signal };
  const retry = options.retryUnavailable ?? { attempts: 0, delayMs: 0 };

  if (options.restartError !== true) {
    const imp = await rpc.imps.get({ name }, callOptions);

    if (imp.state === 'error') {
      throw new ImpErrorStateError(imp);
    }
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc.imps.wake({ name }, callOptions);
    } catch (error) {
      const isUnavailable = error instanceof ORPCError && error.code === 'SERVICE_UNAVAILABLE';

      if (!isUnavailable || attempt >= retry.attempts) {
        throw error;
      }

      await waitFor(retry.delayMs, signal);
    }
  }
}

// the imp failed and waits to be looked at; `restartError` wakes it anyway
export class ImpErrorStateError extends Error {
  readonly imp: Imp;

  constructor(imp: Imp) {
    super(`imp ${imp.name} is in the error state: ${imp.error ?? 'no reason recorded'}`);

    this.name = 'ImpErrorStateError';
    this.imp = imp;
  }
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
