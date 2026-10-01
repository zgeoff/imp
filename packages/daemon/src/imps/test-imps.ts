import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config';
import { createImage } from '../db/images';
import type { ImageRecord } from '../db/images';
import { openDatabase } from '../db/open-database';
import { createGovernedImps } from '../governor/create-governed-imps';
import { createImageService } from '../images/image-service';
import type { VmRunner } from '../vmm/vm-runner';

// every awake fake VM owns this much, as the governor measures it
const FAKE_VM_RAM_MIB = 300;

const TEST_IDENTITY = {
  firecrackerVersion: 'v1.17.0',
  snapshotVersion: 'v12.0.0',
  hostKernel: 'test',
  guestKernel: 'k',
  systemDrive: 's',
};

// A VM runner that boots, sleeps and wakes at once and tracks which pids are
// alive. `control` steers the next calls: failBoot makes the next boot throw;
// sleepGate and bootGate hold sleeps and boots until they resolve.
function buildFakeVms() {
  const alive = new Set<number>();

  const wakes: number[] = [];
  const stops: { pid: number; graceful: boolean }[] = [];
  const counter = { nextPid: 1000 };

  const control: {
    failBoot: boolean;
    sleepGate: Promise<void> | null;
    bootGate: Promise<void> | null;
    agentReady: boolean;
  } = { failBoot: false, sleepGate: null, bootGate: null, agentReady: true };

  const vms: VmRunner = {
    startVm: async () => {
      await control.bootGate;

      if (control.failBoot) {
        control.failBoot = false;
        throw new Error('boot failed: no agent\nlog tail');
      }

      counter.nextPid += 1;

      alive.add(counter.nextPid);

      return { pid: counter.nextPid, firecrackerVersion: 'v1.17.0', timings: {} };
    },
    stopVm: (pid, _paths, graceful) => {
      alive.delete(pid);
      stops.push({ pid, graceful });

      return Promise.resolve();
    },
    sleepVm: async (pid, paths) => {
      await control.sleepGate;

      alive.delete(pid);

      mkdirSync(paths.snapshotDir, { recursive: true });
      writeFileSync(paths.vmstate, 'vmstate');
      writeFileSync(paths.memFile, 'mem');

      return {};
    },
    wakeVm: () => {
      counter.nextPid += 1;

      alive.add(counter.nextPid);
      wakes.push(counter.nextPid);

      return Promise.resolve({ pid: counter.nextPid, firecrackerVersion: 'v1.17.0', timings: {} });
    },
    isVmAlive: (pid) => alive.has(pid),
    isAgentReady: () => Promise.resolve(control.agentReady),
  };

  return { vms, alive, stops, wakes, control };
}

interface ImpTestOptions {
  readonly env?: Readonly<Record<string, string>>;

  // a plain copy by default: the test tmpdir is not XFS
  readonly cloneDisk?: (source: string, target: string) => Promise<void>;
}

// The governed imp service over an in-memory database, fake VMs and taps,
// in a fresh data dir.
export async function setupImpTest(options: ImpTestOptions = {}) {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-test-`);

  const db = await openDatabase(':memory:');

  const config = loadConfig({ IMP_DATA_DIR: dataDir, ...options.env });
  const images = createImageService({ config, db });
  const fake = buildFakeVms();
  const taps: string[] = [];
  const logs: string[] = [];

  const governed = createGovernedImps({
    config,
    identity: TEST_IDENTITY,
    readRamMib: (pid) => (fake.alive.has(pid) ? FAKE_VM_RAM_MIB : null),
    db,
    images,
    vms: fake.vms,
    taps: {
      setupTap: (address) => {
        taps.push(address.tap);

        return Promise.resolve();
      },
      removeTap: () => Promise.resolve(),
    },
    log: (message) => {
      logs.push(message);
    },
    cloneDisk:
      options.cloneDisk ??
      ((source, target) => {
        copyFileSync(source, target);

        return Promise.resolve();
      }),
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
    imps: governed.imps,
    governor: governed.governor,
    createTestImage,
    async [Symbol.asyncDispose]() {
      await db.destroy();

      rmSync(dataDir, { recursive: true, force: true });
    },
  };
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
