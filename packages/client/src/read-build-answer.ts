import {
  IMAGE_BUILD_STREAM_TYPE,
  ImageBuildErrorSchema,
  ImageBuildEventSchema,
  ImageBuildResultSchema,
} from '@imp/api';
import type { Image, ImageBuildProgress } from '@imp/api';
import { splitLines } from '@imp/shared';
import { ORPCError } from '@orpc/client';

// The image of impd's answer to `POST /images/build`: a stream of events, or
// the JSON of an impd from before the stream. A failure throws an ORPCError,
// as a contract call would.
export async function readBuildAnswer(
  response: Response,
  onProgress: ((progress: ImageBuildProgress) => void) | undefined,
  onLog?: (line: string) => void,
): Promise<Image> {
  if (response.ok && isStream(response)) {
    return readBuildEvents(response, onProgress, onLog);
  }

  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    return ImageBuildResultSchema.parse(body);
  }

  const failure = ImageBuildErrorSchema.safeParse(body);

  if (failure.success) {
    throw new ORPCError(failure.data.code, {
      status: response.status,
      message: failure.data.message,
    });
  }

  // a 401 comes before the route, from impd's auth, without a code
  const code = response.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_SERVER_ERROR';

  throw new ORPCError(code, {
    status: response.status,
    message: `impd answered ${String(response.status)} to the image build`,
  });
}

function isStream(response: Response): boolean {
  return response.headers.get('content-type')?.startsWith(IMAGE_BUILD_STREAM_TYPE) === true;
}

// The image or the error that ends the stream. A line that is not an event
// this client knows is skipped; a stream that ends without its last event
// lost impd, or the connection, mid-build.
async function readBuildEvents(
  response: Response,
  onProgress: ((progress: ImageBuildProgress) => void) | undefined,
  onLog: ((line: string) => void) | undefined,
): Promise<Image> {
  for await (const line of readLines(response)) {
    const parsed = ImageBuildEventSchema.safeParse(parseJson(line));

    if (!parsed.success) {
      continue;
    }

    const event = parsed.data;

    if (event.type === 'image') {
      return event.image;
    }

    if (event.type === 'error') {
      throw new ORPCError(event.code, { message: event.message });
    }

    if (event.type === 'log') {
      onLog?.(event.text);
    } else {
      onProgress?.(event);
    }
  }

  throw new ORPCError('INTERNAL_SERVER_ERROR', {
    message: 'the image build stream ended before impd answered the image',
  });
}

// each line of the body, as it completes
async function* readLines(response: Response): AsyncGenerator<string> {
  if (response.body === null) {
    return;
  }

  yield* response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(splitLines()) as AsyncIterable<string>;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
