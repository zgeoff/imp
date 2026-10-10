import { join } from 'node:path';
import * as z from 'zod';
import { config } from './config';
import { buildFirecrackerPgrepArgv, readFirecrackerPids } from './firecracker-pids';

// the harness drives scripts/dev.sh and scripts/imp from this checkout
export const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
export const FIXTURES_DIR = join(REPO_ROOT, 'test', 'e2e', 'fixtures');
export const LIB_SCRIPT = join(REPO_ROOT, 'scripts', 'lib.sh');
const DEV_SCRIPT = join(REPO_ROOT, 'scripts', 'dev.sh');
const offset = Number(process.env['IMP_DEV_PORT_OFFSET'] ?? '0');

// with the default name, an offset run would drive and wipe imp-dev, not its own instance
if (offset !== 0 && (process.env['IMP_DEV_NAME'] ?? '') === '') {
  throw new Error('IMP_DEV_PORT_OFFSET needs IMP_DEV_NAME: name the instance it belongs to');
}

// A dev instance (scripts/dev.sh) and where it listens
export interface DevInstance {
  readonly container: string;

  // mounted at /data in the container
  readonly dataDir: string;
  readonly apiUrl: string;
  readonly proxyPort: number;
  readonly impPortBase: number;

  // the SSH gateway, published on localhost by scripts/dev.sh
  readonly sshPort: number;

  // IMP_DEV_PORT_OFFSET, for what else instances side by side must not share
  readonly portOffset: number;

  // what scripts/dev.sh reads for this instance, over this process's env;
  // each call passes it, so no instance's settings leak into another's
  readonly env: Readonly<Record<string, string>>;
}

// The run's own instance. Every published port shifts by
// IMP_DEV_PORT_OFFSET, so worktrees run instances side by side.
export const instance: DevInstance = {
  container: process.env['IMP_DEV_NAME'] ?? 'imp-dev',
  dataDir: process.env['IMP_DEV_DATA'] ?? join(REPO_ROOT, '.data', 'dev'),
  apiUrl: process.env['IMP_URL'] ?? `http://localhost:${String(7070 + offset)}`,
  proxyPort: 7080 + offset,
  impPortBase: 20_000 + offset,
  sshPort: 2222 + offset,

  // IMP_DEV_PORT_OFFSET, for what else instances side by side must not share
  portOffset: offset,
  env: {},
};

export interface InstanceOptions {
  readonly container: string;
  readonly dataDir: string;

  // a Docker network and the address on it: the instance publishes no
  // ports, and answers there only
  readonly network: string;
  readonly ip: string;

  // tuning for impd, passed through scripts/dev.sh
  readonly env?: Readonly<Record<string, string>>;
}

// Another instance beside the run's own, such as a move's second host
export function createInstance(options: InstanceOptions): DevInstance {
  return {
    container: options.container,
    dataDir: options.dataDir,
    apiUrl: `http://${options.ip}:7070`,
    proxyPort: 7080,
    impPortBase: 20_000,
    sshPort: 22,
    portOffset: 0,
    env: {
      ...options.env,
      IMP_DEV_NAME: options.container,
      IMP_DEV_DATA: options.dataDir,
      IMP_DEV_PORT_OFFSET: '0',
      IMP_DEV_NETWORK: options.network,
      IMP_DEV_IP: options.ip,
      IMP_DEV_PUBLISH: '0',
    },
  };
}

