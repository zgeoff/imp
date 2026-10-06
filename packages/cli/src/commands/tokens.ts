import { readFileSync } from 'node:fs';
import { ImpPatternSchema, ScopeSchema, SecretNameSchema } from '@imp/api';
import type { Scope } from '@imp/api';
import { defineCommand } from '../define-command';
import { formatIdentity, formatOutput, formatSshKey, formatTokens } from '../format-output';
import { requireFeature } from '../require-feature';
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

// --grantable 'gh,npm': existing secrets the token may grant to its imps
function parseGrantable(text: string | undefined): string[] | undefined {
  if (text === undefined) {
    return undefined;
  }

  const names = text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  const bad = names.find((name) => !SecretNameSchema.safeParse(name).success);

  if (names.length === 0 || bad !== undefined) {
    throw new UsageError(`--grantable takes secret names, such as gh,npm; not ${bad ?? text}`);
  }

  return names;
}

// `token set --grantable`: the whole new list, as parseGrantable; '' clears it
function parseGrantableUpdate(text: string): string[] {
  return text.trim() === '' ? [] : (parseGrantable(text) ?? []);
}

// a list makes sense only on a manage token for some imps; an impd refuses
// it otherwise, but an older one would not see the list at all
function requireGrantScope(scope: Scope, imps: readonly string[] | undefined): void {
  if (scope !== 'manage' || imps === undefined) {
    throw new UsageError('--grantable needs --scope manage and --imps');
  }
}

// The key lines of a public key file, such as ~/.ssh/id_ed25519.pub. A
// private key is refused before it leaves this machine.
function readKeyFile(path: string): string[] {
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new UsageError(`cannot read ${path}: ${reason}`);
  }

  if (text.includes('PRIVATE KEY')) {
    throw new UsageError(`${path} is a private key; give its .pub file`);
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  if (lines.length === 0) {
    throw new UsageError(`${path} holds no key`);
  }

  return lines;
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
    grantable: {
      type: 'string',
      description:
        "secrets it may grant to its imps and revoke, such as 'gh,npm' (comma-separated; needs manage and --imps)",
    },
    'ssh-key': {
      type: 'string',
      description: 'a public key file whose keys log in over ssh as this token',
    },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const scope = parseScope(context.args.scope);
      const imps = parseImpPatterns(context.args.imps);
      const grantable = parseGrantable(context.args.grantable);

      if (grantable !== undefined) {
        requireGrantScope(scope, imps);

        await requireFeature(
          client,
          'grantableTokens',
          'drop --grantable and make the token without that limit',
        );
      }

      const keyFile = context.args['ssh-key'];
      const sshKeys = keyFile === undefined ? undefined : readKeyFile(keyFile);

      const made = await client.tokens.create({
        name: context.args.name,
        scope,
        ...(imps !== undefined && { imps }),
        ...(sshKeys !== undefined && { sshKeys }),
        ...(grantable !== undefined && { grantable }),
      });

      if (context.args.json === true) {
        console.log(formatOutput(made, true, () => ''));

        return;
      }

      console.error(`imp: token ${made.token.name} made; impd shows its secret only this once`);
      console.log(made.secret);
    }),
});

const setCommand = defineCommand({
  meta: {
    name: 'set',
    description:
      "Change a token's grantable secrets; its secret stays, and a secret taken off loses its grants on the token's imps",
  },
  args: {
    name: tokenArg,
    grantable: {
      type: 'string',
      description:
        "the whole new list, such as 'gh,npm' (comma-separated; '' for none; non-empty needs a manage token with imps)",
      required: true,
    },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const grantable = parseGrantableUpdate(context.args.grantable);

      await requireFeature(client, 'tokenUpdate', 'not know tokens.update');

      const token = await client.tokens.update({ name: context.args.name, grantable });

      console.log(formatOutput(token, context.args.json, (shown) => formatTokens([shown])));
    }),
});

const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List tokens: their scopes, imps and grantable secrets, never their secrets',
  },
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
    description:
      'Delete a token; its dashboard sessions, streams, sockets and ssh logins end at once',
  },
  args: { name: tokenArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.tokens.delete({ name: context.args.name });
    }),
});

const keyAddCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Bind the keys in a public key file to a token: an ssh login with one runs as it',
  },
  args: {
    name: tokenArg,
    file: {
      type: 'positional',
      description: 'public key file, such as ~/.ssh/id_ed25519.pub',
      required: true,
    },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const lines = readKeyFile(context.args.file);
      const added = [];

      for (const key of lines) {
        const bound = await client.tokens.addKey({ name: context.args.name, key });

        added.push(bound);
      }

      console.log(
        formatOutput(added, context.args.json, (keys) =>
          keys.map((key) => formatSshKey(key)).join('\n'),
        ),
      );
    }),
});

const keyRmCommand = defineCommand({
  meta: {
    name: 'rm',
    description: 'Unbind a key from a token; the ssh logins made with it end at once',
  },
  args: {
    name: tokenArg,
    fingerprint: { type: 'positional', description: 'the key, as SHA256:...', required: true },
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.tokens.removeKey({
        name: context.args.name,
        fingerprint: context.args.fingerprint,
      });
    }),
});

const keyLsCommand = defineCommand({
  meta: { name: 'ls', description: 'List the SSH keys bound to a token, by fingerprint' },
  args: { name: tokenArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const tokens = await client.tokens.list();

      const token = tokens.find((each) => each.name === context.args.name);

      if (token === undefined) {
        throw new UsageError(`no token named ${context.args.name}`);
      }

      console.log(
        formatOutput(token.sshKeys, context.args.json, (keys) =>
          keys.map((key) => formatSshKey(key)).join('\n'),
        ),
      );
    }),
});

const keyCommand = defineCommand({
  meta: { name: 'key', description: 'Bind SSH keys to a token, list or unbind them' },
  subCommands: { add: keyAddCommand, ls: keyLsCommand, rm: keyRmCommand },
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
  subCommands: {
    new: newCommand,
    set: setCommand,
    ls: lsCommand,
    rm: rmCommand,
    key: keyCommand,
    whoami: whoamiCommand,
  },
});
