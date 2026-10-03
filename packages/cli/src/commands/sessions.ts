import { defineCommand } from '../define-command';
import { DEFAULT_SESSION } from '../detach-key';
import { runExec } from '../exec-client';
import { formatOutput, formatSessions } from '../format-output';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { detachKeyArg, jsonArg, nameArg, readDetachKey, readSessionName } from './common-args';
import { readTermEnv } from './imps';
import { listSessionLogs, removeSessionLogs, writeSessionLog } from './session-logs';

// `imp sessions kill|logs|log|log-rm ...` share the command with
// `imp sessions <name>`: citty cannot mix subcommands with positionals, so
// a first positional that names a verb always means it.
export const sessionsCommand = defineCommand({
  meta: {
    name: 'sessions',
    description:
      "List an imp's sessions without waking it (imp sessions kill <name> <session> ends one; logs, log and log-rm read and delete session logs)",
  },
  args: {
    name: nameArg,
    json: jsonArg,
    from: {
      type: 'string',
      description: 'imp sessions log: the offset to read from (default 0)',
    },
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const positionals = context.args._;
      const [verb, ...rest] = positionals;

      if (verb === 'logs') {
        await listSessionLogs(client, rest, context.args.json === true);

        return;
      }

      if (verb === 'log') {
        await writeSessionLog(client, rest, context.args.from);

        return;
      }

      if (verb === 'log-rm') {
        await removeSessionLogs(client, rest);

        return;
      }

      if (positionals[0] === 'kill') {
        const [, name, session] = positionals;

        if (positionals.length !== 3 || name === undefined || session === undefined) {
          throw new UsageError('usage: imp sessions kill <name> <session>');
        }

        await client.sessions.kill({ name, session });

        return;
      }

      const sessions = await client.sessions.list({ name: context.args.name });

      console.log(formatOutput(sessions, context.args.json, formatSessions));
    }),
});

export const attachCommand = defineCommand({
  meta: {
    name: 'attach',
    description: 'Attach to a session in an imp: its recent output, then live (ctrl-] detaches)',
  },
  args: {
    name: nameArg,
    session: {
      type: 'positional',
      description: `session name (default ${DEFAULT_SESSION})`,
      required: false,
    },
    'detach-key': detachKeyArg,
  },
  run: async (context) => {
    const session = readSessionName(context.args.session ?? DEFAULT_SESSION);
    const detachKey = readDetachKey(context.args['detach-key']);

    if (session === undefined || detachKey === undefined) {
      return;
    }

    const code = await runExec({
      host: context.host,
      name: context.args.name,
      argv: [],
      tty: true,
      env: readTermEnv(),
      session: { name: session, attachOnly: true, detachKey },
    });

    process.exit(code);
  },
});
