import { ApprovalCodeSchema, GrantPatternSchema, RedirectUriSchema, ScopeSchema } from '@imp/api';
import type { Scope } from '@imp/api';
import { defineCommand } from '../define-command';
import {
  formatOAuthApproval,
  formatOAuthClients,
  formatOAuthGrants,
  formatOutput,
} from '../format-output';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { jsonArg } from './common-args';

// The public MCP route's clients, grants and sign-in approvals
// (docs/guides/mcp.md#public-route)

const clientArg = { type: 'positional', description: 'client name', required: true } as const;

const redirectArg = {
  type: 'string',
  description: "the client's redirect URIs, matched exactly (comma-separated)",
  required: true,
} as const;

// --redirect-uri 'https://a/cb,https://b/cb'
function parseRedirectUris(text: string): string[] {
  const uris = text
    .split(',')
    .map((uri) => uri.trim())
    .filter((uri) => uri !== '');

  const bad = uris.find((uri) => !RedirectUriSchema.safeParse(uri).success);

  if (uris.length === 0 || bad !== undefined) {
    throw new UsageError(
      `--redirect-uri takes https URLs, or http on a loopback host, with no fragment; not ${bad ?? text}`,
    );
  }

  return uris;
}

function parseScope(scope: string): Scope {
  const parsed = ScopeSchema.safeParse(scope);

  if (!parsed.success) {
    throw new UsageError(`--scope must be one of ${ScopeSchema.options.join(', ')}`);
  }

  return parsed.data;
}

// --imps 'dev-*,web': imp names, or a name prefix and a trailing *
function parseGrantPatterns(text: string | undefined): string[] | undefined {
  if (text === undefined) {
    return undefined;
  }

  const patterns = text
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');

  const bad = patterns.find((pattern) => !GrantPatternSchema.safeParse(pattern).success);

  if (patterns.length === 0 || bad !== undefined) {
    throw new UsageError(
      `--imps takes imp names, or a name prefix and a trailing *, such as dev-*; not ${bad ?? text}`,
    );
  }

  return patterns;
}

function parseApprovalCode(text: string): string {
  const parsed = ApprovalCodeSchema.safeParse(text);

  if (!parsed.success) {
    throw new UsageError(`${text} is not a sign-in code; it looks like ABCD-EFGH`);
  }

  return parsed.data;
}

const clientAddCommand = defineCommand({
  meta: {
    name: 'add',
    description: "Add a client; its client ID prints on stdout, for the connector's settings",
  },
  args: { name: clientArg, 'redirect-uri': redirectArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const redirectUris = parseRedirectUris(context.args['redirect-uri']);

      const added = await client.oauth.clients.add({ name: context.args.name, redirectUris });

      console.log(formatOutput(added, context.args.json, (made) => made.clientId));
    }),
});

const clientSetCommand = defineCommand({
  meta: {
    name: 'set',
    description: "Replace a client's redirect URIs; its client ID and grants stay",
  },
  args: { name: clientArg, 'redirect-uri': redirectArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const redirectUris = parseRedirectUris(context.args['redirect-uri']);

      const updated = await client.oauth.clients.update({ name: context.args.name, redirectUris });

      console.log(formatOutput([updated], context.args.json, formatOAuthClients));
    }),
});

const clientLsCommand = defineCommand({
  meta: { name: 'ls', description: 'List clients, their client IDs and redirect URIs' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const clients = await client.oauth.clients.list();

      console.log(formatOutput(clients, context.args.json, formatOAuthClients));
    }),
});

const clientRmCommand = defineCommand({
  meta: {
    name: 'rm',
    description: 'Remove a client; its grants end, and their sessions and commands with them',
  },
  args: { name: clientArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.oauth.clients.delete({ name: context.args.name });
    }),
});

const clientCommand = defineCommand({
  meta: { name: 'client', description: 'Add, list, change or remove the clients that may sign in' },
  subCommands: {
    add: clientAddCommand,
    set: clientSetCommand,
    ls: clientLsCommand,
    rm: clientRmCommand,
  },
});

const grantLsCommand = defineCommand({
  meta: { name: 'ls', description: 'List grants: their client, approving token, scope and imps' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const grants = await client.oauth.grants.list();

      console.log(formatOutput(grants, context.args.json, formatOAuthGrants));
    }),
});

const grantRmCommand = defineCommand({
  meta: {
    name: 'rm',
    description: 'End a grant; its tokens, sessions and running commands end at once',
  },
  args: {
    id: { type: 'positional', description: 'grant ID (imp oauth grant ls)', required: true },
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.oauth.grants.delete({ id: context.args.id });
    }),
});

const grantCommand = defineCommand({
  meta: { name: 'grant', description: 'List or end the grants sign-ins made' },
  subCommands: { ls: grantLsCommand, rm: grantRmCommand },
});

const approveCommand = defineCommand({
  meta: {
    name: 'approve',
    description:
      'Approve a sign-in by the code its page shows, as this named token; approve only one you started',
  },
  args: {
    code: { type: 'positional', description: 'the code on the sign-in page', required: true },
    scope: {
      type: 'string',
      description: 'read (the default), exec or manage; at most what the client asked for',
      default: 'read',
    },
    imps: {
      type: 'string',
      description: "limit it to these imps, such as 'dev-*' (comma-separated; default the token's)",
    },
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const code = parseApprovalCode(context.args.code);
      const scope = parseScope(context.args.scope);
      const imps = parseGrantPatterns(context.args.imps);

      // what the sign-in asks for shows before it is approved
      const approval = await client.oauth.approvals.get({ code });

      console.error(formatOAuthApproval(approval));

      await client.oauth.approvals.approve({ code, scope, ...(imps !== undefined && { imps }) });

      const where = imps === undefined ? "the token's imps" : imps.join(',');

      console.error(
        `imp: approved: ${approval.client} gets ${scope} on ${where}; press Continue on the sign-in page`,
      );
    }),
});

export const oauthCommand = defineCommand({
  meta: {
    name: 'oauth',
    description: 'Manage sign-ins to the public MCP route: clients, grants and approvals',
  },
  subCommands: { client: clientCommand, grant: grantCommand, approve: approveCommand },
});
