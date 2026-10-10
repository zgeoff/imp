import { onTestFinished } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import type { ImpContract } from '@imp/api';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { InstallBundle } from '../broker/guest-trust';
import type { OAuthFetch } from '../broker/oauth-refresher';
import { createSecretFiles } from '../broker/secret-files';
import { TunnelRefusedError } from '../broker/tunnel-target';
import type { AppDeps } from '../build-app';
import { loadConfig } from '../config';
import type { Config } from '../config';
import {
  buildImpdApp,
  buildImpdEgress,
  buildImpdServices,
  buildImpdStorage,
  createImpdBroker,
  createImpdMoves,
  loadImpdAccess,
  startGovernedImps,
  startImpdBuilders,
} from '../create-impd';
import type { GovernedParts, ImpdDeps } from '../create-impd';
import { createImage } from '../db/images';
import type { ImageRecord } from '../db/images';
import { listImps } from '../db/imps';
import { openDatabase } from '../db/open-database';
import type { ImpDatabase } from '../db/open-database';
import { createDnsToken } from '../https/dns/dns-token';
import { createPublicRecordsLink } from '../https/public-records-link';
import { BUILD_KEEPALIVE_MS } from '../images/build-event-stream';
import type { MoveServiceDeps } from '../moves/move-service';
import type { Uplinks } from '../net/host-routes';
import type { Ipv6Plan } from '../net/ipv6-plan';
import type { TailscaleStatus } from '../net/tailscale-status';
import { createForwardedPeers } from '../proxy/forwarded-peers';
import { hasSnapshot, writeSnapshotMeta } from '../sleep/snapshot-meta';
import type { SnapshotIdentity } from '../sleep/snapshot-meta';
import type { HostIdentity } from '../sleep/vm-identity';
import { buildImpPaths, buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import type { ImpPaths } from '../storage/data-layout';
import type { StorageBackend } from '../storage/storage-backend';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { createCpuCgroups } from '../vmm/cpu-cgroups';
import type { CpuCgroups } from '../vmm/cpu-cgroups';
import type { KsmHostStats } from '../vmm/ksm';
import type { ImpService } from './imp-service';

export const TEST_TOKEN = 'test-token';

// what system.info reports about the guest kernel and the system drive
const TEST_SYSTEM_FILES = {
  guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
  systemDrive: { sha256: 'b'.repeat(64) },
};

// every awake fake VM owns this much, as the governor measures it
const FAKE_VM_RAM_MIB = 300;
const FAKE_VM_RSS_MIB = 340;

// the sha256 of the system drive every test impd starts with
const TEST_DRIVE = 'd1'.repeat(32);

// the freeze a checkpoint or a template asks of the guest; the fake VMs
// run no agent to ask
const NO_FREEZER = { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() };

// tailscaled, as on a host that is not on a tailnet
function readNoTailscale(): Promise<TailscaleStatus> {
  return Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] });
}

// what a host with `drive` installed in `dataDir` boots imps with
function buildTestIdentity(dataDir: string, drive: string): HostIdentity {
  return {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: drive,
    systemDrivePath: buildSystemDrivePath(dataDir, drive),
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  };
}

// The boundaries a test impd reaches through createImpd's deps: the
// database, the clock, the log, and what the shim's recorders stand in for
function buildTestDeps(
  ctx: Readonly<{
    db: ImpDatabase;
    dataDir: string;
    storage: StorageBackend;
    systemDrivePath: string;
    now: () => number;
    log: (message: string) => void;
  }>,
): ImpdDeps {
  return {
    db: ctx.db,
    rootToken: TEST_TOKEN,
    storage: ctx.storage,
    systemFiles: {
      kernelPath: `${ctx.dataDir}/system/vmlinux`,
      systemDrivePath: ctx.systemDrivePath,
      info: TEST_SYSTEM_FILES,
    },
    log: ctx.log,
    now: ctx.now,
    readTailscale: readNoTailscale,
    freezer: NO_FREEZER,
    oauthKey: Buffer.alloc(32, 7),
  };
}

