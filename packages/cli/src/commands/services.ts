import { ServiceRestartSchema } from '@impz/api';
import type { ServiceDef, ServiceLog } from '@impz/api';
import { ORPCError } from '@impz/client';
import { choice, integer } from 'gunshi/combinators';
import { match } from 'ts-pattern';
import { jsonArg, nameArg } from '../args/common-args';
import { defineCommand, defineGroup } from '../cli/define-command';
import { UsageError } from '../cli/errors';
import { formatError, runAction } from '../cli/run-action';
import { formatOutput, formatServices } from '../output/format-output';

const serviceArg = { type: 'positional', description: 'service name', required: true } as const;

// what `impz service add` takes besides the names
export interface ServiceAddArgs {
  readonly cmd?: string | undefined;

  // the words after `--`
  readonly argv: readonly string[];

  // KEY=VALUE, one or more
  readonly env?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly user?: string | undefined;
  readonly restart?: ServiceDef['restart'] | undefined;
}

// --cmd runs through the shell; a stop signals the whole process group, so
// it reaches what the shell starts. `--` passes argv as it is.
export function buildServiceDef(service: string, args: Readonly<ServiceAddArgs>): ServiceDef {
  if ((args.cmd === undefined) === (args.argv.length === 0)) {
    throw new UsageError('give the command once: --cmd "…" or after --');
  }

  const argv = args.cmd === undefined ? [...args.argv] : ['/bin/sh', '-c', args.cmd];
  const env = requireEnvEntries(args.env ?? []);
  const restart = args.restart;

  return {
    name: service,
    argv,
    ...(env.length > 0 && { env }),
    ...(args.cwd !== undefined && { cwd: args.cwd }),
    ...(args.user !== undefined && { user: args.user }),
    ...(restart !== undefined && { restart }),
  };
}

function requireEnvEntries(entries: readonly string[]): readonly string[] {
  for (const entry of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(entry)) {
      throw new UsageError(`--env ${entry}: want KEY=VALUE`);
    }
  }

  return entries;
}

const addCommand = defineCommand({
  name: 'add',
  description:
    'Add a service to an imp and start it (impz service add <name> <service> --cmd "…" or -- argv)',
  args: {
    name: nameArg,
    service: serviceArg,
    cmd: { type: 'string', description: 'the command, run by /bin/sh' },
    env: { type: 'string', multiple: true, description: 'KEY=VALUE; give it once per variable' },
    cwd: { type: 'string', description: 'working directory (default /)' },
    user: { type: 'string', description: "user to run as (default the image's)" },
    restart: choice(ServiceRestartSchema.options, {
      description: 'always (default), on-failure or never',
    }),
    replace: { type: 'boolean', description: 'replace a service by that name' },
    'http-port': integer({
      min: 1,
      max: 65_535,
      description: "then point the imp's URL at this port (impz set; needs manage)",
    }),
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const name = ctx.values.name;
      const httpPort = ctx.values['http-port'];

      const def = buildServiceDef(ctx.values.service, {
        cmd: ctx.values.cmd,
        argv: ctx.rest,
        env: ctx.values.env,
        cwd: ctx.values.cwd,
        user: ctx.values.user,
        restart: ctx.values.restart,
      });

      await client.services.add({
        name,
        service: def,
        ...(ctx.values.replace === true && { replace: true }),
      });

      if (httpPort === undefined) {
        return;
      }

      // a second call: the port is the imp's, not the service's
      try {
        await client.imps.update({ name, httpPort });
      } catch (error) {
        throw new Error(formatPortRefusal(name, def.name, httpPort, error), { cause: error });
      }
    }),
});

// The service runs either way; say so, and how to set the port after.
function formatPortRefusal(name: string, service: string, port: number, error: unknown): string {
  const forbidden = error instanceof ORPCError && error.code === 'FORBIDDEN';
  const retry = `impz set ${name} --http-port ${String(port)}`;
  const reason = forbidden ? 'setting the HTTP port needs a token with manage' : formatError(error);

  return `service ${service} was added and runs, but the HTTP port was not set: ${reason}. Run \`${retry}\` to set it.`;
}

const lsCommand = defineCommand({
  name: 'ls',
  description: "List an imp's services; a sleeping imp's as its last sleep left them",
  args: { name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const io = ctx.extensions.impz.io;
      const name = ctx.values.name;

      const [listed, imp] = await Promise.all([
        client.services.list({ name }),
        client.imps.get({ name }),
      ]);

      if (!listed.recorded) {
        io.printError(`${name} is sleeping, and its last sleep recorded no services list`);
      } else if (imp.state === 'sleeping') {
        io.printError(`${name} is sleeping: its services as they were when it went to sleep`);
      }

      io.print(formatOutput(listed.services, ctx.values.json, formatServices));
    }),
});

const rmCommand = defineCommand({
  name: 'rm',
  description: 'Stop a service and delete its file; its logs stay',
  args: { name: nameArg, service: serviceArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.services.remove({ name: ctx.values.name, service: ctx.values.service });
    }),
});

const restartCommand = defineCommand({
  name: 'restart',
  description: 'Stop a service and start it again from its file, so an edit applies',
  args: { name: nameArg, service: serviceArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.services.restart({ name: ctx.values.name, service: ctx.values.service });
    }),
});

export const serviceCommand = defineGroup({
  name: 'service',
  description: "Manage an imp's services: add, ls, rm, restart",
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
  name: 'logs',
  description: "Print an imp's service logs (impz logs <name> [service] [-f] [-n lines])",
  args: {
    name: nameArg,
    service: {
      type: 'positional',
      description: 'service name (default every service)',
      required: false,
    },
    follow: { type: 'boolean', short: 'f', description: 'keep printing what they write' },
    lines: integer({
      min: 0,
      max: 100_000,
      short: 'n',
      description: 'lines to print first (default 100)',
    }),
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const io = ctx.extensions.impz.io;
      const lines = ctx.values.lines;
      const service = ctx.values.service;
      const printer = createLogPrinter(service === undefined, io.writeOut);

      const stream = await client.services.logs({
        name: ctx.values.name,
        ...(service !== undefined && { service }),
        ...(lines !== undefined && { lines }),
        ...(ctx.values.follow === true && { follow: true }),
      });

      for await (const event of stream) {
        if (event.type === 'log') {
          printer.print(event);
        } else {
          io.printError(`impz: ${formatLogEvent(ctx.values.name, event)}`);
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
  return match(event)
    .with(
      { type: 'sleeping' },
      (sleeping) =>
        `${name} is ${sleeping.state}; waiting for it to run (a follow does not wake it)`,
    )
    .with({ type: 'awake' }, () => `${name} runs again`)
    .with({ type: 'restarting' }, () => 'impd is restarting; the follow ends')
    .exhaustive();
}
