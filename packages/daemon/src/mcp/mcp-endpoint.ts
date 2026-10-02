import { createHttpTransport, createPatternGuard } from '@imp/mcp';
import type { HttpTransport } from '@imp/mcp';
import { createImpClient } from '@zgeoff/imp-client';
import type { ExecSocket } from '@zgeoff/imp-client';
import packageJson from '../../package.json' with { type: 'json' };
import type { Caller } from '../auth/caller';

export const MCP_PATH = '/mcp';

// the client's calls never leave the process, so the host is a placeholder
const IN_PROCESS_URL = 'http://impd.internal';

export interface McpEndpointDeps {
  // a token or a tailnet identity; null for none
  readonly findCaller: (request: Request) => Promise<Caller | null>;

  // one API call as the caller, through its access rules and audit
  readonly handleRpc: (request: Request, caller: Readonly<Caller>) => Promise<Response>;
  readonly connectExec: (url: string) => ExecSocket;

  // what ends when the caller's token is removed
  readonly readEnds: (caller: Readonly<Caller>) => AbortSignal | null;
}

// impd's own MCP endpoint (docs/guides/mcp.md#http): the tools of `imp mcp`,
// each call made as the request's caller, so its token's scope and imp
// patterns limit the agent exactly as they limit the API
export function createMcpEndpoint(deps: Readonly<McpEndpointDeps>): HttpTransport {
  return createHttpTransport({
    version: packageJson.version,
    authenticate: async (request) => {
      const caller = await deps.findCaller(request);

      if (caller === null) {
        return null;
      }

      const client = createImpClient({
        url: IN_PROCESS_URL,
        fetch: (rpc) => deps.handleRpc(rpc, caller),
        connect: deps.connectExec,
      });

      return {
        key: `${caller.kind}:${caller.tokenId ?? caller.name}`,
        scope: caller.scope,
        client,
        guard: createPatternGuard(caller.imps),
        ends: deps.readEnds(caller),
      };
    },
  });
}
