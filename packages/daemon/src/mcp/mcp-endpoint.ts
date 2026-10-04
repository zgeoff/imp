import { createHttpTransport, createPatternGuard } from '@imp/mcp';
import type { HttpTransport } from '@imp/mcp';
import { createImpClient } from '@zgeoff/imp-client';
import type { ExecSocket } from '@zgeoff/imp-client';
import packageJson from '../../package.json' with { type: 'json' };
import { isSameOrigin } from '../auth/authenticate';
import type { Caller } from '../auth/caller';

export const MCP_PATH = '/mcp';

// the client's calls never leave the process, so the host is a placeholder
const IN_PROCESS_URL = 'http://impd.internal';

export interface McpEndpointDeps {
  // a token or a tailnet identity, or a grant on the public route; null for
  // none
  readonly findCaller: (request: Request) => Promise<Caller | null>;

  // one API call as the caller, through its access rules and audit
  readonly handleRpc: (request: Request, caller: Readonly<Caller>) => Promise<Response>;
  readonly connectExec: (url: string) => ExecSocket;

  // what ends when the caller's token or grant is removed
  readonly readEnds: (caller: Readonly<Caller>) => AbortSignal | null;

  // the public route's: who may call from a browser, and the 401's challenge
  readonly isCrossOrigin?: (request: Request) => boolean;
  readonly challenge?: string;
}

// impd's own MCP endpoint (docs/guides/mcp.md#http): the tools of `imp mcp`,
// each call made as the request's caller, so its token's scope and imp
// patterns limit the agent exactly as they limit the API
export function createMcpEndpoint(deps: Readonly<McpEndpointDeps>): HttpTransport {
  return createHttpTransport({
    version: packageJson.version,
    isCrossOrigin: deps.isCrossOrigin ?? isCrossOrigin,
    ...(deps.challenge !== undefined && { challenge: deps.challenge }),
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
        // a grant is a caller of its own, apart from its token's other grants
        key: `${caller.kind}:${caller.grantId ?? caller.tokenId ?? caller.name}`,
        scope: caller.scope,
        client,
        guard: createPatternGuard(caller.imps),
        ends: deps.readEnds(caller),
      };
    },
  });
}

// A browser names the page a request comes from in Sec-Fetch-Site or Origin,
// and the dashboard's rule decides, Sec-Fetch-Site first. A client that is no
// browser sends neither, and the token alone counts.
function isCrossOrigin(request: Request): boolean {
  const fromBrowser = request.headers.has('sec-fetch-site') || request.headers.has('origin');

  return fromBrowser && !isSameOrigin(request);
}
