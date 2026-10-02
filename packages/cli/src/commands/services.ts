import { ServiceRestartSchema } from '@imp/api';
import type { ServiceDef, ServiceLog } from '@imp/api';
import { defineCommand } from '../define-command';
import { formatOutput, formatServices } from '../format-output';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { jsonArg, nameArg } from './common-args';

const serviceArg = { type: 'positional', description: 'service name', required: true } as const;

// what `imp service add` takes besides the names
export interface ServiceAddArgs {
  readonly cmd?: string | undefined;

  // the words after `--`
  readonly argv: readonly string[];

  // KEY=VALUE, one or more
  readonly env?: string | readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly user?: string | undefined;
  readonly restart?: string | undefined;
}

// --cmd runs through the shell; a stop signals the whole process group, so
// it reaches what the shell starts. `--` passes argv as it is.
export function buildServiceDef(service: string, args: Readonly<ServiceAddArgs>): ServiceDef {
  if ((args.cmd === undefined) === (args.argv.length === 0)) {
    throw new UsageError('give the command once: --cmd "…" or after --');
  }

  const argv = args.cmd === undefined ? [...args.argv] : ['/bin/sh', '-c', args.cmd];
  const env = readRepeated(args.env);
  const restart = readRestart(args.restart);

  return {
    name: service,
    argv,
    ...(env.length > 0 && { env }),
    ...(args.cwd !== undefined && { cwd: args.cwd }),
    ...(args.user !== undefined && { user: args.user }),
    ...(restart !== undefined && { restart }),
  };
}

function readRepeated(value: string | readonly string[] | undefined): string[] {
  const values = typeof value === 'string' ? [value] : [...(value ?? [])];

  for (const entry of values) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry)) {
      throw new UsageError(`--env ${entry}: want KEY=VALUE`);
    }
  }

  return values;
}

function readRestart(restart: string | undefined): ServiceDef['restart'] {
  if (restart === undefined) {
    return undefined;
  }

  const parsed = ServiceRestartSchema.safeParse(restart);

  if (!parsed.success) {
    throw new UsageError(`--restart must be one of ${ServiceRestartSchema.options.join(', ')}`);
  }

  return parsed.data;
}

// citty keeps only the last of a repeated string flag, so the values come
// from the raw arguments before `--`
function readFlagValues(rawArgs: readonly string[], flag: string): string[] {
  const separator = rawArgs.indexOf('--');
  const args = separator === -1 ? rawArgs : rawArgs.slice(0, separator);
  const values: string[] = [];

  for (const [index, arg] of args.entries()) {
    const next = args[index + 1];

    if (arg === `--${flag}` && next !== undefined) {
      values.push(next);
    } else if (arg.startsWith(`--${flag}=`)) {
      values.push(arg.slice(flag.length + 3));
    }
  }

  return values;
}

// main hands citty only the arguments before `--`, as for `imp exec`
function splitAfterSeparator(argv: readonly string[]): string[] {
  const separator = argv.indexOf('--');

  return separator === -1 ? [] : argv.slice(separator + 1);
}

const addCommand = defineCommand({
  meta: {
    name: 'add',
    description:
      'Add a service to an imp and start it (imp service add <name> <service> --cmd "…" or -- argv)',
  },
  args: {
    name: nameArg,
    service: serviceArg,
    cmd: { type: 'string', description: 'the command, run by /bin/sh' },
    env: { type: 'string', description: 'KEY=VALUE; give it once per variable' },
    cwd: { type: 'string', description: 'working directory (default /)' },
    user: { type: 'string', description: "user to run as (default the image's)" },
    restart: { type: 'string', description: 'always (default), on-failure or never' },
    replace: { type: 'boolean', description: 'replace a service by that name' },
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const def = buildServiceDef(context.args.service, {
        cmd: context.args.cmd,
        argv: splitAfterSeparator(process.argv),
        env: readFlagValues(context.rawArgs, 'env'),
        cwd: context.args.cwd,
        user: context.args.user,
        restart: context.args.restart,
      });

      await client.services.add({
        name: context.args.name,
        service: def,
        ...(context.args.replace === true && { replace: true }),
      });
    }),
});

