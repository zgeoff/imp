import { EVENT_VERSION, impContract, isImpAllowed } from '@imp/api';
import type { Image, ImageBuildPhase, Imp, ImpEvent, Scope, SystemInfo } from '@imp/api';
import { implement } from '@orpc/server';
import packageJson from '../package.json' with { type: 'json' };
import { buildForbiddenError } from './api-errors';
import { readImpName } from './audit/api-audit';
import type { ApiAudit } from './audit/api-audit';
import {
  checkAccess,
  findAccess,
  findForkAuthority,
  findGrantAuthority,
  isAuditedProcedure,
  isRefusalAudited,
} from './auth/access-policy';
import { formatCaller, isCallerAllowed, toIdentity } from './auth/caller';
import type { Caller } from './auth/caller';
import {
  isLeaseVisible,
  requireLeaseHolder,
  toApiLease,
  toCallerError,
  toLeaseSummary,
} from './auth/caller-view';
import { hasScope } from './auth/scopes';
import type { TokenStore } from './auth/token-store';
import { buildBackupsOffError } from './backup/backup-service';
import type { BackupService } from './backup/backup-service';
import type { Broker } from './broker/broker-service';
import type { CheckpointService } from './checkpoints/checkpoint-service';
import type { Config } from './config';
import { listApiCalls } from './db/api-audit';
import { writeDatabaseCopy } from './db/database-copy';
import type { ImageRecord } from './db/images';
import { listImps } from './db/imps';
import type { ImpRecord } from './db/imps';
import type { ImpDatabase } from './db/open-database';
import { findSecret } from './db/secrets';
import type { EgressService } from './egress/egress-service';
import { createEventCheck } from './events/event-check';
import { openEventStream } from './events/event-stream';
import type { ExecTickets } from './exec/exec-tickets';
import type { RamGovernor } from './governor/ram-governor';
import type { DnsTokenStatus } from './https/dns/dns-token';
import { createExposureService } from './https/exposure-service';
import type { RecordsStatus } from './https/https-service';
import type { PublicRecordsLink } from './https/public-records-link';
import { runImageOp } from './images/image-op-stream';
import type { ImageOpStreamOptions } from './images/image-op-stream';
import type { ImageService } from './images/image-service';
import type { TemplateService } from './images/template-service';
import { countBootStatuses } from './imps/boot-status';
import { readPresentedLeases } from './imps/imp-presenter';
import type { ImpService } from './imps/imp-service';
import type { MoveService } from './moves/move-service';
import type { TailscaleStatus } from './net/tailscale-status';
import type { NetworkService } from './networks/network-service';
import type { OAuthService } from './oauth/oauth-service';
import type { DiskBudget } from './storage/disk-budget';
import type { StorageBackend } from './storage/storage-backend';
import type { StorageGcService } from './storage/storage-gc';
import type { SystemFileInfo } from './storage/system-file-info';
import type { TailnetNamesStatus } from './tailnet-names/tailnet-names';
import { readKsmHostStats } from './vmm/ksm';
import type { KsmHostStats } from './vmm/ksm';

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
  readonly templates: TemplateService;
  readonly broker: Broker;
  readonly egress: Pick<EgressService, 'readPolicy' | 'setPolicy' | 'isEnforced'>;
  readonly networks: NetworkService;

  // null when no repository is set
  readonly backups: BackupService | null;
  readonly moves: Omit<MoveService, 'handle' | 'recover'>;
  readonly firecrackerVersion: string | null;
  readonly systemFiles: SystemFileInfo;

  // the host's KSM counters; null without KSM
  readonly readKsmHostStats?: () => KsmHostStats | null;
  readonly readTailscale: () => Promise<TailscaleStatus>;

  // per-imp names on the tailnet; null when IMP_TAILNET_NAMES is off
  readonly readTailnetNames: (() => TailnetNamesStatus) | null;

  // the HTTPS service's public records, once it runs
  readonly publicRecords: PublicRecordsLink;

  // reads the DNS API token now; null for a provider without one
  readonly checkDnsToken: (() => Promise<DnsTokenStatus>) | null;
  readonly execTickets: ExecTickets;
  readonly storage: Pick<StorageBackend, 'kind'>;
  readonly diskBudget: Pick<DiskBudget, 'readStatus' | 'withRoom'>;
  readonly gc: Pick<StorageGcService, 'runGc'>;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly audit: ApiAudit;
  readonly tokens: TokenStore;

  // the gap between progress events of a streamed image add or build
  readonly imageKeepaliveMs: number;

  // OAuth for the public MCP route (docs/guides/mcp.md#public-route)
  readonly oauth: OAuthService;
}