const HealthSchema = z.object({ ready: z.boolean() });

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// stdin is closed unless given
export async function runCommand(
  argv: readonly string[],
  options: Readonly<{ stdin?: string; env?: Readonly<Record<string, string>> }> = {},
): Promise<CommandResult> {
  const proc = Bun.spawn([...argv], {
    stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

export async function runChecked(argv: readonly string[]): Promise<string> {
  const result = await runCommand(argv);

  if (result.exitCode !== 0) {
    const output = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();

    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${output}`);
  }

  return result.stdout;
}

// The dev host image as scripts/lib.sh picks it: IMP_HOST_IMAGE, else this
// checkout's own tag (dev_image_tag). main.ts reads it once into the env, so
// dev.sh, the suites and the harness all name the same image.
export async function readHostImage(): Promise<string> {
  const stdout = await runChecked([
    'bash',
    '-c',
    'source "$1" && printf "%s" "$IMP_HOST_IMAGE"',
    'bash',
    LIB_SCRIPT,
  ]);

  return stdout.trim();
}

// the host image main.ts put in the env (readHostImage)
export function getHostImage(): string {
  const image = process.env['IMP_HOST_IMAGE'] ?? '';

  if (image === '') {
    throw new Error('IMP_HOST_IMAGE is not set: run the suites through scripts/test-e2e.sh');
  }

  return image;
}

// Passes dev.sh's output through, so a slow `up` shows progress. impd gets
// the run's RAM budget and idle timeout (config.ts), then the tuning
// variables in this process's env, then the instance's, then the call's.
export async function runDevScript(
  command: string,
  target: DevInstance = instance,
  env: Readonly<Record<string, string>> = {},
): Promise<void> {
  // Bun.spawn's default env is the one the process started with, not
  // process.env as changed since
  const proc = Bun.spawn([DEV_SCRIPT, command], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      IMP_RAM_BUDGET_MIB: String(config.ramBudgetMib),
      IMP_IDLE_TIMEOUT_S: String(config.idleTimeoutS),
      ...process.env,
      ...target.env,
      ...env,
    },
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`scripts/dev.sh ${command} exited ${String(exitCode)}`);
  }
}

export async function readToken(target: DevInstance = instance): Promise<string> {
  const result = await runCommand([DEV_SCRIPT, 'token'], { env: target.env });

  if (result.exitCode !== 0) {
    throw new Error(`scripts/dev.sh token exited ${String(result.exitCode)}: ${result.stderr}`);
  }

  return result.stdout.trim();
}

export function runInContainer(
  argv: readonly string[],
  target: DevInstance = instance,
): Promise<CommandResult> {
  return runCommand(['docker', 'exec', target.container, ...argv]);
}

// This machine as the container sees it. Guests reach it through FORWARD
// and MASQUERADE: #26's egress policies must keep that route open, or the
// ssh-agent suite cannot reach its git server.
export async function readContainerGateway(): Promise<string> {
  const route = await runInContainer(['ip', '-4', 'route', 'show', 'default']);

  const gateway = /via (?<ip>[\d.]+)/.exec(route.stdout)?.groups?.['ip'];

  if (gateway === undefined) {
    throw new Error(`no default route in ${instance.container}: ${route.stdout}`);
  }

  return gateway;
}

export async function readImpdLogTail(lines: number): Promise<string> {
  const result = await runCommand(['docker', 'logs', '--tail', String(lines), instance.container]);

  return `${result.stdout}${result.stderr}`;
}

// what impd logged from `since` on; throws when docker cannot read the log,
// as an empty log would read as a clean one
export async function readImpdLogSince(since: Readonly<Date>): Promise<string> {
  const argv = ['docker', 'logs', '--since', since.toISOString(), instance.container];

  const result = await runCommand(argv);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return `${result.stdout}${result.stderr}`;
}

// The milliseconds impd logged for an operation: the newest log line that
// contains the text and ends in `in <n>ms`, or null.
export async function readImpdLoggedMs(text: string): Promise<number | null> {
  const result = await runCommand(['docker', 'logs', instance.container]);

  const lines = `${result.stdout}${result.stderr}`
    .split('\n')
    .filter((line) => line.includes(text));

  const match = /in (?<ms>\d+)ms$/.exec(lines.at(-1)?.trim() ?? '');
  const ms = match?.groups?.['ms'];

  return ms === undefined ? null : Number(ms);
}

// Firecracker's argv holds the imp's directory (imps/<id>/run/api.sock)
export async function checkFirecrackerRunning(id: string): Promise<boolean> {
  const result = await runInContainer(buildFirecrackerPgrepArgv(id));

  return result.exitCode === 0;
}

// SIGKILL to the imp's Firecracker, as a crash would end it; throws when
// none runs
export async function stopFirecrackerHard(id: string): Promise<void> {
  const found = await runInContainer(buildFirecrackerPgrepArgv(id));

  const pids = readFirecrackerPids(id, found.stdout);

  await runChecked(['docker', 'exec', instance.container, 'kill', '-9', ...pids]);
}

// null between an old impd exiting and the new one starting
export async function findImpdPid(): Promise<string | null> {
  const result = await runInContainer(['pgrep', '-f', 'bun .*/daemon/src/main.ts']);

  const pid = result.stdout.split('\n')[0]?.trim() ?? '';

  return pid === '' ? null : pid;
}

export async function checkHealthReady(target: DevInstance = instance): Promise<boolean> {
  try {
    const response = await fetch(`${target.apiUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });

    const body: unknown = await response.json();

    const health = HealthSchema.safeParse(body);

    return response.ok && health.success && health.data.ready;
  } catch {
    // impd is down mid-restart
    return false;
  }
}
