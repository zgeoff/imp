import { join } from 'node:path';
import { loadOrCreateBrokerCa } from '../broker/broker-ca';

interface StubTlsUpstreamOptions {
  // a directory the test owns, for the stand-in's own CA
  readonly dir: string;

  // the name its certificate is issued for; localhost by default
  readonly host?: string;

  // answers each request the upstream receives
  readonly fetch: (request: Request) => Response | Promise<Response>;
}

// An HTTPS host on a free loopback port, its certificate signed by a CA of
// its own: real TLS, for a test whose contract is certificate verification,
// which interception cannot carry. Its stop goes into the caller's stack.
export async function startStubBrokerTlsUpstream(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<StubTlsUpstreamOptions>,
) {
  const ca = await loadOrCreateBrokerCa(join(options.dir, 'stub-upstream-ca'));
  const leaf = await ca.issueLeaf(options.host ?? 'localhost');

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: leaf.certPem, key: leaf.keyPem },
    fetch: options.fetch,
  });

  stack.defer(() => server.stop(true));

  const port = server.port ?? 0;

  return { port, origin: `https://localhost:${String(port)}`, caPem: ca.certPem };
}
