import { BrokerRuleSchema, OAuthConfigSchema, SecretKindSchema } from '@imp/api';
import type { BrokerRule, OAuthConfig, Secret, SecretKind } from '@imp/api';
import { defineCommand } from '../define-command';
import { formatApiCalls, formatAudit, formatOutput, formatSecrets } from '../format-output';
import { readToken } from '../read-token';
import { requireFeature } from '../require-feature';
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

    return `imp: ${secret.name} signed in${until}`;
  }

  const reason = oauth.error === null ? '' : `: ${oauth.error}`;

  return `imp: ${secret.name} is ${oauth.status}${reason}`;
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

function parseKind(kind: string): SecretKind {
  const parsed = SecretKindSchema.safeParse(kind);

  if (!parsed.success) {
    throw new UsageError(`--kind must be one of ${SecretKindSchema.options.join(', ')}`);
  }

  return parsed.data;
}

const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Store a secret in impd; the value comes from stdin or a prompt, never a flag',
  },
  args: {
    name: secretArg,
    kind: {
      type: 'string',
      description: 'github, anthropic, npm, custom or oauth (both with --hosts)',
      required: true,
    },

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
  run: (context) =>
    runAction(context.host, async (client) => {
      const kind = parseKind(context.args.kind);
      const rules = buildCustomRules(kind, context.args);

      const oauth = buildOAuthConfig(kind, {
        tokenUrl: context.args['token-url'],
        clientId: context.args['client-id'],
        tokenFormat: context.args['token-format'],
      });

      if (context.args.rebind === true && context.args.replace !== true) {
        throw new UsageError('--rebind needs --replace');
      }

      // an older impd would take another binding and keep every grant
      if (context.args.replace === true) {
        await requireFeature(
          client,
          'secretRebind',
          'let --replace change the hosts and keep every grant',
        );
      }

      // an older impd would drop the upstream unread and send the credential
      // to the host
      if (context.args.upstream !== undefined) {
        await requireFeature(client, 'secretUpstream', 'send the credential to the host itself');
      }

      // an older impd would refuse the kind, or drop the config unread
      if (kind === 'oauth') {
        await requireFeature(client, 'oauthSecrets', 'refuse the oauth kind');
      }

      const prompt = kind === 'oauth' ? 'refresh token' : 'value';

      const value = await readToken(`${prompt} for ${context.args.name}: `);

      if (value === '') {
        throw new UsageError('no value given; nothing stored');
      }

      const secret = await client.secrets.add({
        name: context.args.name,
        kind,
        value,
        ...(rules !== undefined && { rules }),
        ...(oauth !== undefined && { oauth }),
        ...(context.args.replace === true && { replace: true }),
        ...(context.args.rebind === true && { rebind: true }),
      });

      if (secret.droppedGrants > 0) {
        console.error(
          `imp: ${secret.name} rebound; revoked from ${String(secret.droppedGrants)} imp(s)`,
        );
      }

      const outcome = formatOAuthOutcome(secret);

      if (outcome !== null) {
        console.error(outcome);
      }

      console.log(formatOutput(secret, context.args.json, (one) => formatSecrets([one])));
    }),
});

const refreshCommand = defineCommand({
  meta: {
    name: 'refresh',
    description: 'Refresh an oauth secret now; exits 1 unless it is ready after it',
  },
  args: { name: secretArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      await requireFeature(client, 'oauthSecrets', 'not know the command');

      const secret = await client.secrets.refresh({ name: context.args.name });

      console.log(formatOutput(secret, context.args.json, (one) => formatSecrets([one])));

      const failure = formatRefreshFailure(secret);

      if (failure !== null) {
        throw new Error(failure);
      }
    }),
});

const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List secrets: their hosts and the imps they are granted to' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const secrets = await client.secrets.list();

      console.log(formatOutput(secrets, context.args.json, formatSecrets));
    }),
});

const rmCommand = defineCommand({
  meta: { name: 'rm', description: 'Delete a secret and revoke it from every imp' },
  args: { name: secretArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.secrets.delete({ name: context.args.name });
    }),
});

export const secretCommand = defineCommand({
  meta: { name: 'secret', description: 'Manage the secrets the credential broker adds' },
  subCommands: { add: addCommand, refresh: refreshCommand, ls: lsCommand, rm: rmCommand },
});

export const grantCommand = defineCommand({
  meta: {
    name: 'grant',
    description: "Let an imp use a secret: the broker adds it to the imp's requests to its hosts",
  },
  args: { name: nameArg, secret: secretArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.grants.add({ name: context.args.name, secret: context.args.secret });
    }),
});

export const revokeCommand = defineCommand({
  meta: { name: 'revoke', description: 'Take a secret away from an imp' },
  args: { name: nameArg, secret: secretArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.grants.delete({ name: context.args.name, secret: context.args.secret });
    }),
});

export const grantsCommand = defineCommand({
  meta: { name: 'grants', description: 'List the secrets granted to an imp' },
  args: { name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const names = await client.grants.list({ name: context.args.name });

      console.log(formatOutput(names, context.args.json, (list) => list.join('\n')));
    }),
});

export const auditCommand = defineCommand({
  meta: {
    name: 'audit',
    description: 'Show requests the broker sent with a credential, or calls to impd, newest first',
  },
  args: {
    name: { type: 'positional', description: 'imp name (default: every imp)', required: false },
    kind: {
      type: 'string',
      description: 'broker: requests with a credential (default); api: calls that changed impd',
    },
    limit: { type: 'string', description: 'how many rows (default 100, at most 1000)' },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const limit = context.args.limit === undefined ? undefined : Number(context.args.limit);

      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
        throw new UsageError('--limit must be a whole number from 1 to 1000');
      }

      const kind = context.args.kind ?? 'broker';

      if (kind !== 'broker' && kind !== 'api') {
        throw new UsageError('--kind is broker or api');
      }

      const input = {
        ...(context.args.name !== undefined && { name: context.args.name }),
        ...(limit !== undefined && { limit }),
      };

      if (kind === 'api') {
        const calls = await client.audit.calls(input);

        console.log(formatOutput(calls, context.args.json, formatApiCalls));

        return;
      }

      const entries = await client.audit.list(input);

      console.log(formatOutput(entries, context.args.json, formatAudit));
    }),
});
