interface SourcedFunctionCall {
  // the bash script to source, which defines fn
  readonly script: string;
  readonly fn: string;
  readonly args?: readonly string[];
  readonly stdin?: string;

  // the child's whole environment besides PATH, which this process's PATH
  // fills unless env sets it: never this process's tokens
  readonly env?: Readonly<Record<string, string>>;
}

export interface SourcedFunctionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Sources script in a new bash and calls one of its functions, as a script
// that runs main only when executed allows; it never throws on a failed call.
export function runSourcedFunction(call: SourcedFunctionCall): SourcedFunctionResult {
  const result = Bun.spawnSync(
    ['bash', '-c', 'source "$1"; shift; "$@"', 'bash', call.script, call.fn, ...(call.args ?? [])],
    {
      env: { PATH: process.env['PATH'] ?? '', ...call.env },
      stdin: Buffer.from(call.stdin ?? ''),
    },
  );

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
