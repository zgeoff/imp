import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createApiAudit } from './audit/api-audit';
import type { ApiAudit } from './audit/api-audit';
import { createKnownHosts } from './auth/ambient-request';
import { createRevocations } from './auth/revocations';
import { createTailnetIdentities, runWhois } from './auth/tailnet-identity';
import type { TailnetPeer } from './auth/tailnet-identity';
import { loadTokenStore } from './auth/token-store';
import { createBackupService } from './backup/backup-service';
import { createBroker } from './broker/broker-service';
import type { Broker, BrokerDeps } from './broker/broker-service';
import { createSecretFiles } from './broker/secret-files';
import type { SecretFiles } from './broker/secret-files';
import { buildApp } from './build-app';
import type { AppDeps } from './build-app';
import { createCheckpointService } from './checkpoints/checkpoint-service';
import type { DiskFreezer } from './checkpoints/consistent-disk';
import type { Config } from './config';
import { subscribeImpWrites } from './db/imp-write-feed';
import { countImpsByState } from './db/imps';
import { isImpSetWrite } from './db/is-imp-set-write';
import type { ImpDatabase } from './db/open-database';
import { runNft } from './egress/egress-firewall';
import { createEgressService } from './egress/egress-service';
import type { EgressDeps, EgressService } from './egress/egress-service';
import { createGovernedImps } from './governor/create-governed-imps';
import { createDnsToken } from './https/dns/dns-token';
import { createPublicRecordsLink } from './https/public-records-link';
import { createBuildContextRoute } from './images/build-context-route';
import { BUILD_KEEPALIVE_MS } from './images/build-event-stream';
import { createBuilders } from './images/builder-imps';
import type { Builders } from './images/builder-imps';
import { HOST_ADD_WARNING, HOST_BUILD_WARNING, createImageService } from './images/image-service';
import type { ImageService, ImageServiceDeps } from './images/image-service';
import { createTemplateService } from './images/template-service';
import type { ImpServiceDeps, Imps } from './imps/imp-service';
import { removeUnusedDrives } from './imps/remove-unused-drives';
import { createMoveService } from './moves/move-service';
import type { MoveServiceDeps } from './moves/move-service';
import {
  checkHostRules6,
  readIpv6DefaultRoute,
  readOrCreateUlaPrefix,
  resolveIpv6Plan,
} from './net/ipv6-plan';
import type { Ipv6Plan } from './net/ipv6-plan';
import { createStatusCache, readTailscaleStatus } from './net/tailscale-status';
import type { TailscaleStatus } from './net/tailscale-status';
import { createTapDevices } from './net/tap-devices';
import type { TapDevices } from './net/tap-devices';
import { createNetworkService } from './networks/network-service';
import { createOAuthService } from './oauth/oauth-service';
import { printLog } from './process/print-log';
import { runCommand } from './process/run-command';
import { createForwardedPeers } from './proxy/forwarded-peers';
import type { WakeProxy } from './proxy/wake-proxy';
import { UNKNOWN_VERSION, readHostIdentity } from './sleep/vm-identity';
import type { HostIdentity } from './sleep/vm-identity';
import { createAuthorizedKeys } from './ssh/authorized-keys';
import { setupSshDir } from './ssh/host-key';
import { createDiskBudget } from './storage/disk-budget';
import type { DiskBudget } from './storage/disk-budget';
import { CHANGES_USAGE, createDiskUsageCache } from './storage/disk-usage-cache';
import type { DiskUsageCache } from './storage/disk-usage-cache';
import { readLiveStorage } from './storage/read-live-storage';
import type { SystemFiles } from './storage/setup-system-files';
import type { StorageBackend } from './storage/storage-backend';
import { createStorageGate } from './storage/storage-gate';
import type { StorageGate } from './storage/storage-gate';
import { createStorageGc } from './storage/storage-gc';
import { buildTailnetNames } from './tailnet-names/build-tailnet-names';
import type { TailnetNames } from './tailnet-names/tailnet-names';
import { startImpTelemetry } from './telemetry/imp-telemetry';
import { createCpuCgroups } from './vmm/cpu-cgroups';
import type { CpuCgroups } from './vmm/cpu-cgroups';
import { createJails } from './vmm/jail';
import { createVmRunner } from './vmm/vm-runner';
import type { VmRunner } from './vmm/vm-runner';

