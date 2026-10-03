import type { ExposeResult, Imp } from '@imp/api';
import { CONSOLE_SHELL, EXEC_REQUIREMENTS } from '@zgeoff/imp-client';
import type { ExecRequirement } from '@zgeoff/imp-client';
import type { CliConfig } from '../cli-config';
import { createImpClient } from '../create-imp-client';
import type { ImpClient } from '../create-imp-client';
import { defineCommand } from '../define-command';
import { DEFAULT_SESSION } from '../detach-key';
import { runExec } from '../exec-client';
import { listSavedTargets, runOnHosts } from '../fan-out';
import type { SavedTarget } from '../fan-out';
import {
  formatExposeResult,
  formatHostImps,
  formatImp,
  formatImps,
  formatJson,
  formatOutput,
} from '../format-output';
import { parseDuration } from '../parse-duration';
import { formatPolicy, parsePolicy } from '../parse-policy';
import { parsePublicAuth } from '../parse-public-auth';
import { parseCount, parseSize } from '../parse-size';
import { buildRanking, createPlaced, readHostProbe } from '../place-imp';
import type { PlaceRequest } from '../place-imp';
import { requireFeature } from '../require-feature';
import { formatError, printError, runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { detachKeyArg, jsonArg, nameArg, readDetachKey, readSessionName } from './common-args';
import { cpuLimitArg, cpuWeightArg, readCpuArgs } from './cpu';
import { authArgs } from './expose';
import { printTrustWarnings } from './networks';

export const newCommand = defineCommand({
  meta: { name: 'new', description: 'Create an imp and boot it' },
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
    policy: { type: 'string', description: 'egress policy: open (default), box or none' },
    allow: {
      type: 'string',
      description: 'what a box may reach: hosts, *.domains, IP addresses or CIDRs, comma-separated',
    },
    'cpu-limit': cpuLimitArg,
    'cpu-weight': cpuWeightArg,
    public: { type: 'boolean', description: 'serve it to the internet too, as imp expose does' },
    ...authArgs,
    net: { type: 'string', description: 'networks to join, comma-separated (see imp net)' },
    place: {
      type: 'boolean',
      description: 'create it on the saved host with the most free RAM (see imp host ls)',
    },
    json: jsonArg,
  },
  run: async (context) => {
    try {
      const request = readNewRequest(context.args);

      if (context.args.place !== true) {
        await runAction(context.host, (client) => runNew(client, request, null));

        return;
      }

      if (context.host !== null) {
        throw new UsageError('--place picks among the saved hosts; drop --host');
      }

      await runPlacedNew(request);
    } catch (error) {
      printError(error);
    }
  },
});

// Probes every saved host, ranks those that could take the imp, and
// creates on the best; docs/guides/hosts.md#placement says how it picks.
async function runPlacedNew(request: NewRequest): Promise<void> {
  const targets = listSavedTargets(process.env);
  const place = toPlaceRequest(request);

  const answers = await runOnHosts(targets, (client, signal) =>
    readHostProbe(client, signal, place),
  );

  const ranking = buildRanking(answers, place);

  for (const dropped of ranking.dropped) {
    console.error(`imp: ${dropped.host}: skipped: ${dropped.reason}`);
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

        console.error(`imp: placing on ${host}`);

        await runNew(createImpClient(target.config), request, target);
      },
      (host, message) => {
        console.error(`imp: ${host}: ${message}; trying the next host`);
      },
    );
  } catch (error) {
    printError(error, config);
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
async function runNew(client: ImpClient, request: NewRequest, placed: SavedTarget | null) {
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

  const { networks, ...fields } = input;

  const imp = await client.imps.create({
    ...fields,
    ...(networks !== undefined && { networks: [...networks] }),
  });

  let exposed: ExposeResult | null = null;

  try {
    if (networks !== undefined) {
      await printTrustWarnings(client, imp.name);
    }

    // a failure here leaves the imp tailnet-only; `imp expose` tries again
    exposed = auth === null ? null : await client.imps.expose({ name: imp.name, ...auth });
  } catch (error) {
    if (placed === null) {
      throw error;
    }

    throw printPlacedFailure(imp, placed, error, request.json);
  }

  if (request.json) {
    // the plain create keeps its shape: the imp alone
    const output =
      host === null && exposed === null
        ? imp
        : { ...(host !== null && { host }), imp, ...(exposed !== null && { public: exposed }) };

    console.log(formatJson(output));

    return;
  }

  const text =
    exposed === null ? formatImp(imp) : `${formatImp(imp)}\n${formatExposeResult(exposed)}`;

  console.log(text);
}

// After a placed create only the stderr line `placing on <host>` says where
// the imp is, so the error names the host and --json still gets the imp. It
// is a plain Error: placement never tries the next host for it.
function printPlacedFailure(imp: Imp, placed: SavedTarget, error: unknown, json: boolean): Error {
  const message = formatError(error, placed.config);

  if (json) {
    console.log(formatJson({ host: placed.host, imp, error: message }));
  }

  return new Error(`${imp.name} was created on ${placed.host}; ${message}`);
}

// `imp ls --all` when some hosts answered and some did not
const PARTIAL_CODE = 3;

export const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List imps' },
  args: {
    all: { type: 'boolean', description: 'list the imps on every saved host (see imp host ls)' },
    json: jsonArg,
  },
  run: async (context) => {
    if (context.args.all !== true) {
      await runAction(context.host, async (client) => {
        const imps = await client.imps.list();

        console.log(formatOutput(imps, context.args.json, formatImps));
      });

      return;
    }

    try {
      if (context.host !== null) {
        throw new UsageError('--all lists every saved host; drop --host');
      }

      await listAllImps(context.args.json === true);
    } catch (error) {
      printError(error);
    }
  },
});

