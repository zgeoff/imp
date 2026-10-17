import { readFileSync } from 'node:fs';
import { ImageRefPrefixSchema, ImpPatternSchema, ScopeSchema, SecretNameSchema } from '@impz/api';
import type { Scope } from '@impz/api';
import { requireFeatures } from '@impz/client';
import { choice } from 'gunshi/combinators';
import { jsonArg } from '../args/common-args';
import { defineCommand, defineGroup } from '../cli/define-command';
import { UsageError } from '../cli/errors';
import { runAction } from '../cli/run-action';
import { formatIdentity, formatOutput, formatSshKey, formatTokens } from '../output/format-output';

const tokenArg = { type: 'positional', description: 'token name', required: true } as const;

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

// --image-ref-prefix ghcr.io/org/app-: the start of the image refs the
// token may add under its imps (docs/guides/tokens.md#adding-images)
function parseImageRefPrefix(text: string): string {
  const parsed = ImageRefPrefixSchema.safeParse(text);

  if (!parsed.success) {
    throw new UsageError(
      `--image-ref-prefix takes a registry host and the start of a path, such as ghcr.io/org/app-; not ${text}`,
    );
  }

  return parsed.data;
}

// `token set --image-ref-prefix`: as parseImageRefPrefix; '' takes it away
function parseImageRefPrefixUpdate(text: string): string | null {
  return text.trim() === '' ? null : parseImageRefPrefix(text);
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
  name: 'new',
  description: 'Make a token; its secret prints once, on stdout, and impd keeps only a hash',
  args: {
    name: tokenArg,
    scope: choice(ScopeSchema.options, {
      description: 'read, exec (read and run things in imps) or manage (everything)',
      required: true,
    }),
    imps: {
      type: 'string',
      description: "limit it to these imps, such as 'dev-*' (comma-separated; default every imp)",
    },
    grantable: {
      type: 'string',
      description:
        "secrets it may grant to its imps and revoke, such as 'gh,npm' (comma-separated; needs manage and --imps)",
    },
    'image-ref-prefix': {
      type: 'string',
      description:
        "let it add images under its imps from refs that start with this and are pinned by digest, such as 'ghcr.io/org/app-' (needs manage and --imps)",
    },
    'ssh-key': {
      type: 'string',
      description: 'a public key file whose keys log in over ssh as this token',
    },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const scope = ctx.values.scope;
      const imps = parseImpPatterns(ctx.values.imps);
      const grantable = parseGrantable(ctx.values.grantable);
      const prefixArg = ctx.values['image-ref-prefix'];
      const imageRefPrefix = prefixArg === undefined ? undefined : parseImageRefPrefix(prefixArg);

      if (imageRefPrefix !== undefined && (scope !== 'manage' || imps === undefined)) {
        throw new UsageError('--image-ref-prefix needs --scope manage and --imps');
      }

      if (grantable !== undefined) {
        requireGrantScope(scope, imps);
      }

      await requireFeatures(client, {
        ...(imageRefPrefix !== undefined && {
          tokenImageAdd: 'drop --image-ref-prefix and make a token that adds no image',
        }),
        ...(grantable !== undefined && {
          grantableTokens: 'drop --grantable and make the token without that limit',
        }),
      });

      const keyFile = ctx.values['ssh-key'];
      const sshKeys = keyFile === undefined ? undefined : readKeyFile(keyFile);

      const made = await client.tokens.create({
        name: ctx.values.name,
        scope,
        ...(imps !== undefined && { imps }),
        ...(sshKeys !== undefined && { sshKeys }),
        ...(grantable !== undefined && { grantable }),
        ...(imageRefPrefix !== undefined && { imageRefPrefix }),
      });

      if (ctx.values.json === true) {
        ctx.extensions.impz.io.print(formatOutput(made, true, () => ''));

        return;
      }

      ctx.extensions.impz.io.printError(
        `impz: token ${made.token.name} made; impd shows its secret only this once`,
      );

      ctx.extensions.impz.io.print(made.secret);
    }),
});