export interface ImpTestOptions {
  readonly env?: Readonly<Record<string, string>>;

  // a data dir the caller made and removes, such as a mounted dataset; a
  // fresh temp dir that the dispose removes by default
  readonly dataDir?: string;

  // a plain copy by default: the test tmpdir is not XFS
  readonly cloneDisk?: (source: string, target: string) => Promise<void>;

  // the host's grow of a new disk's filesystem, after the harness records it;
  // grown at once by default
  readonly growFilesystem?: (disk: string) => Promise<boolean>;

  // sees each log line as impd writes it
  readonly onLog?: (message: string) => void;

  // the broker's CA install into a guest; by default it records the imp's
  // vsock path and succeeds
  readonly installBundle?: InstallBundle;

  // where the broker's plain tunnels dial, in place of DNS and its checks;
  // by default a tunnel is refused, so no test reaches the network
  readonly resolveTunnelTarget?: (host: string) => Promise<string>;
  readonly dialTunnel?: (address: string, port: number) => Socket;

  // holds a broker request between its rule read and its value read
  readonly afterRuleRead?: () => Promise<void>;

  // the broker's token calls for oauth secrets, and its clock; its refresh
  // timer never runs in the harness, so no test reaches a token endpoint
  // unasked
  readonly oauthFetch?: OAuthFetch;
  readonly brokerNow?: () => number;

  // nft in place of the real one; by default it records each script
  readonly runNft?: (script: string) => Promise<void>;

  // what `iptables -S FORWARD` prints; setup-net's rules by default
  readonly forwardRules?: string;

  // each imp's tailnet name as a URL; none by default
  readonly readServiceUrl?: (name: string) => string | null;

  // the clock's start, also a sleep's timing clock; it moves only with
  // `advance` and a young guest wait's pauses, which take no real time
  readonly frozenClockMs?: number;

  // the storage backend over the data dir; XFS on plain files by default
  readonly createStorage?: (dataDir: string) => StorageBackend;

  // CPU limits: none enforced, and 8 cores, by default
  readonly cgroups?: CpuCgroups;
  readonly hostCpus?: number;

  // IPv6 for imps, as impd resolved it; none by default
  readonly ipv6?: Ipv6Plan;

  // the host container's default-route interfaces; eth0 in each family by
  // default
  readonly readUplinks?: () => Promise<Uplinks>;

  // IMP_KSM's readers: the unshared size a sleep records, the merge flag, and
  // the host counters
  readonly readUnsharedRamMib?: (pid: number) => number | null;
  readonly checkGuestMerge?: (pid: number) => Promise<boolean | null>;
  readonly readKsmProfitMib?: (pid: number) => Promise<number | null>;
  readonly readKsmHostStats?: () => KsmHostStats | null;
}

