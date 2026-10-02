import type { Imp } from '@imp/api';
import { findImageById, listImages } from '../db/images';
import type { ImpRecord } from '../db/imps';
import type { HttpsConfig } from '../https/https-config';
import { countSessions } from '../sessions/count-sessions';
import { readBootStatus } from './boot-status';
import type { ImpContext } from './imp-context';
import { MIB } from './imp-disk';

export interface ImpUrls {
  readonly local: string;

  // https://<name>.<domain> when IMP_DOMAIN is set
  readonly https: string | null;

  // https://<service>.<tailnet> once impd serves the imp's own name
  readonly service: string | null;
  readonly tailnet: string | null;
}

// Imp records as the API shows them; the URLs follow
// docs/architecture/networking.md#urls.
export interface ImpPresenter {
  readonly toApi: (imp: ImpRecord) => Promise<Imp>;
  readonly toApiList: (imps: readonly ImpRecord[]) => Promise<Imp[]>;
  readonly readUrls: (imp: ImpRecord) => Promise<ImpUrls>;
}

export function createImpPresenter(context: ImpContext): ImpPresenter {
  const buildLocalUrl = (name: string): string =>
    `http://${name}.imp.localhost:${String(context.config.proxyPort)}`;

  const toApiImp = (imp: ImpRecord, imageName: string): Imp => {
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

    if (imp.holdUntil !== null) {
      api.holdUntil = imp.holdUntil;
    }

    if (imp.error !== null) {
      api.error = imp.error;
    }

    const diskUsage = context.readDiskUsage(imp.id);

    if (diskUsage !== undefined) {
      api.diskUsage = diskUsage;
    }

    const paths = context.findPaths(imp.id);

    if (imp.state === 'running' && imp.pid !== null) {
      const ramMib = context.readRamMib(imp.pid, paths.apiSocket);
      const rssMib = context.readRssMib(imp.pid, paths.apiSocket);

      if (ramMib !== null) {
        api.ramMib = ramMib;
      }

      if (rssMib !== null) {
        api.rssMib = rssMib;
      }
    }

    const sessions = countSessions(context, imp);

    if (sessions !== undefined) {
      api.sessions = sessions;
    }

    return { ...api, ...readBootStatus(imp, paths, context.identity) };
  };

  return {
    toApi: async (imp) => {
      const image = await findImageById(context.db, imp.imageId);

      return toApiImp(imp, image?.name ?? 'unknown');
    },
    toApiList: async (imps) => {
      const images = await listImages(context.db);

      const names = new Map(images.map((image) => [image.id, image.name]));

      return imps.map((imp) => toApiImp(imp, names.get(imp.imageId) ?? 'unknown'));
    },
    readUrls: async (imp) => {
      const local = buildLocalUrl(imp.name);
      const https = buildHttpsUrl(imp.name, context.config.https);
      const service = context.readServiceUrl(imp.name);

      if (!context.config.tailscaleEnabled) {
        return { local, https, service, tailnet: null };
      }

      const live =
        context.readTailnetHostname === undefined ? null : await context.readTailnetHostname();

      const host = live ?? context.config.tailscaleHostname;
      const port = context.findAddress(imp.slot).tailnetPort;

      return { local, https, service, tailnet: `http://${host}:${String(port)}` };
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