// The broker's reach past impd: the guest's CA install, the token endpoint,
// the upstreams and the tunnels' DNS and dials
type BrokerBoundaries = Pick<
  BrokerDeps,
  | 'installBundle'
  | 'fetch'
  | 'oauthFetch'
  | 'now'
  | 'runOAuthTimer'
  | 'resolveTunnelTarget'
  | 'dialTunnel'
  | 'afterRuleRead'
>;

// The firewall's reach past impd: nft, conntrack, iptables, the routes and
// the upstream DNS
type EgressBoundaries = Pick<
  EgressDeps,
  | 'runNft'
  | 'readConnected6'
  | 'readConnected4'
  | 'readUplinks'
  | 'flushConnections'
  | 'flushPair'
  | 'readForwardRules'
  | 'forward'
  | 'resolveExact'
  | 'now'
  | 'repeat'
>;

// The imp service's reach past impd: /proc, KSM, the host's filesystem
// grow, the host's cores, the memory limit and the agent's session taps
type ImpBoundaries = Pick<
  ImpServiceDeps,
  | 'readRamMib'
  | 'readRssMib'
  | 'readUnsharedRamMib'
  | 'checkGuestMerge'
  | 'readKsmProfitMib'
  | 'growFilesystem'
  | 'hostCpus'
  | 'memoryLimit'
  | 'now'
  | 'openTap'
>;

// What impd reaches outside its own code: every field but the four
// required ones defaults to the host's real one, which main.ts uses. A test
// passes stand-ins only for what it cannot host.
export interface ImpdDeps {
  readonly db: ImpDatabase;

  // the token in <dataDir>/token
  readonly rootToken: string;

  // the backend over the data dir, not started (createStorageBackend)
  readonly storage: StorageBackend;

  // the kernel and system drive in the data dir (setupSystemFiles)
  readonly systemFiles: SystemFiles;

  readonly log?: (message: string) => void;

  // the API's unexpected RPC failures; stderr by default
  readonly logRpcFailure?: AppDeps['logRpcFailure'];

  // leases', the RAM governor's, egress's, the broker's injected and the
  // API services' clock; Date.now by default. project-testing names what
  // still reads Date.now itself
  readonly now?: () => number;

  // the host's free space as the disk budget sees it; the storage's own
  readonly readDiskSpace?: StorageBackend['readUsage'];

  // the host's IPv6 routes and rules, read into a plan for imps
  readonly resolveIpv6?: () => Promise<Ipv6Plan | null>;

  // tailscaled's status, and `tailscale whois`
  readonly readTailscale?: () => Promise<TailscaleStatus>;
  readonly whois?: (address: string) => Promise<TailnetPeer | null>;

  // the cgroup tree; /sys/fs/cgroup by default
  readonly cgroups?: CpuCgroups;

  // what this host boots imps with: Firecracker's versions, the CPU, the
  // kernel and the system drive
  readonly readIdentity?: (
    systemFiles: Readonly<SystemFiles>,
    ipv6Prefix: string | null,
  ) => HostIdentity;

  // Firecracker and the jailer; `runCommand` runs the jailer's mount and
  // chown when `vms` is left out
  readonly vms?: VmRunner;
  readonly runCommand?: typeof runCommand;

  // `ip` for each imp's tap
  readonly taps?: TapDevices;
  readonly broker?: BrokerBoundaries;
  readonly egress?: EgressBoundaries;
  readonly imps?: ImpBoundaries;

  // the docker engine a host build talks to
  readonly images?: Pick<ImageServiceDeps, 'dockerEnv' | 'builderImagePullMs'>;

