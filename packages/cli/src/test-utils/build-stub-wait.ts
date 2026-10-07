interface StubWaitCall {
  readonly ms: number;
  readonly signal: AbortSignal;

  // ends the wait, as its time passing would
  readonly release: () => void;
}

// A wait that ends only when the test releases it, or at once when its
// signal aborts, as the reverse forward's timer does. `calls` holds each wait
// in the order it began.
export function buildStubWait() {
  const calls: StubWaitCall[] = [];

  const wait = (ms: number, signal: AbortSignal): Promise<void> => {
    const waited = Promise.withResolvers<void>();

    signal.addEventListener(
      'abort',
      () => {
        waited.resolve();
      },
      { once: true },
    );

    calls.push({ ms, signal, release: waited.resolve });

    return waited.promise;
  };

  return { wait, calls };
}
