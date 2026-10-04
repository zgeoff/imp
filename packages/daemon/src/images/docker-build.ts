import * as z from 'zod';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { readRefusalError } from './run-docker';

// the tail of a failed build's message the client gets
const FAILURE_MAX_CHARS = 4000;

export interface DockerBuildOptions {
  // DOCKER_HOST, a unix socket: imp-docker-proxy's on imp-host; null is
  // the engine's default socket
  readonly dockerHost: string | null;

  // the build context, a tar file
  readonly tarPath: string;
  readonly tag: string;

  // the Dockerfile's path inside the context; Dockerfile when undefined
  readonly dockerfile: string | undefined;

  // aborts the request, which ends the build on the engine
  readonly signal: AbortSignal;
}

// The build itself failed: the Dockerfile, its context or its size. The
// message is the client's to read.
export class DockerBuildError extends Error {
  override readonly name = 'DockerBuildError';
}

// the messages of POST /build's JSON stream that impd reads; the rest
// (BuildKit's trace, as protobuf in base64) passes by
const BuildMessageSchema = z.object({
  id: z.string().optional(),
  aux: z.unknown().optional(),
  error: z.string().optional(),
  errorDetail: z.object({ message: z.string().optional() }).optional(),
});

const ImageIdSchema = z.object({ ID: z.string().regex(/^sha256:[a-f0-9]{64}$/v) });
const RefusalSchema = z.object({ message: z.string() });

// one message of the stream at most; BuildKit's trace messages carry step
// output, which comes in chunks far below this
const LINE_MAX_CHARS = 8 * 1024 ** 2;

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`docker build: the engine sent a line that is not JSON: ${line.slice(0, 200)}`);
  }
}

// each JSON line of the body, as it comes
async function* readJsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator {
  const decoder = new TextDecoder();

  let pending = '';

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });

    const lines = pending.split('\n');

    pending = lines.pop() ?? '';

    if (pending.length > LINE_MAX_CHARS) {
      throw new Error(
        `docker build: the engine sent a line longer than ${String(LINE_MAX_CHARS)} characters`,
      );
    }

    for (const line of lines) {
      if (line.trim() !== '') {
        yield parseLine(line);
      }
    }
  }

  pending += decoder.decode();

  if (pending.trim() !== '') {
    yield parseLine(pending);
  }
}

// The image ID from a build's message stream. An error message fails the
// build: the engine answers 200 and reports a failed build in the stream.
export async function readBuiltImageId(
  messages: Readonly<AsyncIterable<unknown> | Iterable<unknown>>,
): Promise<string> {
  let imageId: string | null = null;

  for await (const raw of messages) {
    const message = BuildMessageSchema.parse(raw);
    const failure = message.errorDetail?.message ?? message.error;

    if (failure !== undefined) {
      throw new DockerBuildError(`docker build failed: ${failure.slice(-FAILURE_MAX_CHARS)}`);
    }

    if (message.id === 'moby.image.id') {
      imageId = ImageIdSchema.parse(message.aux).ID;
    }
  }

  if (imageId === null) {
    throw new Error('docker build: the engine sent no image ID');
  }

  return imageId;
}

// The engine's answer before any build ran: a refusal by imp-docker-proxy
// (403), a context over its limit (413), or the engine's own error.
async function readRefusal(response: Response): Promise<Error> {
  const text = await response.text();

  const refused = response.status === 403 ? readRefusalError('docker build', text) : null;

  if (refused !== null) {
    return refused;
  }

  let message = text.trim();

  try {
    const parsed = RefusalSchema.safeParse(JSON.parse(text));

    message = parsed.success ? parsed.data.message : message;
  } catch {
    // not JSON: the text as it is
  }

  const status = String(response.status);

  if (response.status === 413) {
    return new DockerBuildError(message);
  }

  return new Error(`docker build: the engine answered ${status}: ${message}`);
}

// impd sends builds itself, and fetch reaches only a unix socket or a URL
// it would have to trust: DOCKER_HOST must be unix:///<path>
export function readDockerSocket(dockerHost: string | null): string {
  if (dockerHost === null) {
    return '/var/run/docker.sock';
  }

  if (!dockerHost.startsWith('unix:///')) {
    throw new Error(
      `DOCKER_HOST is ${dockerHost}; impd builds images only through a unix socket, unix:///<path>`,
    );
  }

  return dockerHost.slice('unix://'.length);
}

// One BuildKit build with no session, the context as the body, so the proxy
// can refuse /session and /grpc. Returns the image ID; the image is tagged
// `tag`.
export async function runDockerBuild(options: Readonly<DockerBuildOptions>): Promise<string> {
  const query = new URLSearchParams({
    t: options.tag,
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  if (options.dockerfile !== undefined) {
    query.set('dockerfile', options.dockerfile);
  }

  // the host part is ignored: the request goes to the unix socket.
  // timeout: false lifts Bun's 360 s limit on a silent response, which a
  // RUN step with no output outlasts; `signal` still ends the build
  const response = await fetch(`http://docker/build?${query.toString()}`, {
    method: 'POST',
    timeout: false,
    headers: { 'content-type': 'application/x-tar' },
    body: Bun.file(options.tarPath),
    unix: readDockerSocket(options.dockerHost),
    signal: options.signal,
  });

  if (!response.ok || response.body === null) {
    throw await readRefusal(response);
  }

  return readBuiltImageId(readJsonLines(response.body));
}
