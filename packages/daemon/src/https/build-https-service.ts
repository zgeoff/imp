import { readFileSync } from 'node:fs';
import { findPublicImp, listPublicImpNames } from '../db/exposure';
import { subscribeImpWrites } from '../db/imp-write-feed';
import type { ImpDatabase } from '../db/open-database';
import { readServePorts } from '../net/tailscale-serve';
import type { TailscaleStatus } from '../net/tailscale-status';
import type { WakeProxy } from '../proxy/wake-proxy';
import { createAcmeIssuer } from './acme/acme-issuer';
import { createCertStore } from './acme/cert-store';
import { createDnsProvider } from './dns/create-dns-provider';
import type { HttpsConfig } from './https-config';
import type { HttpsService } from './https-service';
import { createHttpsService } from './https-service';

interface BuildHttpsOptions {
  readonly config: HttpsConfig;
  readonly dataDir: string;
  readonly db: ImpDatabase;
  readonly proxy: Pick<WakeProxy, 'startListener'>;
  readonly readTailscale: (() => Promise<TailscaleStatus>) | null;
  readonly log: (message: string) => void;
}

// The HTTPS service from impd's config, with the real CA, DNS provider and
// tailscaled.
export function buildHttpsService(options: BuildHttpsOptions): HttpsService {
  const config = options.config;
  const log = options.log;
  const store = createCertStore(options.dataDir, log);
  const dns = createDnsProvider(config.dns, log);

  const issue = createAcmeIssuer({
    directoryUrl: config.acmeDirectory,
    email: config.acmeEmail,
    caPem: config.acmeCaFile === null ? null : readFileSync(config.acmeCaFile, 'utf8'),
    store,
    dns,
    log,
  });

  const service = createHttpsService({
    config,
    store,
    issue,
    dns,
    proxy: options.proxy,
    readTailscale: options.readTailscale,
    readServePorts,
    now: Date.now,
    log,
    listPublicImps: () => listPublicImpNames(options.db),
    findPublicImp: (name) => findPublicImp(options.db, name),
  });

  // the destroy of a public imp takes its record; an expose and an unexpose
  // update the records themselves, to report how the write went
  const unsubscribe = subscribeImpWrites(options.db, (write) => {
    if (write.kind === 'removed' && write.imp.publicAuth !== null) {
      void service.updatePublicRecords();
    }
  });

  return {
    ...service,
    stop: async () => {
      unsubscribe();

      await service.stop();
    },
  };
}
