import { SYSTEM_FEATURES } from '@impz/api';
import type { SystemInfo } from '@impz/api';
import packageJson from '../package.json' with { type: 'json' };
import type { RouterDeps, RpcImplementer } from './build-router';
import type { Config } from './config';
import { writeDatabaseCopy } from './db/database-copy';
import { listImps } from './db/imps';
import type { ImpRecord } from './db/imps';
import type { RecordsStatus } from './https/https-service';
import { countBootStatuses } from './imps/boot-status';
import { readKsmHostStats } from './vmm/ksm';

// `system.*`: what the host runs and holds, its storage GC, and a copy of
// its database
// oxlint-disable-next-line prefer-readonly-parameter-types -- an oRPC implementer, a builder with no readonly form
export function buildSystemRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    info: os.system.info.handler(() => readSystemInfo(deps)),
    gc: os.system.gc.handler((context) =>
      deps.gc.runGc({
        isDryRun: context.input.dryRun ?? false,
        isOrphans: context.input.orphans ?? false,
        isSecretFiles: context.input.secretFiles ?? false,
        isRemoveSecretFiles: context.input.removeSecretFiles ?? false,
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
  };
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
    rebootReason: deps.imps.readRebootReason(),
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

// imp-20261004-061233: a name's form, in UTC, to the second
function buildCopyName(now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 19).replaceAll(/[-:]/g, '').replace('T', '-');

  return `imp-${stamp}`;
}
