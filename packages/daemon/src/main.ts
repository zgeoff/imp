import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './build-app';
import { loadConfig } from './config';
import { openDatabase } from './db/open-database';
import { createGovernedImps } from './governor/create-governed-imps';
import { createIdleLoop } from './idle/idle-loop';
import { createImageService } from './images/image-service';
import { createTapDevices } from './net/tap-devices';
import { startTicker } from './process/ticker';
import { startWakeProxy } from './proxy/wake-proxy';
import type { WakeProxy } from './proxy/wake-proxy';
import { readSnapshotIdentity } from './sleep/snapshot-meta';
import { setupSystemFiles } from './storage/setup-system-files';
import { loadOrCreateToken } from './token';
import { readFirecrackerVersion } from './vmm/firecracker-process';
import { createVmRunner } from './vmm/vm-runner';

function printLog(message: string): void {
  console.log(message);
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  mkdirSync(join(config.dataDir, 'db'), { recursive: true });
  setupSystemFiles(config);

  const db = await openDatabase(join(config.dataDir, 'db', 'imp.sqlite'));

  const token = loadOrCreateToken(config.dataDir);
  const images = createImageService({ config, db });
  const proxyHolder: { proxy: WakeProxy | null } = { proxy: null };

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
  });

  const imps = governed.imps;
  const governor = governed.governor;

  await imps.reconcileImps();

  const state = { ready: false };

  const app = buildApp({
    config,
    db,
    token,
    imps,
    images,
    governor,
    firecrackerVersion: readFirecrackerVersion(config.firecrackerBin),
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

    await Promise.all(tickers.map((ticker) => ticker.stop()));
    await proxy.stop();
    await app.stop();

    if (sleepImps) {
      await imps.sleepAllImps();

      const sleptMs = Math.round(performance.now() - started);

      printLog(`impd: every imp asleep in ${String(sleptMs)}ms`);
    }

    await db.destroy();

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