  // fsfreeze inside the guest, around a checkpoint or a template's disk
  readonly freezer?: DiskFreezer;

  // signs each OAuth sign-in's id; drawn at random by default
  readonly oauthKey?: Buffer;
}

// What the storage services need, and the data dir's backend
export interface ImpdStorage {
  readonly storageGate: StorageGate;
  readonly diskBudget: DiskBudget;

  // the builders, once the imps they run as exist
  readonly setBuilders: (builders: Builders) => void;
  readonly images: ImageService;
  readonly diskUsage: DiskUsageCache;
}

// The storage gate, the disk budget, the images and the usage cache
export function buildImpdStorage(config: Config, deps: Readonly<ImpdDeps>): ImpdStorage {
  const log = deps.log ?? printLog;
  const storage = deps.storage;

  // every operation that makes storage before its row joins it; the GC waits
  const storageGate = createStorageGate();
  const zfsCommitDelayMs = config.storageBackend === 'zfs' ? 20_000 : 0;

  const diskBudget = createDiskBudget({
    storage: deps.readDiskSpace === undefined ? storage : { readUsage: deps.readDiskSpace },
    reserveBytes: config.diskReserveBytes,
    releaseDelayMs: zfsCommitDelayMs,
    log,
  });

  // the image builders need the imps, which need the images
  const buildersHolder: { builders: Builders | null } = { builders: null };

  const images = createImageService({
    config,
    db: deps.db,
    storage,
    storageGate,
    diskBudget,
    readBuilders: () => buildersHolder.builders,
    log,
    ...deps.images,
  });

  const diskUsage = createDiskUsageCache({ db: deps.db, storage, log });

  return {
    storageGate,
    diskBudget,
    setBuilders: (builders) => {
      buildersHolder.builders = builders;
    },
    images,
    diskUsage,
  };
}

// The credential broker, with the secret files it shares with the GC
export function createImpdBroker(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<{ ipv6: Ipv6Plan | null; secretFiles: SecretFiles }>,
): Promise<Broker> {
  return createBroker({
    config,
    db: deps.db,
    log: deps.log ?? printLog,
    ipv6: parts.ipv6,
    secretFiles: parts.secretFiles,
    ...(deps.now !== undefined && { now: deps.now }),
    ...deps.broker,
  });
}

// The firewall and its resolver, not started
export function buildImpdEgress(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<{
    ipv6: Ipv6Plan | null;
    broker: Pick<Broker, 'isGranted' | 'closeTunnels'>;
  }>,
): EgressService {
  return createEgressService({
    config,
    db: deps.db,
    ipv6: parts.ipv6,
    log: deps.log ?? printLog,
    isGranted: parts.broker.isGranted,
    closeTunnels: parts.broker.closeTunnels,
    ...(deps.now !== undefined && { now: deps.now }),
    ...deps.egress,
  });
}

export interface GovernedParts {
  readonly storage: ImpdStorage;
  readonly broker: Pick<Broker, 'readExecEnv'>;
  readonly egress: EgressService;
  readonly ipv6: Ipv6Plan | null;
  readonly cgroups: CpuCgroups;
  readonly readServiceUrl: (name: string) => string | null;
  readonly readTailscale: () => Promise<TailscaleStatus>;
}

// The imp service with its RAM governor and memory controller. A restart
// calls it again with a new runner, over the same database and storage.
export function startGovernedImps(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<GovernedParts>,
  identity: Readonly<HostIdentity>,
  vms: VmRunner,
): ReturnType<typeof createGovernedImps> {
  return createGovernedImps({
    cgroups: parts.cgroups,

    // each VM's memory.max follows what its elastic guest holds
    memoryLimit: parts.cgroups,
    config,
    db: deps.db,
    images: parts.storage.images,
    taps: deps.taps ?? createTapDevices(),
    vms,
    storage: deps.storage,
    identity,
    ipv6: parts.ipv6,
    log: deps.log ?? printLog,
    readExecEnv: parts.broker.readExecEnv,
    storageGate: parts.storage.storageGate,
    diskBudget: parts.storage.diskBudget,
    readDiskUsage: parts.storage.diskUsage.read,
    egress: parts.egress,
    readServiceUrl: parts.readServiceUrl,
    readTailnetHostname: async () => {
      const status = await parts.readTailscale();

      return status.hostname;
    },
    ...(deps.now !== undefined && { now: deps.now }),
    ...deps.imps,
  });
}