const setCommand = defineCommand({
  name: 'set',
  description:
    "Change a token's grantable secrets or its image ref prefix; its secret stays, and a secret taken off loses its grants on the token's imps",
  args: {
    name: tokenArg,
    grantable: {
      type: 'string',
      description:
        "the whole new list, such as 'gh,npm' (comma-separated; '' for none; non-empty needs a manage token with imps)",
    },
    'image-ref-prefix': {
      type: 'string',
      description:
        "the start of the pinned refs it may add images from, such as 'ghcr.io/org/app-' ('' for none; needs a manage token with imps)",
    },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const grantableArg = ctx.values.grantable;
      const prefixArg = ctx.values['image-ref-prefix'];

      if (grantableArg === undefined && prefixArg === undefined) {
        throw new UsageError('give --grantable, --image-ref-prefix or both');
      }

      const grantable = grantableArg === undefined ? undefined : parseGrantableUpdate(grantableArg);

      const imageRefPrefix =
        prefixArg === undefined ? undefined : parseImageRefPrefixUpdate(prefixArg);

      // an older impd needs `grantable` on every update, and would drop the
      // prefix unread
      await (imageRefPrefix === undefined
        ? requireFeatures(client, { tokenUpdate: 'not know tokens.update' })
        : requireFeatures(client, { tokenImageAdd: 'not change the image ref prefix' }));

      const token = await client.tokens.update({
        name: ctx.values.name,
        ...(grantable !== undefined && { grantable }),
        ...(imageRefPrefix !== undefined && { imageRefPrefix }),
      });

      ctx.extensions.impz.io.print(
        formatOutput(token, ctx.values.json, (shown) => formatTokens([shown])),
      );
    }),
});

const lsCommand = defineCommand({
  name: 'ls',
  description:
    'List tokens: their scopes, imps, grantable secrets and image ref prefixes, never their secrets',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const tokens = await client.tokens.list();

      ctx.extensions.impz.io.print(formatOutput(tokens, ctx.values.json, formatTokens));
    }),
});

const rmCommand = defineCommand({
  name: 'rm',
  description:
    'Delete a token; its dashboard sessions, streams, sockets and ssh logins end at once',
  args: { name: tokenArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.tokens.delete({ name: ctx.values.name });
    }),
});

const keyAddCommand = defineCommand({
  name: 'add',
  description: 'Bind the keys in a public key file to a token: an ssh login with one runs as it',
  args: {
    name: tokenArg,
    file: {
      type: 'positional',
      description: 'public key file, such as ~/.ssh/id_ed25519.pub',
      required: true,
    },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const lines = readKeyFile(ctx.values.file);
      const added = [];

      for (const key of lines) {
        const bound = await client.tokens.addKey({ name: ctx.values.name, key });

        added.push(bound);
      }

      ctx.extensions.impz.io.print(
        formatOutput(added, ctx.values.json, (keys) =>
          keys.map((key) => formatSshKey(key)).join('\n'),
        ),
      );
    }),
});

const keyRmCommand = defineCommand({
  name: 'rm',
  description: 'Unbind a key from a token; the ssh logins made with it end at once',
  args: {
    name: tokenArg,
    fingerprint: { type: 'positional', description: 'the key, as SHA256:...', required: true },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.tokens.removeKey({
        name: ctx.values.name,
        fingerprint: ctx.values.fingerprint,
      });
    }),
});

const keyLsCommand = defineCommand({
  name: 'ls',
  description: 'List the SSH keys bound to a token, by fingerprint',
  args: { name: tokenArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const tokens = await client.tokens.list();

      const token = tokens.find((each) => each.name === ctx.values.name);

      if (token === undefined) {
        throw new UsageError(`no token named ${ctx.values.name}`);
      }

      ctx.extensions.impz.io.print(
        formatOutput(token.sshKeys, ctx.values.json, (keys) =>
          keys.map((key) => formatSshKey(key)).join('\n'),
        ),
      );
    }),
});

const keyCommand = defineGroup({
  name: 'key',
  description: 'Bind SSH keys to a token, list or unbind them',
  subCommands: { add: keyAddCommand, ls: keyLsCommand, rm: keyRmCommand },
});

const whoamiCommand = defineCommand({
  name: 'whoami',
  description: 'Show who impd takes this CLI for, and what it may do',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const identity = await client.tokens.whoami();

      ctx.extensions.impz.io.print(formatOutput(identity, ctx.values.json, formatIdentity));
    }),
});

export const tokenCommand = defineGroup({
  name: 'token',
  description: 'Manage API tokens and their scopes (needs manage)',
  subCommands: {
    new: newCommand,
    set: setCommand,
    ls: lsCommand,
    rm: rmCommand,
    key: keyCommand,
    whoami: whoamiCommand,
  },
});
