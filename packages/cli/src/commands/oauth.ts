import { ApprovalCodeSchema, GrantPatternSchema, RedirectUriSchema, ScopeSchema } from '@impz/api';
import type { Scope } from '@impz/api';
import type { ImpClient } from '../create-imp-client';
import { defineCommand, defineGroup } from '../define-command';
import {
  formatOAuthApproval,
  formatOAuthClients,
  formatOAuthGrants,
  formatOutput,
} from '../format-output';
import { readConfirmation } from '../read-confirmation';
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
  name: 'add',
  description: "Add a client; its client ID prints on stdout, for the connector's settings",
  args: { name: clientArg, 'redirect-uri': redirectArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const redirectUris = parseRedirectUris(ctx.values['redirect-uri']);

      const added = await client.oauth.clients.add({ name: ctx.values.name, redirectUris });

      ctx.extensions.impz.io.print(formatOutput(added, ctx.values.json, (made) => made.clientId));
    }),
});

const clientSetCommand = defineCommand({
  name: 'set',
  description: "Replace a client's redirect URIs; its client ID and grants stay",
  args: { name: clientArg, 'redirect-uri': redirectArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const redirectUris = parseRedirectUris(ctx.values['redirect-uri']);

      const updated = await client.oauth.clients.update({ name: ctx.values.name, redirectUris });

      ctx.extensions.impz.io.print(formatOutput([updated], ctx.values.json, formatOAuthClients));
    }),
});

const clientLsCommand = defineCommand({
  name: 'ls',
  description: 'List clients, their client IDs and redirect URIs',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const clients = await client.oauth.clients.list();

      ctx.extensions.impz.io.print(formatOutput(clients, ctx.values.json, formatOAuthClients));
    }),
});

const clientRmCommand = defineCommand({
  name: 'rm',
  description: 'Remove a client; its grants end, and their sessions and commands with them',
  args: { name: clientArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.oauth.clients.delete({ name: ctx.values.name });
    }),
});

const clientCommand = defineGroup({
  name: 'client',
  description: 'Add, list, change or remove the clients that may sign in',
  subCommands: {
    add: clientAddCommand,
    set: clientSetCommand,
    ls: clientLsCommand,
    rm: clientRmCommand,
  },
});

const grantLsCommand = defineCommand({
  name: 'ls',
  description: 'List grants: their client, approving token, scope and imps',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const grants = await client.oauth.grants.list();

      ctx.extensions.impz.io.print(formatOutput(grants, ctx.values.json, formatOAuthGrants));
    }),
});

const grantRmCommand = defineCommand({
  name: 'rm',
  description: 'End a grant; its tokens, sessions and running commands end at once',
  args: {
    id: { type: 'positional', description: 'grant ID (impz oauth grant ls)', required: true },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.oauth.grants.delete({ id: ctx.values.id });
    }),
});

const grantCommand = defineGroup({
  name: 'grant',
  description: 'List or end the grants sign-ins made',
  subCommands: { ls: grantLsCommand, rm: grantRmCommand },
});

// how approve asks: whether stdin is a terminal, the question itself, and
// where it shows the sign-in and the outcome (stderr)
interface ApprovePrompt {
  readonly isTerminal: boolean;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly show: (line: string) => void;
}

// the calls approve makes, so a test can pass a fake impd
interface ApprovalsClient {
  readonly oauth: {
    readonly approvals: Pick<ImpClient['oauth']['approvals'], 'get' | 'approve'>;
  };
}

interface ApproveRequest {
  readonly code: string;
  readonly scope: Scope;
  readonly imps: readonly string[] | undefined;
  readonly isConfirmed: boolean;
}

// Shows what the sign-in asks for and what it would get, then asks; --yes
// skips the question, and with no terminal to ask at, --yes is required
export async function runApprove(
  client: Readonly<ApprovalsClient>,
  request: Readonly<ApproveRequest>,
  prompt: Readonly<ApprovePrompt>,
): Promise<void> {
  if (!request.isConfirmed && !prompt.isTerminal) {
    throw new UsageError(
      'impz oauth approve asks before it approves, and stdin is not a terminal; pass --yes to approve without asking',
    );
  }

  const approval = await client.oauth.approvals.get({ code: request.code });

  const where = request.imps === undefined ? "the token's imps" : request.imps.join(',');

  prompt.show(formatOAuthApproval(approval));
  prompt.show(`it gets:      ${request.scope} on ${where}`);

  if (!request.isConfirmed) {
    const isApproved = await prompt.confirm('Approve this sign-in? [y/N] ');

    if (!isApproved) {
      throw new Error('not approved; nothing changed');
    }
  }

  await client.oauth.approvals.approve({
    code: request.code,
    scope: request.scope,
    ...(request.imps !== undefined && { imps: [...request.imps] }),
  });

  prompt.show(
    `impz: approved: ${approval.client} gets ${request.scope} on ${where}; press Continue on the sign-in page`,
  );
}

const approveCommand = defineCommand({
  name: 'approve',
  description:
    'Approve a sign-in by the code its page shows, as this named token; approve only one you started',
  args: {
    code: { type: 'positional', description: 'the code on the sign-in page', required: true },
    scope: {
      type: 'enum',
      choices: ScopeSchema.options,
      description: 'read (the default), exec or manage; at most what the client asked for',
      default: 'read',
    },
    imps: {
      type: 'string',
      description: "limit it to these imps, such as 'dev-*' (comma-separated; default the token's)",
    },
    yes: {
      type: 'boolean',
      description: 'approve without asking; needed when stdin is no terminal',
    },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const request = {
        code: parseApprovalCode(ctx.values.code),
        scope: ctx.values.scope,
        imps: parseGrantPatterns(ctx.values.imps),
        isConfirmed: ctx.values.yes === true,
      };

      await runApprove(client, request, {
        isTerminal: ctx.extensions.impz.io.isStdinTerminal,
        confirm: (question) => readConfirmation(question),
        show: (line) => {
          ctx.extensions.impz.io.printError(line);
        },
      });
    }),
});

export const oauthCommand = defineGroup({
  name: 'oauth',
  description: 'Manage sign-ins to the public MCP route: clients, grants and approvals',
  subCommands: { client: clientCommand, grant: grantCommand, approve: approveCommand },
});
