import type { Imp } from '@imp/api';
import { findImageById, listImages } from '../db/images';
import type { ImpRecord } from '../db/imps';
import { countSessions } from '../sessions/count-sessions';
import { readBootStatus } from './boot-status';
import type { ImpContext } from './imp-context';

export interface ImpUrls {
  readonly local: string;
  readonly tailnet: string | null;
}

// Imp records as the API shows them (DESIGN 2.11 for the URLs).
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

    const paths = context.findPaths(imp.id);

    const ramMib =
      imp.state === 'running' && imp.pid !== null
        ? context.readRamMib(imp.pid, paths.apiSocket)
        : null;

    if (ramMib !== null) {
      api.ramMib = ramMib;
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

      if (context.config.tailscaleAuthKey === null) {
        return { local, tailnet: null };
      }

      const live =
        context.readTailnetHostname === undefined ? null : await context.readTailnetHostname();

      const host = live ?? context.config.tailscaleHostname;
      const port = context.findAddress(imp.slot).tailnetPort;

      return { local, tailnet: `http://${host}:${String(port)}` };
    },
  };
}
