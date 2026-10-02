import { ORPCError } from '@orpc/server';
import type { Config } from '../config';
import type { ImpDatabase } from '../db/open-database';
import type { Imps } from '../imps/imp-service';
import { deriveSlotAddress } from '../net/addressing';
import type { TailscaleStatus } from '../net/tailscale-status';
import { loadOrCreateHostId } from './host-id';
import { readOAuthCredential } from './oauth-credential';
import { createServiceServe } from './service-serve';
import { createServicesApi } from './services-api';
import { createTailnetNames } from './tailnet-names';
import type { TailnetNames } from './tailnet-names';
import type { TailnetNamesConfig } from './tailnet-names-config';

interface BuildTailnetNamesOptions {
  readonly names: TailnetNamesConfig;
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: Pick<Imps, 'lockImp'>;
  readonly readTailscale: () => Promise<TailscaleStatus>;
  readonly log: (message: string) => void;
}

// Per-imp names from impd's config, with the real API and tailscaled.
export function buildTailnetNames(options: BuildTailnetNamesOptions): TailnetNames {
  const names = options.names;

  return createTailnetNames({
    config: names,
    hostId: loadOrCreateHostId(options.config.dataDir),
    db: options.db,
    api: createServicesApi({ readCredential: () => readOAuthCredential(names.oauthFile) }),
    serve: createServiceServe(),
    findPort: (slot) => deriveSlotAddress(slot, options.config).tailnetPort,

    // under the imp's lock: a create or destroy of the name finishes first
    isImpPresent: async (name) => {
      try {
        return await options.imps.lockImp(name, () => Promise.resolve(true));
      } catch (error) {
        if (error instanceof ORPCError && error.code === 'NOT_FOUND') {
          return false;
        }

        throw error;
      }
    },
    readSuffix: async () => {
      const status = await options.readTailscale();

      const suffix = status.dnsName?.split('.').slice(1).join('.') ?? '';

      return suffix === '' ? null : suffix;
    },
    log: options.log,
  });
}
