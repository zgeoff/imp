import * as z from 'zod';

// what this stand-in reads of a system.info answer, as `/rpc` sends it
const InfoAnswerSchema = z.object({
  json: z.looseObject({ features: z.looseObject({}).optional() }),
});

// an impd without execDropSysAdmin in front of a real impd's `handle`: it
// drops the feature from system.info and passes every other call through
export function buildStubImpdBeforeExecDropSysAdmin(
  handle: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await handle(request);

    if (new URL(request.url).pathname !== '/rpc/system/info' || !response.ok) {
      return response;
    }

    const body: unknown = await response.json();

    const answer = InfoAnswerSchema.parse(body);
    const { execDropSysAdmin: _dropped, ...features } = answer.json.features ?? {};

    return Response.json({ ...answer, json: { ...answer.json, features } });
  };
}
