import * as z from 'zod';

// oRPC's answer as the RPC protocol encodes it: the output under `json`
const RpcBodySchema = z.looseObject({ json: z.unknown() });
const InfoJsonSchema = z.looseObject({ features: z.record(z.string(), z.unknown()).optional() });

// one SSE event of an event-iterator procedure, its data as oRPC encodes it
const EventDataSchema = z.looseObject({ json: z.looseObject({ type: z.string() }) });

export interface StubOlderImpdOptions {
  // the feature flags a release before them did not report in system.info
  readonly withoutFeatures?: readonly string[];

  // a release from before SystemInfo.features reported no features object
  readonly isWithoutFeatureList?: boolean;

  // procedures a release before them did not have, such as `moves/facts`;
  // impd's own answer for a procedure it does not know comes back
  readonly withoutProcedures?: readonly string[];

  // a fault: an event-iterator procedure's events of these types never
  // arrive, such as `{ 'images/addStream': ['image'] }`; the rest, and the
  // stream's end, do
  readonly withoutEvents?: Readonly<Record<string, readonly string[]>>;
}

// the path a procedure takes when no impd has it
const ABSENT_PROCEDURE = 'older-impd/absent';

// impd's fetch as an older release answers it: the real app's answers with
// only what that release lacked taken out. It records the procedure of each
// call it forwards, such as `system/info`, in `calls`.
export function buildStubOlderImpdFetch(
  fetch: (request: Request) => Promise<Response>,
  options: Readonly<StubOlderImpdOptions> = {},
) {
  const calls: string[] = [];

  const removeFeatures = async (response: Response): Promise<Response> => {
    const answer: unknown = await response.json();

    const body = RpcBodySchema.parse(answer);
    const json = InfoJsonSchema.parse(body.json);
    const { features, ...rest } = json;

    // a reply without features stays without them: the stand-in only removes
    const info =
      options.isWithoutFeatureList === true || features === undefined
        ? rest
        : {
            ...rest,
            features: Object.fromEntries(
              Object.entries(features).filter(
                ([key]) => options.withoutFeatures?.includes(key) !== true,
              ),
            ),
          };

    return Response.json({ ...body, json: info }, { status: response.status });
  };

  const removeEvents = async (response: Response, types: readonly string[]): Promise<Response> => {
    const text = await response.text();

    const events = text.split('\n\n').filter((event) => {
      const data = event.split('\n').find((line) => line.startsWith('data: '));

      if (data === undefined) {
        return true;
      }

      const parsed = EventDataSchema.safeParse(JSON.parse(data.slice('data: '.length)));

      // an event without a type, such as the stream's end, always passes
      return !parsed.success || !types.includes(parsed.data.json.type);
    });

    return new Response(events.join('\n\n'), {
      status: response.status,
      headers: response.headers,
    });
  };

  const send = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    const marker = url.pathname.indexOf('/rpc/');

    if (marker === -1) {
      return fetch(request);
    }

    const prefix = url.pathname.slice(0, marker);
    const procedure = url.pathname.slice(marker + '/rpc/'.length);

    calls.push(procedure);

    if (options.withoutProcedures?.includes(procedure) === true) {
      url.pathname = `${prefix}/rpc/${ABSENT_PROCEDURE}`;

      return fetch(new Request(url.href, request));
    }

    const response = await fetch(request);

    const types = options.withoutEvents?.[procedure];

    if (procedure === 'system/info' && response.ok) {
      return removeFeatures(response);
    }

    if (types !== undefined && response.ok) {
      return removeEvents(response, types);
    }

    return response;
  };

  return { fetch: send, calls };
}
