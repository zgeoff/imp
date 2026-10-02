import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { createApiAudit } from './audit/api-audit';
import { createBackupService } from './backup/backup-service';
import { createBroker } from './broker/broker-service';
import { buildApp } from './build-app';
import { createCheckpointService } from './checkpoints/checkpoint-service';
import { loadConfig } from './config';
import { subscribeImpWrites } from './db/imp-write-feed';
import { countImpsByState } from './db/imps';
import { isImpSetWrite } from './db/is-imp-set-write';
import { openDatabase } from './db/open-database';
import { createGovernedImps } from './governor/create-governed-imps';
import { buildHttpsService } from './https/build-https-service';
import { createIdleLoop } from './idle/idle-loop';
import { createImageService } from './images/image-service';
import { removeUnusedDrives } from './imps/remove-unused-drives';
import { readTailscaleStatus } from './net/tailscale-status';
import { createTapDevices } from './net/tap-devices';
import { printLog } from './process/print-log';
import { startTicker } from './process/ticker';
import { waitWithin } from './process/wait-within';
import { startWakeProxy } from './proxy/wake-proxy';
import type { WakeProxy } from './proxy/wake-proxy';
import { readErrorMessage } from './read-error-message';
import { readHostIdentity } from './sleep/vm-identity';
import { startSsh } from './ssh/start-ssh';
import { createStorageBackend } from './storage/create-storage-backend';
import { createDiskBudget } from './storage/disk-budget';
import { readLiveStorage } from './storage/read-live-storage';
import { setupSystemFiles } from './storage/setup-system-files';
import { createStorageGate } from './storage/storage-gate';
import { createStorageGc } from './storage/storage-gc';
import { startImpTelemetry } from './telemetry/imp-telemetry';
import { startOtlpExport } from './telemetry/start-otlp-export';
import { loadOrCreateToken } from './token';
import { readFirecrackerVersion } from './vmm/firecracker-process';
import { createVmRunner } from './vmm/vm-runner';

// the whole stop, within the 120 s that scripts/dev.sh gives `docker stop`
const STOP_DEADLINE_MS = 100_000;

// at most per step before the sleep pass, which gets whatever is left
const STOP_STEP_MAX_MS = 10_000;

