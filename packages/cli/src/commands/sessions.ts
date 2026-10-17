import { integer } from 'gunshi/combinators';
import { detachKeyArg, jsonArg, nameArg, requireSessionName } from '../args/common-args';
import { defineCommand } from '../cli/define-command';
import { dispatchVerb, listOperands } from '../cli/dispatch-verb';
import { CommandExitError, UsageError } from '../cli/errors';
import { runAction } from '../cli/run-action';
import { DEFAULT_SESSION, parseDetachKey } from '../exec/detach-key';
import { buildExecIO, runExec } from '../exec/exec-client';
import { formatOutput, formatSessions } from '../output/format-output';
import { readTermEnv } from '../sessions/read-term-env';
import { listSessionLogs, removeSessionLogs, writeSessionLog } from '../sessions/session-logs';

export const sessionsCommand = defineCommand({
  name: 'sessions',
  description:
    "List an imp's sessions without waking it (impz sessions kill <name> <session> ends one; logs, log and log-rm read and delete session logs)",
  args: {
    name: nameArg,
    json: jsonArg,
    from: integer({
      min: 0,
      description: 'impz sessions log: the offset to read from (default 0)',
    }),
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const io = ctx.extensions.impz.io;
      const isJson = ctx.values.json === true;

      await dispatchVerb(
        listOperands(ctx),
        {
          logs: (operands) => listSessionLogs(client, io, operands, isJson),
          log: (operands) => writeSessionLog(client, io, operands, ctx.values.from ?? 0),
          'log-rm': (operands) => removeSessionLogs(client, io, operands),
          kill: async (operands) => {
            const [name, session] = operands;

            if (operands.length !== 2 || name === undefined || session === undefined) {
              throw new UsageError('usage: impz sessions kill <name> <session>');
            }

            await client.sessions.kill({ name, session });
          },
        },
        async () => {
          const sessions = await client.sessions.list({ name: ctx.values.name });

          io.print(formatOutput(sessions, ctx.values.json, formatSessions));
        },
      );
    }),
});

export const attachCommand = defineCommand({
  name: 'attach',
  description: 'Attach to a session in an imp: its recent output, then live (ctrl-] detaches)',
  args: {
    name: nameArg,
    session: {
      type: 'positional',
      description: `session name (default ${DEFAULT_SESSION})`,
      required: false,
    },
    'detach-key': detachKeyArg,
  },
  run: async (ctx) => {
    const session = requireSessionName(ctx.values.session ?? DEFAULT_SESSION);
    const detachKey = parseDetachKey(ctx.values['detach-key']);

    const code = await runExec(
      {
        host: ctx.extensions.impz.host,
        name: ctx.values.name,
        argv: [],
        tty: true,
        env: readTermEnv(ctx.extensions.impz.io.env),
        session: { name: session, attachOnly: true, detachKey },
      },
      buildExecIO(ctx.extensions.impz.io),
    );

    throw new CommandExitError(code, true);
  },
});
