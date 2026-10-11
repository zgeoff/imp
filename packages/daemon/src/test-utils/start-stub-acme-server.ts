import * as z from 'zod';

// RFC 8555 7.4: the identifiers a new order names, inside the JWS payload
const IdentifierSchema = z.object({ type: z.literal('dns'), value: z.string() });
const OrderPayloadSchema = z.object({ identifiers: z.array(IdentifierSchema) });
const JwsSchema = z.object({ payload: z.string() });

// An ACME server on a free loopback port, up to the challenge: a directory,
// a nonce on each answer, an account, an order, and per name an
// authorization that offers the test's challenge types.
export function startStubAcmeServer(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<{ challengeTypes: readonly string[] }>,
) {
  // each call it does not model, which gets a 500 that names it
  const unexpected: string[] = [];
  const orders: { value: string }[][] = [];
  const nonces = { count: 0 };

  const readNonce = (): Record<string, string> => {
    nonces.count += 1;

    return { 'replay-nonce': `nonce-${String(nonces.count)}` };
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);

      const path = url.pathname;
      const call = `${request.method} ${path}`;

      if (call === 'GET /dir') {
        return Response.json({
          newNonce: `${url.origin}/new-nonce`,
          newAccount: `${url.origin}/new-account`,
          newOrder: `${url.origin}/new-order`,
        });
      }

      if (call === 'HEAD /new-nonce') {
        return new Response(null, { status: 200, headers: readNonce() });
      }

      if (call === 'POST /new-account') {
        return Response.json(
          { status: 'valid' },
          { status: 201, headers: { ...readNonce(), location: `${url.origin}/account/1` } },
        );
      }

      if (call === 'POST /new-order') {
        const body: unknown = await request.json();

        const jws = JwsSchema.parse(body);
        const payload: unknown = JSON.parse(Buffer.from(jws.payload, 'base64url').toString());
        const identifiers = OrderPayloadSchema.parse(payload).identifiers;

        orders.push(identifiers);

        return Response.json(
          {
            status: 'pending',
            identifiers,
            authorizations: identifiers.map(
              (_, index) => `${url.origin}/authz/${String(orders.length)}/${String(index)}`,
            ),
            finalize: `${url.origin}/finalize/${String(orders.length)}`,
          },
          {
            status: 201,
            headers: { ...readNonce(), location: `${url.origin}/order/${String(orders.length)}` },
          },
        );
      }

      const authz = /^\/authz\/(?<order>\d+)\/(?<index>\d+)$/v.exec(path)?.groups;
      const identifier = orders[Number(authz?.['order']) - 1]?.[Number(authz?.['index'])];

      if (request.method === 'POST' && identifier !== undefined) {
        // RFC 8555 7.1.4: a wildcard's authorization names its base domain
        const isWildcard = identifier.value.startsWith('*.');

        return Response.json(
          {
            status: 'pending',
            identifier: { type: 'dns', value: identifier.value.replace(/^\*\./v, '') },
            ...(isWildcard && { wildcard: true }),
            challenges: options.challengeTypes.map((type, index) => ({
              type,
              status: 'pending',
              url: `${url.origin}/challenge${path.slice('/authz'.length)}/${String(index)}`,
              token: `token-${String(index)}`,
            })),
          },
          { headers: readNonce() },
        );
      }

      unexpected.push(call);

      return new Response(`the stub ACME server does not model ${call}`, { status: 500 });
    },
  });

  stack.defer(() => server.stop(true));

  const port = server.port ?? 0;

  return { directoryUrl: `http://127.0.0.1:${String(port)}/dir`, unexpected };
}
