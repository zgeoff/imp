export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  // the whole environment of the child; impd's own by default
  readonly env?: Readonly<Record<string, string>>;

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
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',

    // process.env as it is now: Bun's own default is the env impd started with
    env: options.env === undefined ? process.env : { ...options.env },
    ...(options.signal !== undefined && { signal: options.signal }),
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
}

// what runs a command: runCommand, or a stand-in in tests
export type CommandRunner = (
  argv: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

// Like runCommand, but throws buildExitError's error on a non-zero exit.
// `run` runs the command, runCommand by default.
export async function runChecked(
  argv: readonly string[],
  options: CommandOptions = {},
  run: CommandRunner = runCommand,
): Promise<string> {
  const result = await run(argv, options);

  if (result.exitCode !== 0) {
    throw buildExitError(argv, result);
  }

  return result.stdout;
}

// "<argv> exited <code>: <stderr>", or stdout when stderr is empty
export function buildExitError(
  argv: readonly string[],
  result: Readonly<
    Pick<CommandResult, 'exitCode' | 'stderr'> & Partial<Pick<CommandResult, 'stdout'>>
  >,
): Error {
  const output = result.stderr.trim() || (result.stdout ?? '').trim();

  return new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${output}`);
}
