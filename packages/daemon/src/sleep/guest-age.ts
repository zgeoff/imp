const POLL_MS = 50;

interface GuestAgeWait {
  // the guest's uptime from the agent; null when it does not answer
  readonly readUptimeMs: () => Promise<number | null>;
  readonly minUptimeMs: number;

  // false once the sleep is no longer wanted, such as an imp that turned busy
  readonly isWanted: () => Promise<boolean>;
}

// Before Linux 6.7, KVM restores a TSC under one second old as about 0 and the guest clock
// stalls until it catches up (docs/architecture/sleep-and-wake.md#young-guests).
// Resolves to the milliseconds waited, or null when the sleep gave way.
export async function waitForGuestAge(wait: Readonly<GuestAgeWait>): Promise<number | null> {
  if (wait.minUptimeMs === 0) {
    return 0;
  }

  // an agent that does not answer cannot say: sleep as before
  const uptimeMs = await wait.readUptimeMs();

  if (uptimeMs === null || uptimeMs >= wait.minUptimeMs) {
    return 0;
  }

  const started = performance.now();
  const deadline = started + wait.minUptimeMs - uptimeMs;

  for (let now = started; now < deadline; now = performance.now()) {
    if (!(await wait.isWanted())) {
      return null;
    }

    await Bun.sleep(Math.min(POLL_MS, deadline - now));
  }

  const wanted = await wait.isWanted();

  return wanted ? Math.round(performance.now() - started) : null;
}
