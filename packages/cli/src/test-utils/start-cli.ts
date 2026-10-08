import { join } from 'node:path';

export interface StartCliOptions {
  readonly args: readonly string[];

  // the CLI's whole environment beside PATH, so no variable of the test run
  // (IMP_URL, IMP_TOKEN, a saved host's HOME) reaches it unasked
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

// Starts the real `imp` binary as a user runs it: `bun main.ts <args>`, with
// stdout and stderr piped. The caller owns the process.
export function startCli(options: StartCliOptions) {
  return Bun.spawn(['bun', MAIN, ...options.args], {
    env: { PATH: process.env['PATH'] ?? '', ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

// Runs the real `imp` binary to its exit and returns what it printed and its
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
