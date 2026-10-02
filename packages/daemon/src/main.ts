import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { createApiAudit } from './audit/api-audit';
import { createKnownHosts } from './auth/ambient-request';
import { createRevocations } from './auth/revocations';
import { createTailnetIdentities, runWhois } from './auth/tailnet-identity';
import { loadTokenStore } from './auth/token-store';
import { createBackupService } from './backup/backup-service';
import { createBroker } from './broker/broker-service';
import { buildApp } from './build-app';
import { createCheckpointService } from './checkpoints/checkpoint-service';
import { loadConfig } from './config';
import type { Config } from './config';
import { subscribeImpWrites } from './db/imp-write-feed';
import { countImpsByState } from './db/imps';
import { isImpSetWrite } from './db/is-imp-set-write';
import { openDatabase } from './db/open-database';
import { runNft } from './egress/egress-firewall';
import { createEgressService } from './egress/egress-service';
import { createGovernedImps } from './governor/create-governed-imps';
import { buildHttpsService } from './https/build-https-service';
import { createPublicRecordsLink } from './https/public-records-link';
import { createIdleLoop } from './idle/idle-loop';
import { createBuildContextRoute } from './images/build-context-route';
import { createImageService } from './images/image-service';
import { createTemplateService } from './images/template-service';
import { removeUnusedDrives } from './imps/remove-unused-drives';
import { MOVE_PART_BYTES } from './moves/move-parts';
import { createMoveService } from './moves/move-service';
import {
  checkHostRules6,
  readIpv6DefaultRoute,
  readOrCreateUlaPrefix,
  resolveIpv6Plan,
} from './net/ipv6-plan';
import { createStatusCache, readTailscaleStatus } from './net/tailscale-status';
import type { TailscaleStatus } from './net/tailscale-status';
import { createTapDevices } from './net/tap-devices';
import { createNetworkService } from './networks/network-service';
import { printLog } from './process/print-log';
import { startTicker } from './process/ticker';
import { waitWithin } from './process/wait-within';
import { createForwardedPeers } from './proxy/forwarded-peers';
import { startWakeProxy } from './proxy/wake-proxy';
import type { WakeProxy } from './proxy/wake-proxy';
import { readErrorMessage } from './read-error-message';
import { UNKNOWN_VERSION, readHostIdentity } from './sleep/vm-identity';
import { createAuthorizedKeys } from './ssh/authorized-keys';
import { setupSshDir } from './ssh/host-key';
import { startSsh } from './ssh/start-ssh';
import { createStorageBackend } from './storage/create-storage-backend';
import { createDiskBudget } from './storage/disk-budget';
import { createDiskUsageCache } from './storage/disk-usage-cache';
import { readLiveStorage } from './storage/read-live-storage';
import { setupSystemFiles } from './storage/setup-system-files';
import { createStorageGate } from './storage/storage-gate';
import { createStorageGc } from './storage/storage-gc';
import { buildTailnetNames } from './tailnet-names/build-tailnet-names';
import type { TailnetNames } from './tailnet-names/tailnet-names';
import { startImpTelemetry } from './telemetry/imp-telemetry';
import { startOtlpExport } from './telemetry/start-otlp-export';
import { loadOrCreateToken } from './token';
import { createCpuCgroups } from './vmm/cpu-cgroups';
import { createVmRunner } from './vmm/vm-runner';

// the whole stop, within the 120 s that scripts/dev.sh gives `docker stop`
const STOP_DEADLINE_MS = 100_000;

// at most per step before the sleep pass, which gets whatever is left
const STOP_STEP_MAX_MS = 10_000;
const BODY_SLACK_BYTES = 1024 ** 2;

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

