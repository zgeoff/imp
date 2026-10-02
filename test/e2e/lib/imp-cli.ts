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
  sessions: z.number().optional(),
});

const SystemInfoSchema = z.object({
  ramBudgetMib: z.number(),
  ramUsedMib: z.number(),
  ramReservedMib: z.number(),
  awakeCount: z.number(),
  impCount: z.number(),
  storage: z.object({ backend: z.enum(['xfs', 'zfs']) }),
  tailscale: z.object({
    state: z.string().nullable(),
    hostname: z.string().nullable(),
    ip: z.string().nullable(),
  }),
});

const CheckpointRowSchema = z.object({ id: z.string(), label: z.string().optional() });
const ImageRowSchema = z.object({ name: z.string() });

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

// A long-running imp command, such as `imp events`, as a child the test reads
// and kills
export async function startImp(...args: readonly string[]) {
  const env = await readImpEnv();

  return Bun.spawn([IMP_SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

// `imp exec NAME -- ARGV...`, without the final newline
export async function runInImp(name: string, ...argv: readonly string[]): Promise<string> {
  const stdout = await runImp('exec', name, '--', ...argv);

  return stdout.replace(/\n$/, '');
}

export function runShellInImp(name: string, script: string): Promise<string> {
  return runInImp(name, 'sh', '-c', script);
}

export interface ImpUrls {
  readonly https: string | null;
  readonly local: string;
  readonly tailnet: string | null;
}

// `imp url NAME`, read by the shape of each line, not its place: the https
// suite's settings stay for the whole run, so its line may come first
export async function readImpUrls(name: string): Promise<ImpUrls> {
  const stdout = await runImp('url', name);

  const lines = stdout.split('\n').filter((line) => line !== '');
  const local = lines.find((line) => /^http:\/\/\S+\.imp\.localhost:\d+$/v.test(line));

  if (local === undefined) {
    throw new Error(`imp url ${name} printed no local URL: ${stdout}`);
  }

  const https = lines.find((line) => line.startsWith('https://')) ?? null;
  const tailnet = lines.find((line) => line !== local && line.startsWith('http://')) ?? null;

  return { https, local, tailnet };
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

// what a command that returns one imp prints with --json
export function parseImp(stdout: string): ImpRow {
  return ImpRowSchema.parse(JSON.parse(stdout));
}

export async function listImageNames(): Promise<readonly string[]> {
  const stdout = await runImp('image', 'ls', '--json');

  const images = z.array(ImageRowSchema).parse(JSON.parse(stdout));

  return images.map((image) => image.name);
}
