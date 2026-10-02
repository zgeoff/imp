import type { CliConfig } from './cli-config';
import { createImpClient } from './create-imp-client';
import type { ImpClient } from './create-imp-client';
import { readHostConfig } from './host-store';
import type { CliEnv } from './host-store';
import { formatError } from './run-action';
import { UsageError } from './usage-error';

// how long one saved host gets to answer before the rest go on without it
const HOST_TIMEOUT_MS = 5000;

// a saved host, as loadCliConfig would give it for `--host <name>`
export interface SavedTarget {
  readonly host: string;
  readonly config: CliConfig;
}

export type HostAnswer<T> =
  | { readonly host: string; readonly value: T }
  | { readonly host: string; readonly error: string };

// Every saved host, in name order. IMP_URL, IMP_HOST and IMP_TOKEN name one
// impd, so a call to all of them reads the saved hosts alone.
export function listSavedTargets(env: CliEnv): SavedTarget[] {
  const hosts = Object.entries(readHostConfig(env).hosts);

  if (hosts.length === 0) {
    throw new UsageError('no saved hosts (see imp login)');
  }

  return hosts
    .map(([host, saved]) => ({ host, config: { url: saved.url, token: saved.token, host } }))
    .toSorted((first, second) => first.host.localeCompare(second.host));
}

// Calls every host at once and waits for each, but no longer than the
// timeout: a sleeping laptop or a host off the tailnet costs the timeout,
// never a hang. The answers keep the targets' order.
export function runOnHosts<T>(
  targets: readonly SavedTarget[],
  call: (client: ImpClient, signal: AbortSignal) => Promise<T>,
  timeoutMs = HOST_TIMEOUT_MS,
): Promise<HostAnswer<T>[]> {
  return Promise.all(
    targets.map(async (target): Promise<HostAnswer<T>> => {
      try {
        const value = await runWithTimeout(
          (signal) => call(createImpClient(target.config), signal),
          timeoutMs,
        );

        return { host: target.host, value };
      } catch (error) {
        return { host: target.host, error: formatError(error, target.config) };
      }
    }),
  );
}

// the signal aborts the requests; the race ends the wait even when a call
// does not watch it. The abort in finally also ends the calls still open
// after another one failed, so none of them keeps the process alive.
async function runWithTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();

  const expired = Promise.withResolvers<never>();

  const timer = setTimeout(() => {
    controller.abort();
    expired.reject(new Error(`no answer in ${String(timeoutMs / 1000)} s`));
  }, timeoutMs);

  try {
    return await Promise.race([call(controller.signal), expired.promise]);
  } finally {
    clearTimeout(timer);

    controller.abort();
  }
}
