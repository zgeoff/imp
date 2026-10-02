import { defineCommand } from '../define-command';
import { DEFAULT_SESSION } from '../detach-key';
import { runExec } from '../exec-client';
import { formatOutput, formatSessions } from '../format-output';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { detachKeyArg, jsonArg, nameArg, readDetachKey } from './common-args';
import { readTermEnv } from './imps';

// `imp sessions kill <name> <session>` shares the command with
// `imp sessions <name>`: citty cannot mix subcommands with positionals, so a
// first positional `kill` always means a kill.
export const sessionsCommand = defineCommand({
  meta: {
    name: 'sessions',
    description:
      "List an imp's sessions without waking it (imp sessions kill <name> <session> ends one)",
  },
  args: { name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const positionals = context.args._;

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
    const detachKey = readDetachKey(context.args['detach-key']);

    if (detachKey === undefined) {
      return;
    }

    const code = await runExec({
      host: context.host,
      name: context.args.name,
      argv: [],
      tty: true,
      env: readTermEnv(),
      session: { name: context.args.session ?? DEFAULT_SESSION, attachOnly: true, detachKey },
    });

    process.exit(code);
  },
});
