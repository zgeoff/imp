import { randomBytes } from 'node:crypto';

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
  const handles = new Map<string, { readonly address: string; readonly expiresAt: number }>();

  return {
    register: (address) => {
      const at = now();

      for (const [handle, entry] of handles) {
        if (entry.expiresAt > at && handles.size < MAX_HANDLES) {
          break;
        }

        handles.delete(handle);
      }

      const handle = randomBytes(24).toString('base64url');

      handles.set(handle, { address, expiresAt: at + HANDLE_TTL_MS });

      return handle;
    },
    take: (handle) => {
      const entry = handles.get(handle);

      handles.delete(handle);

      return entry === undefined || entry.expiresAt <= now() ? null : entry.address;
    },
  };
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