// One list per saved host, at once. What came back is printed, JSON or
// table, then one line per host that failed; docs/guides/hosts.md#one-view
// gives the exit codes.
async function listAllImps(json: boolean): Promise<void> {
  const answers = await runOnHosts(listSavedTargets(process.env), (client, signal) =>
    client.imps.list(undefined, { signal }),
  );

  const imps = answers.flatMap((answer) =>
    'value' in answer ? answer.value.map((imp) => ({ ...imp, host: answer.host })) : [],
  );

  const errors = answers.flatMap((answer) =>
    'error' in answer ? [{ host: answer.host, message: answer.error }] : [],
  );

  const output = json ? formatJson({ imps, errors }) : formatHostImps(imps);

  console.log(output);

  for (const error of errors) {
    console.error(`imp: ${error.host}: ${error.message}`);
  }

  if (errors.length > 0) {
    process.exitCode = errors.length === answers.length ? 1 : PARTIAL_CODE;
  }
}

export const startCommand = defineCommand({
  meta: { name: 'start', description: 'Boot a stopped imp' },
  args: { name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const imp = await client.imps.start({ name: context.args.name });

      console.log(formatOutput(imp, context.args.json, formatImp));
    }),
});

export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description: 'Shut an imp down (its disk stays, its memory and leases do not)',
  },
  args: { name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      // a person typed it: the imp's leases end rather than refuse it
      const imp = await client.imps.stop({ name: context.args.name, force: true });

      console.log(formatOutput(imp, context.args.json, formatImp));
    }),
});

export const rmCommand = defineCommand({
  meta: { name: 'rm', description: 'Destroy an imp and its disk and checkpoints' },
  args: { name: nameArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.imps.destroy({ name: context.args.name });
    }),
});

export const sleepCommand = defineCommand({
  meta: {
    name: 'sleep',
    description: 'Snapshot an imp to disk and free its RAM, ending its leases',
  },
  args: { name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      // as for stop
      const imp = await client.imps.sleep({ name: context.args.name, force: true });

      console.log(formatOutput(imp, context.args.json, formatImp));
    }),
});

export const wakeCommand = defineCommand({
  meta: { name: 'wake', description: 'Resume a sleeping or stopped imp' },
  args: { name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const imp = await client.imps.wake({ name: context.args.name });

      console.log(formatOutput(imp, context.args.json, formatImp));
    }),
});

export const holdCommand = defineCommand({
  meta: { name: 'hold', description: 'Keep an imp awake for a while (0 releases)' },
  args: {
    name: nameArg,
    duration: { type: 'positional', description: 'e.g. 90s, 15m, 2h', required: true },
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const imp = await client.imps.hold({
        name: context.args.name,
        seconds: parseDuration(context.args.duration),
      });

      console.log(`${imp.name} held until ${imp.holdUntil?.toISOString() ?? 'released'}`);
    }),
});

export const urlCommand = defineCommand({
  meta: {
    name: 'url',
    description:
      "Print an imp's URLs: https first when HTTPS is on, then its tailnet name, local and tailnet",
  },
  args: { name: nameArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const urls = await client.imps.url({ name: context.args.name });

      if (urls.https !== null) {
        console.log(urls.https);
      }

      // the same name on the internet, which differs only by port
      if (urls.public !== null && urls.public !== urls.https) {
        console.log(urls.public);
      }

      if (urls.service !== null) {
        console.log(urls.service);
      }

      console.log(urls.local);

      if (urls.tailnet !== null) {
        console.log(urls.tailnet);
      }
    }),
});

export const policyCommand = defineCommand({
  meta: {
    name: 'policy',
    description: "Show or set an imp's egress policy: open, box with --allow, or none",
  },
  args: {
    name: nameArg,
    mode: { type: 'positional', description: 'open, box or none', required: false },
    allow: {
      type: 'string',
      description: 'what a box may reach: hosts, *.domains, IP addresses or CIDRs, comma-separated',
    },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const policy = parsePolicy(context.args.mode, context.args.allow);

      const current =
        policy === undefined
          ? await client.imps.policy({ name: context.args.name })
          : await client.imps.setPolicy({ name: context.args.name, policy });

      console.log(formatOutput(current, context.args.json, formatPolicy));

      if (policy !== undefined) {
        await printTrustWarnings(client, context.args.name);
      }
    }),
});

