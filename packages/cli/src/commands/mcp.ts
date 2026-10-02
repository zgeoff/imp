import type { GuardOptions, ImpGuard } from '@imp/mcp';
import packageJson from '../../package.json' with { type: 'json' };
import { defineCommand } from '../define-command';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';

// stdout carries only JSON-RPC messages; anything else goes to stderr. The
// server loads on use, so other commands do not build its tool schemas.
export const mcpCommand = defineCommand({
  meta: {
    name: 'mcp',
    description:
      'Serve imps to a coding agent as MCP tools over stdio. The guard limits which imps the tools touch; it stops mistakes. For a real limit, run it with a scoped token (imp token new).',
  },
  args: {
    prefix: {
      type: 'string',
      description: 'touch only imps whose names start with this; new imps get it',
    },
    allow: { type: 'string', description: 'touch these imps too (comma-separated names)' },
    all: { type: 'boolean', description: 'touch every imp on impd' },
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const mcp = await import('@imp/mcp');

      let guard: ImpGuard;

      // a missing or broken guard is a usage error: exit 2 with the reason
      try {
        guard = mcp.createImpGuard(readGuardOptions(context.args));
      } catch (error) {
        throw error instanceof mcp.GuardError ? new UsageError(error.message) : error;
      }

      const server = mcp.createMcpServer({ version: packageJson.version });

      // impd enforces the token's own scope; every tool is listed
      await mcp.handleLines(Bun.stdin.stream(), server, {
        reply: (message) => {
          process.stdout.write(`${message}\n`);
        },
        client,
        guard,
        scope: 'manage',
      });
    }),
});

interface GuardArgs {
  readonly prefix?: string | undefined;
  readonly allow?: string | undefined;
  readonly all?: boolean | undefined;
}

function readGuardOptions(args: Readonly<GuardArgs>): GuardOptions {
  const allow = (args.allow ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  return {
    ...(args.prefix !== undefined && { prefix: args.prefix }),
    allow,
    all: args.all === true,
  };
}
