import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { ExposeResult, ForkResult, Imp } from '@impz/api';
import { CONSOLE_SHELL, EXEC_REQUIREMENTS, requireFeatures } from '@impz/client';
import type { ExecRequirement } from '@impz/client';
import { authArgs } from '../args/auth-args';
import { detachKeyArg, jsonArg, nameArg, requireSessionName } from '../args/common-args';
import { cpuLimitArg, cpuWeightArg, readCpuArgs } from '../args/cpu-args';
import type { CommandIO } from '../cli/command-io';
import { defineCommand } from '../cli/define-command';
import { listOperands } from '../cli/dispatch-verb';
import { CommandExitError, UsageError } from '../cli/errors';
import { formatError, runAction, toCallError } from '../cli/run-action';
import type { CliConfig } from '../config/cli-config';
import { createImpClient } from '../config/create-imp-client';
import type { ImpClient } from '../config/create-imp-client';
import type { CliEnv } from '../config/host-store';
import { DEFAULT_SESSION, parseDetachKey } from '../exec/detach-key';
import { buildExecIO, runExec } from '../exec/exec-client';
import { listSavedTargets, runOnHosts } from '../hosts/fan-out';
import type { SavedTarget, StartTimer } from '../hosts/fan-out';
import { buildRanking, createPlaced, readHostProbe } from '../hosts/place-imp';
import type { PlaceRequest } from '../hosts/place-imp';
import {
  formatExposeResult,
  formatHostImps,
  formatImp,
  formatImps,
  formatJson,
  formatOutput,
} from '../output/format-output';
import { printTrustWarnings } from '../output/print-trust-warnings';
import { parseDuration } from '../parse/parse-duration';
import { formatPolicy, parsePolicy } from '../parse/parse-policy';
import { parsePublicAuth } from '../parse/parse-public-auth';
import { parseCount, parseSize } from '../parse/parse-size';
import { readTermEnv } from '../sessions/read-term-env';

export const newCommand = defineCommand({
  name: 'new',
  description: 'Create an imp and boot it',
  args: {
    name: {
      type: 'positional',
      description: 'imp name (generated when left out)',
      required: false,
    },
    image: { type: 'string', description: 'image name' },
    cpus: { type: 'string', description: 'vCPU count' },
    memory: { type: 'string', description: 'memory: MiB, or with a unit (512m, 2g)' },
    'max-memory': {
      type: 'string',
      description: 'what the guest may grow to under pressure, at most 4 × memory',
    },
    disk: { type: 'string', description: 'disk size, with a unit (64g); 32g by default' },
    'http-port': { type: 'string', description: 'guest port the proxy forwards to (default 8080)' },
    policy: {
      type: 'string',
      description: 'egress policy: open (default), public (the internet only), box or none',
    },
    allow: {
      type: 'string',
      description: 'what a box may reach: hosts, *.domains, IP addresses or CIDRs, comma-separated',
    },
    'cpu-limit': cpuLimitArg,
    'cpu-weight': cpuWeightArg,
    public: { type: 'boolean', description: 'serve it to the internet too, as impz expose does' },
    ...authArgs,
    net: { type: 'string', description: 'networks to join, comma-separated (see impz net)' },
    backup: {
      type: 'boolean',
      negatable: true,
      default: true,
      description: 'hold the imp in the host’s backups (the default)',
      negativeDescription: 'leave its disk and checkpoints out of every backup, for its life',
    },
    place: {
      type: 'boolean',
      description: 'create it on the saved host with the most free RAM (see impz host ls)',
    },
    json: jsonArg,
  },
  run: async (ctx) => {
    const io = ctx.extensions.impz.io;
    const request = readNewRequest(ctx.values);

    if (ctx.values.place !== true) {
      await runAction(ctx.extensions.impz, (client) => runNew(client, io, request, null));

      return;
    }

    if (ctx.extensions.impz.host !== null) {
      throw new UsageError('--place picks among the saved hosts; drop --host');
    }

    await runPlacedNew(io, request);
  },
});

