import { defineCommand } from 'citty';
import { runExec } from '../exec-client';
import { formatImps, formatJson } from '../format-output';
import { parseDuration } from '../parse-duration';
import { runAction } from '../run-action';

const nameArg = { type: 'positional', description: 'imp name', required: true } as const;

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
    memory: { type: 'string', description: 'memory in MiB' },
    'http-port': { type: 'string', description: 'guest port the proxy forwards to (default 8080)' },
  },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.create({
        ...(context.args.name !== undefined && { name: context.args.name }),
        ...(context.args.image !== undefined && { image: context.args.image }),
        ...(context.args.cpus !== undefined && { vcpus: Number(context.args.cpus) }),
        ...(context.args.memory !== undefined && { memoryMib: Number(context.args.memory) }),
        ...(context.args['http-port'] !== undefined && {
          httpPort: Number(context.args['http-port']),
        }),
      });

      console.log(`${imp.name} ${imp.url}`);
    }),
});

export const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List imps' },
  args: { json: { type: 'boolean', description: 'print JSON' } },
  run: (context) =>
    runAction(async (client) => {
      const imps = await client.imps.list();

      const output = context.args.json === true ? formatJson(imps) : formatImps(imps);

      console.log(output);
    }),
});

export const startCommand = defineCommand({
  meta: { name: 'start', description: 'Boot a stopped imp' },
  args: { name: nameArg },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.start({ name: context.args.name });

      console.log(`${imp.name} ${imp.state}`);
    }),
});

export const stopCommand = defineCommand({
  meta: { name: 'stop', description: 'Shut an imp down (its disk stays, its memory does not)' },
  args: { name: nameArg },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.stop({ name: context.args.name });

      console.log(`${imp.name} ${imp.state}`);
    }),
});

export const rmCommand = defineCommand({
  meta: { name: 'rm', description: 'Destroy an imp and its disk and checkpoints' },
  args: { name: nameArg },
  run: (context) =>
    runAction(async (client) => {
      await client.imps.destroy({ name: context.args.name });
    }),
});

export const sleepCommand = defineCommand({
  meta: { name: 'sleep', description: 'Snapshot an imp to disk and free its RAM' },
  args: { name: nameArg },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.sleep({ name: context.args.name });

      console.log(formatImps([imp]));
    }),
});

export const wakeCommand = defineCommand({
  meta: { name: 'wake', description: 'Resume a sleeping or stopped imp' },
  args: { name: nameArg },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.wake({ name: context.args.name });

      console.log(formatImps([imp]));
    }),
});

export const holdCommand = defineCommand({
  meta: { name: 'hold', description: 'Keep an imp awake for a while (0 releases)' },
  args: {
    name: nameArg,
    duration: { type: 'positional', description: 'e.g. 90s, 15m, 2h', required: true },
  },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.hold({
        name: context.args.name,
        seconds: parseDuration(context.args.duration),
      });

      console.log(`${imp.name} held until ${imp.holdUntil?.toISOString() ?? 'released'}`);
    }),
});

export const urlCommand = defineCommand({
  meta: { name: 'url', description: "Print an imp's URLs" },
  args: { name: nameArg },
  run: (context) =>
    runAction(async (client) => {
      const urls = await client.imps.url({ name: context.args.name });

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
    checkpoint: { type: 'string', description: 'checkpoint id or label to fork from' },
  },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.fork({
        source: context.args.source,
        name: context.args.name,
        ...(context.args.checkpoint !== undefined && { checkpoint: context.args.checkpoint }),
      });

      console.log(formatImps([imp]));
    }),
});

export const execCommand = defineCommand({
  meta: { name: 'exec', description: 'Run a command in an imp (imp exec [-t] <name> -- cmd args)' },
  args: {
    name: nameArg,
    tty: { type: 'boolean', alias: 't', description: 'run on a terminal' },
  },
  run: async (context) => {
    const argv = splitCommand(context.rawArgs, context.args._.slice(1));

    if (argv.length === 0) {
      console.error('imp: exec needs a command: imp exec <name> -- cmd args');
      process.exit(2);
    }

    const code = await runExec({
      name: context.args.name,
      argv,
      tty: context.args.tty === true,
      ...(context.args.tty === true && { env: readTermEnv() }),
    });

    process.exit(code);
  },
});

// The login shell from the image's /etc/passwd, else bash, else sh. Plain
// sh, because the image may have neither awk nor getent.
const CONSOLE_SHELL = [
  'shell=',
  'while IFS=: read -r user _ _ _ _ _ login; do',
  '  if [ "$user" = root ]; then shell=$login; break; fi',
  'done < /etc/passwd',
  '[ -x "$shell" ] || shell=/bin/bash',
  '[ -x "$shell" ] || shell=/bin/sh',
  'exec "$shell" -l',
].join('\n');

export const consoleCommand = defineCommand({
  meta: { name: 'console', description: 'Open an interactive shell in an imp' },
  args: { name: nameArg },
  run: async (context) => {
    const code = await runExec({
      name: context.args.name,
      argv: ['/bin/sh', '-c', CONSOLE_SHELL],
      tty: true,
      env: readTermEnv(),
    });

    process.exit(code);
  },
});

// everything after `--`, else the positionals after the name
function splitCommand(rawArgs: readonly string[], positionals: readonly string[]): string[] {
  const separator = rawArgs.indexOf('--');

  return separator === -1 ? [...positionals] : rawArgs.slice(separator + 1);
}

function readTermEnv(): Record<string, string> {
  return { TERM: process.env['TERM'] ?? 'xterm-256color' };
}
