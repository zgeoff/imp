import { impContract } from '@imp/api';
import type { Image, SystemInfo } from '@imp/api';
import { implement } from '@orpc/server';
import packageJson from '../package.json' with { type: 'json' };
import type { CheckpointService } from './checkpoints/checkpoint-service';
import type { Config } from './config';
import type { ImageRecord } from './db/images';
import { listImps } from './db/imps';
import type { ImpDatabase } from './db/open-database';
import type { RamGovernor } from './governor/ram-governor';
import type { ImageService } from './images/image-service';
import type { ImpService } from './imps/imp-service';
import type { TailscaleStatus } from './net/tailscale-status';

export interface RouterDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: ImpService;
  readonly images: ImageService;
  readonly governor: RamGovernor;
  readonly checkpoints: CheckpointService;
  readonly firecrackerVersion: string | null;
  readonly readTailscale: () => Promise<TailscaleStatus>;
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
      sleep: os.imps.sleep.handler((context) => deps.imps.sleepImp(context.input.name)),
      wake: os.imps.wake.handler((context) => deps.imps.wakeImp(context.input.name)),
      hold: os.imps.hold.handler((context) =>
        deps.imps.holdImp(context.input.name, context.input.seconds),
      ),
      url: os.imps.url.handler((context) => deps.imps.readUrls(context.input.name)),
      fork: os.imps.fork.handler((context) => deps.checkpoints.forkImp(context.input)),
    },
    checkpoints: {
      create: os.checkpoints.create.handler((context) =>
        deps.checkpoints.createCheckpoint(context.input.name, context.input.label),
      ),
      list: os.checkpoints.list.handler((context) =>
        deps.checkpoints.listCheckpoints(context.input.name),
      ),
      restore: os.checkpoints.restore.handler((context) =>
        deps.checkpoints.restoreCheckpoint(context.input.name, context.input.checkpoint),
      ),
      delete: os.checkpoints.delete.handler(async (context) => {
        await deps.checkpoints.deleteCheckpoint(context.input.name, context.input.checkpoint);

        return {};
      }),
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

// RAM used is measured (what awake Firecrackers own); committed is the
// memory the awake imps were given (DESIGN 2.9).
async function readSystemInfo(deps: RouterDeps): Promise<SystemInfo> {
  const [imps, usage, tailscale] = await Promise.all([
    listImps(deps.db),
    deps.governor.readUsage(),
    deps.readTailscale(),
  ]);

  const running = imps.filter((imp) => imp.state === 'running');

  return {
    version: packageJson.version,
    ramBudgetMib: deps.config.ramBudgetMib,
    ramUsedMib: usage.usedMib,
    ramReservedMib: usage.reservedMib,
    ramCommittedMib: running.reduce((sum, imp) => sum + imp.memoryMib, 0),
    awakeCount: running.length,
    impCount: imps.length,
    firecrackerVersion: deps.firecrackerVersion,
    tailscale: {
      enabled: deps.config.tailscaleAuthKey !== null,
      ...tailscale,
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
