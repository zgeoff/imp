import * as z from 'zod';

// what this stand-in reads of an events.stream data line, as `/rpc` sends it
// (records, so each key keeps its place)
const FieldsSchema = z.record(z.string(), z.unknown());
const EventLineSchema = FieldsSchema.pipe(z.looseObject({ json: FieldsSchema }));

// A newer impd in front of a real impd's `handle`: each ImpChanged event of
// events.stream carries `reason`, a reason this client's schema does not
// list; every other call and line passes through unchanged.
export function buildStubImpdWithNewReason(
  handle: (request: Request) => Promise<Response>,
  reason: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await handle(request);

    if (new URL(request.url).pathname !== '/rpc/events/stream' || response.body === null) {
      return response;
    }

    const body = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(splitLines())
      .pipeThrough(
        new TransformStream<string, string>({
          transform: (line, controller) => {
            controller.enqueue(`${buildRenamedLine(line, reason)}\n`);
          },
        }),
      )
      .pipeThrough(new TextEncoderStream());

    return new Response(body, { status: response.status, headers: response.headers });
  };
}

// each line of the text, without its newline, as it completes
function splitLines(): TransformStream<string, string> {
  const state = { pending: '' };

  return new TransformStream<string, string>({
    transform: (chunk, controller) => {
      const lines = `${state.pending}${chunk}`.split('\n');

      state.pending = lines.pop() ?? '';

      for (const line of lines) {
        controller.enqueue(line);
      }
    },
    flush: (controller) => {
      if (state.pending !== '') {
        controller.enqueue(state.pending);
      }
    },
  });
}

// an SSE data line of an ImpChanged event, with `reason` in place of its own
function buildRenamedLine(line: string, reason: string): string {
  if (!line.startsWith('data: ')) {
    return line;
  }

  const data: unknown = JSON.parse(line.slice('data: '.length));
  const parsed = EventLineSchema.safeParse(data);

  if (!parsed.success || parsed.data.json['ev'] !== 'ImpChanged') {
    return line;
  }

  return `data: ${JSON.stringify({ ...parsed.data, json: { ...parsed.data.json, reason } })}`;
}
