import * as z from 'zod';

// what this stand-in reads of a system.info answer, as `/rpc` sends it
const InfoAnswerSchema = z.object({
  json: z.looseObject({ features: z.looseObject({}).optional() }),
});

// impd from before 0.30.0 in front of a real impd's `handle`: its
// system.info answers without the execRequire feature, which those releases
// lacked; every other call passes through unchanged
export function buildStubImpdBeforeExecRequire(
  handle: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await handle(request);

    if (new URL(request.url).pathname !== '/rpc/system/info' || !response.ok) {
      return response;
    }

    const body: unknown = await response.json();

    const answer = InfoAnswerSchema.parse(body);
    const { execRequire: _dropped, ...features } = answer.json.features ?? {};

    return Response.json({ ...answer, json: { ...answer.json, features } });
  };
}
