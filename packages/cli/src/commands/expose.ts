import { authArgs } from '../args/auth-args';
import { jsonArg, nameArg } from '../args/common-args';
import { defineCommand } from '../cli/define-command';
import { runAction } from '../cli/run-action';
import { formatExposeResult, formatImp, formatOutput } from '../output/format-output';
import { parsePublicAuth } from '../parse/parse-public-auth';

export const exposeCommand = defineCommand({
  name: 'expose',
  description: 'Serve an imp to the internet at https://<name>.<domain>, with optional auth',
  args: { name: nameArg, ...authArgs, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const auth = parsePublicAuth(ctx.values.auth, ctx.values.user);

      const result = await client.imps.expose({ name: ctx.values.name, ...auth });

      ctx.extensions.impz.io.print(formatOutput(result, ctx.values.json, formatExposeResult));
    }),
});

export const unexposeCommand = defineCommand({
  name: 'unexpose',
  description: 'Take an imp off the internet: tailnet only again',
  args: { name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imp = await client.imps.unexpose({ name: ctx.values.name });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});
