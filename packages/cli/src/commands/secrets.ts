import { BrokerRuleSchema, SecretKindSchema } from '@imp/api';
import type { BrokerRule, SecretKind } from '@imp/api';
import { defineCommand } from '../define-command';
import { formatApiCalls, formatAudit, formatOutput, formatSecrets } from '../format-output';
import { readToken } from '../read-token';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { jsonArg, nameArg } from './common-args';

const secretArg = { type: 'positional', description: 'secret name', required: true } as const;

interface CustomRuleArgs {
  readonly hosts?: string | undefined;
  readonly header?: string | undefined;
  readonly scheme?: string | undefined;
  readonly user?: string | undefined;
}

// --hosts a.example.com,b.example.com --header x-api-key --scheme raw: one
// rule per host, all with the same header
function buildCustomRules(kind: SecretKind, args: CustomRuleArgs): BrokerRule[] | undefined {
  const given = [args.hosts, args.header, args.scheme, args.user].some((arg) => arg !== undefined);

  if (kind !== 'custom') {
    if (given) {
      throw new UsageError('--hosts, --header, --scheme and --user are for --kind custom');
    }

    return undefined;
  }

  if (args.hosts === undefined) {
    throw new UsageError('--kind custom needs --hosts');
  }

  return args.hosts.split(',').map((host) => {
    const parsed = BrokerRuleSchema.safeParse({
      host: host.trim(),
      header: (args.header ?? 'authorization').toLowerCase(),
      scheme: args.scheme ?? 'bearer',
      ...(args.user !== undefined && { user: args.user }),
    });

    if (!parsed.success) {
      throw new UsageError(parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    return parsed.data;
  });
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
      description: 'github, anthropic, npm, or custom with --hosts',
      required: true,
    },

    // not --host, which names the impd to call
    hosts: { type: 'string', description: 'custom: the hosts it is for, comma-separated' },
    header: { type: 'string', description: 'custom: the header to set (default authorization)' },
    scheme: { type: 'string', description: 'custom: bearer (default), basic or raw' },
    user: { type: 'string', description: 'custom: the user name for basic' },
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

      const value = await readToken(`value for ${context.args.name}: `);

      if (value === '') {
        throw new UsageError('no value given; nothing stored');
      }

      const secret = await client.secrets.add({
        name: context.args.name,
        kind,
        value,
        ...(rules !== undefined && { rules }),
        ...(context.args.replace === true && { replace: true }),
        ...(context.args.rebind === true && { rebind: true }),
      });

      if (secret.droppedGrants > 0) {
        console.error(
          `imp: ${secret.name} rebound; revoked from ${String(secret.droppedGrants)} imp(s)`,
        );
      }

      console.log(formatOutput(secret, context.args.json, (one) => formatSecrets([one])));
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
  subCommands: { add: addCommand, ls: lsCommand, rm: rmCommand },
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
