import { impContract } from '@imp/api';
import type { Image, SystemInfo } from '@imp/api';
import { implement } from '@orpc/server';
import packageJson from '../package.json' with { type: 'json' };
import { buildBackupsOffError } from './backup/backup-service';
import type { BackupService } from './backup/backup-service';
import type { Broker } from './broker/broker-service';
import type { CheckpointService } from './checkpoints/checkpoint-service';
import type { Config } from './config';
import type { ImageRecord } from './db/images';
import { listImps } from './db/imps';
import type { ImpDatabase } from './db/open-database';
import type { ExecTickets } from './exec/exec-tickets';
import type { RamGovernor } from './governor/ram-governor';
import type { ImageService } from './images/image-service';
import type { ImpService } from './imps/imp-service';
import type { TailscaleStatus } from './net/tailscale-status';
import type { StorageBackend } from './storage/storage-backend';
import type { SystemFileInfo } from './storage/system-file-info';

// audit rows `audit.list` gives when the caller names no limit
const AUDIT_LIMIT = 100;

export interface RouterDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: ImpService;
  readonly images: ImageService;
  readonly governor: RamGovernor;
  readonly checkpoints: CheckpointService;
  readonly broker: Broker;

  // null when no repository is set
  readonly backups: BackupService | null;
  readonly firecrackerVersion: string | null;
  readonly systemFiles: SystemFileInfo;
  readonly readTailscale: () => Promise<TailscaleStatus>;
  readonly execTickets: ExecTickets;
  readonly storage: Pick<StorageBackend, 'kind' | 'readUsage'>;
}

export function buildRouter(deps: RouterDeps) {
  const os = implement(impContract);

  const requireBackups = (): BackupService => {
    if (deps.backups === null) {
      throw buildBackupsOffError();
    }

    return deps.backups;
  };

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
      wake: os.imps.wake.handler((context) =>
        deps.imps.wakeImp(context.input.name, context.input.restartError),
      ),
      hold: os.imps.hold.handler((context) =>
        deps.imps.holdImp(context.input.name, context.input.seconds),
      ),
      url: os.imps.url.handler((context) => deps.imps.readUrls(context.input.name)),

      // a fork gets its source's grants, as it gets its disk
      fork: os.imps.fork.handler(async (context) => {
        const imp = await deps.checkpoints.forkImp(context.input);

        await deps.broker.createForkGrants(context.input.source, imp.name);

        return imp;
      }),
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
    backups: {
      run: os.backups.run.handler(() => requireBackups().runBackup()),
      list: os.backups.list.handler(() => requireBackups().readStatus()),
      restore: os.backups.restore.handler((context) =>
        requireBackups().restoreBackup(context.input),
      ),
      check: os.backups.check.handler(async (context) => {
        await requireBackups().checkBackups(context.input.subset);

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
    exec: {
      // NOT_FOUND now, rather than at the socket's start
      ticket: os.exec.ticket.handler(async (context) => {
        await deps.imps.getImp(context.input.name);

        return deps.execTickets.issue(context.input.name);
      }),
    },
    sessions: {
      list: os.sessions.list.handler((context) => deps.imps.listSessions(context.input.name)),
      kill: os.sessions.kill.handler(async (context) => {
        await deps.imps.killSession(context.input.name, context.input.session);

        return {};
      }),
    },
    secrets: {
      add: os.secrets.add.handler((context) => deps.broker.addSecret(context.input)),
      list: os.secrets.list.handler(() => deps.broker.listSecrets()),
      delete: os.secrets.delete.handler(async (context) => {
        await deps.broker.deleteSecret(context.input.name);

        return {};
      }),
    },
    grants: {
      add: os.grants.add.handler(async (context) => {
        await deps.broker.addGrant(context.input.name, context.input.secret);

        return {};
      }),
      delete: os.grants.delete.handler(async (context) => {
        await deps.broker.removeGrant(context.input.name, context.input.secret);

        return {};
      }),
      list: os.grants.list.handler((context) => deps.broker.listGrants(context.input.name)),
    },
    audit: {
      list: os.audit.list.handler((context) =>
        deps.broker.listAudit(context.input.name ?? null, context.input.limit ?? AUDIT_LIMIT),
      ),
    },
    system: {
      info: os.system.info.handler(() => readSystemInfo(deps)),
    },
  });
}

// RAM used is measured (what awake Firecrackers own); committed is the
// memory the awake imps were given (DESIGN 2.9).
async function readSystemInfo(deps: RouterDeps): Promise<SystemInfo> {
  const [imps, usage, tailscale, storage] = await Promise.all([
    listImps(deps.db),
    deps.governor.readUsage(),
    deps.readTailscale(),
    deps.storage.readUsage(),
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
    sessionCount: imps.reduce((sum, imp) => sum + (deps.imps.countSessions(imp) ?? 0), 0),
    firecrackerVersion: deps.firecrackerVersion,
    guestKernel: deps.systemFiles.guestKernel,
    systemDrive: deps.systemFiles.systemDrive,
    storage: { backend: deps.storage.kind, ...storage },
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