// tailnet identity, when IMP_TAILNET_IDENTITIES has rules; both ask about
// the node on every request, so they share one cached status
function buildTailnetAccess(config: Config, readStatus: () => Promise<TailscaleStatus>) {
  if (config.tailnetRules === null) {
    return null;
  }

  const readTailscale = createStatusCache(readStatus, Date.now);

  return {
    identities: createTailnetIdentities({
      rules: config.tailnetRules,
      whois: runWhois,
      readTailscale,
      now: Date.now,
    }),
    knownHosts: createKnownHosts({
      readTailscale,
      domain: config.https?.domain ?? null,
    }),
  };
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
  const zfsCommitDelayMs = config.storageBackend === 'zfs' ? 20_000 : 0;

  const diskBudget = createDiskBudget({
    storage,
    reserveBytes: config.diskReserveBytes,
    releaseDelayMs: zfsCommitDelayMs,
    log: printLog,
  });

  const images = createImageService({ config, db, storage, storageGate, diskBudget });
  const diskUsage = createDiskUsageCache({ db, storage, log: printLog });

  const ipv6 = await resolveIpv6Plan(config.ipv6, {
    readDefaultRoute: readIpv6DefaultRoute,
    readUlaPrefix: () => readOrCreateUlaPrefix(join(config.dataDir, 'net', 'ipv6-ula')),
    checkHostRules: () => checkHostRules6(),
    runNft,
    log: printLog,
  });

  const broker = await createBroker({ config, db, log: printLog, ipv6 });

  // the firewall and its resolver, before any VM is adopted, booted or woken
  const egress = createEgressService({
    config,
    db,
    ipv6,
    log: printLog,
    isGranted: broker.isGranted,
    closeTunnels: broker.closeTunnels,
  });

  await egress.start();

  const proxyHolder: { proxy: WakeProxy | null } = { proxy: null };
  const publicRecords = createPublicRecordsLink();
  const namesHolder: { names: TailnetNames | null } = { names: null };
  const readTailscale = () => readTailscaleStatus(config.tailscaleEnabled);
  const cgroups = createCpuCgroups({ root: '/sys/fs/cgroup', log: printLog });

  if (!cgroups.isEnforced) {
    printLog('impd: no cpu controller under /sys/fs/cgroup/imps; CPU limits are kept, not applied');
  }

  // spawns Firecracker once per version flag; system.info reuses it
  const identity = readHostIdentity(config.firecrackerBin, systemFiles, ipv6?.prefix.text ?? null);

  const governed = createGovernedImps({
    cgroups,
    config,
    db,
    images,
    taps: createTapDevices(),
    vms: createVmRunner(),
    storage,
    identity,
    ipv6,
    log: printLog,
    readExecEnv: broker.readExecEnv,
    storageGate,
    diskBudget,
    readDiskUsage: diskUsage.read,
    egress,
    readServiceUrl: (name) => namesHolder.names?.readUrl(name) ?? null,
    readTailnetHostname: async () => {
      const status = await readTailscale();

      return status.hostname;
    },
  });

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
    // storage comes or goes with an imp or a checkpoint
    if (write.kind !== 'changed') {
      diskUsage.requestRefresh();
    }

    if (isImpSetWrite(write)) {
      void proxyHolder.proxy?.syncListeners();
      void broker.applyGrants();
      void namesHolder.names?.runSync();
    }
  });

  await imps.reconcileImps();

  // templates this host no longer boots go first, so their drives can too
  for (const key of imps.bootTemplates?.removeStale() ?? []) {
    printLog(`impd: removed boot template ${key.slice(0, 12)}: this host boots something else`);
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
    printLog(`impd: removed system drive ${name}: no imp uses it`);
  }

  const checkpoints = createCheckpointService({ config, db, imps, storage, diskBudget });
  const templates = createTemplateService({ config, db, imps, storage, storageGate, diskBudget });
  const networks = createNetworkService({ db, egress });

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
          networks,
          storageGate,
          diskBudget,
        });

  const gc = createStorageGc({ db, storage, storageGate, log: printLog });
  const state = { ready: false };
  const audit = createApiAudit({ db, now: Date.now, log: printLog });
  const revocations = createRevocations();

  // a key in this file cannot be bound to a token, so the gateway and the
  // token store read the same one
  const authorizedKeys = createAuthorizedKeys(
    join(setupSshDir(config.dataDir), 'authorized_keys'),
    printLog,
  );

  const tokens = await loadTokenStore({
    db,
    rootToken: token,
    now: Date.now,
    onRemove: revocations.revoke,
    isFileKey: authorizedKeys.isListed,
  });

  const peers = createForwardedPeers(Date.now);

  const tailnetNames =
    config.tailnetNames === null
      ? null
      : buildTailnetNames({
          names: config.tailnetNames,
          config,
          db,
          imps,
          readTailscale,
          log: printLog,
        });

  namesHolder.names = tailnetNames;

  const moves = createMoveService({
    config,
    db,
    dataDir: config.dataDir,
    storage,
    storageGate,
    diskBudget,
    imps,
    grants: broker,
    egress,
    readTailnetIp: async () => {
      const status = await readTailscale();

      return status.ip;
    },
    releaseName: async () => {
      await tailnetNames?.runSync();
    },
    onCommitted: () => {
      void tailnetNames?.runSync();
    },
    now: Date.now,
    log: printLog,
  });

  await moves.recover();

  const api = buildApp({
    config,
    db,
    rootToken: token,
    tokens,
    revocations,
    peers,
    tailnet: buildTailnetAccess(config, readTailscale),
    imps,
    images,
    governor,
    checkpoints,
    templates,
    backups,
    broker,
    egress,
    networks,
    firecrackerVersion:
      identity.firecrackerVersion === UNKNOWN_VERSION ? null : identity.firecrackerVersion,
    systemFiles: systemFiles.info,
    storage,
    diskBudget,
    gc,
    readTailscale,
    readTailnetNames: tailnetNames === null ? null : tailnetNames.readStatus,
    publicRecords,
    isReady: () => state.ready,
    now: Date.now,
    log: printLog,
    audit,
    buildContexts: createBuildContextRoute({ config, images, diskBudget, audit, now: Date.now }),
    moves,
  });

  // Bun refuses a larger body before any route sees it; the slack leaves the
  // build route room to answer 413 itself
  const app = api.app.listen({
    port: config.apiPort,
    maxRequestBodySize: Math.max(config.buildContextMaxBytes, MOVE_PART_BYTES) + BODY_SLACK_BYTES,
  });

  console.log(`impd: api on :${String(config.apiPort)}, data in ${config.dataDir}`);

  const proxy = startWakeProxy({ config, db, imps, log: printLog, peers });

  proxyHolder.proxy = proxy;

  await proxy.syncListeners();

  const https =
    config.https === null
      ? null
      : buildHttpsService({
          config: config.https,
          dataDir: config.dataDir,
          db,
          proxy,
          readTailscale: config.tailscaleEnabled ? readTailscale : null,
          log: printLog,
        });

  if (https !== null) {
    publicRecords.attach(https);
    https.start();
  }

  // in the background: an API or tailscaled outage never holds up impd
  void tailnetNames?.runSync();

  const brokerPort = await broker.listen(config.brokerPort);

  console.log(`impd: credential broker on :${String(brokerPort)} of every imp's gateway`);

  const ssh = await startSsh({
    config,
    db,
    imps,
    authorizedKeys,
    tokens,
    revocations,
    log: printLog,
    audit,
    now: Date.now,
  });

  const idle = createIdleLoop({ config, db, imps, log: printLog });

  const tickers = [
    startTicker('idle', 2000, idle.runCheck, printLog),
    startTicker('governor', 5000, governor.enforce, printLog),
    startTicker('resources', 5000, imps.sampleResources, printLog),

    // listeners follow creates and destroys; this catches anything missed
    startTicker('proxy', 30_000, proxy.syncListeners, printLog),

    ...(tailnetNames === null
      ? []
      : [
          // names follow creates and destroys; this repairs what failed
          startTicker('tailnet-names', 600_000, tailnetNames.runSync, printLog),
        ]),

    // terminators follow grants; this also renews leaves near their end
    startTicker('broker', 60_000, broker.applyGrants, printLog),

    // what a crash or a failed removal left; start sweeps the same way
    startTicker('gc', 3_600_000, gc.runScheduled, printLog),

    // FIEMAP over every file on XFS: often enough for `imp ls`
    startTicker('disk-usage', 300_000, diskUsage.runPass, printLog),
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

  // the first usage numbers soon after start, not a ticker interval later
  diskUsage.requestRefresh();

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

  // SIGTERM and SIGINT (container stop): every running imp goes to sleep, so a container
  // restart keeps memory. SIGHUP (impd restart in place): VMs keep running and the next impd
  // re-adopts them (docs/architecture/sleep-and-wake.md#restarts).
  const stop = async (sleepImps: boolean) => {
    const started = performance.now();
    const readLeftMs = () => Math.max(0, STOP_DEADLINE_MS - (performance.now() - started));
    const readStepMs = () => Math.min(STOP_STEP_MAX_MS, readLeftMs());

    diskUsage.stop();

    await runStopStep('tickers', readStepMs(), () =>
      Promise.all(tickers.map((ticker) => ticker.stop())),
    );

    if (https !== null) {
      await runStopStep('https', readStepMs(), () => https.stop());
    }

    await runStopStep('proxy', readStepMs(), () => proxy.stop());
    await runStopStep('broker', readStepMs(), () => broker.stop());

    egress.stop();

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

    // a build cut short leaves a Firecracker no record knows
    await runStopStep(
      'templates',
      readStepMs(),
      () => imps.bootTemplates?.stop() ?? Promise.resolve(),
    );

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
