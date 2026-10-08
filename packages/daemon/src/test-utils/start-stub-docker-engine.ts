import { onTestFinished } from 'bun:test';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { Collection } from '@msw/data';
import { z } from 'zod';
import type { ContainerSchema as ProxyContainerSchema } from '../docker-proxy/proxy';
import type { PinInspectSchema } from '../images/image-pin';

// a container a test adds: its full ID and its labels
interface StubEngineContainer {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
}

// one request as the engine got it
interface StubEngineRequest {
  readonly method: string;

  // the path and query, as sent
  readonly target: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;

  // the client cut the body off before its end
  readonly isBodyCut: boolean;
}

// A test's own answer for one request, ahead of the engine's defaults;
// null leaves the request to them. The request's body is read already.
export type StubEngineAnswer = (
  request: Request,
  seen: StubEngineRequest,
) => Response | null | Promise<Response | null>;

export interface StubDockerEngineOptions {
  // a directory of the test's own, where the socket goes
  readonly dir: string;

  // what GET /containers/<id>/export streams
  readonly exportBytes?: Uint8Array;

  // the ID a build answers with
  readonly builtImageId?: string;
}

// the API version a Docker 29 engine answers with
const API_VERSION = '1.55';
const CONTAINER_PATH = /^\/containers\/(?<id>[^\/]+)(?<rest>\/json|\/export)?$/v;
const IMAGE_PATH = /^\/images\/(?<name>.+)\/json$/v;

// the part of POST /containers/create the engine keeps
const CreateBodySchema = z.object({ Labels: z.record(z.string(), z.string()).nullish() });

function buildEngineId(): string {
  return faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' });
}

// a container the engine holds: its full ID and the labels of its create
const ContainerSchema = z.object({
  id: z.string().default(buildEngineId),
  labels: z.record(z.string(), z.string()).default({}),
});

// an image the engine holds, by one reference in its normalised form,
// `docker.io/library/name:tag` or `<repository>@<digest>`
const ImageSchema = z.object({
  ref: z
    .string()
    .default(
      () => `docker.io/library/${faker.string.alpha({ length: 8, casing: 'lower' })}:latest`,
    ),
  id: z.string().default(() => `sha256:${buildEngineId()}`),
});

// What a reference names, as the engine's reference parser reads it: a
// name with no registry is on docker.io, a one-part docker.io name is in
// library/, and a name with neither tag nor digest takes `latest`.
function normalizeImageRef(ref: string): string {
  const [named = '', digest] = ref.split('@');
  const slash = named.lastIndexOf('/');
  const colon = named.lastIndexOf(':');
  const repository = colon > slash ? named.slice(0, colon) : named;
  const tag = colon > slash ? named.slice(colon + 1) : 'latest';
  const [first = '', ...rest] = repository.split('/');

  const hasRegistry =
    rest.length > 0 && (first.includes('.') || first.includes(':') || first === 'localhost');

  const path = hasRegistry ? rest.join('/') : repository;
  const registry = hasRegistry && first !== 'index.docker.io' ? first : 'docker.io';
  const libraryPath = registry === 'docker.io' && !path.includes('/') ? `library/${path}` : path;
  const full = `${registry}/${libraryPath}`;

  return digest === undefined ? `${full}:${tag}` : `${full}@${digest}`;
}

// a normalised reference as the engine shows it in RepoTags and
// RepoDigests: docker.io/library/ and docker.io/ left off
function toFamiliarRef(ref: string): string {
  return ref.replace(/^docker\.io\/(?:library\/)?/v, '');
}

function readApiPath(path: string): string {
  return path.replace(/^\/v1\.\d+(?=\/)/v, '');
}