export const forkCommand = defineCommand({
  meta: { name: 'fork', description: "Create an imp from another imp's disk or checkpoint" },
  args: {
    source: { type: 'positional', description: 'imp to fork', required: true },
    name: { type: 'positional', description: 'name of the new imp', required: true },
    from: { type: 'string', description: 'checkpoint id or label (default: the live disk)' },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const imp = await client.imps.fork({
        source: context.args.source,
        name: context.args.name,
        ...(context.args.from !== undefined && { checkpoint: context.args.from }),
      });

      console.log(formatOutput(imp, context.args.json, formatImp));
    }),
});

export const execCommand = defineCommand({
  meta: { name: 'exec', description: 'Run a command in an imp (imp exec [-t] <name> -- cmd args)' },
  args: {
    name: nameArg,
    tty: { type: 'boolean', alias: 't', description: 'run on a terminal' },
    agent: {
      type: 'boolean',
      description:
        "run as root in the imp's agent, outside its container, with busybox (host-wide manage scope)",
    },
    require: {
      type: 'string',
      description:
        'start the command only if impd can ensure these, or fail and run nothing: broker (comma-separated)',
    },
  },
  run: async (context) => {
    const argv = splitCommand(process.argv, context.args._.slice(1));

    if (argv.length === 0) {
      console.error('imp: exec needs a command: imp exec <name> -- cmd args');
      process.exit(2);
    }

    const requirements = parseRequire(context.args.require, context.args.agent === true);

    if (requirements === null) {
      process.exit(2);
    }

    // an older impd would drop the list and run the command anyway
    if (requirements !== undefined && !(await checkExecRequire(context.host))) {
      process.exit(1);
    }

    const code = await runExec({
      host: context.host,
      name: context.args.name,
      argv,
      tty: context.args.tty === true,
      ...(context.args.tty === true && { env: readTermEnv() }),
      ...(context.args.agent === true && { outer: true }),
      ...(requirements !== undefined && { require: requirements }),
    });

    process.exit(code);
  },
});

// --require 'broker': what impd must ensure first; undefined when unset, and
// null once a bad list is reported
function parseRequire(
  text: string | undefined,
  isAgent: boolean,
): ExecRequirement[] | null | undefined {
  if (text === undefined) {
    return undefined;
  }

  const names = text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  const known = new Set<string>(EXEC_REQUIREMENTS);

  const bad = names.find((name) => !known.has(name));

  if (names.length === 0 || bad !== undefined) {
    console.error(`imp: --require takes ${EXEC_REQUIREMENTS.join(', ')}; not ${bad ?? text}`);

    return null;
  }

  if (isAgent) {
    console.error('imp: --require does not go with --agent: an exec in the agent gets no broker');

    return null;
  }

  return EXEC_REQUIREMENTS.filter((name) => names.includes(name));
}

// false once the failed check is reported
async function checkExecRequire(host: string | null): Promise<boolean> {
  const checked = { ok: false };

  await runAction(host, async (client) => {
    await requireFeature(client, 'execRequire', 'run the command without checking --require');

    checked.ok = true;
  });

  return checked.ok;
}

// `--no-session` parses to session: false. With no terminal on stdin, as
// in a script, the shell runs without a session unless one is named.
export const consoleCommand = defineCommand({
  meta: {
    name: 'console',
    description:
      'Open a shell in an imp, in a session that outlives the terminal (ctrl-] detaches)',
  },
  args: {
    name: nameArg,
    session: {
      type: 'string',
      description: `session to start or attach to (default ${DEFAULT_SESSION} on a terminal); --no-session for a shell that ends with the terminal`,
    },
    'detach-key': detachKeyArg,
  },
  run: async (context) => {
    const session = readConsoleSession(context.args.session, process.stdin.isTTY);
    const detachKey = readDetachKey(context.args['detach-key']);

    if (session === undefined || detachKey === undefined) {
      return;
    }

    const code = await runExec({
      host: context.host,
      name: context.args.name,
      argv: ['/bin/sh', '-c', CONSOLE_SHELL],
      tty: true,
      env: readTermEnv(),
      ...(typeof session === 'string' && {
        session: { name: session, attachOnly: false, detachKey },
      }),
    });

    process.exit(code);
  },
});

// the named session, the default on a terminal, or null for none;
// undefined once a bad name is reported
export function readConsoleSession(
  session: unknown,
  isTerminal: boolean,
): string | null | undefined {
  if (session === false || (session === undefined && !isTerminal)) {
    return null;
  }

  const name = typeof session === 'string' ? session : DEFAULT_SESSION;

  return readSessionName(name);
}

// everything after `--` (main.ts keeps it from citty), else the
// positionals after the name
function splitCommand(argv: readonly string[], positionals: readonly string[]): string[] {
  const separator = argv.indexOf('--');

  return separator === -1 ? [...positionals] : argv.slice(separator + 1);
}

export function readTermEnv(): Record<string, string> {
  return { TERM: process.env['TERM'] ?? 'xterm-256color' };
}
