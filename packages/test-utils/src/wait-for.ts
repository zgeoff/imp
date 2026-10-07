interface WaitForOptions {
  // Milliseconds between retries.
  readonly intervalMs?: number;

  // Milliseconds before the wait gives up.
  readonly timeoutMs?: number;

  // The clock the deadline is read from.
  readonly now?: () => number;

  // Waits out the interval between retries.
  readonly wait?: (ms: number) => Promise<void>;
}

// Retries the attempt until it stops throwing, resolving with its value; past
// the deadline, the attempt's last failure becomes the wait's rejection.
export async function waitFor<T>(
  attempt: () => Promise<T> | T,
  options: Readonly<WaitForOptions> = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 4000;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? Bun.sleep;
  const deadline = now() + timeoutMs;

  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (now() >= deadline) {
        throw error;
      }
    }

    await wait(intervalMs);
  }
}