// The image builders, which run as imps
export function startImpdBuilders(
  config: Config,
  deps: Readonly<ImpdDeps>,
  storage: Readonly<ImpdStorage>,
  imps: Readonly<Imps>,
): Builders {
  const builders = createBuilders({
    config,
    db: deps.db,
    imps,
    ensureImage: storage.images.ensureBuilderImage,
    log: deps.log ?? printLog,
  });

  storage.setBuilders(builders);

  return builders;
}

// The API tokens, their revocations and the OAuth grants on top of them
export async function loadImpdAccess(
  config: Config,
  deps: Readonly<ImpdDeps>,
  isFileKey: (blob: Buffer) => boolean,
) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? printLog;
  const revocations = createRevocations();

  const tokens = await loadTokenStore({
    db: deps.db,
    rootToken: deps.rootToken,
    now,
    onRemove: revocations.revoke,
    isFileKey,
  });

  const oauth = createOAuthService({
    db: deps.db,
    tokens,
    revocations,
    config: config.publicMcp,
    now,
    log,
    key: deps.oauthKey ?? randomBytes(32),
  });

  return { revocations, tokens, oauth };
}

type ImpdAccess = Readonly<Awaited<ReturnType<typeof loadImpdAccess>>>;

// The services over the imps that the API serves
export function buildImpdServices(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<{
    storage: Pick<ImpdStorage, 'storageGate' | 'diskBudget'>;
    imps: Imps;
    egress: EgressService;
    secretFiles: SecretFiles;
  }>,
) {
  const db = deps.db;
  const log = deps.log ?? printLog;
  const storage = deps.storage;
  const freezer = deps.freezer === undefined ? {} : { freezer: deps.freezer };

  const checkpoints = createCheckpointService({
    config,
    db,
    imps: parts.imps,
    storage,
    diskBudget: parts.storage.diskBudget,
    log,
    ...freezer,
  });

  const templates = createTemplateService({
    config,
    db,
    imps: parts.imps,
    storage,
    storageGate: parts.storage.storageGate,
    diskBudget: parts.storage.diskBudget,
    log,
    ...freezer,
  });

  const networks = createNetworkService({ db, egress: parts.egress, imps: parts.imps });

  const gc = createStorageGc({
    db,
    storage,
    storageGate: parts.storage.storageGate,
    log,
    secretFiles: parts.secretFiles,
  });

  const audit = createApiAudit({ db, now: deps.now ?? Date.now, log });

  return { checkpoints, templates, networks, gc, audit };
}

type ImpdServices = Readonly<ReturnType<typeof buildImpdServices>>;

// The moves to and from other hosts
export function createImpdMoves(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<{
    storage: Pick<ImpdStorage, 'storageGate' | 'diskBudget'>;
    imps: Imps;
    broker: MoveServiceDeps['grants'];
    egress: EgressService;
    audit: ApiAudit;
    readIdentity: () => HostIdentity;
  }>,
  hooks: Readonly<
    Pick<MoveServiceDeps, 'readTailnetIp' | 'releaseName' | 'onCommitted'> &
      Partial<Pick<MoveServiceDeps, 'fetch' | 'partBytes' | 'readWarmHost' | 'readTapMac'>>
  >,
) {
  return createMoveService({
    audit: parts.audit,
    config,
    db: deps.db,
    dataDir: config.dataDir,
    storage: deps.storage,
    storageGate: parts.storage.storageGate,
    diskBudget: parts.storage.diskBudget,
    imps: parts.imps,
    grants: parts.broker,
    egress: parts.egress,
    readIdentity: parts.readIdentity,
    ...hooks,
    now: deps.now ?? Date.now,
    log: deps.log ?? printLog,
  });
}

