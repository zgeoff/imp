interface WaitForOptions {
  // milliseconds between retries
  readonly intervalMs?: number;

  // milliseconds before the wait gives up
  readonly timeoutMs?: number;
}

// Retries the attempt until it stops throwing, resolving with its value, so
// a wait reads like the assertion it waits on. Past the deadline it rejects
// with what it waited for and the attempt's last failure.
export async function waitFor<T>(
  what: string,
  attempt: () => Promise<T> | T,
  options: Readonly<WaitForOptions> = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() >= deadline) {
        const reason = error instanceof Error ? error.message : String(error);

        throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}: ${reason}`, {
          cause: error,
        });
      }
    }

    await Bun.sleep(intervalMs);
  }
}
