import { join } from 'node:path';
import * as z from 'zod';

// the harness drives scripts/dev.sh and scripts/imp from this checkout
export const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
export const FIXTURES_DIR = join(REPO_ROOT, 'test', 'e2e', 'fixtures');
const DEV_SCRIPT = join(REPO_ROOT, 'scripts', 'dev.sh');
const offset = Number(process.env['IMP_DEV_PORT_OFFSET'] ?? '0');

// with the default name, an offset run would drive and wipe imp-dev, not its own instance
if (offset !== 0 && (process.env['IMP_DEV_NAME'] ?? '') === '') {
  throw new Error('IMP_DEV_PORT_OFFSET needs IMP_DEV_NAME: name the instance it belongs to');
}

// Where the dev instance (scripts/dev.sh) listens. Every published port
// shifts by IMP_DEV_PORT_OFFSET, so worktrees run instances side by side.
export const instance = {
  container: process.env['IMP_DEV_NAME'] ?? 'imp-dev',
  apiUrl: process.env['IMP_URL'] ?? `http://localhost:${String(7070 + offset)}`,
  proxyPort: 7080 + offset,
  impPortBase: 20_000 + offset,
} as const;

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

// Passes dev.sh's output through, so a slow `up` shows progress. Tuning
// variables in this process's env reach impd.
export async function runDevScript(command: string): Promise<void> {
  // Bun.spawn's default env is the one the process started with, not
  // process.env as changed since
  const proc = Bun.spawn([DEV_SCRIPT, command], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env },
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`scripts/dev.sh ${command} exited ${String(exitCode)}`);
  }
}

export async function readToken(): Promise<string> {
  const token = await runChecked([DEV_SCRIPT, 'token']);

  return token.trim();
}

export function runInContainer(argv: readonly string[]): Promise<CommandResult> {
  return runCommand(['docker', 'exec', instance.container, ...argv]);
}

export async function readImpdLogTail(lines: number): Promise<string> {
  const result = await runCommand(['docker', 'logs', '--tail', String(lines), instance.container]);

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
  const result = await runInContainer(['pgrep', '-f', `firecracker.*imps/${id}/`]);

  return result.exitCode === 0;
}

// null between an old impd exiting and the new one starting
export async function findImpdPid(): Promise<string | null> {
  const result = await runInContainer(['pgrep', '-f', 'bun .*/daemon/src/main.ts']);

  const pid = result.stdout.split('\n')[0]?.trim() ?? '';

  return pid === '' ? null : pid;
}

export async function checkHealthReady(): Promise<boolean> {
  try {
    const response = await fetch(`${instance.apiUrl}/health`, {
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