// Bounded, and a failure is logged: impd always reaches its exit. True when
// the step finished in time. A ticker stop waits for a pass under way.
async function runStopStep(
  step: string,
  ms: number,
  task: () => Promise<unknown>,
): Promise<boolean> {
  try {
    const finished = await waitWithin(task(), ms);

    if (!finished) {
      printLog(`impd: stop: ${step} still running after ${String(ms)}ms; going on`);
    }

    return finished;
  } catch (error) {
    printLog(`impd: stop: ${step} failed: ${readErrorMessage(error)}`);

    return true;
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  // before any instrument is made: a meter taken earlier stays a no-op
  const stopExport = await startOtlpExport(process.env, packageJson.version);

  mkdirSync(join(config.dataDir, 'db'), { recursive: true });

  const systemFiles = await setupSystemFiles(config);
  const db = await openDatabase(join(config.dataDir, 'db', 'imp.sqlite'));

  const token = loadOrCreateToken(config.dataDir);
  const storage = createStorageBackend(config);

  // before any VM is re-adopted or woken: on ZFS the disks are mounted here
  const live = await readLiveStorage(db);

  await storage.start(live);

  // every operation that makes storage before its row joins it; the GC waits
  const storageGate = createStorageGate();

  const diskBudget = createDiskBudget({
    storage,
    reserveBytes: config.diskReserveBytes,
    log: printLog,
  });

  const images = createImageService({ config, db, storage, storageGate, diskBudget });

  const broker = await createBroker({ config, db, log: printLog });

  const proxyHolder: { proxy: WakeProxy | null } = { proxy: null };
  const readTailscale = () => readTailscaleStatus(config.tailscaleAuthKey !== null);

  const governed = createGovernedImps({
    config,
    db,
    images,
    taps: createTapDevices(),
    vms: createVmRunner(),
    storage,
    identity: readHostIdentity(config.firecrackerBin, systemFiles),
    log: printLog,
    readExecEnv: broker.readExecEnv,
    storageGate,
    diskBudget,
    readTailnetHostname: async () => {
      const status = await readTailscale();

      return status.hostname;
    },
  });

  const imps = governed.imps;
  const governor = governed.governor;

  startImpTelemetry({
    bus: imps.events,
    readStateCounts: () => countImpsByState(db),
    readRam: async () => {
      const usage = await governor.readUsage();

      return { usedMib: usage.usedMib, budgetMib: config.ramBudgetMib };
    },
  });

  // an imp that comes or goes opens or closes its proxy port and its grants
  subscribeImpWrites(db, (write) => {
    if (isImpSetWrite(write)) {
      void proxyHolder.proxy?.syncListeners();
      void broker.applyGrants();
    }
  });

  await imps.reconcileImps();

  // before anything can boot or sleep an imp, so the set of drives in use holds
  const removed = await removeUnusedDrives(
    db,
    config.dataDir,
    storage.resolveImpPaths,
    systemFiles.systemDrivePath,
  );

  for (const name of removed) {
    printLog(`impd: removed system drive ${name}: no imp uses it`);
  }

  const checkpoints = createCheckpointService({ config, db, imps, storage, diskBudget });

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
          storageGate,
          diskBudget,
        });

  const gc = createStorageGc({ db, storage, storageGate, log: printLog });
  const state = { ready: false };
  const audit = createApiAudit({ db, now: Date.now, log: printLog });

  const api = buildApp({
    config,
    db,
    token,
    imps,
    images,
    governor,
    checkpoints,
    backups,
    broker,
    firecrackerVersion: readFirecrackerVersion(config.firecrackerBin),
    systemFiles: systemFiles.info,
    storage,
    diskBudget,
    gc,
    readTailscale,
    isReady: () => state.ready,
    now: Date.now,
    audit,
  });

  const app = api.app.listen(config.apiPort);

  console.log(`impd: api on :${String(config.apiPort)}, data in ${config.dataDir}`);

  const proxy = startWakeProxy({ config, db, imps, log: printLog });

  proxyHolder.proxy = proxy;

  await proxy.syncListeners();

  const https =
    config.https === null
      ? null
      : buildHttpsService({
          config: config.https,
          dataDir: config.dataDir,
          proxy,
          readTailscale: config.tailscaleAuthKey === null ? null : readTailscale,
          log: printLog,
        });

  https?.start();

  const brokerPort = await broker.listen(config.brokerPort);

  console.log(`impd: credential broker on :${String(brokerPort)} of every imp's gateway`);

  const ssh = await startSsh({ config, db, imps, log: printLog, audit, now: Date.now });

  const idle = createIdleLoop({ config, db, imps, log: printLog });

  const tickers = [
    startTicker('idle', 2000, idle.runCheck, printLog),
    startTicker('governor', 5000, governor.enforce, printLog),

    // listeners follow creates and destroys; this catches anything missed
    startTicker('proxy', 30_000, proxy.syncListeners, printLog),

    // terminators follow grants; this also renews leaves near their end
    startTicker('broker', 60_000, broker.applyGrants, printLog),

    // what a crash or a failed removal left; start sweeps the same way
    startTicker('gc', 3_600_000, gc.runScheduled, printLog),
    ...(backups === null
      ? []
      : [
          startTicker(
            'backup',

            // a run is due by the time since the last one, so a restart
            // never puts it off by a whole interval
            Math.min(config.backup?.intervalS ?? 0, 300) * 1000,
            backups.runScheduled,
            printLog,
          ),
        ]),
  ];

  // ready either way: a failed seed leaves `imp image add` to the user
  const setupDefaultImage = async (): Promise<void> => {
    try {
      await images.seedDefaultImage();

      const existing = await images.listImages();

      if (!existing.some((image) => image.name === config.defaultImage)) {
        printLog(
          `impd: warning: no image named ${config.defaultImage} (IMP_DEFAULT_IMAGE); imp new uses ubuntu until \`imp image add <ref> --name ${config.defaultImage}\` adds it`,
        );
      }
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
    const readLeftMs = () => Math.max(0, STOP_DEADLINE_MS - (performance.now() - started));
    const readStepMs = () => Math.min(STOP_STEP_MAX_MS, readLeftMs());

    await runStopStep('tickers', readStepMs(), () =>
      Promise.all(tickers.map((ticker) => ticker.stop())),
    );

    if (https !== null) {
      await runStopStep('https', readStepMs(), () => https.stop());
    }

    await runStopStep('proxy', readStepMs(), () => proxy.stop());
    await runStopStep('broker', readStepMs(), () => broker.stop());

    // before the sleep pass, as exec sessions are: a client sees its
    // connection end instead of hanging while its imp sleeps
    await runStopStep('ssh', readStepMs(), () => ssh?.stop() ?? Promise.resolve());

    api.closeExecSessions();

    await runStopStep('api', readStepMs(), () => app.stop(true));

    // either way, a wake or boot under way finishes first: one cut short
    // leaves a Firecracker that no record knows
    const settled = sleepImps
      ? await runStopStep('sleep', readLeftMs(), () => imps.sleepAllImps())
      : await runStopStep('lifecycle', readLeftMs(), () => imps.waitForLifecycle());

    if (sleepImps) {
      const sleptMs = Math.round(performance.now() - started);

      printLog(`impd: every imp asleep in ${String(sleptMs)}ms`);
    }

    // a reclaim pass left running would race the next impd's start
    await runStopStep('storage', readStepMs(), () => storage.stop());

    // sends what the sleep pass recorded; its gauges still read the database
    if (stopExport !== null) {
      await runStopStep('telemetry', readStepMs(), stopExport);
    }

    // a sleep still running writes its record later: closing the database
    // under it would fail that write. The next start finds its snapshot.
    if (settled) {
      await runStopStep('database', readStepMs(), () => db.destroy());
    }

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

// The release pipeline runs `impd --version` in the built image to check it
// reports the tag it is published under.
if (process.argv[2] === '--version') {
  process.stdout.write(`${packageJson.version}\n`);
} else {
  await main();
}
