import { ImpPatternSchema, ScopeSchema } from '@imp/api';
import type { Scope } from '@imp/api';
import { defineCommand } from '../define-command';
import { formatIdentity, formatOutput, formatTokens } from '../format-output';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { jsonArg } from './common-args';

const tokenArg = { type: 'positional', description: 'token name', required: true } as const;

function parseScope(scope: string): Scope {
  const parsed = ScopeSchema.safeParse(scope);

  if (!parsed.success) {
    throw new UsageError(`--scope must be one of ${ScopeSchema.options.join(', ')}`);
  }

  return parsed.data;
}

// --imps 'dev-*,ci-*': the imps a token may touch; unset for every imp
function parseImpPatterns(text: string | undefined): string[] | undefined {
  if (text === undefined) {
    return undefined;
  }

  const patterns = text
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');

  const bad = patterns.find((pattern) => !ImpPatternSchema.safeParse(pattern).success);

  if (patterns.length === 0 || bad !== undefined) {
    throw new UsageError(
      `--imps takes imp names with * for any run of characters, such as dev-*; not ${bad ?? text}`,
    );
  }

  return patterns;
}

const newCommand = defineCommand({
  meta: {
    name: 'new',
    description: 'Make a token; its secret prints once, on stdout, and impd keeps only a hash',
  },
  args: {
    name: tokenArg,
    scope: {
      type: 'string',
      description: 'read, exec (read and run things in imps) or manage (everything)',
      required: true,
    },
    imps: {
      type: 'string',
      description: "limit it to these imps, such as 'dev-*' (comma-separated; default every imp)",
    },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const scope = parseScope(context.args.scope);
      const imps = parseImpPatterns(context.args.imps);

      const made = await client.tokens.create({
        name: context.args.name,
        scope,
        ...(imps !== undefined && { imps }),
      });

      if (context.args.json === true) {
        console.log(formatOutput(made, true, () => ''));

        return;
      }

      console.error(`imp: token ${made.token.name} made; impd shows its secret only this once`);
      console.log(made.secret);
    }),
});

const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List tokens: their scopes and imps, never their secrets' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const tokens = await client.tokens.list();

      console.log(formatOutput(tokens, context.args.json, formatTokens));
    }),
});

const rmCommand = defineCommand({
  meta: {
    name: 'rm',
    description: 'Delete a token; its dashboard sessions, streams and sockets end at once',
  },
  args: { name: tokenArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.tokens.delete({ name: context.args.name });
    }),
});

const whoamiCommand = defineCommand({
  meta: { name: 'whoami', description: 'Show who impd takes this CLI for, and what it may do' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const identity = await client.tokens.whoami();

      console.log(formatOutput(identity, context.args.json, formatIdentity));
    }),
});

export const tokenCommand = defineCommand({
  meta: { name: 'token', description: 'Manage API tokens and their scopes (needs manage)' },
  subCommands: { new: newCommand, ls: lsCommand, rm: rmCommand, whoami: whoamiCommand },
});
