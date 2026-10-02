import { EVENT_VERSION, impContract } from '@imp/api';
import type { Image, ImpEvent, SystemInfo } from '@imp/api';
import { implement } from '@orpc/server';
import packageJson from '../package.json' with { type: 'json' };
import { buildForbiddenError } from './api-errors';
import { readImpName } from './audit/api-audit';
import type { ApiAudit } from './audit/api-audit';
import { checkAccess, findAccess, isAuditedProcedure } from './auth/access-policy';
import { formatCaller, isCallerAllowed, toIdentity } from './auth/caller';
import type { Caller } from './auth/caller';
import { isImpAllowed } from './auth/imp-patterns';
import { hasScope } from './auth/scopes';
import type { TokenStore } from './auth/token-store';
import { buildBackupsOffError } from './backup/backup-service';
import type { BackupService } from './backup/backup-service';
import type { Broker } from './broker/broker-service';
import type { CheckpointService } from './checkpoints/checkpoint-service';
import type { Config } from './config';
import { listApiCalls } from './db/api-audit';
import type { ImageRecord } from './db/images';
import { listImps } from './db/imps';
import type { ImpDatabase } from './db/open-database';
import type { EgressService } from './egress/egress-service';
import { openEventStream } from './events/event-stream';
import type { ExecTickets } from './exec/exec-tickets';
import type { RamGovernor } from './governor/ram-governor';
import type { ImageService } from './images/image-service';
import { countBootStatuses } from './imps/boot-status';
import type { ImpService } from './imps/imp-service';
import type { TailscaleStatus } from './net/tailscale-status';
import type { DiskBudget } from './storage/disk-budget';
import type { StorageBackend } from './storage/storage-backend';
import type { StorageGcService } from './storage/storage-gc';
import type { SystemFileInfo } from './storage/system-file-info';
import type { TailnetNamesStatus } from './tailnet-names/tailnet-names';

// audit rows `audit.list` gives when the caller names no limit
const AUDIT_LIMIT = 100;

// log lines `services.logs` sends first when the caller names no count
const DEFAULT_LOG_LINES = 100;

export interface RouterDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: ImpService;
  readonly images: ImageService;
  readonly governor: RamGovernor;
  readonly checkpoints: CheckpointService;
  readonly broker: Broker;
  readonly egress: Pick<EgressService, 'readPolicy' | 'setPolicy'>;

  // null when no repository is set
  readonly backups: BackupService | null;
  readonly firecrackerVersion: string | null;
  readonly systemFiles: SystemFileInfo;
  readonly readTailscale: () => Promise<TailscaleStatus>;

  // per-imp names on the tailnet; null when IMP_TAILNET_NAMES is off
  readonly readTailnetNames: (() => TailnetNamesStatus) | null;
  readonly execTickets: ExecTickets;
  readonly storage: Pick<StorageBackend, 'kind'>;
  readonly diskBudget: Pick<DiskBudget, 'readStatus'>;
  readonly gc: Pick<StorageGcService, 'runGc'>;
  readonly now: () => number;
  readonly audit: ApiAudit;
  readonly tokens: TokenStore;
}

// what each call gets from build-app: who made it, and a signal that aborts
// when what it authenticated with ends (a logout, a removed token); null
// for nothing that can end
export interface RpcContext {
  readonly caller: Caller;
  readonly ends: AbortSignal | null;
}

