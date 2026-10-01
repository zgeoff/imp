export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Runs argv to completion and captures its output; never throws on a
// non-zero exit.
export async function runCommand(argv: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
}

// Like runCommand, but throws with stderr on a non-zero exit.
export async function runChecked(argv: readonly string[]): Promise<string> {
  const result = await runCommand(argv);

  if (result.exitCode !== 0) {
    throw new Error(
      `${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  return result.stdout;
}