// Probes every saved host, ranks those that could take the imp, and
// creates on the best; docs/guides/hosts.md#placement says how it picks.
async function runPlacedNew(io: CommandIO, request: NewRequest): Promise<void> {
  const targets = listSavedTargets(io.env, io.printError);
  const place = toPlaceRequest(request);

  const answers = await runOnHosts(targets, (client, signal) =>
    readHostProbe(client, signal, place),
  );

  const ranking = buildRanking(answers, place);

  for (const dropped of ranking.dropped) {
    io.printError(`impz: ${dropped.host}: skipped: ${dropped.reason}`);
  }

  if (ranking.ranked.length === 0) {
    throw new Error('no saved host can take the imp');
  }

  let config: CliConfig | null = null;

  try {
    await createPlaced(
      ranking.ranked,
      async (host) => {
        const target = targets.find((saved) => saved.host === host);

        if (target === undefined) {
          throw new Error(`no saved host ${host}`);
        }

        config = target.config;

        io.printError(`impz: placing on ${host}`);

        await runNew(createImpClient(target.config), io, request, target);
      },
      (host, message) => {
        io.printError(`impz: ${host}: ${message}; trying the next host`);
      },
    );
  } catch (error) {
    throw config === null ? error : toCallError(error, config);
  }
}

function toPlaceRequest(request: NewRequest): PlaceRequest {
  const input = request.input;

  return {
    name: input.name ?? null,
    image: input.image ?? null,

    // impd refuses an elastic imp whose max passes its budget
    memoryMib: input.maxMemoryMib ?? input.memoryMib ?? null,
    cpuLimit: input.cpuLimit ?? null,
    policyMode: input.policy?.mode ?? null,
    networks: input.networks ?? [],
    needsWholeHost: request.auth !== null || input.networks !== undefined,
  };
}

interface NewRequest {
  readonly input: CreateInput;
  readonly auth: ExposeAuth | null;
  readonly json: boolean;
}

// the create's input, with its network list read-only until the call
type CreateInput = Readonly<Omit<Parameters<ImpClient['imps']['create']>[0], 'networks'>> & {
  readonly networks?: readonly string[];
};

type ExposeAuth = ReturnType<typeof parsePublicAuth>;

interface NewArgs extends Readonly<Record<string, unknown>> {
  readonly name?: string | undefined;
  readonly image?: string | undefined;
  readonly cpus?: string | undefined;
  readonly memory?: string | undefined;
  readonly 'max-memory'?: string | undefined;
  readonly disk?: string | undefined;
  readonly 'http-port'?: string | undefined;
  readonly policy?: string | undefined;
  readonly allow?: string | undefined;
  readonly 'cpu-limit'?: string | undefined;
  readonly 'cpu-weight'?: string | undefined;
  readonly public?: boolean | undefined;
  readonly auth?: string | undefined;
  readonly user?: string | undefined;
  readonly net?: string | undefined;
  readonly backup?: boolean | undefined;
  readonly json?: boolean | undefined;
}

// every flag checked before any call, so a bad one leaves no imp behind
function readNewRequest(args: NewArgs): NewRequest {
  const policy = parsePolicy(args.policy, args.allow);
  const networks = args.net?.split(',').map((network) => network.trim());
  const isPublic = args.public === true;

  if (!isPublic && (args.auth !== undefined || args.user !== undefined)) {
    throw new UsageError('--auth and --user need --public');
  }

  const input: CreateInput = {
    ...(args.name !== undefined && { name: args.name }),
    ...(args.image !== undefined && { image: args.image }),
    ...(args.cpus !== undefined && { vcpus: parseCount(args.cpus, 'cpus') }),
    ...(args.memory !== undefined && { memoryMib: parseSize(args.memory) }),
    ...(args['max-memory'] !== undefined && { maxMemoryMib: parseSize(args['max-memory']) }),
    ...(args.disk !== undefined && { diskMib: parseSize(args.disk) }),
    ...(args['http-port'] !== undefined && {
      httpPort: parseCount(args['http-port'], 'http-port'),
    }),
    ...(policy !== undefined && { policy }),
    ...readCpuArgs(args),
    ...(networks !== undefined && { networks }),
    ...(args.backup === false && { backup: false }),
  };

  return {
    input,
    auth: isPublic ? parsePublicAuth(args.auth, args.user) : null,
    json: args.json === true,
  };
}

