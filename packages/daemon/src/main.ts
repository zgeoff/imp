import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './build-app';
import { createCheckpointService } from './checkpoints/checkpoint-service';
import { loadConfig } from './config';
import { openDatabase } from './db/open-database';
import { createGovernedImps } from './governor/create-governed-imps';
import { createIdleLoop } from './idle/idle-loop';
import { createImageService } from './images/image-service';
import { readTailscaleStatus } from './net/tailscale-status';
import { createTapDevices } from './net/tap-devices';
import { printLog } from './process/print-log';
import { startTicker } from './process/ticker';
import { waitWithin } from './process/wait-within';
import { startWakeProxy } from './proxy/wake-proxy';
import type { WakeProxy } from './proxy/wake-proxy';
import { readErrorMessage } from './read-error-message';
import { readSnapshotIdentity } from './sleep/snapshot-meta';
import { setupSystemFiles } from './storage/setup-system-files';
import { loadOrCreateToken } from './token';
import { readFirecrackerVersion } from './vmm/firecracker-process';
import { createVmRunner } from './vmm/vm-runner';

const STOP_STEP_TIMEOUT_MS = 10_000;

// within the 120 s that scripts/dev.sh gives `docker stop`
const SLEEP_ALL_TIMEOUT_MS = 90_000;

// Bounded, and a failure is logged: impd always reaches its exit. A ticker
// stop waits for a governor or idle pass under way.
async function runStopStep(step: string, ms: number, task: () => Promise<unknown>): Promise<void> {
  try {
    const finished = await waitWithin(task(), ms);

    if (!finished) {
      printLog(`impd: stop: ${step} still running after ${String(ms)}ms; going on`);
    }
  } catch (error) {
    printLog(`impd: stop: ${step} failed: ${readErrorMessage(error)}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  mkdirSync(join(config.dataDir, 'db'), { recursive: true });
  setupSystemFiles(config);

  const db = await openDatabase(join(config.dataDir, 'db', 'imp.sqlite'));

  const token = loadOrCreateToken(config.dataDir);
  const images = createImageService({ config, db });
  const proxyHolder: { proxy: WakeProxy | null } = { proxy: null };
  const readTailscale = () => readTailscaleStatus(config.tailscaleAuthKey !== null);

  const governed = createGovernedImps({
    config,
    db,
    images,
    taps: createTapDevices(),
    vms: createVmRunner(),
    identity: readSnapshotIdentity(config),
    log: printLog,
    onImpsChanged: () => {
      void proxyHolder.proxy?.syncListeners();
    },
    readTailnetHostname: async () => {
      const status = await readTailscale();

      return status.hostname;
    },
  });

  const imps = governed.imps;
  const governor = governed.governor;

  await imps.reconcileImps();

  const checkpoints = createCheckpointService({ config, db, imps });
  const state = { ready: false };

  const app = buildApp({
    config,
    db,
    token,
    imps,
    images,
    governor,
    checkpoints,
    firecrackerVersion: readFirecrackerVersion(config.firecrackerBin),
    readTailscale,
    isReady: () => state.ready,
  }).listen(config.apiPort);

  console.log(`impd: api on :${String(config.apiPort)}, data in ${config.dataDir}`);

  const proxy = startWakeProxy({ config, db, imps, log: printLog });

  proxyHolder.proxy = proxy;

  await proxy.syncListeners();

  const idle = createIdleLoop({ config, db, imps, log: printLog });

  const tickers = [
    startTicker('idle', 2000, idle.runCheck, printLog),
    startTicker('governor', 5000, governor.enforce, printLog),

    // listeners follow creates and destroys; this catches anything missed
    startTicker('proxy', 30_000, proxy.syncListeners, printLog),
  ];

  // ready either way: a failed seed leaves `imp image add` to the user
  const setupDefaultImage = async (): Promise<void> => {
    try {
      await images.seedDefaultImage();
    } catch (error) {
      console.error('impd: could not add the default image:', error);
    } finally {
      state.ready = true;
    }
  };

  void setupDefaultImage();

  // SIGTERM and SIGINT (container stop): every running imp goes to sleep, so
  // a container restart keeps memory. SIGHUP (impd restart in place): VMs keep
  // running and the next impd re-adopts them (DESIGN 2.8).
  const stop = async (sleepImps: boolean) => {
    const started = performance.now();

    await runStopStep('tickers', STOP_STEP_TIMEOUT_MS, () =>
      Promise.all(tickers.map((ticker) => ticker.stop())),
    );

    await runStopStep('proxy', STOP_STEP_TIMEOUT_MS, () => proxy.stop());

    // open exec sessions end here; their imps go to sleep next
    await runStopStep('api', STOP_STEP_TIMEOUT_MS, () => app.stop(true));

    if (sleepImps) {
      await runStopStep('sleep', SLEEP_ALL_TIMEOUT_MS, () => imps.sleepAllImps());

      const sleptMs = Math.round(performance.now() - started);

      printLog(`impd: every imp asleep in ${String(sleptMs)}ms`);
    }

    await runStopStep('database', STOP_STEP_TIMEOUT_MS, () => db.destroy());

    process.exit(0);
  };

  const stopState = { stopping: false };

  const handleSignal = (sleepImps: boolean): void => {
    if (!stopState.stopping) {
      stopState.stopping = true;
      void stop(sleepImps);
    }
  };

  process.on('SIGINT', () => {
    handleSignal(true);
  });

  process.on('SIGTERM', () => {
    handleSignal(true);
  });

  process.on('SIGHUP', () => {
    handleSignal(false);
  });
}

await main();
