import { CONSOLE_SHELL } from '@zgeoff/imp-client';
import { defineCommand } from '../define-command';
import { DEFAULT_SESSION } from '../detach-key';
import { runExec } from '../exec-client';
import {
  formatExposeResult,
  formatImp,
  formatImps,
  formatJson,
  formatOutput,
} from '../format-output';
import { parseDuration } from '../parse-duration';
import { formatPolicy, parsePolicy } from '../parse-policy';
import { parsePublicAuth } from '../parse-public-auth';
import { parseCount, parseSize } from '../parse-size';
import { runAction } from '../run-action';
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
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const policy = parsePolicy(context.args.policy, context.args.allow);
      const networks = context.args.net?.split(',').map((network) => network.trim());
      const isPublic = context.args.public === true;

      if (!isPublic && (context.args.auth !== undefined || context.args.user !== undefined)) {
        throw new UsageError('--auth and --user need --public');
      }

      // checked before the create, so a bad flag leaves no imp behind
      const auth = isPublic ? parsePublicAuth(context.args.auth, context.args.user) : null;

      // expose needs manage on the host; impd checks it again on the call
      if (auth !== null) {
        const identity = await client.tokens.whoami();

        if (identity.scope !== 'manage' || identity.imps !== null) {
          // a refusal, as impd's own would be: exit 1, not a usage error
          throw new Error(
            '--public needs a token with manage scope on the host; this one is limited',
          );
        }
      }

      const imp = await client.imps.create({
        ...(context.args.name !== undefined && { name: context.args.name }),
        ...(context.args.image !== undefined && { image: context.args.image }),
        ...(context.args.cpus !== undefined && { vcpus: parseCount(context.args.cpus, 'cpus') }),
        ...(context.args.memory !== undefined && { memoryMib: parseSize(context.args.memory) }),
        ...(context.args.disk !== undefined && { diskMib: parseSize(context.args.disk) }),
        ...(context.args['http-port'] !== undefined && {
          httpPort: parseCount(context.args['http-port'], 'http-port'),
        }),
        ...(policy !== undefined && { policy }),
        ...readCpuArgs(context.args),
        ...(networks !== undefined && { networks }),
      });

      if (networks !== undefined) {
        await printTrustWarnings(client, imp.name);
      }

      if (auth === null) {
        console.log(formatOutput(imp, context.args.json, formatImp));

        return;
      }

      // a failure here leaves the imp tailnet-only; `imp expose` tries again
      const exposed = await client.imps.expose({ name: imp.name, ...auth });

      const output =
        context.args.json === true
          ? formatJson({ imp, public: exposed })
          : `${formatImp(imp)}\n${formatExposeResult(exposed)}`;

      console.log(output);
    }),
});

export const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List imps' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const imps = await client.imps.list();

      console.log(formatOutput(imps, context.args.json, formatImps));
    }),
});

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
  },
  run: async (context) => {
    const argv = splitCommand(process.argv, context.args._.slice(1));

    if (argv.length === 0) {
      console.error('imp: exec needs a command: imp exec <name> -- cmd args');
      process.exit(2);
    }

    const code = await runExec({
      host: context.host,
      name: context.args.name,
      argv,
      tty: context.args.tty === true,
      ...(context.args.tty === true && { env: readTermEnv() }),
      ...(context.args.agent === true && { outer: true }),
    });

    process.exit(code);
  },
});

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