export function buildRouter(deps: RouterDeps) {
  // every call is checked against its access rule (auth/access-policy.ts);
  // every call that changes something, refused or not, leaves an audit row
  // after its answer
  const os = implement(impContract)
    .$context<RpcContext>()
    .use(async (options, input) => {
      const procedure = options.path.join('.');
      const caller = options.context.caller;

      const requireAccess = (): void => {
        const refusal = checkAccess(findAccess(procedure), caller, input);

        if (refusal !== null) {
          throw buildForbiddenError(refusal);
        }
      };

      if (!isAuditedProcedure(procedure)) {
        requireAccess();

        return options.next();
      }

      const startedAt = deps.now();

      const buildCall = (output: unknown) => ({
        procedure,
        actor: caller,
        impName: readImpName(procedure, input, output),
        startedAt,
      });

      try {
        requireAccess();

        const result = await options.next();

        deps.audit.record(buildCall(result.output), null);

        return result;
      } catch (error) {
        deps.audit.record(buildCall(null), error);
        throw error;
      }
    });

  // the caller's imps as its event stream opens
  const readSnapshot = async (caller: Readonly<Caller>): Promise<ImpEvent[]> => {
    const imps = await listCallerImps(caller);

    const at = new Date(deps.now());

    return imps.map((imp) => ({ v: EVENT_VERSION, at, ev: 'ImpAdded', reason: 'snapshot', imp }));
  };

  const listCallerImps = async (caller: Readonly<Caller>) => {
    const imps = await deps.imps.listImps();

    return imps.filter((imp) => isImpAllowed(caller.imps, imp.name));
  };

  const requireBackups = (): BackupService => {
    if (deps.backups === null) {
      throw buildBackupsOffError();
    }

    return deps.backups;
  };

  return os.router({
    imps: {
      create: os.imps.create.handler((context) => deps.imps.createImp(context.input)),
      list: os.imps.list.handler((context) => listCallerImps(context.context.caller)),
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
      resizeDisk: os.imps.resizeDisk.handler((context) =>
        deps.imps.resizeDisk(context.input.name, context.input.diskMib),
      ),
      update: os.imps.update.handler((context) =>
        deps.imps.updateImp(context.input.name, context.input),
      ),
      url: os.imps.url.handler((context) => deps.imps.readUrls(context.input.name)),
      policy: os.imps.policy.handler((context) => deps.egress.readPolicy(context.input.name)),
      setPolicy: os.imps.setPolicy.handler((context) =>
        deps.egress.setPolicy(context.input.name, context.input.policy),
      ),

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

        return deps.execTickets.issue(context.input.name, context.context.caller);
      }),
    },
    sessions: {
      list: os.sessions.list.handler((context) => deps.imps.listSessions(context.input.name)),
      kill: os.sessions.kill.handler(async (context) => {
        await deps.imps.killSession(context.input.name, context.input.session);

        return {};
      }),
    },
    services: {
      list: os.services.list.handler((context) => deps.imps.listServices(context.input.name)),
      add: os.services.add.handler(async (context) => {
        const input = context.input;

        await deps.imps.addService(input.name, input.service, {
          canManage: hasScope(context.context.caller.scope, 'manage'),
          replace: input.replace ?? false,
        });

        return {};
      }),
      remove: os.services.remove.handler(async (context) => {
        const rights = { canManage: hasScope(context.context.caller.scope, 'manage') };

        await deps.imps.removeService(context.input.name, context.input.service, rights);

        return {};
      }),
      restart: os.services.restart.handler(async (context) => {
        const rights = { canManage: hasScope(context.context.caller.scope, 'manage') };

        await deps.imps.restartService(context.input.name, context.input.service, rights);

        return {};
      }),
      logs: os.services.logs.handler((context) =>
        deps.imps.openServiceLogs(context.input.name, {
          service: context.input.service,
          lines: context.input.lines ?? DEFAULT_LOG_LINES,
          follow: context.input.follow ?? false,
        }),
      ),
    },
    secrets: {
      add: os.secrets.add.handler((context) => deps.broker.addSecret(context.input)),

      // a caller limited to some imps sees the grants to those only
      list: os.secrets.list.handler(async (context) => {
        const patterns = context.context.caller.imps;

        const secrets = await deps.broker.listSecrets();

        return secrets.map((secret) => ({
          name: secret.name,
          kind: secret.kind,
          rules: secret.rules,
          imps: secret.imps.filter((name) => isImpAllowed(patterns, name)),
          createdAt: secret.createdAt,
        }));
      }),
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
      list: os.audit.list.handler((context) => {
        const caller = context.context.caller;

        requireNamedImp(caller, context.input.name);

        return deps.broker.listAudit(
          context.input.name ?? null,
          context.input.limit ?? AUDIT_LIMIT,
          caller.imps,
        );
      }),
      calls: os.audit.calls.handler((context) => {
        const caller = context.context.caller;

        requireNamedImp(caller, context.input.name);

        return listApiCalls(
          deps.db,
          context.input.name ?? null,
          context.input.limit ?? AUDIT_LIMIT,
          caller.imps,
        );
      }),
    },
    events: {
      // a dashboard's stream ends when its session expires or at a logout;
      // any stream ends when its token is removed
      stream: os.events.stream.handler((options) => {
        const caller = options.context.caller;

        return openEventStream({
          bus: deps.imps.events,
          readSnapshot: () => readSnapshot(caller),
          signal: mergeSignals(options.signal, options.context.ends),
          endsAt: caller.expiresAt,
          now: deps.now,
          accepts: (event) => isImpAllowed(caller.imps, readEventImpName(event)),
        });
      }),
    },
    system: {
      info: os.system.info.handler(() => readSystemInfo(deps)),
      gc: os.system.gc.handler((context) => deps.gc.runGc(context.input.dryRun ?? false)),
    },
    tokens: {
      list: os.tokens.list.handler(() => deps.tokens.list()),
      create: os.tokens.create.handler((context) =>
        deps.tokens.create({
          name: context.input.name,
          scope: context.input.scope,
          imps: context.input.imps ?? null,
          sshKeys: context.input.sshKeys ?? [],
        }),
      ),
      delete: os.tokens.delete.handler(async (context) => {
        await deps.tokens.remove(context.input.name);

        return {};
      }),
      addKey: os.tokens.addKey.handler((context) =>
        deps.tokens.addKey(context.input.name, context.input.key),
      ),
      removeKey: os.tokens.removeKey.handler(async (context) => {
        await deps.tokens.removeKey(context.input.name, context.input.fingerprint);

        return {};
      }),
      whoami: os.tokens.whoami.handler((context) => toIdentity(context.context.caller)),
    },
  });
}

