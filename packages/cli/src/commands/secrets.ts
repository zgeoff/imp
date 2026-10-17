import {
  BrokerRuleSchema,
  GrantFilterSchema,
  OAuthConfigSchema,
  SecretKindSchema,
} from '@impz/api';
import type { BrokerRule, GrantFilter, OAuthConfig, Secret, SecretKind } from '@impz/api';
import { requireFeatures } from '@impz/client';
import { choice, integer } from 'gunshi/combinators';
import { defineCommand, defineGroup } from '../define-command';
import {
  formatApiCalls,
  formatAudit,
  formatGrants,
  formatOutput,
  formatRefusedRequests,
  formatSecrets,
} from '../format-output';
import { buildTokenTerminal, readToken } from '../read-token';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { jsonArg, nameArg } from './common-args';

const secretArg = { type: 'positional', description: 'secret name', required: true } as const;

interface CustomRuleArgs {
  readonly hosts?: string | undefined;
  readonly header?: string | undefined;
  readonly scheme?: string | undefined;
  readonly user?: string | undefined;
  readonly upstream?: string | undefined;
}

interface OAuthArgs {
  readonly tokenUrl?: string | undefined;
  readonly clientId?: string | undefined;
  readonly tokenFormat?: string | undefined;
}

// --hosts a.example.com,b.example.com --header x-api-key --scheme raw: one
// rule per host, all with the same header; kinds custom and oauth
function buildCustomRules(kind: SecretKind, args: CustomRuleArgs): BrokerRule[] | undefined {
  const given = [args.hosts, args.header, args.scheme, args.user].some((arg) => arg !== undefined);

  if (args.upstream !== undefined && kind !== 'custom') {
    throw new UsageError('--upstream is for --kind custom');
  }

  if (kind !== 'custom' && kind !== 'oauth') {
    if (given) {
      throw new UsageError(
        '--hosts, --header, --scheme and --user are for --kind custom and --kind oauth',
      );
    }

    return undefined;
  }

  if (args.hosts === undefined) {
    throw new UsageError(`--kind ${kind} needs --hosts`);
  }

  const hosts = args.hosts.split(',');

  if (args.upstream !== undefined && hosts.length !== 1) {
    throw new UsageError('--upstream needs exactly one host in --hosts');
  }

  return hosts.map((host) => {
    const parsed = BrokerRuleSchema.safeParse({
      host: host.trim(),
      header: (args.header ?? 'authorization').toLowerCase(),
      scheme: args.scheme ?? 'bearer',
      ...(args.user !== undefined && { user: args.user }),
      ...(args.upstream !== undefined && { upstream: args.upstream }),
    });

    if (!parsed.success) {
      throw new UsageError(parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    return parsed.data;
  });
}

// --token-url, --client-id and --token-format: kind oauth only
function buildOAuthConfig(kind: SecretKind, args: OAuthArgs): OAuthConfig | undefined {
  const given = [args.tokenUrl, args.clientId, args.tokenFormat].some((arg) => arg !== undefined);

  if (kind !== 'oauth') {
    if (given) {
      throw new UsageError('--token-url, --client-id and --token-format are for --kind oauth');
    }

    return undefined;
  }

  if (args.tokenUrl === undefined || args.clientId === undefined) {
    throw new UsageError('--kind oauth needs --token-url and --client-id');
  }

  const parsed = OAuthConfigSchema.safeParse({
    tokenUrl: args.tokenUrl,
    clientId: args.clientId,
    ...(args.tokenFormat !== undefined && { tokenFormat: args.tokenFormat }),
  });

  if (!parsed.success) {
    throw new UsageError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }

  return parsed.data;
}

// what an oauth secret's first refresh came to, for stderr; never a token
function formatOAuthOutcome(secret: Readonly<Secret>): string | null {
  const oauth = secret.oauth;

  if (oauth === undefined) {
    return null;
  }

  if (oauth.status === 'ready') {
    const until =
      oauth.expiresAt === null ? '' : `, access token valid until ${oauth.expiresAt.toISOString()}`;

    return `impz: ${secret.name} signed in${until}`;
  }

  const reason = oauth.error === null ? '' : `: ${oauth.error}`;

  return `impz: ${secret.name} is ${oauth.status}${reason}`;
}

// why a refresh left the secret not ready, or null when it is
function formatRefreshFailure(secret: Readonly<Secret>): string | null {
  const oauth = secret.oauth;

  if (oauth === undefined) {
    return `${secret.name} is not an oauth secret`;
  }

  if (oauth.status === 'ready') {
    return null;
  }

  const reason = oauth.error === null ? '' : `: ${oauth.error}`;

  return `${secret.name} is ${oauth.status}${reason}`;
}

const addCommand = defineCommand({
  name: 'add',
  description: 'Store a secret in impd; the value comes from stdin or a prompt, never a flag',
  args: {
    name: secretArg,
    kind: choice(SecretKindSchema.options, {
      description: 'github, anthropic, npm, custom or oauth (both with --hosts)',
      required: true,
    }),

    // not --host, which names the impd to call
    hosts: {
      type: 'string',
      description: 'custom, oauth: the hosts it is for, comma-separated',
    },
    header: {
      type: 'string',
      description: 'custom, oauth: the header to set (default authorization)',
    },
    scheme: { type: 'string', description: 'custom, oauth: bearer (default), basic or raw' },
    user: { type: 'string', description: 'custom, oauth: the user name for basic' },
    upstream: {
      type: 'string',
      description:
        'custom, one host: send its requests here (http or https origin) instead of the host; the credential goes there',
    },
    'token-url': { type: 'string', description: 'oauth: the https token endpoint' },
    'client-id': { type: 'string', description: 'oauth: the client the refresh token is for' },
    'token-format': {
      type: 'string',
      description: 'oauth: form (default) or json, the token request body',
    },
    replace: { type: 'boolean', description: 'replace the value of a secret by that name' },
    rebind: {
      type: 'boolean',
      description: 'with --replace: let the kind or hosts change, and revoke it from every imp',
    },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const kind = ctx.values.kind;
      const rules = buildCustomRules(kind, ctx.values);

      const oauth = buildOAuthConfig(kind, {
        tokenUrl: ctx.values['token-url'],
        clientId: ctx.values['client-id'],
        tokenFormat: ctx.values['token-format'],
      });

      if (ctx.values.rebind === true && ctx.values.replace !== true) {
        throw new UsageError('--rebind needs --replace');
      }

      // an older impd would take another binding and keep every grant; drop
      // the upstream unread and send the credential to the host; or refuse
      // the oauth kind, or drop its config unread
      await requireFeatures(client, {
        ...(ctx.values.replace === true && {
          secretRebind: 'let --replace change the hosts and keep every grant',
        }),
        ...(ctx.values.upstream !== undefined && {
          secretUpstream: 'send the credential to the host itself',
        }),
        ...(kind === 'oauth' && { oauthSecrets: 'refuse the oauth kind' }),
      });

      const prompt = kind === 'oauth' ? 'refresh token' : 'value';

      const value = await readToken(
        `${prompt} for ${ctx.values.name}: `,
        buildTokenTerminal(ctx.extensions.impz.io),
      );

      if (value === '') {
        throw new UsageError('no value given; nothing stored');
      }

      const secret = await client.secrets.add({
        name: ctx.values.name,
        kind,
        value,
        ...(rules !== undefined && { rules }),
        ...(oauth !== undefined && { oauth }),
        ...(ctx.values.replace === true && { replace: true }),
        ...(ctx.values.rebind === true && { rebind: true }),
      });

      if (secret.droppedGrants > 0) {
        ctx.extensions.impz.io.printError(
          `impz: ${secret.name} rebound; revoked from ${String(secret.droppedGrants)} imp(s)`,
        );
      }

      const outcome = formatOAuthOutcome(secret);

      if (outcome !== null) {
        ctx.extensions.impz.io.printError(outcome);
      }

      ctx.extensions.impz.io.print(
        formatOutput(secret, ctx.values.json, (one) => formatSecrets([one])),
      );
    }),
});

const refreshCommand = defineCommand({
  name: 'refresh',
  description: 'Refresh an oauth secret now; exits 1 unless it is ready after it',
  args: { name: secretArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await requireFeatures(client, { oauthSecrets: 'not know the command' });

      const secret = await client.secrets.refresh({ name: ctx.values.name });

      ctx.extensions.impz.io.print(
        formatOutput(secret, ctx.values.json, (one) => formatSecrets([one])),
      );

      const failure = formatRefreshFailure(secret);

      if (failure !== null) {
        throw new Error(failure);
      }
    }),
});