// tailnet identity, when IMP_TAILNET_IDENTITIES has rules; both ask about
// the node on every request, so they share one cached status
function buildTailnetAccess(
  config: Config,
  deps: Readonly<Pick<ImpdDeps, 'now' | 'whois'>>,
  readStatus: () => Promise<TailscaleStatus>,
): AppDeps['tailnet'] {
  if (config.tailnetRules === null) {
    return null;
  }

  const now = deps.now ?? Date.now;
  const readTailscale = createStatusCache(readStatus, now);

  return {
    identities: createTailnetIdentities({
      rules: config.tailnetRules,
      whois: deps.whois ?? runWhois,
      readTailscale,
      now,
    }),
    knownHosts: createKnownHosts({
      readTailscale,
      domain: config.https?.domain ?? null,
    }),
  };
}

export interface ImpdAppParts {
  readonly storage: Pick<ImpdStorage, 'images' | 'diskBudget'>;
  readonly access: ImpdAccess;
  readonly services: ImpdServices;
  readonly imps: Imps;
  readonly governor: AppDeps['governor'];
  readonly broker: Broker;
  readonly egress: EgressService;
  readonly identity: HostIdentity;
  readonly peers: AppDeps['peers'];
  readonly tailnet: AppDeps['tailnet'];
  readonly backups: AppDeps['backups'];
  readonly moves: AppDeps['moves'];
  readonly publicRecords: AppDeps['publicRecords'];
  readonly checkDnsToken: AppDeps['checkDnsToken'];
  readonly readTailscale: () => Promise<TailscaleStatus>;
  readonly readTailnetNames: AppDeps['readTailnetNames'];
  readonly isReady: () => boolean;

  // the gap between the progress events of a streamed image call
  readonly keepaliveMs?: number;
  readonly readKsmHostStats?: AppDeps['readKsmHostStats'];
}

// impd's HTTP app: the RPC API, exec, tunnels, the dashboard and MCP
export function buildImpdApp(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<ImpdAppParts>,
) {
  const now = deps.now ?? Date.now;
  const keepaliveMs = parts.keepaliveMs ?? BUILD_KEEPALIVE_MS;

  return buildApp({
    config,
    db: deps.db,
    rootToken: deps.rootToken,
    tokens: parts.access.tokens,
    revocations: parts.access.revocations,
    oauth: parts.access.oauth,
    peers: parts.peers,
    tailnet: parts.tailnet,
    imps: parts.imps,
    images: parts.storage.images,
    governor: parts.governor,
    ...(parts.readKsmHostStats !== undefined && { readKsmHostStats: parts.readKsmHostStats }),
    checkpoints: parts.services.checkpoints,
    templates: parts.services.templates,
    backups: parts.backups,
    broker: parts.broker,
    egress: parts.egress,
    networks: parts.services.networks,
    firecrackerVersion:
      parts.identity.firecrackerVersion === UNKNOWN_VERSION
        ? null
        : parts.identity.firecrackerVersion,
    systemFiles: deps.systemFiles.info,
    storage: deps.storage,
    diskBudget: parts.storage.diskBudget,
    gc: parts.services.gc,
    readTailscale: parts.readTailscale,
    readTailnetNames: parts.readTailnetNames,
    publicRecords: parts.publicRecords,
    checkDnsToken: parts.checkDnsToken,
    isReady: parts.isReady,
    now,
    log: deps.log ?? printLog,
    ...(deps.logRpcFailure !== undefined && { logRpcFailure: deps.logRpcFailure }),
    audit: parts.services.audit,
    buildContexts: createBuildContextRoute({
      config,
      images: parts.storage.images,
      diskBudget: parts.storage.diskBudget,
      audit: parts.services.audit,
      now,
      keepaliveMs,
    }),
    imageKeepaliveMs: keepaliveMs,
    moves: parts.moves,
  });
}

