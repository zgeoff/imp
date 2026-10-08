import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { ImpClient } from '@zgeoff/imp-client';
import { createImpClient } from '@zgeoff/imp-client';
import type { ReactNode } from 'react';
import { createContext, use } from 'react';

// The SDK client and its TanStack Query helpers (queryOptions,
// mutationOptions and keys for every procedure).
export interface Impd {
  readonly client: ImpClient;
  readonly query: ReturnType<typeof buildQueryUtils>;
}

// The browser talks to the impd that served the page, with the session
// cookie and no token (docs/architecture/daemon.md#dashboard)
export function createBrowserImpd(origin: string): Impd {
  const client = createImpClient({ url: origin });

  return { client, query: buildQueryUtils(client) };
}

// the contract's namespaces only: the SDK's exec helpers are not procedures
function buildQueryUtils(client: ImpClient) {
  return createTanstackQueryUtils({
    imps: client.imps,
    checkpoints: client.checkpoints,
    images: client.images,
    exec: client.exec,
    sessions: client.sessions,
    system: client.system,
    tokens: client.tokens,
  });
}

const ImpdContext = createContext<Impd | null>(null);

interface ImpdProviderProps {
  readonly impd: Impd;
  readonly children: ReactNode;
}

export function ImpdProvider(props: ImpdProviderProps) {
  return <ImpdContext value={props.impd}>{props.children}</ImpdContext>;
}

export function useImpd(): Impd {
  const impd = use(ImpdContext);

  if (impd === null) {
    throw new Error('useImpd needs an ImpdProvider');
  }

  return impd;
}
