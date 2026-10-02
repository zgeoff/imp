import { CONSOLE_SHELL } from '@zgeoff/imp-client';
import { defineCommand } from '../define-command';
import { DEFAULT_SESSION } from '../detach-key';
import { runExec } from '../exec-client';
import { formatImp, formatImps, formatOutput } from '../format-output';
import { parseDuration } from '../parse-duration';
import { parseCount, parseSize } from '../parse-size';
import { runAction } from '../run-action';
import { detachKeyArg, jsonArg, nameArg, readDetachKey, readSessionName } from './common-args';

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
    'http-port': { type: 'string', description: 'guest port the proxy forwards to (default 8080)' },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const imp = await client.imps.create({
        ...(context.args.name !== undefined && { name: context.args.name }),
        ...(context.args.image !== undefined && { image: context.args.image }),
        ...(context.args.cpus !== undefined && { vcpus: parseCount(context.args.cpus, 'cpus') }),
        ...(context.args.memory !== undefined && { memoryMib: parseSize(context.args.memory) }),
        ...(context.args['http-port'] !== undefined && {
          httpPort: parseCount(context.args['http-port'], 'http-port'),
        }),
      });

      console.log(formatOutput(imp, context.args.json, formatImp));
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
  meta: { name: 'stop', description: 'Shut an imp down (its disk stays, its memory does not)' },
  args: { name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const imp = await client.imps.stop({ name: context.args.name });

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
  meta: { name: 'sleep', description: 'Snapshot an imp to disk and free its RAM' },
  args: { name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const imp = await client.imps.sleep({ name: context.args.name });

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
    description: "Print an imp's URLs: https first when HTTPS is on, then local and tailnet",
  },
  args: { name: nameArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const urls = await client.imps.url({ name: context.args.name });

      if (urls.https !== null) {
        console.log(urls.https);
      }

      console.log(urls.local);

      if (urls.tailnet !== null) {
        console.log(urls.tailnet);
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