const lsCommand = defineCommand({
  name: 'ls',
  description: 'List secrets: their hosts and the imps they are granted to',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const secrets = await client.secrets.list();

      ctx.extensions.impz.io.print(formatOutput(secrets, ctx.values.json, formatSecrets));
    }),
});

const rmCommand = defineCommand({
  name: 'rm',
  description: 'Delete a secret and revoke it from every imp',
  args: { name: secretArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.secrets.delete({ name: ctx.values.name });
    }),
});

export const secretCommand = defineGroup({
  name: 'secret',
  description: 'Manage the secrets the credential broker adds',
  subCommands: { add: addCommand, refresh: refreshCommand, ls: lsCommand, rm: rmCommand },
});

export const grantCommand = defineCommand({
  name: 'grant',
  description: "Let an imp use a secret: the broker adds it to the imp's requests to its hosts",
  args: {
    name: nameArg,
    secret: secretArg,
    methods: {
      type: 'string',
      description:
        'only requests with one of these methods get the secret, comma-separated (GET,HEAD)',
    },
    paths: {
      type: 'string',
      description:
        'only requests to one of these paths get it, comma-separated; * is one segment, a last /** the rest',
    },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const filter = buildGrantFilter(ctx.values);

      // an older impd drops the filter unread and would grant the whole host
      if (filter !== undefined) {
        await requireFeatures(client, { grantFilters: 'grant the whole host' });
      }

      await client.grants.add({
        name: ctx.values.name,
        secret: ctx.values.secret,
        ...(filter !== undefined && { filter }),
      });
    }),
});

