// A child Bun's builds through imp-docker-proxy, under the idle limit its
// BUN_CONFIG_HTTP_IDLE_TIMEOUT sets, beside an unprotected fetch that starts
// on a `control` line of stdin; a `cancel` line ends the second build.
import { join } from 'node:path';
import { z } from 'zod';
import { createDockerProxy } from '../docker-proxy/proxy';
import { runDockerBuild } from '../images/docker-build';

const ArgsSchema = z.object({
  dir: z.string(),
  buildEngine: z.string(),
  cancelEngine: z.string(),
  controlEngine: z.string(),
});

const args = ArgsSchema.parse(JSON.parse(process.argv[2] ?? ''));
const tarPath = join(args.dir, 'context.tar');

await Bun.write(tarPath, 'the context');

function startProxy(name: string, upstreamSocket: string): string {
  const socket = join(args.dir, `${name}.sock`);

  // as imp-docker-proxy's main serves it; Bun's types leave idleTimeout off
  // unix servers, but it applies there too
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  Bun.serve({
    unix: socket,
    idleTimeout: 0,
    fetch: createDockerProxy({
      upstreamSocket,
      token: 'test-token',
      hostImage: 'ghcr.io/zgeoff/imp-host:latest',

      // host isolation: the proxy lets builds through
      builderImage: null,
      buildContextMaxBytes: 1024 ** 2,
      log: () => {},
    }),
  } as unknown as Bun.Serve.Options<undefined>);

  return `unix://${socket}`;
}

function print(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// a failure by its name and, for a DOMException, its legacy code
function readError(error: unknown): { name: string; code: number | null } {
  if (error instanceof DOMException) {
    // the legacy code tells a timeout (23) from an abort (20) by number
    // oxlint-disable-next-line typescript/no-deprecated -- see above
    return { name: error.name, code: error.code };
  }

  return { name: error instanceof Error ? error.name : 'unknown', code: null };
}

const cancel = new AbortController();

const controlStart = Promise.withResolvers<void>();

async function runControl(): Promise<void> {
  await controlStart.promise;

  try {
    const response = await fetch('http://docker/build', {
      method: 'POST',
      body: 'the context',
      unix: args.controlEngine,
    });

    await response.text();

    print({ kind: 'control', isOk: true });
  } catch (error) {
    print({ kind: 'control', isOk: false, error: readError(error) });
  }
}

async function runBuild(kind: string, upstreamSocket: string, signal: AbortSignal): Promise<void> {
  try {
    const id = await runDockerBuild({
      dockerHost: startProxy(`${kind}-proxy`, upstreamSocket),
      tarPath,
      tag: `imp/${kind}:latest`,
      dockerfile: undefined,
      signal,
    });

    print({ kind, isOk: true, id });
  } catch (error) {
    print({ kind, isOk: false, error: readError(error) });
  }
}

async function readCommands(): Promise<void> {
  for await (const line of console) {
    if (line === 'control') {
      controlStart.resolve();
    }

    if (line === 'cancel') {
      cancel.abort();

      return;
    }
  }
}

await Promise.all([
  runControl(),
  runBuild('build', args.buildEngine, new AbortController().signal),
  runBuild('cancel', args.cancelEngine, cancel.signal),
  readCommands(),
]);

process.exit(0);
