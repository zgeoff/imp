import { defineCommand } from '../define-command';
import { formatExposeResult, formatImp, formatOutput } from '../format-output';
import { parsePublicAuth } from '../parse-public-auth';
import { runAction } from '../run-action';
import { jsonArg, nameArg } from './common-args';

export const authArgs = {
  auth: {
    type: 'string',
    description: 'what the imp asks for before it wakes: token (default), basic or none',
  },
  user: { type: 'string', description: 'the basic auth user (default imp)' },
} as const;

export const exposeCommand = defineCommand({
  meta: {
    name: 'expose',
    description: 'Serve an imp to the internet at https://<name>.<domain>, with optional auth',
  },
  args: { name: nameArg, ...authArgs, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const auth = parsePublicAuth(context.args.auth, context.args.user);

      const result = await client.imps.expose({ name: context.args.name, ...auth });

      console.log(formatOutput(result, context.args.json, formatExposeResult));
    }),
});

export const unexposeCommand = defineCommand({
  meta: { name: 'unexpose', description: 'Take an imp off the internet: tailnet only again' },
  args: { name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const imp = await client.imps.unexpose({ name: context.args.name });

      console.log(formatOutput(imp, context.args.json, formatImp));
    }),
});