// A shim over createImpd's parts, released at the test's end. `restartImpd`
// starts a new impd on the same database, data dir and VMs; given an
// identity, as an upgrade would.
export async function setupImpTest(options: ImpTestOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, options);

  return {
    ...harness,

    // transitional: in-flight area branches still hold the harness with
    // `await using`; the GEO-135 PR that deletes this shim removes it
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

// The same harness outside a test, as the client's smoke impd runs it: each
// release goes into `stack`, which the caller disposes.
export async function createImpTest(
  stack: Readonly<AsyncDisposableStack>,
  options: ImpTestOptions = {},
) {
  const dataDir = options.dataDir ?? mkdtempSync(`${tmpdir()}/impd-test-`);

  if (options.dataDir === undefined) {
    stack.defer(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });
  }

  const db = await openDatabase(':memory:');

  stack.defer(async () => {
    await db.destroy();

    options.onLog?.('test harness: database closed');
  });

  // a new disk stays the size of its image: the fake clone copies every byte
  const config: Config = {
    // unjailed unless a test asks: the fake VMs have no cgroups
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_BOOT_TEMPLATES: 'false',
      IMP_JAILER: 'false',
      ...options.env,
    }),
    defaultDiskBytes: 0,
  };

  const fake = buildStubVmm();
  const taps: string[] = [];
  const removedTaps: string[] = [];
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

  // the host's free space as the budget sees it; a test lowers it
  const diskUsage = { usedBytes: 0, availableBytes: 1024 ** 4 };

  const printTestLog = (message: string): void => {
    logs.push(message);
    options.onLog?.(message);
  };

  // a system drive file, as setupSystemFiles installs it
  const createSystemDrive = (drive: string): HostIdentity => {
    const identity = buildTestIdentity(dataDir, drive);

    mkdirSync(buildSystemDrivesDir(dataDir), { recursive: true });
    writeFileSync(identity.systemDrivePath, drive);

    return identity;
  };

  const host = { identity: createSystemDrive(TEST_DRIVE) };

  // the vsock paths the broker installed its CA through
  const bundleInstalls: string[] = [];

  // every nft script and conntrack flush the egress firewall ran
  const nftScripts: string[] = [];
  const flushed: string[] = [];
  const flushedPairs: string[] = [];

  // each policy change's call to end the broker's tunnels, with its keep
  const closedTunnels: { impId: string; keep: (host: string) => boolean }[] = [];

  // each limit impd sets on an imp's memory, in order
  const memoryLimits: { impId: string; guestMib: number }[] = [];

  const deps: ImpdDeps = {
    ...buildTestDeps({
      db,
      dataDir,
      storage,
      systemDrivePath: host.identity.systemDrivePath,
      now: readClock,
      log: printTestLog,
    }),
    readDiskSpace: () => Promise.resolve({ ...diskUsage }),
    broker: {
      installBundle:
        options.installBundle ??
        ((vsockPath) => {
          bundleInstalls.push(vsockPath);

          return Promise.resolve();
        }),
      resolveTunnelTarget:
        options.resolveTunnelTarget ??
        ((name) => Promise.reject(new TunnelRefusedError(`${name}: no network in tests`))),
      ...(options.dialTunnel !== undefined && { dialTunnel: options.dialTunnel }),
      ...(options.afterRuleRead !== undefined && { afterRuleRead: options.afterRuleRead }),
      ...(options.oauthFetch !== undefined && { oauthFetch: options.oauthFetch }),

      // on the wall clock unless a test asks, as before the harness's clock
      // reached createImpd's broker
      now: options.brokerNow ?? Date.now,
      runOAuthTimer: false,
    },
    egress: {
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
      readConnected6: () => Promise.resolve(['2001:db8:a::/64']),
      readConnected4: () => Promise.resolve(['172.17.0.0/16', '172.17.0.2/32', '44.0.0.0/24']),
      readUplinks:
        options.readUplinks ?? (() => Promise.resolve({ ipv4: ['eth0'], ipv6: ['eth0'] })),
    },
    imps: {
      readRamMib: (pid) => (fake.alive.has(pid) ? FAKE_VM_RAM_MIB : null),
      readRssMib: (pid) => (fake.alive.has(pid) ? FAKE_VM_RSS_MIB : null),
      growFilesystem: (disk) => {
        filesystemGrows.push(disk);

        return options.growFilesystem?.(disk) ?? Promise.resolve(true);
      },

      // recorded, then written as main.ts does when a test passes cgroups
      memoryLimit: {
        setGuestMib: (impId, guestMib) => {
          memoryLimits.push({ impId, guestMib });
          options.cgroups?.setGuestMib(impId, guestMib);
        },
      },
      hostCpus: options.hostCpus ?? 8,
      ...(frozenAt !== undefined && {
        sleepTiming: {
          now: readClock,
          sleep: (ms: number) => {
            clock.offsetMs += ms;

            return Promise.resolve();
          },
        },
      }),
      ...(options.readUnsharedRamMib !== undefined && {
        readUnsharedRamMib: options.readUnsharedRamMib,
      }),
      ...(options.checkGuestMerge !== undefined && { checkGuestMerge: options.checkGuestMerge }),
      ...(options.readKsmProfitMib !== undefined && { readKsmProfitMib: options.readKsmProfitMib }),
    },
    taps: {
      setupTap: (address) => {
        taps.push(address.tap);

        return Promise.resolve();
      },
      removeTap: (tap) => {
        removedTaps.push(tap);

        return Promise.resolve();
      },
    },
  };

  const stored = buildImpdStorage(config, deps);

  stack.defer(() => {
    stored.diskUsage.stop();
  });

  const broker = await createImpdBroker(config, deps, {
    ipv6: options.ipv6 ?? null,
    secretFiles: createSecretFiles(dataDir),
  });

  stack.defer(() => broker.stop());

  const egress = buildImpdEgress(config, deps, {
    ipv6: options.ipv6 ?? null,
    broker: {
      isGranted: broker.isGranted,
      closeTunnels: (impId, keep) => {
        closedTunnels.push({ impId, keep });
        broker.closeTunnels(impId, keep);
      },
    },
  });

  stack.defer(() => {
    fake.releaseHangs();
  });

  const governedParts: GovernedParts = {
    storage: stored,
    broker,
    egress,
    ipv6: options.ipv6 ?? null,
    cgroups: options.cgroups ?? createCpuCgroups({ root: '/nonexistent', log: printTestLog }),
    readServiceUrl: options.readServiceUrl ?? (() => null),
    readTailscale: readNoTailscale,
  };

  // the impd restartImpd started last; a replaced one's VM calls park forever
  const generations = { current: 0 };

  const startImpd = (identity: HostIdentity = host.identity) => {
    host.identity = identity;
    generations.current += 1;

    const generation = generations.current;

    const started = startGovernedImps(
      config,
      deps,
      governedParts,
      identity,
      fake.startGeneration(),
    );

    // as main.ts stops them: a template build still running would write
    // into the data dir after its removal. A hung build is released first,
    // and a replaced impd's build is parked, so nothing waits on it.
    stack.defer(async () => {
      fake.releaseHangs();

      if (generation === generations.current) {
        await started.imps.bootTemplates?.stop();
      }
    });

    return started;
  };

  const governed = startImpd();
  const builders = startImpdBuilders(config, deps, stored, governed.imps);

  const access = await loadImpdAccess(config, deps, () => false);

  // an image row whose rootfs is a small file in the data dir
  const createTestImage = async (name: string): Promise<ImageRecord> => {
    await Bun.write(`${dataDir}/images/${name}/rootfs.ext4`, 'rootfs');

    return createImage(db, { name, ref: `${name}:latest`, digest: `sha256:${name}`, sizeBytes: 6 });
  };

  return {
    config,
    db,
    dataDir,
    images: stored.images,
    builders,
    fake,
    taps,
    removedTaps,
    logs,
    log: printTestLog,
    filesystemGrows,
    imps: governed.imps,
    governor: governed.governor,
    memory: governed.memory,
    memoryLimits,
    broker,
    egress,
    nftScripts,
    flushed,
    flushedPairs,
    closedTunnels,
    bundleInstalls,
    storage,
    storageGate: stored.storageGate,
    diskBudget: stored.diskBudget,
    diskUsage,
    tokens: access.tokens,
    revocations: access.revocations,
    oauth: access.oauth,
    now: readClock,
    advance: (ms: number) => {
      clock.offsetMs += ms;
    },
    readKsmHostStats: options.readKsmHostStats ?? null,
    restartImpd: startImpd,
    createSystemDrive,
    readIdentity: () => host.identity,
    createTestImage,
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
  | 'oauth'
  | 'egress'
  | 'readIdentity'
  | 'readKsmHostStats'
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
  moveOptions: Partial<
    Pick<
      MoveServiceDeps,
      'fetch' | 'releaseName' | 'onCommitted' | 'partBytes' | 'readWarmHost' | 'readTapMac'
    >
  > = {},

  // the gap between the progress events of a streamed image call
  buildKeepaliveMs = BUILD_KEEPALIVE_MS,
) {
  const identity = ctx.readIdentity();

  const deps = buildTestDeps({
    db: ctx.db,
    dataDir: ctx.config.dataDir,
    storage: ctx.storage,
    systemDrivePath: identity.systemDrivePath,
    now: ctx.now,
    log: ctx.log,
  });

  // the services under the API log nowhere, as before the shim
  const quiet: ImpdDeps = { ...deps, log: () => {} };

  const storage = {
    storageGate: ctx.storageGate,
    diskBudget: ctx.diskBudget,
    images: ctx.images,
  };

  const services = buildImpdServices(ctx.config, quiet, {
    storage,
    imps: impd.imps,
    egress: ctx.egress,
    secretFiles: createSecretFiles(ctx.config.dataDir),
  });

  const peers = createForwardedPeers(ctx.now);

  const moves = createImpdMoves(
    ctx.config,
    quiet,
    {
      storage,
      imps: impd.imps,
      broker: ctx.broker,
      egress: ctx.egress,
      audit: services.audit,
      readIdentity: ctx.readIdentity,
    },
    {
      readTailnetIp: () => Promise.resolve(null),
      releaseName: () => Promise.resolve(),
      onCommitted: () => {},
      ...moveOptions,
    },
  );

  // the DNS API token as main reads it, for system info
  const dnsTokenSource = ctx.config.https?.dns.token ?? null;
  const dnsToken = dnsTokenSource === null ? null : createDnsToken(dnsTokenSource, ctx.now);

  const built = buildImpdApp(ctx.config, deps, {
    storage,
    access: { tokens: ctx.tokens, revocations: ctx.revocations, oauth: ctx.oauth },
    services,
    imps: { ...impd.imps, ...agent },
    governor: impd.governor,
    broker: ctx.broker,
    egress: ctx.egress,

    // every test VM reports this Firecracker, whatever identity a restart took
    identity: { ...identity, firecrackerVersion: 'v1.17.0' },
    peers,
    tailnet,
    backups: null,
    moves,
    publicRecords: createPublicRecordsLink(),
    checkDnsToken: dnsToken?.check ?? null,
    readTailscale: readNoTailscale,
    readTailnetNames: null,
    isReady: () => true,
    keepaliveMs: buildKeepaliveMs,
    ...(ctx.readKsmHostStats !== null && { readKsmHostStats: ctx.readKsmHostStats }),
  });

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: `Bearer ${token}` },
    fetch: (request) => built.app.handle(request),
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(link);

  return {
    app: built.app,
    publicMcp: built.publicMcp,
    closeExecSessions: built.closeExecSessions,
    client,
    peers,
    moves,
  };
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

// 'done' or 'failed' once the promise settles, 'hung' when it is still
// pending after `ms` of polling its state, read on `clock`
export async function waitForOutcome(
  promise: Promise<unknown>,
  ms: number,
  clock: Readonly<{ now?: () => number; wait?: (ms: number) => Promise<void> }> = {},
): Promise<string> {
  const settled = (async () => {
    try {
      await promise;

      return 'done';
    } catch {
      return 'failed';
    }
  })();

  try {
    await waitFor(
      () => {
        if (Bun.peek.status(settled) === 'pending') {
          throw new Error('still pending');
        }
      },
      { ...clock, timeoutMs: ms },
    );
  } catch {
    return 'hung';
  }

  return settled;
}
