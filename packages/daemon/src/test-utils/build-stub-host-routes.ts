import type { Uplinks } from '../net/host-routes';

interface StubHostRoutesOptions {
  // the host container's own networks of each family; none by default
  readonly connected4?: readonly string[];
  readonly connected6?: readonly string[];

  // its default routes' interfaces; none by default
  readonly uplinks?: Uplinks;
}

// The host container's networks and default routes, as egress reads them
// (its readConnected4, readConnected6 and readUplinks). The route read can
// be made to fail, as `ip route` does, until the test restores it.
export function buildStubHostRoutes(options: Readonly<StubHostRoutesOptions> = {}) {
  const state = { failure: null as string | null };
  const uplinks = options.uplinks ?? { ipv4: [], ipv6: [] };

  return {
    deps: {
      readConnected4: (): Promise<readonly string[]> => Promise.resolve(options.connected4 ?? []),
      readConnected6: (): Promise<readonly string[]> => Promise.resolve(options.connected6 ?? []),
      readUplinks: (): Promise<Uplinks> =>
        state.failure === null
          ? Promise.resolve(uplinks)
          : Promise.reject(new Error(state.failure)),
    },

    // each route read rejects with `message` from now on
    failUplinks: (message: string): void => {
      state.failure = message;
    },

    // each route read answers again
    restoreUplinks: (): void => {
      state.failure = null;
    },
  };
}
