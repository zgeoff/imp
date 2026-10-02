import { join } from 'node:path';
import * as z from 'zod';
import type { CommandResult } from './instance';
import { REPO_ROOT, instance, readToken, runCommand } from './instance';

const IMP_SCRIPT = join(REPO_ROOT, 'scripts', 'imp');

// The CLI's JSON output, with only the fields the suites read. Dates arrive
// as ISO strings.
const ImpStateSchema = z.enum(['creating', 'running', 'sleeping', 'stopped', 'error']);

const ImpRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  state: ImpStateSchema,
  vcpus: z.number(),
  memoryMib: z.number(),
  slot: z.number(),
  port: z.number(),
  url: z.string(),
  lastActiveAt: z.string(),
  ramMib: z.number().optional(),
});

const SystemInfoSchema = z.object({
  ramBudgetMib: z.number(),
  ramUsedMib: z.number(),
  awakeCount: z.number(),
  impCount: z.number(),
  tailscale: z.object({
    state: z.string().nullable(),
    hostname: z.string().nullable(),
    ip: z.string().nullable(),
  }),
});

const CheckpointRowSchema = z.object({ id: z.string(), label: z.string().optional() });

export type ImpState = z.infer<typeof ImpStateSchema>;

export type ImpRow = z.infer<typeof ImpRowSchema>;

export type SystemInfo = z.infer<typeof SystemInfoSchema>;

export type CheckpointRow = z.infer<typeof CheckpointRowSchema>;

let token: Promise<string> | null = null;

// From the env when the runner passed it, else read from the dev container
// once, so a suite file also runs on its own.
function readImpToken(): Promise<string> {
  const fromEnv = process.env['IMP_TOKEN'] ?? '';

  if (fromEnv !== '') {
    return Promise.resolve(fromEnv);
  }

  token ??= readToken();

  return token;
}

// the env that points the CLI at the dev instance
export async function readImpEnv(): Promise<Record<string, string>> {
  const impToken = await readImpToken();

  return { IMP_URL: instance.apiUrl, IMP_TOKEN: impToken };
}

// Runs the imp CLI as a user would and returns what happened, failure
// included.
export async function tryImp(
  args: readonly string[],
  options: Readonly<{ stdin?: string }> = {},
): Promise<CommandResult> {
  const env = await readImpEnv();

  return runCommand([IMP_SCRIPT, ...args], { ...options, env });
}

// Runs the imp CLI and returns its stdout, or throws with its stderr.
export async function runImp(...args: readonly string[]): Promise<string> {
  const result = await tryImp(args);

  if (result.exitCode !== 0) {
    throw new Error(
      `imp ${args.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
    );
  }

  return result.stdout;
}

// `imp exec NAME -- ARGV...`, without the final newline
export async function runInImp(name: string, ...argv: readonly string[]): Promise<string> {
  const stdout = await runImp('exec', name, '--', ...argv);

  return stdout.replace(/\n$/, '');
}

export function runShellInImp(name: string, script: string): Promise<string> {
  return runInImp(name, 'sh', '-c', script);
}

export async function listImps(): Promise<readonly ImpRow[]> {
  const stdout = await runImp('ls', '--json');

  return z.array(ImpRowSchema).parse(JSON.parse(stdout));
}

export async function findImp(name: string): Promise<ImpRow | undefined> {
  const rows = await listImps();

  return rows.find((row) => row.name === name);
}

export async function requireImp(name: string): Promise<ImpRow> {
  const row = await findImp(name);

  if (row === undefined) {
    throw new Error(`${name} is not in imp ls`);
  }

  return row;
}

export async function readState(name: string): Promise<ImpState> {
  const row = await requireImp(name);

  return row.state;
}

// throws unless the imp is in the state, for use inside waitFor
export async function assertState(name: string, state: ImpState): Promise<void> {
  const actual = await readState(name);

  if (actual !== state) {
    throw new Error(`${name} is ${actual}, not ${state}`);
  }
}

export async function readInfo(): Promise<SystemInfo> {
  const stdout = await runImp('info', '--json');

  return SystemInfoSchema.parse(JSON.parse(stdout));
}

export async function listCheckpoints(name: string): Promise<readonly CheckpointRow[]> {
  const stdout = await runImp('checkpoints', name, '--json');

  return z.array(CheckpointRowSchema).parse(JSON.parse(stdout));
}

// `imp image ls` has no --json: the first column of every row under the header
export async function listImageNames(): Promise<readonly string[]> {
  const stdout = await runImp('image', 'ls');

  const rows = stdout.trim().split('\n').slice(1);

  return rows.map((row) => row.split(/\s+/)[0] ?? '').filter((name) => name !== '');
}
