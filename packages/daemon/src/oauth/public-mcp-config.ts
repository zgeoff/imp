import * as z from 'zod';

// The public MCP route (docs/guides/mcp.md#public-route): off unless
// IMP_MCP_PUBLIC_URL names the origin the operator's TLS front serves
export const PublicMcpEnvSchema = z.object({
  IMP_MCP_PUBLIC_URL: z.string().optional(),
  IMP_MCP_PUBLIC_PORT: z.coerce.number().pipe(z.int().min(1).max(65_535)).default(7071),
});

export interface PublicMcpConfig {
  // the bare origin: the OAuth issuer, and `<origin>/mcp` the one resource
  readonly origin: string;

  // its host and port as a request's Host names them
  readonly host: string;

  // plain HTTP, for the TLS front alone to reach
  readonly port: number;
}

// http only on a loopback host, for tests: a front on the internet speaks https
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function parsePublicMcpConfig(
  env: Readonly<z.infer<typeof PublicMcpEnvSchema>>,
  others: readonly (readonly [string, number])[],
  slotPorts: readonly [number, number],
): PublicMcpConfig | null {
  const text = env.IMP_MCP_PUBLIC_URL;

  if (text === undefined) {
    return null;
  }

  const origin = readOrigin(text);
  const port = env.IMP_MCP_PUBLIC_PORT;
  const clash = others.find(([, other]) => other === port);

  if (clash !== undefined) {
    throw new Error(
      `IMP_MCP_PUBLIC_PORT ${String(port)} is also ${clash[0]}; give it a port of its own`,
    );
  }

  if (port >= slotPorts[0] && port <= slotPorts[1]) {
    throw new Error(
      `IMP_MCP_PUBLIC_PORT ${String(port)} is one of the imps' ports, ${String(slotPorts[0])} to ${String(slotPorts[1])}`,
    );
  }

  return { origin: origin.origin, host: origin.host, port };
}

// an origin with no path, query or credentials: the issuer must be exactly it
function readOrigin(text: string): URL {
  let url: URL;

  try {
    url = new URL(text);
  } catch {
    throw new Error(`IMP_MCP_PUBLIC_URL ${text} is not a URL`);
  }

  const isBare =
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    !text.endsWith('/');

  if (!isBare) {
    throw new Error(
      `IMP_MCP_PUBLIC_URL ${text} must be a bare origin, such as https://imp.example.com`,
    );
  }

  const isLoopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);

  if (url.protocol !== 'https:' && !isLoopbackHttp) {
    throw new Error(
      `IMP_MCP_PUBLIC_URL ${text} must be https; http is for a loopback host in tests only`,
    );
  }

  return url;
}
