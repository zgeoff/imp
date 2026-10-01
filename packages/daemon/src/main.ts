import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './build-app';
import { loadConfig } from './config';
import { openDatabase } from './db/open-database';
import { loadOrCreateToken } from './token';

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  mkdirSync(join(config.dataDir, 'db'), { recursive: true });

  const db = await openDatabase(join(config.dataDir, 'db', 'imp.sqlite'));

  const token = loadOrCreateToken(config.dataDir);
  const app = buildApp({ config, db, token }).listen(config.apiPort);

  console.log(`impd: api on :${String(config.apiPort)}, data in ${config.dataDir}`);

  const stop = async () => {
    await app.stop();
    await db.destroy();

    process.exit(0);
  };

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

await main();