// The create on one host, then what follows it there: trust warnings for
// --net, and the expose for --public. `placed` is the saved host placement
// picked, null for the usual one-host create.
async function runNew(
  client: ImpClient,
  io: CommandIO,
  request: NewRequest,
  placed: SavedTarget | null,
) {
  const input = request.input;
  const auth = request.auth;
  const host = placed?.host ?? null;

  // expose needs manage on the host; impd checks it again on the call.
  // Placement checked it on every host it ranked.
  if (auth !== null && placed === null) {
    const identity = await client.tokens.whoami();

    if (identity.scope !== 'manage' || identity.imps !== null) {
      // a refusal, as impd's own would be: exit 1, not a usage error
      throw new Error('--public needs a token with manage scope on the host; this one is limited');
    }
  }

  await requireFeatures(client, {
    ...(input.policy !== undefined &&
      EGRESS_MODE_TRAITS[input.policy.mode].isPublic && {
        publicEgress: 'refuse the public egress policy',
      }),
    ...(input.backup === false && { backupOptOut: 'back the imp up anyway' }),
  });

  const { networks, ...fields } = input;

  const imp = await client.imps.create({
    ...fields,
    ...(networks !== undefined && { networks: [...networks] }),
  });

  let exposed: ExposeResult | null = null;

  try {
    if (networks !== undefined) {
      await printTrustWarnings(client, io, imp.name);
    }

    // a failure here leaves the imp tailnet-only; `impz expose` tries again
    exposed = auth === null ? null : await client.imps.expose({ name: imp.name, ...auth });
  } catch (error) {
    if (placed === null) {
      throw error;
    }

    throw printPlacedFailure(io, imp, placed, error, request.json);
  }

  if (request.json) {
    // the plain create keeps its shape: the imp alone
    const output =
      host === null && exposed === null
        ? imp
        : { ...(host !== null && { host }), imp, ...(exposed !== null && { public: exposed }) };

    io.print(formatJson(output));

    return;
  }

  const text =
    exposed === null ? formatImp(imp) : `${formatImp(imp)}\n${formatExposeResult(exposed)}`;

  io.print(text);
}

// After a placed create only the stderr line `placing on <host>` says where
// the imp is, so the error names the host and --json still gets the imp. It
// is a plain Error: placement never tries the next host for it.
function printPlacedFailure(
  io: CommandIO,
  imp: Imp,
  placed: SavedTarget,
  error: unknown,
  json: boolean,
): Error {
  const message = formatError(error, placed.config);

  if (json) {
    io.print(formatJson({ host: placed.host, imp, error: message }));
  }

  return new Error(`${imp.name} was created on ${placed.host}; ${message}`);
}

// `impz ls --all` when some hosts answered and some did not
const PARTIAL_CODE = 3;

export const lsCommand = defineCommand({
  name: 'ls',
  description: 'List imps',
  args: {
    all: { type: 'boolean', description: 'list the imps on every saved host (see impz host ls)' },
    builders: {
      type: 'boolean',
      description: 'list the image builders impd runs for builds too',
    },
    json: jsonArg,
  },
  run: async (ctx) => {
    if (ctx.values.all !== true) {
      await runAction(ctx.extensions.impz, async (client) => {
        const input = ctx.values.builders === true ? { builders: true } : undefined;

        const imps = await client.imps.list(input);

        ctx.extensions.impz.io.print(formatOutput(imps, ctx.values.json, formatImps));
      });

      return;
    }

    const io = ctx.extensions.impz.io;

    if (ctx.extensions.impz.host !== null) {
      throw new UsageError('--all lists every saved host; drop --host');
    }

    const code = await listAllImps({
      env: io.env,
      isJson: ctx.values.json === true,
      hasBuilders: ctx.values.builders === true,
      print: io.print,
      printError: io.printError,
    });

    if (code !== 0) {
      throw new CommandExitError(code);
    }
  },
});

interface AllImpsRun {
  // where the saved hosts are read from
  readonly env: CliEnv;
  readonly isJson: boolean;
  readonly hasBuilders: boolean;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;

  // each host's timeout; runOnHosts' timer by default
  readonly startTimer?: StartTimer;
}

// One list per saved host, at once. What came back is printed, JSON or
// table, then one line per host that failed; the result is the exit code
// docs/guides/hosts.md#one-view gives.
export async function listAllImps(run: Readonly<AllImpsRun>): Promise<number> {
  const input = run.hasBuilders ? { builders: true } : undefined;

  const answers = await runOnHosts(
    listSavedTargets(run.env, run.printError),
    (client, signal) => client.imps.list(input, { signal }),
    undefined,
    run.startTimer,
  );

  const imps = answers.flatMap((answer) =>
    'value' in answer ? answer.value.map((imp) => ({ ...imp, host: answer.host })) : [],
  );

  const errors = answers.flatMap((answer) =>
    'error' in answer ? [{ host: answer.host, message: answer.error }] : [],
  );

  const output = run.isJson ? formatJson({ imps, errors }) : formatHostImps(imps);

  run.print(output);

  for (const error of errors) {
    run.printError(`impz: ${error.host}: ${error.message}`);
  }

  if (errors.length === 0) {
    return 0;
  }

  return errors.length === answers.length ? 1 : PARTIAL_CODE;
}