// Every impd service, wired and started as a host runs them: storage
// mounted, the firewall up, the VMs re-adopted and leftovers removed.
// main.ts opens the ports, starts the tickers and owns the stop.
export async function createImpd(config: Config, deps: Readonly<ImpdDeps>) {
  const db = deps.db;
  const storage = deps.storage;
  const systemFiles = deps.systemFiles;
  const log = deps.log ?? printLog;
  const now = deps.now ?? Date.now;

  // before any VM is re-adopted or woken: on ZFS the disks are mounted here
  const live = await readLiveStorage(db);

  await storage.start(live);

  const stored = buildImpdStorage(config, deps);
  const diskUsage = stored.diskUsage;

  if (config.build.isolation === 'host') {
    log(HOST_BUILD_WARNING);
    log(HOST_ADD_WARNING);
  }

  const ipv6 = await (
    deps.resolveIpv6 ??
    (() =>
      resolveIpv6Plan(config.ipv6, {
        readDefaultRoute: readIpv6DefaultRoute,
        readUlaPrefix: () => readOrCreateUlaPrefix(join(config.dataDir, 'net', 'ipv6-ula')),
        checkHostRules: () => checkHostRules6(),
        runNft: deps.egress?.runNft ?? runNft,
        log,
      }))
  )();

  // the broker's and the GC's: the GC lists and removes what the broker kept aside
  const secretFiles = createSecretFiles(config.dataDir);

  const broker = await createImpdBroker(config, deps, { ipv6, secretFiles });

  // the firewall and its resolver, before any VM is adopted, booted or woken
  const egress = buildImpdEgress(config, deps, { ipv6, broker });

  await egress.start();

  const proxyHolder: { proxy: WakeProxy | null } = { proxy: null };
  const publicRecords = createPublicRecordsLink();
  const dnsTokenSource = config.https?.dns.token ?? null;
  const dnsToken = dnsTokenSource === null ? null : createDnsToken(dnsTokenSource, now);
  const namesHolder: { names: TailnetNames | null } = { names: null };
  const readTailscale = deps.readTailscale ?? (() => readTailscaleStatus(config.tailscaleEnabled));
  const cgroups = deps.cgroups ?? createCpuCgroups({ root: '/sys/fs/cgroup', log });

  if (!cgroups.isEnforced) {
    const effect =
      config.jailerBin === null
        ? 'CPU limits are kept, not applied'
        : 'no jailed VM can start (IMP_JAILER=false runs them unjailed, with no limits)';

    log(`impd: no cpu controller under /sys/fs/cgroup/imps; ${effect}`);
  }

  // spawns Firecracker once per version flag; system.info reuses it
  const identity = (
    deps.readIdentity ?? ((files, prefix) => readHostIdentity(config.firecrackerBin, files, prefix))
  )(systemFiles, ipv6?.prefix.text ?? null);

  // even with the jailer off, impd cleans up after jailed VMs it adopted
  const vms =
    deps.vms ??
    createVmRunner(
      createJails({
        jailerBin: config.jailerBin ?? 'jailer',
        firecrackerBin: Bun.which(config.firecrackerBin) ?? config.firecrackerBin,
        chrootBase: config.jailDir,
        run: deps.runCommand ?? runCommand,
        log,
        killCgroup: cgroups.kill,
      }),
      config.ksm?.execBin ?? null,
    );

  const governed = startGovernedImps(
    config,
    deps,
    {
      storage: stored,
      broker,
      egress,
      ipv6,
      cgroups,
      readServiceUrl: (name) => namesHolder.names?.readUrl(name) ?? null,
      readTailscale,
    },
    identity,
    vms,
  );

  const imps = governed.imps;
  const governor = governed.governor;

  startImpTelemetry({
    bus: imps.events,
    subscribeResources: imps.subscribeResources,
    readDiskUsedBytes: diskUsage.readExclusiveTotal,
    readStateCounts: () => countImpsByState(db),
    readRam: async () => {
      const usage = await governor.readUsage();

      return { usedMib: usage.usedMib, budgetMib: config.ramBudgetMib };
    },
  });

  // an imp that comes or goes opens or closes its proxy port and its grants
  subscribeImpWrites(db, (write) => {
    // storage comes or goes with an imp or a checkpoint, and changes when
    // its disk grows or a stop or sleep writes it out
    if (write.kind !== 'changed' || CHANGES_USAGE.has(write.reason)) {
      diskUsage.requestRefresh();
    }

    if (isImpSetWrite(write)) {
      void proxyHolder.proxy?.syncListeners();
      void broker.applyGrants();
      void namesHolder.names?.runSync();
    }
  });

  await imps.reconcileImps();

  const builders = startImpdBuilders(config, deps, stored, imps);

  // a build that a stop cut short left its builder
  await builders.removeLeftovers();

  // templates this host no longer boots go first, so their drives can too
  for (const key of imps.bootTemplates?.removeStale() ?? []) {
    log(`impd: removed boot template ${key.slice(0, 12)}: this host boots something else`);
  }

  // before anything can boot or sleep an imp, so the set of drives in use holds
  const removed = await removeUnusedDrives(
    db,
    config.dataDir,
    storage.resolveImpPaths,
    systemFiles.systemDrivePath,
    imps.bootTemplates?.listDrivePaths() ?? [],
  );

  for (const name of removed) {
    log(`impd: removed system drive ${name}: no imp uses it`);
  }

  const services = buildImpdServices(config, deps, {
    storage: stored,
    imps,
    egress,
    secretFiles,
  });

  const backups =
    config.backup === null
      ? null
      : createBackupService({
          dataDir: config.dataDir,
          backup: config.backup,
          db,
          imps,
          storage,
          grants: broker,
          networks: services.networks,
          storageGate: stored.storageGate,
          diskBudget: stored.diskBudget,
        });

  const state = { ready: false };

  // a key in this file cannot be bound to a token, so the gateway and the
  // token store read the same one
  const authorizedKeys = createAuthorizedKeys(
    join(setupSshDir(config.dataDir), 'authorized_keys'),
    log,
  );

  const access = await loadImpdAccess(config, deps, authorizedKeys.isListed);

  const peers = createForwardedPeers(now);

  const tailnetNames =
    config.tailnetNames === null
      ? null
      : buildTailnetNames({
          names: config.tailnetNames,
          config,
          db,
          imps,
          readTailscale,
          log,
        });

  namesHolder.names = tailnetNames;

  const moves = createImpdMoves(
    config,
    deps,
    {
      storage: stored,
      imps,
      broker,
      egress,
      audit: services.audit,
      readIdentity: () => identity,
    },
    {
      readTailnetIp: async () => {
        const status = await readTailscale();

        return status.ip;
      },
      releaseName: async () => {
        await tailnetNames?.runSync();
      },

      // the received disk counts here now; the source's ImpRemoved counts there
      onCommitted: () => {
        diskUsage.requestRefresh();
        void tailnetNames?.runSync();
      },
    },
  );

  await moves.recover();

  const api = buildImpdApp(config, deps, {
    storage: stored,
    access,
    services,
    imps,
    governor,
    broker,
    egress,
    identity,
    peers,
    tailnet: buildTailnetAccess(config, deps, readTailscale),
    backups,
    moves,
    publicRecords,
    checkDnsToken: dnsToken?.check ?? null,
    readTailscale,
    readTailnetNames: tailnetNames === null ? null : tailnetNames.readStatus,
    isReady: () => state.ready,
  });

  return {
    ...stored,
    ...access,
    ...services,
    governed,
    imps,
    governor,
    broker,
    egress,
    backups,
    authorizedKeys,
    peers,
    tailnetNames,
    moves,
    api,
    proxyHolder,
    publicRecords,
    dnsToken,
    readTailscale,
    state,
  };
}
