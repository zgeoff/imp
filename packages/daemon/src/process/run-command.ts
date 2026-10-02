export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandOptions {
  // the whole environment of the child; impd's own by default
  readonly env?: Readonly<Record<string, string>>;

  // a file the child reads as stdin; none by default
  readonly stdinFile?: string;

  // kills the child when it aborts
  readonly signal?: AbortSignal;
}

// Runs argv to completion and captures its output; never throws on a
// non-zero exit.
export async function runCommand(
  argv: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    stdin: options.stdinFile === undefined ? 'ignore' : Bun.file(options.stdinFile),
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.env !== undefined && { env: { ...options.env } }),
    ...(options.signal !== undefined && { signal: options.signal }),
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
}

// Like runCommand, but throws with stderr on a non-zero exit.
export async function runChecked(
  argv: readonly string[],
  options: CommandOptions = {},
): Promise<string> {
  const result = await runCommand(argv, options);

  if (result.exitCode !== 0) {
    throw new Error(
      `${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  return result.stdout;
}
