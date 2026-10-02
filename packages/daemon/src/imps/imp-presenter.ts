import type { Imp } from '@imp/api';
import { findImageById, listImages } from '../db/images';
import type { ImpRecord } from '../db/imps';
import { listLeases } from '../db/leases';
import type { LeaseRecord } from '../db/leases';
import type { HttpsConfig } from '../https/https-config';
import { countSessions } from '../sessions/count-sessions';
import { readBootStatus } from './boot-status';
import type { ImpContext } from './imp-context';
import { MIB } from './imp-disk';

export interface ImpUrls {
  readonly local: string;

  // https://<name>.<domain> when IMP_DOMAIN is set
  readonly https: string | null;

  // the same name from the internet, while the imp is public
  readonly public: string | null;

  // https://<service>.<tailnet> once impd serves the imp's own name
  readonly service: string | null;
  readonly tailnet: string | null;
}

// the live leases each presented imp was shown with, by the object itself:
// the router names their owners per caller without a second read
const presentedLeases = new WeakMap<Imp, readonly LeaseRecord[]>();

export function readPresentedLeases(imp: Imp): readonly LeaseRecord[] | undefined {
  return presentedLeases.get(imp);
}

// Imp records as the API shows them; the URLs follow
// docs/architecture/networking.md#urls.
export interface ImpPresenter {
  readonly toApi: (imp: ImpRecord) => Promise<Imp>;
  readonly toApiList: (imps: readonly ImpRecord[]) => Promise<Imp[]>;
  readonly readUrls: (imp: ImpRecord) => Promise<ImpUrls>;
}

// `readSilentSince` is the watchdog's: when the imp's agent went silent
export function createImpPresenter(
  context: ImpContext,
  readSilentSince: (id: string) => Date | null,
): ImpPresenter {
  const buildLocalUrl = (name: string): string =>
    `http://${name}.imp.localhost:${String(context.config.proxyPort)}`;

  // `leases` are the imp's live ones, shown as a count: who owns them is
  // the router's to show, per caller (auth/caller-view.ts)
  const toApiImp = (imp: ImpRecord, imageName: string, leases: readonly LeaseRecord[]): Imp => {
    const api: Imp = {
      id: imp.id,
      name: imp.name,
      image: imageName,
      state: imp.state,
      vcpus: imp.vcpus,
      memoryMib: imp.memoryMib,
      diskMib: Math.ceil(imp.diskBytes / MIB),
      ip: imp.ip,
      slot: imp.slot,
      port: context.findAddress(imp.slot).tailnetPort,
      httpPort: imp.httpPort,
      url: buildLocalUrl(imp.name),
      createdAt: imp.createdAt,
      lastActiveAt: imp.lastActiveAt,
    };

    if (imp.sleptAt !== null) {
      api.sleptAt = imp.sleptAt;
    }

    if (imp.publicAuth !== null) {
      api.public = { auth: imp.publicAuth };
    }

    // a hold that ended holds nothing
    if (imp.holdUntil !== null && imp.holdUntil.getTime() > context.now()) {
      api.holdUntil = imp.holdUntil;
    }

    api.leases = { leases: [], otherCount: leases.length };

    if (imp.error !== null) {
      api.error = imp.error;
    }

    const diskUsage = context.readDiskUsage(imp.id);

    if (diskUsage !== undefined) {
      api.diskUsage = diskUsage;
    }

    const paths = context.findPaths(imp.id);

    api.cpu = imp.cpu;

    // a running imp's current span counts too
    const awakeMs =
      imp.awakeMs +
      (imp.awakeSince === null ? 0 : Math.max(0, Date.now() - imp.awakeSince.getTime()));

    api.resources = { wakeCount: imp.wakeCount, awakeMs };

    // the sampler's cache: a list does not read smaps for every imp
    if (imp.state === 'running' && imp.pid !== null) {
      const sample = context.resources.readSample({
        impId: imp.id,
        pid: imp.pid,
        apiSocket: paths.apiSocket,
        tap: context.findAddress(imp.slot).tap,
      });

      if (sample.ramMib !== null) {
        api.ramMib = sample.ramMib;
      }

      if (sample.rssMib !== null) {
        api.rssMib = sample.rssMib;
      }

      api.resources.sample = {
        measuredAt: sample.measuredAt,
        since: sample.since,
        ...(sample.cpuPercent !== undefined && { cpuPercent: sample.cpuPercent }),
        cpuThrottledMs: sample.cpuThrottledMs,
        netRxBytes: sample.netRxBytes,
        netTxBytes: sample.netTxBytes,
      };
    }

    const sessions = countSessions(context, imp);

    if (sessions !== undefined) {
      api.sessions = sessions;
    }

    const silentSince = imp.state === 'running' ? readSilentSince(imp.id) : null;

    if (silentSince !== null) {
      api.agentSilentSince = silentSince;
    }

    const shown = { ...api, ...readBootStatus(imp, paths, context.identity) };

    presentedLeases.set(shown, leases);

    return shown;
  };

  return {
    toApi: async (imp) => {
      const [image, leases] = await Promise.all([
        findImageById(context.db, imp.imageId),
        listLeases(context.db, context.now(), [imp.id]),
      ]);

      return toApiImp(imp, image?.name ?? 'unknown', leases);
    },
    toApiList: async (imps) => {
      const [images, leases] = await Promise.all([
        listImages(context.db),
        listLeases(
          context.db,
          context.now(),
          imps.map((imp) => imp.id),
        ),
      ]);

      const names = new Map(images.map((image) => [image.id, image.name]));

      const byImp = Map.groupBy(leases, (lease) => lease.impId);

      return imps.map((imp) =>
        toApiImp(imp, names.get(imp.imageId) ?? 'unknown', byImp.get(imp.id) ?? []),
      );
    },
    readUrls: async (imp) => {
      const local = buildLocalUrl(imp.name);
      const https = buildHttpsUrl(imp.name, context.config.https);
      const service = context.readServiceUrl(imp.name);
      const publicUrl = buildPublicUrl(imp, context.config.https);

      if (!context.config.tailscaleEnabled) {
        return { local, https, public: publicUrl, service, tailnet: null };
      }

      const live =
        context.readTailnetHostname === undefined ? null : await context.readTailnetHostname();

      const host = live ?? context.config.tailscaleHostname;
      const port = context.findAddress(imp.slot).tailnetPort;

      return {
        local,
        https,
        public: publicUrl,
        service,
        tailnet: `http://${host}:${String(port)}`,
      };
    },
  };
}

function buildHttpsUrl(name: string, https: HttpsConfig | null): string | null {
  if (https === null) {
    return null;
  }

  const port = https.httpsPort === 443 ? '' : `:${String(https.httpsPort)}`;

  return `https://${name}.${https.domain}${port}`;
}

// Docker publishes the public listener as 443, so the URL has no port
function buildPublicUrl(imp: ImpRecord, https: HttpsConfig | null): string | null {
  if (imp.publicAuth === null || https === null || https.public === null) {
    return null;
  }

  return `https://${imp.name}.${https.domain}`;
}