// what a streamed image call's options are made from
interface ImageOpCall {
  readonly context: RpcContext;
  readonly input: unknown;
  readonly signal?: AbortSignal | undefined;
}

// what each call gets from build-app: who made it, and a signal that aborts
// when what it authenticated with ends (a logout, a removed token); null
// for nothing that can end
export interface RpcContext {
  readonly caller: Caller;
  readonly ends: AbortSignal | null;
}

export function buildRouter(deps: RouterDeps) {
  const exposure = createExposureService({
    db: deps.db,
    https: deps.config.https,
    updateRecords: deps.publicRecords.update,
  });

  // read at each grant or revoke, never cached: the secret by a name can be
  // another one than a token was given
  const readGeneration = async (name: string): Promise<string | null> => {
    const secret = await findSecret(deps.db, name);

    return secret?.generation ?? null;
  };

  // every call is checked against its access rule (auth/access-policy.ts);
  // every call that changes something, refused or not, leaves an audit row
  // after its answer
  const os = implement(impContract)
    .$context<RpcContext>()
    .use(async (options, input) => {
      const procedure = options.path.join('.');
      const caller = options.context.caller;

      const requireAccess = async (): Promise<void> => {
        const refusal = await checkAccess(findAccess(procedure), caller, input, readGeneration);

        if (refusal !== null) {
          throw buildForbiddenError(refusal.message, refusal.reason);
        }
      };

      const startedAt = deps.now();

      const buildCall = (output: unknown) => ({
        procedure,
        actor: caller,
        impName: readImpName(procedure, input, output),
        startedAt,
      });

      if (!isAuditedProcedure(procedure)) {
        try {
          await requireAccess();
        } catch (error) {
          if (isRefusalAudited(procedure)) {
            deps.audit.record(buildCall(null), error);
          }

          throw toCallerError(error, caller);
        }

        try {
          return await options.next();
        } catch (error) {
          throw toCallerError(error, caller);
        }
      }

      try {
        await requireAccess();

        const result = await options.next();

        deps.audit.record(buildCall(result.output), null);

        return result;
      } catch (error) {
        deps.audit.record(buildCall(null), error);

        // a refusal names only the leases and imps the caller may see
        throw toCallerError(error, caller);
      }
    });

  // the caller's imps as its event stream opens
  const readSnapshot = async (caller: Readonly<Caller>): Promise<ImpEvent[]> => {
    const imps = await listCallerImps(caller);

    const at = new Date(deps.now());

    return imps.map((imp) => ({ v: EVENT_VERSION, at, ev: 'ImpAdded', reason: 'snapshot', imp }));
  };

  // A streamed image call audits itself as its work ends, so the row holds
  // the outcome rather than the stream's opening (access-policy.ts)
  const buildImageOpOptions = (
    call: Readonly<ImageOpCall>,
    procedure: string,
    firstPhase: ImageBuildPhase,
  ): ImageOpStreamOptions => {
    const startedAt = deps.now();

    return {
      firstPhase,
      signal: call.signal ?? new AbortController().signal,
      keepaliveMs: deps.imageKeepaliveMs,
      now: deps.now,
      record: (failure) => {
        const impName = readImpName(procedure, call.input, null);

        deps.audit.record({ procedure, actor: call.context.caller, impName, startedAt }, failure);
      },
    };
  };

  // one for every stream: each event is checked once, whoever reads it
  const isEventValid = createEventCheck({ log: deps.log, now: deps.now });

  const listCallerImps = async (caller: Readonly<Caller>) => {
    const imps = await deps.imps.listImps();

    return imps.filter((imp) => isImpAllowed(caller.imps, imp.name));
  };

  // The presenter shows an imp's leases as a count; the caller sees its own,
  // or every owner with host-wide manage. The records are the ones the
  // presenter read; an imp from elsewhere has its read here.
  const toCallerImps = async (caller: Readonly<Caller>, imps: readonly Imp[]): Promise<Imp[]> => {
    const unread = imps.filter((imp) => readPresentedLeases(imp) === undefined);

    const byImp = await deps.imps.readLeases(unread.map((imp) => imp.id));

    return imps.map((imp) => {
      const leases = readPresentedLeases(imp) ?? byImp.get(imp.id) ?? [];

      return { ...imp, leases: toLeaseSummary(caller, imp.name, leases) };
    });
  };

  const toCallerImp = async (caller: Readonly<Caller>, imp: Imp | Promise<Imp>): Promise<Imp> => {
    const [shown] = await toCallerImps(caller, [await imp]);

    if (shown === undefined) {
      throw new Error('an imp went missing on its way out');
    }

    return shown;
  };

  const requireBackups = (): BackupService => {
    if (deps.backups === null) {
      throw buildBackupsOffError();
    }

    return deps.backups;
  };

  return os.router({
    imps: {
      // a network reaches past a caller's imp patterns, as a join does
      create: os.imps.create.handler(async (context) => {
        const caller = context.context.caller;
        const { networks, ...input } = context.input;

        if (networks !== undefined && caller.imps !== null) {
          throw buildForbiddenError(
            `${formatCaller(caller)} is limited to some imps, so it cannot put an imp on a network`,
          );
        }

        // a template holds its source imp's disk: a caller limited to some
        // imps must reach the source, as for a fork
        if (caller.imps !== null) {
          const image = await deps.images.resolveImage(input.image);

          if (image.sourceImp !== null && !isCallerAllowed(caller, 'manage', image.sourceImp)) {
            throw buildForbiddenError(
              `${formatCaller(caller)} may not copy imp ${image.sourceImp}, the source of template ${image.name}`,
            );
          }
        }

        const networkIds = await deps.networks.resolveNetworkIds(networks ?? []);

        return toCallerImp(caller, deps.imps.createImp({ ...input, networkIds }));
      }),
      list: os.imps.list.handler(async (context) => {
        const caller = context.context.caller;

        const imps = await listCallerImps(caller);

        return toCallerImps(caller, imps);
      }),
      get: os.imps.get.handler((context) =>
        toCallerImp(context.context.caller, deps.imps.getImp(context.input.name)),
      ),
      destroy: os.imps.destroy.handler(async (context) => {
        await deps.imps.destroyImp(context.input.name);

        return {};
      }),
      start: os.imps.start.handler((context) =>
        toCallerImp(context.context.caller, deps.imps.startImp(context.input.name)),
      ),
      stop: os.imps.stop.handler((context) =>
        toCallerImp(
          context.context.caller,
          deps.imps.stopImp(context.input.name, context.input.force ?? false),
        ),
      ),
      sleep: os.imps.sleep.handler((context) =>
        toCallerImp(
          context.context.caller,
          deps.imps.sleepImp(context.input.name, context.input.force ?? false),
        ),
      ),
      wake: os.imps.wake.handler((context) =>
        toCallerImp(
          context.context.caller,
          deps.imps.wakeImp(context.input.name, context.input.restartError),
        ),
      ),
      hold: os.imps.hold.handler((context) => {
        const caller = context.context.caller;

        return toCallerImp(
          caller,
          deps.imps.holdImp(context.input.name, context.input.seconds, requireLeaseHolder(caller)),
        );
      }),
      resizeDisk: os.imps.resizeDisk.handler((context) =>
        toCallerImp(
          context.context.caller,
          deps.imps.resizeDisk(context.input.name, context.input.diskMib),
        ),
      ),
      update: os.imps.update.handler((context) =>
        toCallerImp(context.context.caller, deps.imps.updateImp(context.input.name, context.input)),
      ),
      url: os.imps.url.handler((context) => deps.imps.readUrls(context.input.name)),
      policy: os.imps.policy.handler((context) => deps.egress.readPolicy(context.input.name)),
      setPolicy: os.imps.setPolicy.handler((context) =>
        deps.egress.setPolicy(context.input.name, context.input.policy),
      ),

      expose: os.imps.expose.handler((context) => exposure.expose(context.input)),
      unexpose: os.imps.unexpose.handler(async (context) => {
        await exposure.unexpose(context.input.name);

        return toCallerImp(context.context.caller, deps.imps.getImp(context.input.name));
      }),

      // a fork gets its source's grants the caller could make, as it gets
      // its disk; the answer names the rest
      fork: os.imps.fork.handler(async (context) => {
        const caller = context.context.caller;

        const forked = await deps.checkpoints.forkImp(context.input);

        const copied = await deps.broker.createForkGrants(
          { id: forked.sourceId, name: context.input.source },
          forked.imp,
          findForkAuthority(caller),
        );

        return {
          ...(await toCallerImp(caller, forked.imp)),
          grantsNotCopied: copied.notCopied,
          ...(copied.error !== null && { grantsError: copied.error }),
        };
      }),
    },
    leases: {
      acquire: os.leases.acquire.handler(async (context) => {
        const input = context.input;
        const caller = context.context.caller;

        const acquired = await deps.imps.acquireLease(
          input.name,
          requireLeaseHolder(caller),
          input.label,
          input.ttlSeconds,
        );

        return toApiLease(acquired.name, acquired.lease);
      }),
      renew: os.leases.renew.handler(async (context) => {
        const input = context.input;
        const caller = context.context.caller;

        const renewed = await deps.imps.renewLease(
          input.name,
          requireLeaseHolder(caller),
          input.label,
          input.ttlSeconds,
        );

        return toApiLease(renewed.name, renewed.lease);
      }),
      release: os.leases.release.handler(async (context) => {
        const input = context.input;
        const caller = context.context.caller;
        const holder = requireLeaseHolder(caller);

        const released = await deps.imps.releaseLease(input.name, holder, input.label);

        return { released };
      }),

      // the caller's imps only, and on them the leases it may see
      list: os.leases.list.handler(async (context) => {
        const caller = context.context.caller;
        const name = context.input.name;
        const label = context.input.label;

        requireNamedImp(caller, name, 'exec');

        if (name !== undefined) {
          await deps.imps.getImp(name);
        }

        const leases = await deps.imps.listLeases();

        return leases
          .filter(
            (each) =>
              (name === undefined || each.name === name) &&
              (label === undefined || each.lease.label === label) &&
              isCallerAllowed(caller, 'exec', each.name) &&
              isLeaseVisible(caller, each.lease),
          )
          .map((each) => toApiLease(each.name, each.lease));
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
        toCallerImp(
          context.context.caller,
          deps.checkpoints.restoreCheckpoint(context.input.name, context.input.checkpoint),
        ),
      ),
      delete: os.checkpoints.delete.handler(async (context) => {
        await deps.checkpoints.deleteCheckpoint(context.input.name, context.input.checkpoint);

        return {};
      }),
    },
    moves: {
      prepare: os.moves.prepare.handler((context) =>
        deps.moves.prepare(context.input.name, {
          stop: context.input.stop === true,
          force: context.input.force === true,
          targetStorage: context.input.targetStorage ?? 'xfs',
          target: context.input.target ?? null,
        }),
      ),
      facts: os.moves.facts.handler(() => deps.moves.readFacts()),
      receive: os.moves.receive.handler((context) =>
        deps.moves.issueTicket(context.input.name, context.input.bytes, context.input.warm),
      ),
      send: os.moves.send.handler((context) =>
        deps.moves.send(context.input.name, context.input.to, context.input.ticket),
      ),
      status: os.moves.status.handler((context) => deps.moves.readStatus(context.input.name)),
      reissue: os.moves.reissue.handler((context) => deps.moves.reissueTicket(context.input.name)),
      resume: os.moves.resume.handler((context) =>
        deps.moves.resume(context.input.name, context.input.ticket),
      ),
      abort: os.moves.abort.handler((context) => deps.moves.abort(context.input.name)),
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
        const input = context.input;

        const image =
          'imp' in input
            ? await deps.templates.createTemplate(input.imp, input.name)
            : await deps.images.addImage(input.ref, input.name);

        return toApiImage(image);
      }),
      addStream: os.images.addStream.handler((context) => {
        const input = context.input;
        const firstPhase = 'imp' in input ? 'copy' : 'pull';

        return runImageOp(
          async (signal, setPhase) => {
            // a template copies an imp's disk under its lock: no client
            // stops it, as with images.add
            const image =
              'imp' in input
                ? await deps.templates.createTemplate(input.imp, input.name)
                : await deps.images.addImage(input.ref, input.name, { signal, setPhase });

            return toApiImage(image);
          },
          buildImageOpOptions(context, 'images.addStream', firstPhase),
        );
      }),
      buildStream: os.images.buildStream.handler((context) =>
        runImageOp(
          async (signal, setPhase) => {
            const image = await deps.images.buildImage(
              context.input.contextDir,
              context.input.name,
              context.input.dockerfile,
              { signal, setPhase },
            );

            return toApiImage(image);
          },
          buildImageOpOptions(context, 'images.buildStream', 'pack'),
        ),
      ),
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
    networks: {
      // a caller limited to some imps sees those members only
      list: os.networks.list.handler(async (context) => {
        const patterns = context.context.caller.imps;

        const networks = await deps.networks.listNetworks();

        return networks.map((network) => ({
          name: network.name,
          imps: network.imps.filter((name) => isImpAllowed(patterns, name)),
          createdAt: network.createdAt,
        }));
      }),
      create: os.networks.create.handler((context) =>
        deps.networks.createNetwork(context.input.name),
      ),
      delete: os.networks.delete.handler(async (context) => {
        await deps.networks.deleteNetwork(context.input.name);

        return {};
      }),
      join: os.networks.join.handler((context) =>
        deps.networks.joinNetwork(context.input.network, context.input.name),
      ),
      leave: os.networks.leave.handler((context) =>
        deps.networks.leaveNetwork(context.input.network, context.input.name),
      ),
      warnings: os.networks.warnings.handler((context) =>
        deps.networks.readTrustWarnings(context.input.name),
      ),
    },
    grants: {
      // a caller for some imps grants the secret its list names, checked
      // again in the grant's transaction: it could be deleted and made
      // again since the access check
      add: os.grants.add.handler(async (context) => {
        const input = context.input;

        await deps.broker.addGrant(
          input.name,
          input.secret,
          findGrantAuthority(context.context.caller, input.secret),
        );

        return {};
      }),
      delete: os.grants.delete.handler(async (context) => {
        const input = context.input;

        await deps.broker.removeGrant(
          input.name,
          input.secret,
          findGrantAuthority(context.context.caller, input.secret),
        );

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
          readSnapshot: async () => {
            const snapshot = await readSnapshot(caller);

            return snapshot.filter((event) => isEventValid(event));
          },
          signal: mergeSignals(options.signal, options.context.ends),
          endsAt: caller.expiresAt,
          now: deps.now,
          accepts: (event) =>
            isEventValid(event) && isImpAllowed(caller.imps, readEventImpName(event)),
        });
      }),
    },
    system: {
      info: os.system.info.handler(() => readSystemInfo(deps)),
      gc: os.system.gc.handler((context) =>
        deps.gc.runGc({
          isDryRun: context.input.dryRun ?? false,
          isOrphans: context.input.orphans ?? false,
        }),
      ),
      copyDatabase: os.system.copyDatabase.handler(async (context) => {
        const copy = await writeDatabaseCopy(
          deps.db,
          deps.diskBudget,
          deps.config.dataDir,
          context.input.name ?? buildCopyName(deps.now()),
          deps.now,
        );

        // in the contract's order, which a restore script's output follows
        return {
          path: copy.path,
          sizeBytes: copy.sizeBytes,
          lastMigration: copy.lastMigration,
          impVersion: packageJson.version,
          createdAt: copy.createdAt,
          integrity: copy.integrity,
        };
      }),
    },
    oauth: {
      clients: {
        list: os.oauth.clients.list.handler(() => deps.oauth.listClients()),
        add: os.oauth.clients.add.handler((context) =>
          deps.oauth.addClient(context.input.name, context.input.redirectUris),
        ),
        update: os.oauth.clients.update.handler((context) =>
          deps.oauth.updateClient(context.input.name, context.input.redirectUris),
        ),
        delete: os.oauth.clients.delete.handler(async (context) => {
          await deps.oauth.removeClient(context.input.name);

          return {};
        }),
      },
      grants: {
        list: os.oauth.grants.list.handler(() => deps.oauth.listGrants()),
        delete: os.oauth.grants.delete.handler(async (context) => {
          await deps.oauth.removeGrant(context.input.id);

          return {};
        }),
      },
      approvals: {
        get: os.oauth.approvals.get.handler((context) =>
          deps.oauth.readApproval(context.input.code, context.context.caller),
        ),
        approve: os.oauth.approvals.approve.handler((context) => {
          deps.oauth.approve(
            context.input.code,
            context.context.caller,
            context.input.scope,
            context.input.imps,
          );

          return {};
        }),
      },
    },
    tokens: {
      list: os.tokens.list.handler(() => deps.tokens.list()),
      create: os.tokens.create.handler((context) =>
        deps.tokens.create({
          name: context.input.name,
          scope: context.input.scope,
          imps: context.input.imps ?? null,
          sshKeys: context.input.sshKeys ?? [],
          grantable: context.input.grantable ?? [],
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

// what this impd can do; each session's `continuity` still decides whether
// its imp's agent counts output
const SYSTEM_FEATURES = {
  sessionOffsets: true,
  leases: true,
  grantableTokens: true,
  secretRebind: true,
  databaseCopy: true,
  imageBuildStream: true,
  imageOpStream: true,
  execRequire: true,
  oauthGrants: true,
} as const;

// imp-20261004-061233: a name's form, in UTC, to the second
function buildCopyName(now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 19).replaceAll(/[-:]/g, '').replace('T', '-');

  return `imp-${stamp}`;
}

// RAM used is measured (what awake Firecrackers own); committed is the memory
// the awake imps were given
// (docs/architecture/sleep-and-wake.md#the-ram-governor).
async function readSystemInfo(deps: RouterDeps): Promise<SystemInfo> {
  const [imps, usage, tailscale, storage, defaultImage] = await Promise.all([
    listImps(deps.db),
    deps.governor.readUsage(),
    deps.readTailscale(),
    deps.diskBudget.readStatus(),
    deps.images.findDefaultImage(),
  ]);

  const running = imps.filter((imp) => imp.state === 'running');
  const sleeping = imps.filter((imp) => imp.state === 'sleeping');

  return {
    version: packageJson.version,
    ramBudgetMib: deps.config.ramBudgetMib,
    ramUsedMib: usage.usedMib,
    ramReservedMib: usage.reservedMib,
    ramCommittedMib: running.reduce((sum, imp) => sum + imp.maxMemoryMib, 0),
    ramSleepingMib: sleeping.reduce((sum, imp) => sum + imp.memoryMib, 0),
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
    defaults: { memoryMib: deps.config.defaultMemoryMib, image: defaultImage?.name ?? null },
    egress: { isEnforced: deps.egress.isEnforced() },
    ksm: readKsmInfo(deps, running, usage.headroomMib),
    public: readPublicInfo(deps.config, imps, deps.publicRecords.readStatus()),
    https: await readHttpsInfo(deps),
    features: SYSTEM_FEATURES,
  };
}

function readPublicInfo(
  config: Config,
  imps: readonly ImpRecord[],
  records: RecordsStatus | null,
): SystemInfo['public'] {
  const ip = config.https?.public?.ip;

  if (ip === undefined) {
    return null;
  }

  return {
    ip,
    imps: imps.filter((imp) => imp.publicAuth !== null).length,
    records:
      records === null
        ? null
        : { isOk: records.isOk, error: records.error, at: new Date(records.at) },
  };
}

async function readHttpsInfo(deps: RouterDeps): Promise<SystemInfo['https']> {
  const domain = deps.config.https?.domain;

  if (domain === undefined) {
    return null;
  }

  const token = deps.checkDnsToken === null ? null : await deps.checkDnsToken();

  return {
    domain,
    dnsToken:
      token === null ? null : { isOk: token.isOk, error: token.error, at: new Date(token.at) },
  };
}

function readKsmInfo(
  deps: RouterDeps,
  running: readonly ImpRecord[],
  headroomMib: number,
): SystemInfo['ksm'] {
  const stats = deps.config.ksm === null ? null : (deps.readKsmHostStats ?? readKsmHostStats)();

  if (stats === null) {
    return null;
  }

  return {
    ...stats,
    headroomMib,
    unmergeable: running.filter((imp) => deps.imps.isUnmergeable(imp.id)).length,
  };
}

export function toApiImage(image: ImageRecord): Image {
  return {
    id: image.id,
    name: image.name,
    ref: image.ref,
    digest: image.digest,
    source: image.source,
    createdAt: image.createdAt,
    sizeBytes: image.sizeBytes,
  };
}

// an audit or lease list may name one imp, which must be the caller's
function requireNamedImp(
  caller: Readonly<Caller>,
  name: string | undefined,
  scope: Scope = 'read',
): void {
  if (name !== undefined && !isCallerAllowed(caller, scope, name)) {
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
