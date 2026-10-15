import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StartCliOptions {
  readonly args: readonly string[];

  // the CLI's whole environment beside PATH, so no variable of the test run
  // (IMP_URL, IMP_TOKEN, a saved host's HOME) reaches it unasked; without a
  // HOME here the CLI gets an empty one of its own
  readonly env?: Readonly<Record<string, string>>;

  // piped in, then closed; no stdin at all when left out
  readonly stdin?: string;
}

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const MAIN = join(import.meta.dir, '..', 'main.ts');

// Starts the real `impz` binary as a user runs it: `bun main.ts <args>`, with
// stdout and stderr piped. The caller owns the process. Without a HOME the CLI
// finds the developer's own, so its default HOME is a temp dir, gone on exit.
export function startCli(options: StartCliOptions) {
  const home = mkdtempSync(join(tmpdir(), 'impz-cli-home-'));

  const child = Bun.spawn(['bun', MAIN, ...options.args], {
    env: { PATH: process.env['PATH'] ?? '', HOME: home, ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  void removeOnExit(child.exited, home);

  return child;
}

async function removeOnExit(exited: Promise<number>, dir: string): Promise<void> {
  try {
    await exited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Runs the real `impz` binary to its exit and returns what it printed and its
// exit code.
export async function runCli(options: StartCliOptions): Promise<CliResult> {
  const child = startCli(options);

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, code };
}
