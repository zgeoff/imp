import { mkdirSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import { openDatabase } from './db/open-database';
import { ENFORCE_INTERVAL_MS } from './governor/ram-governor';
import { buildHttpsService } from './https/build-https-service';
import { createIdleLoop } from './idle/idle-loop';
import { readSetfcapWarning } from './images/unpack-export';
import { MOVE_PART_BYTES } from './moves/move-parts';
import { startPublicListener } from './oauth/public-listener';
import { printLog } from './process/print-log';
import { startTicker } from './process/ticker';
import { waitWithin } from './process/wait-within';
import { startWakeProxy } from './proxy/wake-proxy';
import { readErrorMessage } from './read-error-message';
import { startSsh } from './ssh/start-ssh';
import { createStorageBackend } from './storage/create-storage-backend';
import { setupSystemFiles } from './storage/setup-system-files';
import { startOtlpExport } from './telemetry/start-otlp-export';
import { loadOrCreateToken } from './token';
import { checkKsmHost, readKsmHostStats } from './vmm/ksm';

// the whole stop, within the 120 s that scripts/dev.sh gives `docker stop`
const STOP_DEADLINE_MS = 100_000;

// at most per step before the sleep pass, which gets whatever is left
const STOP_STEP_MAX_MS = 10_000;

// the broker's stop waits for a token exchange under way (30 s at most) and
// its write, so a rotated refresh token is stored before the database closes
const STOP_BROKER_MAX_MS = 40_000;
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

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  for (const warning of config.warnings) {
    printLog(`impd: warning: ${warning}`);
  }

  if (config.ksm !== null) {
    const ksm = readKsmHostStats();
    const refusal = checkKsmHost(release(), ksm);

    if (refusal !== null) {
      throw new Error(refusal);
    }

    if (ksm?.running === false) {
      printLog('impd: IMP_KSM is on, but ksmd does not run (/sys/kernel/mm/ksm/run is 0)');
    }
  }

  // before any instrument is made: a meter taken earlier stays a no-op
  const stopExport = await startOtlpExport(process.env, packageJson.version);

  mkdirSync(join(config.dataDir, 'db'), { recursive: true });

  const systemFiles = await setupSystemFiles(config);

  // a start-time hint; an image with a file capability still fails its build
  const setfcapWarning = readSetfcapWarning();

  if (setfcapWarning !== null) {
    printLog(setfcapWarning);
  }

  const db = await openDatabase(join(config.dataDir, 'db', 'imp.sqlite'));

  const token = loadOrCreateToken(config.dataDir);
  const storage = createStorageBackend(config);

  const impd = await createImpd(config, { db, rootToken: token, storage, systemFiles });

  // Bun refuses a larger body before any route sees it; the slack leaves the
  // build route room to answer 413 itself
  const app = impd.api.app.listen({
    port: config.apiPort,
    maxRequestBodySize: Math.max(config.buildContextMaxBytes, MOVE_PART_BYTES) + BODY_SLACK_BYTES,
  });

  console.log(`impd: api on :${String(config.apiPort)}, data in ${config.dataDir}`);

  // off unless the operator names the route's origin
  const publicMcp =
    config.publicMcp === null
      ? null
      : startPublicListener(
          { config: config.publicMcp, oauth: impd.oauth, mcp: impd.api.publicMcp },
          printLog,
        );

  const proxy = startWakeProxy({ config, db, imps: impd.imps, log: printLog, peers: impd.peers });

  impd.proxyHolder.proxy = proxy;

  await proxy.syncListeners();

  const https =
    config.https === null
      ? null
      : buildHttpsService({
          config: config.https,
          dataDir: config.dataDir,
          db,
          proxy,
          readTailscale: config.tailscaleEnabled ? impd.readTailscale : null,
          dnsToken: impd.dnsToken,
          log: printLog,
        });

  if (https !== null) {
    impd.publicRecords.attach(https);
    https.start();
  }

  // in the background: an API or tailscaled outage never holds up impd
  void impd.tailnetNames?.runSync();

  const brokerPort = await impd.broker.listen(config.brokerPort);

  console.log(`impd: credential broker on :${String(brokerPort)} of every imp's gateway`);

  const ssh = await startSsh({
    config,
    db,
    imps: impd.imps,
    authorizedKeys: impd.authorizedKeys,
    tokens: impd.tokens,
    revocations: impd.revocations,
    log: printLog,
    audit: impd.audit,
    now: Date.now,
  });

  const idle = createIdleLoop({ config, db, imps: impd.imps, log: printLog });

  const tickers = [
    startTicker('idle', 2000, idle.runCheck, printLog),
    startTicker('oauth-expiry', 3_600_000, impd.oauth.removeExpired, printLog),
    startTicker('governor', ENFORCE_INTERVAL_MS, impd.governor.enforce, printLog),
    startTicker('resources', 5000, impd.imps.sampleResources, printLog),
    startTicker('session-logs', 60_000, impd.imps.sweepSessionLogs, printLog),

    // elastic guests grow within a second of running low
    startTicker('memory', 500, impd.governed.memory.runTick, printLog),

    // listeners follow creates and destroys; this catches anything missed
    startTicker('proxy', 30_000, proxy.syncListeners, printLog),

    ...(impd.tailnetNames === null
      ? []
      : [
          // names follow creates and destroys; this repairs what failed
          startTicker('tailnet-names', 600_000, impd.tailnetNames.runSync, printLog),
        ]),

    // terminators follow grants; this also renews leaves near their end
    startTicker('broker', 60_000, impd.broker.applyGrants, printLog),

    // what a crash or a failed removal left; start sweeps the same way
    startTicker('gc', 3_600_000, impd.gc.runScheduled, printLog),

    // FIEMAP over every file on XFS: often enough for `imp ls`
    startTicker('disk-usage', 300_000, impd.diskUsage.runPass, printLog),
    ...(impd.backups === null
      ? []
      : [
          startTicker(
            'backup',

            // a run is due by the time since the last one, so a restart
            // never puts it off by a whole interval
            Math.min(config.backup?.intervalS ?? 0, 300) * 1000,
            impd.backups.runScheduled,
            printLog,
          ),
        ]),
  ];

  // the first usage numbers soon after start, not a ticker interval later
  impd.diskUsage.requestRefresh();

  // ready either way: a failed seed leaves `imp image add` to the user
  const setupDefaultImage = async (): Promise<void> => {
    try {
      await impd.images.seedDefaultImage();

      const existing = await impd.images.listImages();

      if (!existing.some((image) => image.name === config.defaultImage)) {
        printLog(
          `impd: warning: no image named ${config.defaultImage} (IMP_DEFAULT_IMAGE); imp new uses ubuntu until \`imp image add <ref> --name ${config.defaultImage}\` adds it`,
        );
      }
    } catch (error) {
      console.error('impd: could not add the default image:', error);
    } finally {
      impd.state.ready = true;
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

    impd.diskUsage.stop();

    await runStopStep('tickers', readStepMs(), () =>
      Promise.all(tickers.map((ticker) => ticker.stop())),
    );

    if (https !== null) {
      await runStopStep('https', readStepMs(), () => https.stop());
    }

    await runStopStep('proxy', readStepMs(), () => proxy.stop());

    await runStopStep('broker', Math.min(STOP_BROKER_MAX_MS, readLeftMs()), () =>
      impd.broker.stop(),
    );

    impd.egress.stop();

    // before the sleep pass, as exec sessions are: a client sees its
    // connection end instead of hanging while its imp sleeps
    await runStopStep('ssh', readStepMs(), () => ssh?.stop() ?? Promise.resolve());

    impd.api.closeExecSessions();

    if (publicMcp !== null) {
      await runStopStep('public-mcp', readStepMs(), () => publicMcp.stop());
    }

    await runStopStep('api', readStepMs(), () => app.stop(true));

    // either way, a wake or boot under way finishes first: one cut short
    // leaves a Firecracker that no record knows
    const settled = sleepImps
      ? await runStopStep('sleep', readLeftMs(), () => impd.imps.sleepAllImps())
      : await runStopStep('lifecycle', readLeftMs(), () => impd.imps.waitForLifecycle());

    // a build cut short leaves a Firecracker no record knows
    await runStopStep(
      'templates',
      readStepMs(),
      () => impd.imps.bootTemplates?.stop() ?? Promise.resolve(),
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
