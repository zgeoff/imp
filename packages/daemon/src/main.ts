import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './build-app';
import { loadConfig } from './config';
import { openDatabase } from './db/open-database';
import { createImageService } from './images/image-service';
import { createImpService } from './imps/imp-service';
import { createTapDevices } from './net/tap-devices';
import { setupSystemFiles } from './storage/setup-system-files';
import { loadOrCreateToken } from './token';
import { readFirecrackerVersion } from './vmm/firecracker-process';
import { createVmRunner } from './vmm/vm-runner';

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  mkdirSync(join(config.dataDir, 'db'), { recursive: true });
  setupSystemFiles(config);

  const db = await openDatabase(join(config.dataDir, 'db', 'imp.sqlite'));

  const token = loadOrCreateToken(config.dataDir);
  const images = createImageService({ config, db });

  const imps = createImpService({
    config,
    db,
    images,
    taps: createTapDevices(),
    vms: createVmRunner(),
  });

  await imps.reconcileImps();

  const state = { ready: false };

  const app = buildApp({
    config,
    db,
    token,
    imps,
    images,
    firecrackerVersion: readFirecrackerVersion(config.firecrackerBin),
    isReady: () => state.ready,
  }).listen(config.apiPort);

  console.log(`impd: api on :${String(config.apiPort)}, data in ${config.dataDir}`);

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

  const stop = async () => {
    await app.stop();
    await db.destroy();

    process.exit(0);
  };

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

await main();
