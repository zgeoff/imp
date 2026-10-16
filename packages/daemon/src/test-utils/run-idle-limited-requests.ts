// A child Bun's POSTs to `origin` under its BUN_CONFIG_HTTP_IDLE_TIMEOUT:
// `/control` by plain fetch, `/long` by `via` (sendLongRequest, or impd's
// wake proxy with `origin` as its API). Each outcome is a JSON line.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../config';
import { openDatabase } from '../db/open-database';
import { createActivityTracker } from '../imps/activity-tracker';
import { sendLongRequest } from '../process/send-long-request';
import { createForwardedPeers } from '../proxy/forwarded-peers';
import { startWakeProxy } from '../proxy/wake-proxy';

const ArgsSchema = z.object({
  origin: z.url(),
  via: z.enum(['long-request', 'wake-proxy']),
});

const args = ArgsSchema.parse(JSON.parse(process.argv[2] ?? ''));

function print(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function readErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

async function runCall(kind: string, send: () => Promise<Response>): Promise<void> {
  try {
    const response = await send();

    print({ kind, isOk: true, status: response.status, body: await response.text() });
  } catch (error) {
    process.stderr.write(`${kind}: ${String(error)}\n`);

    print({ kind, isOk: false, error: readErrorName(error) });
  }
}

// the wake proxy's own listener, its route impd's API at `origin`
async function startProxy(stack: Readonly<AsyncDisposableStack>): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'idle-limited-proxy-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the origin's free port may fall in the imp ports, which a config refuses
  const config = {
    ...loadConfig({ IMP_DATA_DIR: dataDir }),
    apiPort: Number(new URL(args.origin).port),
  };

  // only an imp route wakes an imp; this one routes to the API alone
  const proxy = startWakeProxy({
    config,
    db,
    imps: {
      requireRunning: () => Promise.reject(new Error('no imp behind this proxy')),
      tracker: createActivityTracker(),
      recordActivity: () => Promise.resolve(),
    },
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  stack.defer(() => proxy.stop());

  const listener = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  stack.defer(() => listener.stop(true));

  return `http://127.0.0.1:${String(listener.port)}`;
}

const stack = new AsyncDisposableStack();

const sendLong =
  args.via === 'long-request'
    ? () =>
        sendLongRequest(
          `${args.origin}/long`,
          { method: 'POST', body: 'the long call' },
          { deadline: null },
        )
    : async () => {
        const proxy = await startProxy(stack);

        // this hop lifts its own limit, so only the proxy's hop is under test
        return fetch(`${proxy}/long`, { method: 'POST', body: 'the long call', timeout: false });
      };

await Promise.all([
  runCall('long', sendLong),
  runCall('control', () =>
    fetch(`${args.origin}/control`, { method: 'POST', body: 'the control call' }),
  ),
]);

await stack.disposeAsync();

process.exit(0);
