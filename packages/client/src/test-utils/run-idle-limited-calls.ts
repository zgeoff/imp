// A child Bun's two SDK calls to impd at `url`, under its
// BUN_CONFIG_HTTP_IDLE_TIMEOUT: `backups.run`, a long call, and `imps.list`,
// an ordinary one. Each outcome is a JSON line.
import { z } from 'zod';
import { createImpClient } from '../create-imp-client';

const ArgsSchema = z.object({ url: z.url() });
const args = ArgsSchema.parse(JSON.parse(process.argv[2] ?? ''));
const client = createImpClient({ url: args.url, token: 'root-token' });

function print(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function runCall(kind: string, call: () => Promise<unknown>): Promise<void> {
  try {
    const answer = await call();

    print({ kind, isOk: true, answer });
  } catch (error) {
    print({ kind, isOk: false, error: error instanceof Error ? error.name : 'unknown' });
  }
}

await Promise.all([
  runCall('backups.run', () => client.backups.run()),
  runCall('imps.list', () => client.imps.list()),
]);

process.exit(0);