export const startCommand = defineCommand({
  name: 'start',
  description: 'Boot a stopped imp',
  args: { name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imp = await client.imps.start({ name: ctx.values.name });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

export const stopCommand = defineCommand({
  name: 'stop',
  description: 'Shut an imp down (its disk stays, its memory and leases do not)',
  args: { name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      // a person typed it: the imp's leases end rather than refuse it
      const imp = await client.imps.stop({ name: ctx.values.name, force: true });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

export const rmCommand = defineCommand({
  name: 'rm',
  description: 'Destroy an imp and its disk and checkpoints',
  args: { name: nameArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.imps.destroy({ name: ctx.values.name });
    }),
});

export const sleepCommand = defineCommand({
  name: 'sleep',
  description: 'Snapshot an imp to disk and free its RAM, ending its leases',
  args: { name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      // as for stop
      const imp = await client.imps.sleep({ name: ctx.values.name, force: true });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

export const wakeCommand = defineCommand({
  name: 'wake',
  description: 'Resume a sleeping or stopped imp',
  args: { name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imp = await client.imps.wake({ name: ctx.values.name });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

export const holdCommand = defineCommand({
  name: 'hold',
  description: 'Keep an imp awake for a while (0 releases)',
  args: {
    name: nameArg,
    duration: { type: 'positional', description: 'e.g. 90s, 15m, 2h', required: true },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imp = await client.imps.hold({
        name: ctx.values.name,
        seconds: parseDuration(ctx.values.duration),
      });

      ctx.extensions.impz.io.print(
        `${imp.name} held until ${imp.holdUntil?.toISOString() ?? 'released'}`,
      );
    }),
});

export const urlCommand = defineCommand({
  name: 'url',
  description:
    "Print an imp's URLs: https first when HTTPS is on, then its tailnet name, local and tailnet",
  args: { name: nameArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const urls = await client.imps.url({ name: ctx.values.name });

      if (urls.https !== null) {
        ctx.extensions.impz.io.print(urls.https);
      }

      // the same name on the internet, which differs only by port
      if (urls.public !== null && urls.public !== urls.https) {
        ctx.extensions.impz.io.print(urls.public);
      }

      if (urls.service !== null) {
        ctx.extensions.impz.io.print(urls.service);
      }

      ctx.extensions.impz.io.print(urls.local);

      if (urls.tailnet !== null) {
        ctx.extensions.impz.io.print(urls.tailnet);
      }
    }),
});

export const policyCommand = defineCommand({
  name: 'policy',
  description: "Show or set an imp's egress policy: open, public, box with --allow, or none",
  args: {
    name: nameArg,
    mode: { type: 'positional', description: 'open, public, box or none', required: false },
    allow: {
      type: 'string',
      description: 'what a box may reach: hosts, *.domains, IP addresses or CIDRs, comma-separated',
    },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const policy = parsePolicy(ctx.values.mode, ctx.values.allow);

      if (policy !== undefined && EGRESS_MODE_TRAITS[policy.mode].isPublic) {
        await requireFeatures(client, { publicEgress: 'refuse the public egress policy' });
      }

      const current =
        policy === undefined
          ? await client.imps.policy({ name: ctx.values.name })
          : await client.imps.setPolicy({ name: ctx.values.name, policy });

      ctx.extensions.impz.io.print(formatOutput(current, ctx.values.json, formatPolicy));

      if (policy !== undefined) {
        await printTrustWarnings(client, ctx.extensions.impz.io, ctx.values.name);
      }
    }),
});

// The source's grants a fork did not get, one line each, and why none came
// when the copy failed as a whole; none from an impd before the report
export function listForkWarnings(
  source: string,
  fork: Readonly<Pick<ForkResult, 'name' | 'grantsNotCopied' | 'grantsError'>>,
): string[] {
  const skipped = (fork.grantsNotCopied ?? []).map(
    (each) => `${fork.name}: grant ${each.secret} of ${source} not copied: ${each.reason}`,
  );

  return fork.grantsError === undefined
    ? skipped
    : [...skipped, `${fork.name}: ${fork.grantsError}`];
}

export const forkCommand = defineCommand({
  name: 'fork',
  description: "Create an imp from another imp's disk or checkpoint",
  args: {
    source: { type: 'positional', description: 'imp to fork', required: true },
    name: { type: 'positional', description: 'name of the new imp', required: true },
    from: { type: 'string', description: 'checkpoint id or label (default: the live disk)' },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imp = await client.imps.fork({
        source: ctx.values.source,
        name: ctx.values.name,
        ...(ctx.values.from !== undefined && { checkpoint: ctx.values.from }),
      });

      // the fork exists either way, so these warn and the exit stays 0
      for (const warning of listForkWarnings(ctx.values.source, imp)) {
        ctx.extensions.impz.io.printError(`impz: ${warning}`);
      }

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

export const execCommand = defineCommand({
  name: 'exec',
  description: 'Run a command in an imp (impz exec [-t] <name> -- cmd args)',
  args: {
    name: nameArg,
    tty: { type: 'boolean', short: 't', description: 'run on a terminal' },
    agent: {
      type: 'boolean',
      description:
        "run as root in the imp's agent, outside its container, with busybox (host-wide manage scope)",
    },
    require: {
      type: 'custom',
      parse: parseRequire,
      conflicts: 'agent',
      description:
        'start the command only if impd can ensure these, or fail and run nothing: broker (comma-separated)',
    },
  },
  run: async (ctx) => {
    const argv = ctx._.includes('--') ? ctx.rest : listOperands(ctx).slice(1);

    if (argv.length === 0) {
      throw new UsageError('exec needs a command: impz exec <name> -- cmd args');
    }

    const code = await runExec(
      {
        host: ctx.extensions.impz.host,
        name: ctx.values.name,
        argv,
        tty: ctx.values.tty === true,
        ...(ctx.values.tty === true && { env: readTermEnv(ctx.extensions.impz.io.env) }),
        ...(ctx.values.agent === true && { outer: true }),
        ...(ctx.values.require !== undefined && { require: ctx.values.require }),
      },
      buildExecIO(ctx.extensions.impz.io),
    );

    throw new CommandExitError(code, true);
  },
});

// --require 'broker': what impd must ensure before it starts the command
function parseRequire(text: string): ExecRequirement[] {
  const names = text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  const known = new Set<string>(EXEC_REQUIREMENTS);

  const bad = names.find((name) => !known.has(name));

  if (names.length === 0 || bad !== undefined) {
    throw new UsageError(`--require takes ${EXEC_REQUIREMENTS.join(', ')}; not ${bad ?? text}`);
  }

  return EXEC_REQUIREMENTS.filter((name) => names.includes(name));
}

// With no terminal on stdin, as in a script, the shell runs without a
// session unless one is named.
export const consoleCommand = defineCommand({
  name: 'console',
  description: 'Open a shell in an imp, in a session that outlives the terminal (ctrl-] detaches)',
  args: {
    name: nameArg,
    session: {
      type: 'string',
      description: `session to start or attach to (default ${DEFAULT_SESSION} on a terminal); --no-session for a shell that ends with the terminal`,
    },
    'no-session': { type: 'boolean', hidden: true },
    log: {
      type: 'boolean',
      description:
        'impd keeps the output of the session this starts, for impz sessions log (docs/guides/session-logs.md)',
    },
    'detach-key': detachKeyArg,
  },
  run: async (ctx) => {
    const impz = ctx.extensions.impz;
    const session = pickConsoleSession(ctx.values, impz.io.isStdinTerminal);
    const detachKey = parseDetachKey(ctx.values['detach-key']);
    const log = ctx.values.log === true;

    if (log && session === null) {
      throw new UsageError('--log needs a session');
    }

    // an older impd would start the session and keep nothing
    if (log) {
      await runAction(impz, (client) =>
        requireFeatures(client, { sessionLog: 'start the session without a log' }),
      );
    }

    const code = await runExec(
      {
        host: impz.host,
        name: ctx.values.name,
        argv: ['/bin/sh', '-c', CONSOLE_SHELL],
        tty: true,
        env: readTermEnv(impz.io.env),
        ...(session !== null && {
          session: { name: session, attachOnly: false, detachKey, log },
        }),
      },
      buildExecIO(impz.io),
    );

    throw new CommandExitError(code, true);
  },
});

interface ConsoleSessionArgs {
  readonly session?: string | undefined;
  readonly 'no-session'?: boolean | undefined;
}

// the named session, the default on a terminal, or null for none
export function pickConsoleSession(
  args: Readonly<ConsoleSessionArgs>,
  isTerminal: boolean,
): string | null {
  if (args['no-session'] === true || (args.session === undefined && !isTerminal)) {
    return null;
  }

  return requireSessionName(args.session ?? DEFAULT_SESSION);
}
