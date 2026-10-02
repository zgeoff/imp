import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import type { ImpContract } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createBroker } from '../broker/broker-service';
import type { InstallBundle } from '../broker/guest-trust';
import { TunnelRefusedError } from '../broker/tunnel-target';
import { buildApp } from '../build-app';
import { createCheckpointService } from '../checkpoints/checkpoint-service';
import { loadConfig } from '../config';
import { createImage } from '../db/images';
import type { ImageRecord } from '../db/images';
import { listImps } from '../db/imps';
import { openDatabase } from '../db/open-database';
import type { ImpDatabase } from '../db/open-database';
import { createGovernedImps } from '../governor/create-governed-imps';
import { createImageService } from '../images/image-service';
import { hasSnapshot, writeSnapshotMeta } from '../sleep/snapshot-meta';
import type { SnapshotIdentity } from '../sleep/snapshot-meta';
import type { HostIdentity } from '../sleep/vm-identity';
import { buildImpPaths, buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import type { ImpPaths } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
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
}

// The governed imp service over an in-memory database, fake VMs and taps, in
// a fresh data dir. `restartImpd` starts a new impd on the same database, data
// dir and VMs, as a restart would; given an identity, as an upgrade would.
export async function setupImpTest(options: ImpTestOptions = {}) {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-test-`);

  const db = await openDatabase(':memory:');

  const config = loadConfig({ IMP_DATA_DIR: dataDir, ...options.env });
  const fake = buildFakeVmm();
  const taps: string[] = [];
  const logs: string[] = [];

  // the clock for holds and reservations; a test moves it with `advance`
  const clock = { offsetMs: 0 };
  const readClock = () => Date.now() + clock.offsetMs;

  const cloneDisk =
    options.cloneDisk ??
    ((source: string, target: string) => {
      copyFileSync(source, target);

      return Promise.resolve();
    });

  const storage = createXfsBackend({ dataDir, cloneFile: cloneDisk });
  const images = createImageService({ config, db, storage });

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
    });
  };

  const governed = startImpd();

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
    imps: governed.imps,
    governor: governed.governor,
    broker,
    bundleInstalls,
    storage,
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

type AppParts = Pick<ImpTest, 'config' | 'db' | 'images' | 'storage' | 'now' | 'broker'>;

// The HTTP app over `impd` (the harness's or a restarted one), an oRPC client
// that calls it without a socket, a no-op freeze and thaw, and `openExec` in
// place of the guest agent, which the fake VMs do not run.
export function buildTestApp(
  ctx: Readonly<AppParts>,
  impd: Readonly<Impd>,
  token = TEST_TOKEN,

  // a fake agent's streams in place of the VM's
  agent: Partial<Pick<ImpService, 'openExec' | 'openAttach'>> = {},
) {
  const imps: ImpService = { ...impd.imps, ...agent };

  const checkpoints = createCheckpointService({
    config: ctx.config,
    db: ctx.db,
    imps: impd.imps,
    storage: ctx.storage,
    log: () => {},
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  const built = buildApp({
    config: ctx.config,
    db: ctx.db,
    token: TEST_TOKEN,
    imps,
    images: ctx.images,
    governor: impd.governor,
    checkpoints,
    backups: null,
    broker: ctx.broker,
    firecrackerVersion: 'v1.17.0',
    systemFiles: TEST_SYSTEM_FILES,
    storage: ctx.storage,
    readTailscale: () => Promise.resolve({ state: null, hostname: null, ip: null }),
    isReady: () => true,
    now: ctx.now,
  });

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: `Bearer ${token}` },
    fetch: (request) => built.app.handle(request),
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(link);

  return { app: built.app, closeExecSessions: built.closeExecSessions, client };
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
