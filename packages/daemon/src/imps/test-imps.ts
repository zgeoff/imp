import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import type { ImpContract } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createApiAudit } from '../audit/api-audit';
import { createRevocations } from '../auth/revocations';
import { loadTokenStore } from '../auth/token-store';
import { createBroker } from '../broker/broker-service';
import type { InstallBundle } from '../broker/guest-trust';
import { TunnelRefusedError } from '../broker/tunnel-target';
import { buildApp } from '../build-app';
import type { AppDeps } from '../build-app';
import { createCheckpointService } from '../checkpoints/checkpoint-service';
import { loadConfig } from '../config';
import type { Config } from '../config';
import { createImage } from '../db/images';
import type { ImageRecord } from '../db/images';
import { listImps } from '../db/imps';
import { openDatabase } from '../db/open-database';
import type { ImpDatabase } from '../db/open-database';
import { createEgressService } from '../egress/egress-service';
import { createGovernedImps } from '../governor/create-governed-imps';
import { createPublicRecordsLink } from '../https/public-records-link';
import { createBuildContextRoute } from '../images/build-context-route';
import { createImageService } from '../images/image-service';
import { createTemplateService } from '../images/template-service';
import { createMoveService } from '../moves/move-service';
import type { MoveServiceDeps } from '../moves/move-service';
import type { Ipv6Plan } from '../net/ipv6-plan';
import { createNetworkService } from '../networks/network-service';
import { createForwardedPeers } from '../proxy/forwarded-peers';
import { hasSnapshot, writeSnapshotMeta } from '../sleep/snapshot-meta';
import type { SnapshotIdentity } from '../sleep/snapshot-meta';
import type { HostIdentity } from '../sleep/vm-identity';
import { buildImpPaths, buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import type { ImpPaths } from '../storage/data-layout';
import { createDiskBudget } from '../storage/disk-budget';
import type { StorageBackend } from '../storage/storage-backend';
import { createStorageGate } from '../storage/storage-gate';
import { createStorageGc } from '../storage/storage-gc';
import { createXfsBackend } from '../storage/xfs-backend';
import type { CpuCgroups } from '../vmm/cpu-cgroups';
import { buildFakeVmm } from './fake-vmm';
import type { ImpService } from './imp-service';

export const TEST_TOKEN = 'test-token';

// what system.info reports about the guest kernel and the system drive
export const TEST_SYSTEM_FILES = {
  guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
  systemDrive: { sha256: 'b'.repeat(64) },
};

// every awake fake VM owns this much, as the governor measures it
const FAKE_VM_RAM_MIB = 300;
const FAKE_VM_RSS_MIB = 340;

// the sha256 of the system drive every test impd starts with
const TEST_DRIVE = 'd1'.repeat(32);

// what a host with `drive` installed in `dataDir` boots imps with
function buildTestIdentity(dataDir: string, drive: string): HostIdentity {
  return {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: drive,
    systemDrivePath: buildSystemDrivePath(dataDir, drive),
  };
}

interface ImpTestOptions {
  readonly env?: Readonly<Record<string, string>>;

  // a plain copy by default: the test tmpdir is not XFS
  readonly cloneDisk?: (source: string, target: string) => Promise<void>;

  // sees each log line as impd writes it
  readonly onLog?: (message: string) => void;

  // the broker's CA install into a guest; by default it records the imp's
  // vsock path and succeeds
  readonly installBundle?: InstallBundle;

  // where the broker's plain tunnels dial, in place of DNS and its checks;
  // by default a tunnel is refused, so no test reaches the network
  readonly resolveTunnelTarget?: (host: string) => Promise<string>;
  readonly dialTunnel?: (address: string, port: number) => Socket;

  // nft in place of the real one; by default it records each script
  readonly runNft?: (script: string) => Promise<void>;

  // what `iptables -S FORWARD` prints; setup-net's rules by default
  readonly forwardRules?: string;

  // each imp's tailnet name as a URL; none by default
  readonly readServiceUrl?: (name: string) => string | null;

  // the clock's start; it moves only with `advance` then, for a test that
  // divides by elapsed time
  readonly frozenClockMs?: number;

  // the storage backend over the data dir; XFS on plain files by default
  readonly createStorage?: (dataDir: string) => StorageBackend;

  // CPU limits: none enforced, and 8 cores, by default
  readonly cgroups?: CpuCgroups;
  readonly hostCpus?: number;

  // IPv6 for imps, as impd resolved it; none by default
  readonly ipv6?: Ipv6Plan;
}

// The governed imp service over an in-memory database, fake VMs and taps, in
// a fresh data dir. `restartImpd` starts a new impd on the same database, data
// dir and VMs, as a restart would; given an identity, as an upgrade would.
export async function setupImpTest(options: ImpTestOptions = {}) {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-test-`);

  const db = await openDatabase(':memory:');

  // a new disk stays the size of its image: the fake clone copies every byte
  const config: Config = {
    ...loadConfig({ IMP_DATA_DIR: dataDir, IMP_BOOT_TEMPLATES: 'false', ...options.env }),
    defaultDiskBytes: 0,
  };

  const fake = buildFakeVmm();
  const taps: string[] = [];
  const logs: string[] = [];

  // disks whose filesystem the host grew; the test disks hold no ext4
  const filesystemGrows: string[] = [];

  // the clock for holds and reservations; a test moves it with `advance`
  const clock = { offsetMs: 0 };
  const frozenAt = options.frozenClockMs;
  const readClock = () => (frozenAt ?? Date.now()) + clock.offsetMs;

  const cloneDisk =
    options.cloneDisk ??
    ((source: string, target: string) => {
      copyFileSync(source, target);

      return Promise.resolve();
    });

  const storage =
    options.createStorage?.(dataDir) ?? createXfsBackend({ dataDir, cloneFile: cloneDisk });

  const storageGate = createStorageGate();

  // the host's free space as the budget sees it; a test lowers it
  const diskUsage = { usedBytes: 0, availableBytes: 1024 ** 4 };

  const diskBudget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve({ ...diskUsage }) },
    reserveBytes: null,
    log: () => {},
  });

  const images = createImageService({ config, db, storage, storageGate, diskBudget });

  const printTestLog = (message: string): void => {
    logs.push(message);
    options.onLog?.(message);
  };

  // the vsock paths the broker installed its CA through
  const bundleInstalls: string[] = [];

  const broker = await createBroker({
    config,
    db,
    log: printTestLog,
    installBundle:
      options.installBundle ??
      ((vsockPath) => {
        bundleInstalls.push(vsockPath);

        return Promise.resolve();
      }),
    resolveTunnelTarget:
      options.resolveTunnelTarget ??
      ((host) => Promise.reject(new TunnelRefusedError(`${host}: no network in tests`))),
    ...(options.dialTunnel !== undefined && { dialTunnel: options.dialTunnel }),
  });

  // every nft script and conntrack flush the egress firewall ran
  const nftScripts: string[] = [];
  const flushed: string[] = [];
  const flushedPairs: string[] = [];

  const egress = createEgressService({
    config,
    db,
    log: printTestLog,
    isGranted: broker.isGranted,
    closeTunnels: broker.closeTunnels,
    runNft:
      options.runNft ??
      ((script) => {
        nftScripts.push(script);

        return Promise.resolve();
      }),
    flushConnections: (guestIp) => {
      flushed.push(guestIp);

      return Promise.resolve();
    },
    readForwardRules: () =>
      Promise.resolve(
        options.forwardRules ??
          '-A FORWARD -i imp+ -o imp+ -m mark --mark 0x1000000/0x1000000 -m comment --comment imp-network -j ACCEPT\n',
      ),
    flushPair: (first, second) => {
      flushedPairs.push(`${first} ${second}`);

      return Promise.resolve();
    },
    forward: () => Promise.reject(new Error('no upstream in tests')),
    resolveExact: () => Promise.resolve([]),
    now: readClock,
    ipv6: options.ipv6 ?? null,
    readConnected6: () => Promise.resolve(['2001:db8:a::/64']),
  });

  // a system drive file, as setupSystemFiles installs it
  const createSystemDrive = (drive: string): HostIdentity => {
    const identity = buildTestIdentity(dataDir, drive);

    mkdirSync(buildSystemDrivesDir(dataDir), { recursive: true });
    writeFileSync(identity.systemDrivePath, drive);

    return identity;
  };

  const host = { identity: createSystemDrive(TEST_DRIVE) };

  const startImpd = (identity: HostIdentity = host.identity) => {
    host.identity = identity;

    return createGovernedImps({
      config,
      identity,
      readRamMib: (pid) => (fake.alive.has(pid) ? FAKE_VM_RAM_MIB : null),
      readRssMib: (pid) => (fake.alive.has(pid) ? FAKE_VM_RSS_MIB : null),
      db,
      images,
      vms: fake.startGeneration(),
      taps: {
        setupTap: (address) => {
          taps.push(address.tap);

          return Promise.resolve();
        },
        removeTap: () => Promise.resolve(),
      },
      log: printTestLog,
      storage,
      now: readClock,
      readExecEnv: broker.readExecEnv,
      storageGate,
      diskBudget,
      growFilesystem: (disk) => {
        filesystemGrows.push(disk);

        return Promise.resolve(true);
      },
      egress,
      ipv6: options.ipv6 ?? null,
      ...(options.readServiceUrl !== undefined && { readServiceUrl: options.readServiceUrl }),
      hostCpus: options.hostCpus ?? 8,
      ...(options.cgroups !== undefined && { cgroups: options.cgroups }),
    });
  };

  const governed = startImpd();
  const revocations = createRevocations();

  const tokens = await loadTokenStore({
    db,
    rootToken: TEST_TOKEN,
    now: readClock,
    onRemove: revocations.revoke,
    isFileKey: () => false,
  });

  // an image row whose rootfs is a small file in the data dir
  const createTestImage = async (name: string): Promise<ImageRecord> => {
    await Bun.write(`${dataDir}/images/${name}/rootfs.ext4`, 'rootfs');

    return createImage(db, { name, ref: `${name}:latest`, digest: `sha256:${name}`, sizeBytes: 6 });
  };

  return {
    config,
    db,
    dataDir,
    images,
    fake,
    taps,
    logs,
    log: printTestLog,
    filesystemGrows,
    imps: governed.imps,
    governor: governed.governor,
    broker,
    egress,
    nftScripts,
    flushed,
    flushedPairs,
    bundleInstalls,
    storage,
    storageGate,
    diskBudget,
    diskUsage,
    tokens,
    revocations,
    now: readClock,
    advance: (ms: number) => {
      clock.offsetMs += ms;
    },
    restartImpd: startImpd,
    createSystemDrive,
    readIdentity: () => host.identity,
    createTestImage,
    async [Symbol.asyncDispose]() {
      fake.releaseHangs();

      await broker.stop();
      await db.destroy();

      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export type ImpTest = Awaited<ReturnType<typeof setupImpTest>>;

type Impd = ReturnType<ImpTest['restartImpd']>;

type AppParts = Pick<
  ImpTest,
  | 'config'
  | 'db'
  | 'images'
  | 'storage'
  | 'storageGate'
  | 'diskBudget'
  | 'now'
  | 'log'
  | 'broker'
  | 'tokens'
  | 'revocations'
  | 'egress'
>;

// The HTTP app over `impd` (the harness's or a restarted one), an oRPC client
// that calls it without a socket, a no-op freeze and thaw, and `openExec` in
// place of the guest agent, which the fake VMs do not run.
export function buildTestApp(
  ctx: Readonly<AppParts>,
  impd: Readonly<Impd>,
  token = TEST_TOKEN,

  // a fake agent's streams in place of the VM's
  agent: Partial<Pick<ImpService, 'openExec' | 'openAttach'>> = {},

  // tailnet identity, off by default
  tailnet: AppDeps['tailnet'] = null,

  // a move test's fetch to the other host, and its hooks
  moveOptions: Partial<Pick<MoveServiceDeps, 'fetch' | 'releaseName' | 'onCommitted'>> = {},
) {
  const imps: ImpService = { ...impd.imps, ...agent };

  const checkpoints = createCheckpointService({
    config: ctx.config,
    db: ctx.db,
    imps: impd.imps,
    storage: ctx.storage,
    diskBudget: ctx.diskBudget,
    log: () => {},
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  const templates = createTemplateService({
    config: ctx.config,
    db: ctx.db,
    imps: impd.imps,
    storage: ctx.storage,
    storageGate: ctx.storageGate,
    diskBudget: ctx.diskBudget,
    log: () => {},
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  const peers = createForwardedPeers(ctx.now);
  const audit = createApiAudit({ db: ctx.db, now: ctx.now, log: () => {} });

  const buildContexts = createBuildContextRoute({
    config: ctx.config,
    images: ctx.images,
    diskBudget: ctx.diskBudget,
    audit,
    now: ctx.now,
  });

  const moves = createMoveService({
    config: ctx.config,
    db: ctx.db,
    dataDir: ctx.config.dataDir,
    storage: ctx.storage,
    storageGate: ctx.storageGate,
    diskBudget: ctx.diskBudget,
    imps: impd.imps,
    grants: ctx.broker,
    egress: ctx.egress,
    readTailnetIp: () => Promise.resolve(null),
    releaseName: () => Promise.resolve(),
    onCommitted: () => {},
    ...moveOptions,
    now: ctx.now,
    log: () => {},
  });

  const built = buildApp({
    config: ctx.config,
    db: ctx.db,
    rootToken: TEST_TOKEN,
    tokens: ctx.tokens,
    revocations: ctx.revocations,
    peers,
    tailnet,
    imps,
    images: ctx.images,
    governor: impd.governor,
    checkpoints,
    templates,
    backups: null,
    broker: ctx.broker,
    egress: ctx.egress,
    networks: createNetworkService({ db: ctx.db, egress: ctx.egress }),
    firecrackerVersion: 'v1.17.0',
    systemFiles: TEST_SYSTEM_FILES,
    storage: ctx.storage,
    diskBudget: ctx.diskBudget,
    gc: createStorageGc({
      db: ctx.db,
      storage: ctx.storage,
      storageGate: ctx.storageGate,
      log: () => {},
    }),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    readTailnetNames: null,
    publicRecords: createPublicRecordsLink(),
    isReady: () => true,
    now: ctx.now,
    log: ctx.log,
    audit,
    buildContexts,
    moves,
  });

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: `Bearer ${token}` },
    fetch: (request) => built.app.handle(request),
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(link);

  return { app: built.app, closeExecSessions: built.closeExecSessions, client, peers, moves };
}

// a memory snapshot as a sleep at `createdAt` by a VM with `identity`
// leaves it
export function writeTestSnapshot(
  paths: Readonly<ImpPaths>,
  createdAt: number,
  identity: Readonly<SnapshotIdentity>,
): void {
  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.vmstate, 'vmstate');
  writeFileSync(paths.memFile, 'mem');

  writeSnapshotMeta(paths, {
    ...identity,
    createdAt,
    memoryMib: 2048,
    ramMib: FAKE_VM_RAM_MIB,
  });
}

interface InvariantParts {
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly fake: {
    readonly alive: ReadonlySet<number>;
    readonly usedSnapshots: ReadonlySet<string>;
  };
}

// What is wrong with the records once all work stopped, read raw: a service
// read repairs a dead VM or a lost snapshot and would hide the bug. Until
// `livenessRan`, a running record may still name a VM that died.
export async function findBrokenInvariants(
  ctx: Readonly<InvariantParts>,
  livenessRan: boolean,
): Promise<string[]> {
  const imps = await listImps(ctx.db);

  const broken: string[] = [];

  const owned = new Set<number>();

  for (const imp of imps) {
    const where = `${imp.name} (${imp.state})`;

    if (imp.state === 'creating') {
      broken.push(`${where}: still creating`);
    }

    // an error record keeps the pid of a VM that would not stop, to retry
    if (imp.state === 'error' && imp.pid !== null) {
      owned.add(imp.pid);
    } else if (imp.state !== 'running' && imp.pid !== null) {
      broken.push(`${where}: keeps pid ${String(imp.pid)}`);
    }

    const paths = buildImpPaths(ctx.dataDir, imp.id);

    if (imp.state === 'sleeping' && !hasSnapshot(paths)) {
      broken.push(`${where}: no snapshot to wake from`);
    }

    if (imp.state === 'sleeping' && ctx.fake.usedSnapshots.has(paths.snapshotDir)) {
      broken.push(`${where}: its snapshot was loaded once and no longer matches the disk`);
    }

    if (imp.state === 'running') {
      if (imp.pid === null) {
        broken.push(`${where}: no pid`);
      } else if (livenessRan && !ctx.fake.alive.has(imp.pid)) {
        broken.push(`${where}: its VM is dead`);
      } else if (owned.has(imp.pid)) {
        broken.push(`${where}: shares pid ${String(imp.pid)}`);
      } else {
        owned.add(imp.pid);
      }
    }
  }

  for (const pid of ctx.fake.alive) {
    if (!owned.has(pid)) {
      broken.push(`VM ${String(pid)} runs for no running imp`);
    }
  }

  return broken;
}

// 'done' or 'failed' once the promise settles, 'hung' after `ms`
export async function waitForOutcome(promise: Promise<unknown>, ms: number): Promise<string> {
  const timer = Promise.withResolvers<string>();

  const timeout = setTimeout(() => {
    timer.resolve('hung');
  }, ms);

  const settled = (async () => {
    try {
      await promise;

      return 'done';
    } catch {
      return 'failed';
    }
  })();

  try {
    return await Promise.race([settled, timer.promise]);
  } finally {
    clearTimeout(timeout);
  }
}
