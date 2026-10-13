import { randomBytes } from 'node:crypto';
import { EXEC_PATH, MCP_PATH, TUNNEL_PATH } from '@imp/api';
import { createTtlCache } from '../process/ttl-cache';

// The wake proxy hands impd's API the client's address in-process, not in a
// forwarded header a client could write: it sends a random handle that the
// API redeems once, from a loopback peer only (docs/guides/tokens.md).
export const PEER_HEADER = 'x-imp-peer';
const HANDLE_TTL_MS = 30_000;

// a flood of requests evicts its own oldest handles
const MAX_HANDLES = 1024;

export interface ForwardedPeers {
  // a handle for the client's address, for one request
  readonly register: (address: string) => string;

  // the address behind a handle, once; null for an unknown or used one
  readonly take: (handle: string) => string | null;
}

export function createForwardedPeers(now: () => number): ForwardedPeers {
  // each handle's address. A handle is gone at 30 s, where lru-cache keeps
  // an entry until its age passes the ttl, hence one ms less; a set past
  // MAX_HANDLES evicts the oldest, as no read touches recency
  const handles = createTtlCache<string, string>({
    max: MAX_HANDLES,
    ttlMs: HANDLE_TTL_MS - 1,
    now,
  });

  return {
    register: (address) => {
      handles.purgeStale();

      const handle = randomBytes(24).toString('base64url');

      handles.set(handle, address);

      return handle;
    },
    take: (handle) => {
      const address = handles.peek(handle);

      handles.delete(handle);

      return address ?? null;
    },
  };
}

// The paths where the API resolves a caller, so where a handle is redeemed;
// a handle for any other path would only crowd out live ones
export function isCallerPath(pathname: string): boolean {
  return (
    pathname.startsWith('/rpc/') ||
    pathname === EXEC_PATH ||
    pathname === TUNNEL_PATH ||
    pathname === MCP_PATH
  );
}

// The client's address: the socket's own, or, when the socket is the wake
// proxy on loopback, the one it handed over
export function readPeerAddress(
  request: Request,
  socketAddress: string | null,
  peers: ForwardedPeers,
): string | null {
  if (socketAddress === null || !isLoopback(socketAddress)) {
    return socketAddress;
  }

  const handle = request.headers.get(PEER_HEADER);

  return handle === null ? socketAddress : (peers.take(handle) ?? socketAddress);
}

function isLoopback(address: string): boolean {
  return address === '::1' || /^(?:::ffff:)?127\./i.test(address);
}
