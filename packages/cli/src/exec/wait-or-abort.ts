// a timer that an abort clears, so a wait left behind keeps no process
// alive; a finished wait takes its listener off the shared signal
export function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  const waited = Promise.withResolvers<void>();

  const onAbort = (): void => {
    clearTimeout(timer);

    waited.resolve();
  };

  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    waited.resolve();
  }, ms);

  signal.addEventListener('abort', onAbort, { once: true });

  return waited.promise;
}