const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: "List an imp's services; a sleeping imp's as its last sleep left them",
  },
  args: { name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const name = context.args.name;

      const [services, imp] = await Promise.all([
        client.services.list({ name }),
        client.imps.get({ name }),
      ]);

      if (imp.state === 'sleeping') {
        console.error(`${name} is sleeping: its services as they were when it went to sleep`);
      }

      console.log(formatOutput(services, context.args.json, formatServices));
    }),
});

const rmCommand = defineCommand({
  meta: { name: 'rm', description: 'Stop a service and delete its file; its logs stay' },
  args: { name: nameArg, service: serviceArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.services.remove({ name: context.args.name, service: context.args.service });
    }),
});

const restartCommand = defineCommand({
  meta: {
    name: 'restart',
    description: 'Stop a service and start it again from its file, so an edit applies',
  },
  args: { name: nameArg, service: serviceArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.services.restart({ name: context.args.name, service: context.args.service });
    }),
});

export const serviceCommand = defineCommand({
  meta: { name: 'service', description: "Manage an imp's services: add, ls, rm, restart" },
  subCommands: { add: addCommand, ls: lsCommand, rm: rmCommand, restart: restartCommand },
});

// a line with no end yet goes out in pieces of this many characters, each
// with the prefix, so one huge line never piles up in memory
const MAX_PARTIAL_LINE = 65_536;

type LogText = Extract<ServiceLog, { readonly type: 'log' }>;

// Writes each service's text as it comes. With prefix, every line starts
// with its service's name, so a line waits for its end; `flush` writes what
// is left once the stream ends.
export function createLogPrinter(prefix: boolean, write: (text: string) => void) {
  const partial = new Map<string, string>();

  return {
    print: (log: Readonly<LogText>) => {
      if (!prefix) {
        write(log.text);

        return;
      }

      const lines = `${partial.get(log.service) ?? ''}${log.text}`.split('\n');
      let rest = lines.pop() ?? '';

      while (rest.length > MAX_PARTIAL_LINE) {
        lines.push(rest.slice(0, MAX_PARTIAL_LINE));

        rest = rest.slice(MAX_PARTIAL_LINE);
      }

      partial.set(log.service, rest);

      for (const line of lines) {
        write(`${log.service} | ${line}\n`);
      }
    },
    flush: () => {
      for (const [service, rest] of partial) {
        if (rest !== '') {
          write(`${service} | ${rest}\n`);
        }
      }

      partial.clear();
    },
  };
}

export const logsCommand = defineCommand({
  meta: {
    name: 'logs',
    description: "Print an imp's service logs (imp logs <name> [service] [-f] [-n lines])",
  },
  args: {
    name: nameArg,
    service: {
      type: 'positional',
      description: 'service name (default every service)',
      required: false,
    },
    follow: { type: 'boolean', alias: 'f', description: 'keep printing what they write' },
    lines: { type: 'string', alias: 'n', description: 'lines to print first (default 100)' },
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const lines = readLineCount(context.args.lines);
      const service = context.args.service;

      const printer = createLogPrinter(service === undefined, (text) => {
        process.stdout.write(text);
      });

      const stream = await client.services.logs({
        name: context.args.name,
        ...(service !== undefined && { service }),
        ...(lines !== undefined && { lines }),
        ...(context.args.follow === true && { follow: true }),
      });

      for await (const event of stream) {
        if (event.type === 'log') {
          printer.print(event);
        } else {
          console.error(`imp: ${formatLogEvent(context.args.name, event)}`);
        }
      }

      printer.flush();
    }),
});

// what a follow says on stderr when the imp stops running, runs again, or
// impd restarts, which ends it
export function formatLogEvent(
  name: string,
  event: Readonly<Exclude<ServiceLog, { readonly type: 'log' }>>,
): string {
  if (event.type === 'sleeping') {
    return `${name} is ${event.state}; waiting for it to run (a follow does not wake it)`;
  }

  if (event.type === 'awake') {
    return `${name} runs again`;
  }

  return 'impd is restarting; the follow ends';
}

function readLineCount(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }

  const count = Number(text);

  if (!Number.isInteger(count) || count < 0 || count > 100_000) {
    throw new UsageError('--lines must be a whole number from 0 to 100000');
  }

  return count;
}