async function readBody(request: Request): Promise<{ body: Uint8Array; isBodyCut: boolean }> {
  const chunks: Uint8Array[] = [];

  if (request.body === null) {
    return { body: new Uint8Array(), isBodyCut: false };
  }

  try {
    for await (const chunk of request.body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
  } catch {
    return { body: Bun.concatArrayBuffers(chunks, Infinity, true), isBodyCut: true };
  }

  return { body: Bun.concatArrayBuffers(chunks, Infinity, true), isBodyCut: false };
}

// the engine's error body, as every refused or missing call carries it
function buildError(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

// The Docker engine API on a unix socket in `dir`, as impd and
// imp-docker-proxy call it, over schema-backed collections; a call it does
// not model gets a 500 that names it. It stops when the test ends.
export function startStubDockerEngine(options: Readonly<StubDockerEngineOptions>) {
  const socket = join(options.dir, 'engine.sock');
  const seen: StubEngineRequest[] = [];
  const unexpected: string[] = [];

  const containers = new Collection({ schema: ContainerSchema });
  const images = new Collection({ schema: ImageSchema });

  const state: { answer: StubEngineAnswer | null } = { answer: null };

  // the engine finds a container by its full ID or a unique prefix of it
  const findContainer = (id: string) =>
    containers.findFirst((query) => query.where({ id: (full: string) => full.startsWith(id) }));

  const buildUnmodelledAnswer = (method: string, path: string): Response => {
    unexpected.push(`${method} ${path}`);

    return buildError(500, `stub docker engine: ${method} ${path} is not modelled`);
  };

  const buildImageAnswer = async (method: string, path: string, query: string) => {
    if (path === '/images/create' && method === 'POST') {
      const params = new URLSearchParams(query);

      const fromImage = params.get('fromImage') ?? '';
      const tag = params.get('tag') ?? 'latest';
      const ref = tag.startsWith('sha256:') ? `${fromImage}@${tag}` : `${fromImage}:${tag}`;

      await images.create({ ref: normalizeImageRef(ref) });

      return new Response(`${JSON.stringify({ status: `Pulling from ${fromImage}` })}\n`);
    }

    const name = IMAGE_PATH.exec(path)?.groups?.['name'];

    if (name === undefined || method !== 'GET') {
      return null;
    }

    const image = images.findFirst((where) => where.where({ ref: normalizeImageRef(name) }));

    if (image === undefined) {
      return buildError(404, `No such image: ${name}`);
    }

    const familiar = toFamiliarRef(image.ref);
    const isDigest = familiar.includes('@');

    // the fields impd and the proxy read, as the engine sends them
    const inspect = {
      Id: image.id,
      RepoTags: isDigest ? [] : [familiar],
      RepoDigests: isDigest ? [familiar] : [],
      Os: 'linux',
      Architecture: 'amd64',
      Config: {},
      Size: 0,
    } satisfies z.input<typeof PinInspectSchema> & { RepoTags: string[]; Size: number };

    return Response.json(inspect);
  };

  const buildContainerAnswer = async (
    method: string,
    path: string,
    body: Uint8Array,
  ): Promise<Response | null> => {
    if (path === '/containers/create' && method === 'POST') {
      const parsed = CreateBodySchema.parse(JSON.parse(new TextDecoder().decode(body)));

      const container = await containers.create({ labels: parsed.Labels ?? {} });

      return Response.json({ Id: container.id, Warnings: [] }, { status: 201 });
    }

    const match = CONTAINER_PATH.exec(path)?.groups;
    const id = match?.['id'];
    const rest = match?.['rest'];

    const isModelled =
      (rest === '/json' && method === 'GET') ||
      (rest === '/export' && method === 'GET') ||
      (rest === undefined && method === 'DELETE');

    if (id === undefined || !isModelled) {
      return null;
    }

    const container = findContainer(id);

    if (container === undefined) {
      return buildError(404, `No such container: ${id}`);
    }

    if (rest === '/json') {
      const inspect = {
        Id: container.id,
        Config: { Labels: container.labels },
      } satisfies z.input<typeof ProxyContainerSchema>;

      return Response.json(inspect);
    }

    if (rest === '/export') {
      return new Response(options.exportBytes ?? new Uint8Array());
    }

    containers.delete((where) => where.where({ id: container.id }));

    return new Response(null, { status: 204 });
  };

  const buildDefaultAnswer = async (
    method: string,
    path: string,
    query: string,
    body: Uint8Array,
  ): Promise<Response> => {
    if (path === '/_ping' && (method === 'GET' || method === 'HEAD')) {
      const pong = method === 'HEAD' ? null : 'OK';

      return new Response(pong, { headers: { 'api-version': API_VERSION } });
    }

    if (path === '/version' && method === 'GET') {
      return Response.json({ ApiVersion: API_VERSION, Os: 'linux', Arch: 'amd64' });
    }

    if (path === '/build' && method === 'POST') {
      const id = options.builtImageId ?? `sha256:${'e'.repeat(64)}`;

      return new Response(`${JSON.stringify({ id: 'moby.image.id', aux: { ID: id } })}\n`);
    }

    const image = await buildImageAnswer(method, path, query);
    const container = await buildContainerAnswer(method, path, body);

    return image ?? container ?? buildUnmodelledAnswer(method, path);
  };

  const server = Bun.serve({
    unix: socket,
    fetch: async (request) => {
      const url = new URL(request.url);

      const read = await readBody(request);

      const received: StubEngineRequest = {
        method: request.method,
        target: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers),
        ...read,
      };

      seen.push(received);

      const answered = state.answer === null ? null : await state.answer(request, received);

      return (
        answered ??
        buildDefaultAnswer(request.method, readApiPath(url.pathname), url.search, read.body)
      );
    },
  });

  // the first stop closes the engine; a later one waits on the same close
  const stopping: { done: Promise<void> | null } = { done: null };

  const stop = (): Promise<void> => {
    stopping.done ??= server.stop(true);

    return stopping.done;
  };

  onTestFinished(stop);

  return {
    // DOCKER_HOST for this engine
    dockerHost: `unix://${socket}`,
    socket,
    seen,

    // each call the engine does not model, as `<method> <path>`
    unexpected,

    // a container as if created earlier, with these labels
    addContainer: (container: Readonly<StubEngineContainer>) =>
      containers.create({ id: container.id, labels: { ...container.labels } }),

    // an image the engine has, as `name:tag` or `name@digest`
    addImage: (ref?: string) => {
      const record = ref === undefined ? {} : { ref: normalizeImageRef(ref) };

      return images.create(record);
    },
    hasContainer: (id: string) =>
      containers.findFirst((query) => query.where({ id })) !== undefined,
    hasImage: (ref: string) =>
      images.findFirst((query) => query.where({ ref: normalizeImageRef(ref) })) !== undefined,

    // the test's own answers, ahead of the defaults
    setAnswer: (answer: StubEngineAnswer | null) => {
      state.answer = answer;
    },
    stop,
  };
}