interface GrantFilterArgs {
  readonly methods?: string | undefined;
  readonly paths?: string | undefined;
}

// --methods GET,HEAD --paths '/repos/*/*/issues,/user': undefined for neither
function buildGrantFilter(args: GrantFilterArgs): GrantFilter | undefined {
  if (args.methods === undefined && args.paths === undefined) {
    return undefined;
  }

  const result = GrantFilterSchema.safeParse({
    ...(args.methods !== undefined && { methods: args.methods.split(',') }),
    ...(args.paths !== undefined && { paths: args.paths.split(',') }),
  });

  if (!result.success) {
    const [issue] = result.error.issues;
    const flag = issue?.path[0] === 'methods' ? '--methods' : '--paths';

    throw new UsageError(`${flag}: ${issue?.message ?? 'not a filter'}`);
  }

  return result.data;
}

export const revokeCommand = defineCommand({
  name: 'revoke',
  description: 'Take a secret away from an imp',
  args: { name: nameArg, secret: secretArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.grants.delete({ name: ctx.values.name, secret: ctx.values.secret });
    }),
});

export const grantsCommand = defineCommand({
  name: 'grants',
  description: 'List the secrets granted to an imp',
  args: {
    name: nameArg,
    json: jsonArg,
    filters: { type: 'boolean', description: 'show the methods and paths each grant covers' },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      if (ctx.values.filters === true) {
        await requireFeatures(client, { grantFilters: 'not know the call' });

        const grants = await client.grants.details({ name: ctx.values.name });

        ctx.extensions.impz.io.print(formatOutput(grants, ctx.values.json, formatGrants));

        return;
      }

      const names = await client.grants.list({ name: ctx.values.name });

      ctx.extensions.impz.io.print(formatOutput(names, ctx.values.json, (list) => list.join('\n')));
    }),
});

export const auditCommand = defineCommand({
  name: 'audit',
  description:
    'Show requests the broker sent with a credential or refused, or calls to impd, newest first',
  args: {
    name: { type: 'positional', description: 'imp name (default: every imp)', required: false },
    kind: choice(['broker', 'refused', 'api'] as const, {
      description:
        'broker: requests with a credential (default); refused: requests the broker refused; api: calls that changed impd',
    }),
    limit: integer({ min: 1, max: 1000, description: 'how many rows (default 100, at most 1000)' }),
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const limit = ctx.values.limit;
      const kind = ctx.values.kind ?? 'broker';

      const input = {
        ...(ctx.values.name !== undefined && { name: ctx.values.name }),
        ...(limit !== undefined && { limit }),
      };

      if (kind === 'api') {
        const calls = await client.audit.calls(input);

        ctx.extensions.impz.io.print(formatOutput(calls, ctx.values.json, formatApiCalls));

        return;
      }

      if (kind === 'refused') {
        await requireFeatures(client, { brokerRefusals: 'not know the call' });

        const refused = await client.audit.refused(input);

        ctx.extensions.impz.io.print(formatOutput(refused, ctx.values.json, formatRefusedRequests));

        return;
      }

      const entries = await client.audit.list(input);

      ctx.extensions.impz.io.print(formatOutput(entries, ctx.values.json, formatAudit));
    }),
});
