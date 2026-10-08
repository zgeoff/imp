import * as z from 'zod';

// oRPC's answer as the RPC protocol encodes it: the output under `json`
const RpcBodySchema = z.looseObject({ json: z.unknown() });
const RecordSchema = z.record(z.string(), z.unknown());

export interface StubNewerImpdOptions {
  // fields a newer release adds to a procedure's output, by procedure such
  // as `imps/list`; each item gets them when the output is a list
  readonly withFields: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

// impd's fetch as a newer release answers it: the real app's answers with
// only the named fields added, which this CLI's schema does not know
export function buildStubNewerImpdFetch(
  fetch: (request: Request) => Promise<Response>,
  options: Readonly<StubNewerImpdOptions>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await fetch(request);

    const pathname = new URL(request.url).pathname;

    const marker = pathname.indexOf('/rpc/');

    const fields =
      marker === -1 ? undefined : options.withFields[pathname.slice(marker + '/rpc/'.length)];

    if (fields === undefined || !response.ok) {
      return response;
    }

    const answer: unknown = await response.json();

    const body = RpcBodySchema.parse(answer);

    const json = Array.isArray(body.json)
      ? body.json.map((item) => ({ ...RecordSchema.parse(item), ...fields }))
      : { ...RecordSchema.parse(body.json), ...fields };

    return Response.json({ ...body, json }, { status: response.status });
  };
}
