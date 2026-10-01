import { impContract } from '@imp/api';
import type { Image, SystemInfo } from '@imp/api';
import { ORPCError, implement } from '@orpc/server';
import packageJson from '../package.json' with { type: 'json' };
import type { Config } from './config';
import type { ImageRecord } from './db/images';
import { listImps } from './db/imps';
import type { ImpDatabase } from './db/open-database';
import type { ImageService } from './images/image-service';
import type { ImpService } from './imps/imp-service';

export interface RouterDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: ImpService;
  readonly images: ImageService;
  readonly firecrackerVersion: string | null;
}

export function buildRouter(deps: RouterDeps) {
  const os = implement(impContract);

  return os.router({
    imps: {
      create: os.imps.create.handler((context) => deps.imps.createImp(context.input)),
      list: os.imps.list.handler(() => deps.imps.listImps()),
      get: os.imps.get.handler((context) => deps.imps.getImp(context.input.name)),
      destroy: os.imps.destroy.handler(async (context) => {
        await deps.imps.destroyImp(context.input.name);

        return {};
      }),
      start: os.imps.start.handler((context) => deps.imps.startImp(context.input.name)),
      stop: os.imps.stop.handler((context) => deps.imps.stopImp(context.input.name)),
      sleep: os.imps.sleep.handler(handleUnimplemented),
      wake: os.imps.wake.handler(handleUnimplemented),
      hold: os.imps.hold.handler(handleUnimplemented),
      url: os.imps.url.handler((context) => deps.imps.readUrls(context.input.name)),
      fork: os.imps.fork.handler(handleUnimplemented),
    },
    checkpoints: {
      create: os.checkpoints.create.handler(handleUnimplemented),
      list: os.checkpoints.list.handler(handleUnimplemented),
      restore: os.checkpoints.restore.handler(handleUnimplemented),
      delete: os.checkpoints.delete.handler(handleUnimplemented),
    },
    images: {
      list: os.images.list.handler(async () => {
        const images = await deps.images.listImages();

        return images.map((image) => toApiImage(image));
      }),
      add: os.images.add.handler(async (context) => {
        const image = await deps.images.addImage(context.input.ref, context.input.name);

        return toApiImage(image);
      }),
      build: os.images.build.handler(async (context) => {
        const image = await deps.images.buildImage(
          context.input.contextDir,
          context.input.name,
          context.input.dockerfile,
        );

        return toApiImage(image);
      }),
      delete: os.images.delete.handler(async (context) => {
        await deps.images.removeImage(context.input.name);

        return {};
      }),
    },
    system: {
      info: os.system.info.handler(() => readSystemInfo(deps)),
    },
  });
}

// RAM in use is the memory the running imps were given, until the governor
// measures Firecracker PSS.
async function readSystemInfo(deps: RouterDeps): Promise<SystemInfo> {
  const imps = await listImps(deps.db);

  const running = imps.filter((imp) => imp.state === 'running');

  return {
    version: packageJson.version,
    ramBudgetMib: deps.config.ramBudgetMib,
    ramUsedMib: running.reduce((sum, imp) => sum + imp.memoryMib, 0),
    awakeCount: running.length,
    impCount: imps.length,
    firecrackerVersion: deps.firecrackerVersion,
    tailscale: {
      enabled: deps.config.tailscaleAuthKey !== null,
      state: null,
      hostname: null,
    },
  };
}

function toApiImage(image: ImageRecord): Image {
  return {
    id: image.id,
    name: image.name,
    ref: image.ref,
    digest: image.digest,
    createdAt: image.createdAt,
    sizeBytes: image.sizeBytes,
  };
}

function handleUnimplemented(): never {
  throw new ORPCError('NOT_IMPLEMENTED', { message: 'not implemented yet' });
}