// RAM used is measured (what awake Firecrackers own); committed is the memory
// the awake imps were given
// (docs/architecture/sleep-and-wake.md#the-ram-governor).
async function readSystemInfo(deps: RouterDeps): Promise<SystemInfo> {
  const [imps, usage, tailscale, storage] = await Promise.all([
    listImps(deps.db),
    deps.governor.readUsage(),
    deps.readTailscale(),
    deps.diskBudget.readStatus(),
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
    bootStatus: countBootStatuses(imps, deps.imps.readBootStatus),
    firecrackerVersion: deps.firecrackerVersion,
    guestKernel: deps.systemFiles.guestKernel,
    systemDrive: deps.systemFiles.systemDrive,
    storage: {
      backend: deps.storage.kind,
      ...storage,
      impDiskBytes: imps.reduce((sum, imp) => sum + imp.diskBytes, 0),
    },
    tailscale: {
      enabled: deps.config.tailscaleEnabled,
      state: tailscale.state,
      hostname: tailscale.hostname,
      ip: tailscale.ip,
      names: deps.readTailnetNames?.() ?? null,
    },
    cpu: deps.imps.readCpuHost(),
  };
}

export function toApiImage(image: ImageRecord): Image {
  return {
    id: image.id,
    name: image.name,
    ref: image.ref,
    digest: image.digest,
    createdAt: image.createdAt,
    sizeBytes: image.sizeBytes,
  };
}

// an audit list may name one imp, which must be the caller's
function requireNamedImp(caller: Readonly<Caller>, name: string | undefined): void {
  if (name !== undefined && !isCallerAllowed(caller, 'read', name)) {
    throw buildForbiddenError(`${formatCaller(caller)} may not touch imp ${name}`);
  }
}

function readEventImpName(event: ImpEvent): string {
  return 'imp' in event ? event.imp.name : event.name;
}

function mergeSignals(
  request: AbortSignal | undefined,
  ends: AbortSignal | null,
): AbortSignal | undefined {
  if (ends === null) {
    return request;
  }

  return request === undefined ? ends : AbortSignal.any([request, ends]);
}
