import { ORPCError } from '@orpc/server';
import type { Config } from '../config';
import { findImpByName } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { Imps } from '../imps/imp-service';
import { deriveSlotAddress } from '../net/addressing';
import type { TailscaleStatus } from '../net/tailscale-status';
import { runChecked, runCommand } from '../process/run-command';
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

  // runs `tailscale serve`; runCommand by default
  readonly runCommand?: typeof runCommand | undefined;
}

// Per-imp names from impd's config, with the real API and tailscaled.
export function buildTailnetNames(options: BuildTailnetNamesOptions): TailnetNames {
  const names = options.names;

  return createTailnetNames({
    config: names,
    hostId: loadOrCreateHostId(options.config.dataDir),
    db: options.db,
    api: createServicesApi({ readCredential: () => readOAuthCredential(names.oauthFile) }),
    serve: createServiceServe((argv) => runChecked(argv, {}, options.runCommand ?? runCommand)),
    findPort: (slot) => deriveSlotAddress(slot, options.config).tailnetPort,

    isImpPresent: createPresenceCheck(options.imps, options.db),
    readSuffix: async () => {
      const status = await options.readTailscale();

      const suffix = status.dnsName?.split('.').slice(1).join('.') ?? '';

      return suffix === '' ? null : suffix;
    },
    log: options.log,
  });
}

// Under the imp's lock: a create or destroy of the name finishes first. An
// imp the target holds a verified copy of is not this host's any more.
export function createPresenceCheck(
  imps: Pick<Imps, 'lockImp'>,
  db: ImpDatabase,
): (name: string) => Promise<boolean> {
  return async (name) => {
    try {
      return await imps.lockImp(name, () => Promise.resolve(true));
    } catch (error) {
      if (error instanceof ORPCError && error.code === 'NOT_FOUND') {
        return false;
      }

      if (error instanceof ORPCError && error.code === 'MOVING') {
        const imp = await findImpByName(db, name);

        return imp !== undefined && imp.moveState !== 'moved';
      }

      throw error;
    }
  };
}
