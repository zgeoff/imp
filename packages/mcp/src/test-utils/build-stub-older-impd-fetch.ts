import * as z from 'zod';

// oRPC's answer as the RPC protocol encodes it: the output under `json`
const RpcBodySchema = z.looseObject({ json: z.record(z.string(), z.unknown()) });

// impd's fetch as a release from before the fork's grant report: imps.fork's
// real answer without `grantsNotCopied` and `grantsError`; every other
// answer, a failed fork's included, passes as it came
export function buildStubOlderImpdFetch(
  fetch: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await fetch(request);

    if (new URL(request.url).pathname !== '/rpc/imps/fork' || !response.ok) {
      return response;
    }

    const answer: unknown = await response.json();

    const body = RpcBodySchema.parse(answer);
    const { grantsNotCopied: _notCopied, grantsError: _error, ...json } = body.json;

    return Response.json({ ...body, json }, { status: response.status });
  };
}
