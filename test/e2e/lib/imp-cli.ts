import { join } from 'node:path';
import * as z from 'zod';
import type { CommandResult, DevInstance } from './instance';
import { REPO_ROOT, instance, readToken, runCommand } from './instance';

const IMP_SCRIPT = join(REPO_ROOT, 'scripts', 'imp');

// The CLI's JSON output, with only the fields the suites read. Dates arrive
// as ISO strings.
const ImpStateSchema = z.enum(['creating', 'running', 'sleeping', 'stopped', 'error']);
const SampleSchema = z.object({ cpuThrottledMs: z.number() });

const ResourcesSchema = z.object({
  wakeCount: z.number(),
  awakeMs: z.number(),
  sample: SampleSchema.optional(),
});

const ImpRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  state: ImpStateSchema,
  vcpus: z.number(),
  memoryMib: z.number(),
  maxMemoryMib: z.number().optional(),
  pluggedMib: z.number().optional(),
  slot: z.number(),
  ip: z.string(),
  port: z.number(),
  url: z.string(),
  lastActiveAt: z.string(),
  ramMib: z.number().optional(),
  error: z.string().optional(),
  sessions: z.number().optional(),
  diskUsage: z
    .object({ exclusiveBytes: z.number(), sharedBytes: z.number(), isPartial: z.boolean() })
    .optional(),
  cpu: z.object({ limit: z.number().nullable(), weight: z.number() }).optional(),
  resources: ResourcesSchema.optional(),
  coldBootReason: z.string().optional(),
});

const NameFailureSchema = z.object({ name: z.string(), error: z.string() });
const TailnetNamesSchema = z.object({ live: z.number(), failed: z.array(NameFailureSchema) });

const SystemInfoSchema = z.object({
  ramBudgetMib: z.number(),
  ramUsedMib: z.number(),
  ramReservedMib: z.number(),
  awakeCount: z.number(),
  impCount: z.number(),
  storage: z.object({ backend: z.enum(['xfs', 'zfs']) }),
  cpu: z.object({ hostCpus: z.number(), limitsEnforced: z.boolean() }).optional(),
  ksm: z
    .object({ sharedMib: z.number(), headroomMib: z.number(), unmergeable: z.number() })
    .nullable()
    .optional(),
  tailscale: z.object({
    state: z.string().nullable(),
    hostname: z.string().nullable(),
    ip: z.string().nullable(),
    names: TailnetNamesSchema.nullable().default(null),
  }),
});

const CheckpointRowSchema = z.object({ id: z.string(), label: z.string().optional() });
const ImageRowSchema = z.object({ name: z.string() });

export type ImpState = z.infer<typeof ImpStateSchema>;

export type ImpRow = z.infer<typeof ImpRowSchema>;

export type SystemInfo = z.infer<typeof SystemInfoSchema>;

export type CheckpointRow = z.infer<typeof CheckpointRowSchema>;

// each instance's root token, by container
const tokens = new Map<string, Promise<string>>();

// From the env when the runner passed it, else read from the dev container
// once, so a suite file also runs on its own. Another instance's is always
// read from its container.
function readImpToken(target: DevInstance): Promise<string> {
  const fromEnv = process.env['IMP_TOKEN'] ?? '';

  if (target === instance && fromEnv !== '') {
    return Promise.resolve(fromEnv);
  }

  let token = tokens.get(target.container);

  if (token === undefined) {
    token = readToken(target);

    tokens.set(target.container, token);
  }

  return token;
}

// the env that points the CLI at a dev instance
export async function readImpEnv(target: DevInstance = instance): Promise<Record<string, string>> {
  const impToken = await readImpToken(target);

  return { IMP_URL: target.apiUrl, IMP_TOKEN: impToken };
}

export interface ImpRunOptions {
  readonly stdin?: string;

  // a token in place of the run's root token, such as a scoped one
  readonly token?: string;

  // the instance to drive, the run's own by default
  readonly target?: DevInstance;

  // more env for the CLI, such as XDG_CONFIG_HOME for saved hosts
  readonly env?: Readonly<Record<string, string>>;
}

// Runs the imp CLI as a user would and returns what happened, failure
// included.
export async function tryImp(
  args: readonly string[],
  options: ImpRunOptions = {},
): Promise<CommandResult> {
  const env = await readImpEnv(options.target);

  const runAs = options.token ?? env['IMP_TOKEN'] ?? '';

  return runCommand([IMP_SCRIPT, ...args], {
    ...(options.stdin !== undefined && { stdin: options.stdin }),
    env: { ...env, ...options.env, IMP_TOKEN: runAs },
  });
}

// Starts the imp CLI for a command that runs until stopped, such as
// `imp proxy` or `imp events`, with its output piped.
export async function startImp(args: readonly string[]) {
  const env = await readImpEnv();

  return Bun.spawn([IMP_SCRIPT, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
}

// Runs the imp CLI and returns its stdout, or throws with its stderr.
export function runImp(...args: readonly string[]): Promise<string> {
  return runImpWith({}, ...args);
}

export async function runImpWith(
  options: ImpRunOptions,
  ...args: readonly string[]
): Promise<string> {
  const result = await tryImp(args, options);

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

export interface ImpUrls {
  readonly https: string | null;

  // the imp's own tailnet name, https://<service>.<tailnet>.ts.net
  readonly service: string | null;
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

  const service = lines.find((line) => /^https:\/\/[\w\-]+\.[\w\-]+\.ts\.net$/v.test(line)) ?? null;
  const https = lines.find((line) => line !== service && line.startsWith('https://')) ?? null;
  const tailnet = lines.find((line) => line !== local && line.startsWith('http://')) ?? null;

  return { https, service, local, tailnet };
}

export async function listImps(target: DevInstance = instance): Promise<readonly ImpRow[]> {
  const stdout = await runImpWith({ target }, 'ls', '--json');

  return z.array(ImpRowSchema).parse(JSON.parse(stdout));
}

export async function findImp(
  name: string,
  target: DevInstance = instance,
): Promise<ImpRow | undefined> {
  const rows = await listImps(target);

  return rows.find((row) => row.name === name);
}

export async function requireImp(name: string, target: DevInstance = instance): Promise<ImpRow> {
  const row = await findImp(name, target);

  if (row === undefined) {
    throw new Error(`${name} is not in imp ls on ${target.container}`);
  }

  return row;
}

export async function readState(name: string, target: DevInstance = instance): Promise<ImpState> {
  const row = await requireImp(name, target);

  return row.state;
}

// throws unless the imp is in the state, for use inside waitFor
export async function assertState(
  name: string,
  state: ImpState,
  target: DevInstance = instance,
): Promise<void> {
  const actual = await readState(name, target);

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
