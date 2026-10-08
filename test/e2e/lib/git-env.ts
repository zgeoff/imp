import type { CommandResult } from './instance';

// What `git rev-parse --local-env-vars` lists: the variables that tie git to
// one repository. A git hook exports them (GIT_DIR above all), and a git
// child that inherits them works on that repository whatever its -C says.
export const GIT_REPO_ENV_VARS: readonly string[] = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

// env without the repository variables, so a git child finds its own repo
export function createGitFreeEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const free: Record<string, string> = {};

  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !GIT_REPO_ENV_VARS.includes(name)) {
      free[name] = value;
    }
  }

  return free;
}

export interface GitCommandOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

// Runs git, or a tool that runs git, with this process's env minus the
// repository variables, then the call's env.
export async function runGitCommand(
  argv: readonly string[],
  options: Readonly<GitCommandOptions> = {},
): Promise<CommandResult> {
  const proc = Bun.spawn([...argv], {
    stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...createGitFreeEnv(process.env), ...options.env },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

// runGitCommand, rejecting on a non-zero exit; resolves with stdout
export async function runGitChecked(argv: readonly string[]): Promise<string> {
  const result = await runGitCommand(argv);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return result.stdout;
}
