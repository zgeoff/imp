// imp-docker-proxy's handler: a call impd or its `docker` CLI makes, checked and
// rebuilt. It closes the Docker socket path only; SYS_ADMIN still lets root
// out of imp-host (docs/architecture/host-contract.md).

import { z } from 'zod';
import type { OwnedReferences } from './owned-references';
import { findRequestRoute, formatQuery } from './router';
import type { RoutedRequest } from './router';
import {
  BUILD_CONTENT_TYPE,
  checkBuildContentType,
  checkBuildQuery,
  checkCreateBody,
  checkImageRemoveQuery,
  checkNoQuery,
  checkPullQuery,
  checkRemovableImage,
  checkRemoveQuery,
  normalizeReference,
  readRepository,
} from './rules';
import type { Check } from './rules';

// the label on every container the proxy creates; export and rm need it
export const PROXY_LABEL = 'imp.docker-proxy';

// a create body from the CLI is about 2 KiB
const CREATE_BODY_MAX_BYTES = 1024 ** 2;

// response headers the proxy sets itself, or that belong to one connection
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'transfer-encoding',
]);

const LabelsSchema = z.record(z.string(), z.string()).nullish();

const ContainerSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/v),
  Config: z.object({ Labels: LabelsSchema }),
});

const ImageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/v);

const ImageSchema = z
  .object({
    Id: ImageIdSchema,
    RepoTags: z.array(z.string()).readonly().nullish(),
    RepoDigests: z.array(z.string()).readonly().nullish(),

    // the last time the engine set any name on the image
    Metadata: z.object({ LastTagTime: z.string().nullish() }).readonly().nullish(),
  })
  .readonly();

type EngineImage = z.infer<typeof ImageSchema>;

const ListedImageSchema = z.object({ RepoDigests: z.array(z.string()).nullish() });
const ImageListSchema = z.array(ListedImageSchema);

// a BuildKit build's last line: the image it made, or the error it ended on
const BuildEndSchema = z.union([
  z.object({ id: z.literal('moby.image.id'), aux: z.object({ ID: ImageIdSchema }) }),
  z.object({ error: z.string() }),
]);

// what the engine said of an image: it has it, it has none (404), or it
// gave no clear answer, which never counts as absent
type ImageLookup =
  | { readonly kind: 'found'; readonly image: EngineImage }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' };

export interface DockerProxyOptions {
  // the engine's socket
  readonly upstreamSocket: string;

  // the value of PROXY_LABEL on the containers this proxy creates
  readonly token: string;

  // the image imp-host runs from, whose repository a pull may not move
  readonly hostImage: string;
  readonly buildContextMaxBytes: number;

  // the references this proxy pulled or built, the only ones impd may remove
  readonly ownedReferences: OwnedReferences;
  readonly log: (message: string) => void;
}

class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError';
}

function buildJsonResponse(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

// the body as bytes, or null past maxBytes; a chunked body is counted too
async function readBodyWithin(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  if (request.body === null) {
    return new Uint8Array();
  }

  for await (const chunk of request.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;

    if (total > maxBytes) {
      return null;
    }

    chunks.push(chunk);
  }

  return Bun.concatArrayBuffers(chunks, Infinity, true);
}

// passes a stream through and errors it past maxBytes
function createByteLimit(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;

  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;

      if (total > maxBytes) {
        controller.error(
          new BodyTooLargeError(`the build context is larger than ${String(maxBytes)} bytes`),
        );

        return;
      }

      controller.enqueue(chunk);
    },
  });
}

function readTaggedAt(image: Readonly<EngineImage>): string {
  return image.Metadata?.LastTagTime ?? '';
}

// the same image under the same tag, set at the same time
function isSameTag(before: Readonly<EngineImage>, after: Readonly<EngineImage>): boolean {
  return before.Id === after.Id && readTaggedAt(before) === readTaggedAt(after);
}

// `name` is the image's ID, whole or a prefix of its hex, rather than a name
function isImageIdName(name: string, id: string): boolean {
  const hex = name.replace(/^sha256:/v, '');

  return /^[a-f0-9]+$/v.test(hex) && id.slice('sha256:'.length).startsWith(hex);
}

// the digest references a removal of `references` can take with it: those
// of the same repositories, or every one when the image goes by its ID
function findRemovedDigests(
  image: Readonly<EngineImage>,
  references: readonly string[],
  isId: boolean,
): string[] {
  const repositories = new Set(references.map((reference) => readRepository(reference)));
  const removed = new Set(references.map((reference) => normalizeReference(reference)));

  return (image.RepoDigests ?? []).filter(
    (digest) =>
      (isId || repositories.has(readRepository(digest))) &&
      !removed.has(normalizeReference(digest)),
  );
}

function readMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// the reference a pull of fromImage and tag fetches; a tag can be a digest
function formatPulledReference(fromImage: string, tag: string): string {
  return tag.startsWith('sha256:') ? `${fromImage}@${tag}` : `${fromImage}:${tag}`;
}

function pickHeaders(request: Request, names: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const name of names) {
    const value = request.headers.get(name);

    if (value !== null) {
      headers[name] = value;
    }
  }

  return headers;
}

// What the engine showed before a pull or a build: the reference itself,
// and the tag time of each image the record names
interface RegisterStart {
  readonly before: ImageLookup;
  readonly imageTimes: ReadonlyMap<string, string>;

  // a pull's: every digest reference the engine had, when it listed them
  readonly digestsBefore?: ReadonlySet<string> | undefined;
}

// What a relay does with the engine's answer: `onChunk` sees each chunk,
// and `onEnd` runs once the body has ended, as a pull or a build streams
// its progress and ends with it; a client that goes first never runs it.
interface RelayWatch {
  readonly onChunk?: (chunk: Uint8Array) => void;
  readonly onEnd: () => Promise<void>;
}

// Reads a build's progress for the image it made: the ID on its
// `moby.image.id` line, unless an error line came. Only those two lines
// are parsed; the trace lines between them are not.
function createBuildEndReader(): {
  readonly read: (chunk: Uint8Array) => void;
  readonly find: () => string | undefined;
} {
  const decoder = new TextDecoder();

  let partial = '';
  let imageId: string | undefined;
  let failed = false;

  const readLine = (line: string): void => {
    if (!line.includes('"moby.image.id"') && !line.includes('"error"')) {
      return;
    }

    const parsed = BuildEndSchema.safeParse(parseJson(line));

    if (!parsed.success) {
      return;
    }

    if ('error' in parsed.data) {
      failed = true;
    } else {
      imageId = parsed.data.aux.ID;
    }
  };

  return {
    read: (chunk) => {
      const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n');

      partial = lines.pop() ?? '';

      for (const line of lines) {
        readLine(line);
      }
    },
    find: () => {
      readLine(partial + decoder.decode());

      partial = '';

      return failed ? undefined : imageId;
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The engine's answer for the client, with `watch` on its body
function toClientResponse(upstream: Response, watch?: Readonly<RelayWatch>): Response {
  const headers = new Headers();

  for (const [name, value] of upstream.headers) {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) {
      headers.append(name, value);
    }
  }

  const body =
    watch === undefined || upstream.body === null
      ? upstream.body
      : upstream.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform: (chunk, controller) => {
              watch.onChunk?.(chunk);
              controller.enqueue(chunk);
            },
            flush: watch.onEnd,
          }),
        );

  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

interface UpstreamCall {
  readonly method: string;

  // the path after the version prefix, as the proxy built it
  readonly path: string;
  readonly query?: ReadonlyMap<string, readonly string[]>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | ReadableStream<Uint8Array> | null;

  // the client's: a client that goes ends a build, a pull or an export on
  // the engine too
  readonly signal?: AbortSignal;
}

export function createDockerProxy(
  options: DockerProxyOptions,
): (request: Request) => Promise<Response> {
  const sendUpstream = (versionPrefix: string, call: UpstreamCall): Promise<Response> => {
    const search = call.query === undefined ? '' : formatQuery(call.query);

    // the host part is ignored: the request goes to the unix socket
    return fetch(`http://docker${versionPrefix}${call.path}${search}`, {
      method: call.method,
      headers: call.headers ?? {},
      body: call.body ?? null,
      unix: options.upstreamSocket,
      duplex: 'half',
      redirect: 'manual',
      decompress: false,
      ...(call.signal !== undefined && { signal: call.signal }),
    });
  };

  const sendAndRelay = async (
    versionPrefix: string,
    call: UpstreamCall,
    watch?: Readonly<RelayWatch>,
  ): Promise<Response> => {
    const upstream = await sendUpstream(versionPrefix, call);

    // a pull or a build the engine refused made nothing
    const watched = upstream.ok ? watch : undefined;

    return toClientResponse(upstream, watched);
  };

  const findImage = async (versionPrefix: string, name: string): Promise<ImageLookup> => {
    const inspected = await sendUpstream(versionPrefix, {
      method: 'GET',
      path: `/images/${name}/json`,
    });

    if (!inspected.ok) {
      await inspected.body?.cancel();

      return inspected.status === 404 ? { kind: 'absent' } : { kind: 'unknown' };
    }

    const body: unknown = await inspected.json();

    const image = ImageSchema.safeParse(body);

    return image.success ? { kind: 'found', image: image.data } : { kind: 'unknown' };
  };

  // the tag time of each image the record names, read before a pull or a
  // build; an image the engine gives no clear answer for is left out
  const readOwnedImageTimes = async (versionPrefix: string): Promise<Map<string, string>> => {
    const times = new Map<string, string>();

    for (const id of options.ownedReferences.listImageIds()) {
      const found = await findImage(versionPrefix, id);

      if (found.kind === 'found') {
        times.set(id, readTaggedAt(found.image));
      }
    }

    return times;
  };

  // every digest reference on the engine, before a pull: one the pull adds
  // is the proxy's, and one it had is not
  const readEngineDigests = async (
    versionPrefix: string,
  ): Promise<ReadonlySet<string> | undefined> => {
    try {
      const listed = await sendUpstream(versionPrefix, { method: 'GET', path: '/images/json' });

      if (!listed.ok) {
        await listed.body?.cancel();

        return undefined;
      }

      const body: unknown = await listed.json();

      const images = ImageListSchema.safeParse(body);

      if (!images.success) {
        return undefined;
      }

      return new Set(
        images.data.flatMap((image) =>
          (image.RepoDigests ?? []).map((digest) => normalizeReference(digest)),
        ),
      );
    } catch {
      return undefined;
    }
  };

  // Records `reference` as the proxy's when the engine shows it other than
  // `start.before`, and on `madeId`, the image a build said it made. A
  // failure is logged, and the image then stays on the engine, the safe side.
  const registerReference = async (
    versionPrefix: string,
    reference: string,
    start: Readonly<RegisterStart>,
    madeId?: string,
  ): Promise<void> => {
    const before = start.before;

    try {
      const after = await findImage(versionPrefix, reference);

      if (after.kind !== 'found' || before.kind === 'unknown') {
        return;
      }

      // with no tag time, a tag the owner set later would not show
      if (readTaggedAt(after.image) === '') {
        options.log(`could not record ${reference} as the proxy's: the engine gave no tag time`);

        return;
      }

      if (madeId !== undefined && after.image.Id !== madeId) {
        return;
      }

      if (before.kind === 'found' && isSameTag(before.image, after.image)) {
        return;
      }

      const owned = { id: after.image.Id, taggedAt: readTaggedAt(after.image) };
      const imageTimeBefore = start.imageTimes.get(after.image.Id);

      options.ownedReferences.write(normalizeReference(reference), owned, imageTimeBefore);

      // the digest references the pull added; the engine removes them with
      // the repository's last tag
      const digestsBefore = start.digestsBefore ?? new Set<string>();
      const digests = start.digestsBefore === undefined ? [] : (after.image.RepoDigests ?? []);

      for (const digest of digests.map((one) => normalizeReference(one))) {
        if (!digestsBefore.has(digest)) {
          options.ownedReferences.write(digest, owned, imageTimeBefore);
        }
      }
    } catch (error) {
      options.log(`could not record ${reference} as the proxy's: ${readMessage(error)}`);
    }
  };

  // Whether the engine still shows `reference` as this proxy made it. A
  // record the engine no longer matches is dropped: the name is gone, or a
  // name set on the image since (the owner's) moved its tag time.
  const findOwnership = async (
    versionPrefix: string,
    reference: string,
  ): Promise<'owned' | 'not-owned' | 'absent' | 'unknown'> => {
    const key = normalizeReference(reference);
    const owned = options.ownedReferences.read(key);

    const found = await findImage(versionPrefix, reference);

    if (found.kind === 'unknown') {
      return 'unknown';
    }

    if (found.kind === 'absent') {
      options.ownedReferences.remove(key);

      return 'absent';
    }

    if (owned === undefined) {
      return 'not-owned';
    }

    const taggedAt = readTaggedAt(found.image);

    if (owned.id !== found.image.Id || taggedAt === '' || owned.taggedAt !== taggedAt) {
      options.ownedReferences.remove(key);

      return 'not-owned';
    }

    return 'owned';
  };

  const buildRefusal = (request: Request, path: string, reason: string): Response => {
    options.log(`refused ${request.method} ${path}: ${reason}`);

    return buildJsonResponse(403, `imp-docker-proxy: ${reason}`);
  };

  // the container's full ID, when the proxy created it; null otherwise
  const findOwnContainer = async (versionPrefix: string, id: string): Promise<string | null> => {
    const inspected = await sendUpstream(versionPrefix, {
      method: 'GET',
      path: `/containers/${id}/json`,
    });

    if (!inspected.ok) {
      await inspected.body?.cancel();

      return null;
    }

    const body: unknown = await inspected.json();

    const container = ContainerSchema.safeParse(body);

    if (!container.success || container.data.Config.Labels?.[PROXY_LABEL] !== options.token) {
      return null;
    }

    return container.data.Id;
  };

  const handleCreate = async (
    request: Request,
    versionPrefix: string,
    path: string,
  ): Promise<Response> => {
    const raw = await readBodyWithin(request, CREATE_BODY_MAX_BYTES);

    if (raw === null) {
      return buildRefusal(
        request,
        path,
        `the create body is larger than ${String(CREATE_BODY_MAX_BYTES)} bytes`,
      );
    }

    let body: unknown = null;

    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return buildRefusal(request, path, 'the create body is not JSON');
    }

    const checked = checkCreateBody(body, options.hostImage);

    if (!checked.isOk || checked.image === undefined) {
      const reason = checked.isOk ? 'Image is missing' : checked.reason;

      return buildRefusal(request, path, reason);
    }

    // a body of the proxy's own: no field of the client's reaches the engine
    const created = JSON.stringify({
      Image: checked.image,
      Cmd: ['/bin/true'],
      Labels: { [PROXY_LABEL]: options.token },
      HostConfig: { NetworkMode: 'none', RestartPolicy: { Name: 'no' } },
    });

    return sendAndRelay(versionPrefix, {
      method: 'POST',
      path: '/containers/create',
      headers: { 'content-type': 'application/json' },
      body: created,
    });
  };

  const handleBuild = async (
    request: Request,
    routed: RoutedRequest,
    path: string,
  ): Promise<Response> => {
    const contentType = checkBuildContentType(request.headers.get('content-type'));

    if (!contentType.isOk) {
      return buildRefusal(request, path, contentType.reason);
    }

    const limit = createByteLimit(options.buildContextMaxBytes);
    const body = request.body === null ? null : request.body.pipeThrough(limit);

    // a tag is the build's own only when the build ended on the image it
    // made, and the tag moved to that image: a failed build makes nothing
    const tags = routed.query.get('t') ?? [];

    const before = await Promise.all(tags.map((tag) => findImage(routed.versionPrefix, tag)));
    const imageTimes = await readOwnedImageTimes(routed.versionPrefix);

    const buildEnd = createBuildEndReader();

    const registerBuiltTags = async (): Promise<void> => {
      const madeId = buildEnd.find();

      if (madeId === undefined) {
        return;
      }

      for (const [index, tag] of tags.entries()) {
        const tagBefore = before[index] ?? { kind: 'unknown' };

        await registerReference(
          routed.versionPrefix,
          tag,
          { before: tagBefore, imageTimes },
          madeId,
        );
      }
    };

    try {
      return await sendAndRelay(
        routed.versionPrefix,
        {
          method: 'POST',
          path: '/build',
          query: routed.query,

          // the proxy's own Content-Type (checkBuildContentType), and no
          // client header: a build without a session reads no registry auth
          headers: { 'content-type': BUILD_CONTENT_TYPE },
          body,
          signal: request.signal,
        },
        { onChunk: buildEnd.read, onEnd: registerBuiltTags },
      );
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return buildJsonResponse(
          413,
          `imp-docker-proxy: ${error.message} (IMP_BUILD_CONTEXT_MAX_MIB)`,
        );
      }

      throw error;
    }
  };

  const handlePull = async (
    request: Request,
    routed: RoutedRequest,
    path: string,
  ): Promise<Response> => {
    const raw = await readBodyWithin(request, 0);

    if (raw === null) {
      return buildRefusal(request, path, 'a pull takes no body');
    }

    const fromImage = routed.query.get('fromImage') ?? [];
    const tag = routed.query.get('tag') ?? [];

    const query = new Map([
      ['fromImage', fromImage],
      ['tag', tag],
    ]);

    // checkPullQuery requires both, once each
    const reference = formatPulledReference(fromImage[0] ?? '', tag[0] ?? '');

    // only a reference the engine did not have is the proxy's to remove:
    // one the host owner pulled stays theirs
    const before = await findImage(routed.versionPrefix, reference);
    const imageTimes = await readOwnedImageTimes(routed.versionPrefix);
    const digestsBefore = await readEngineDigests(routed.versionPrefix);

    const registerPulled =
      before.kind === 'absent'
        ? {
            onEnd: () =>
              registerReference(routed.versionPrefix, reference, {
                before,
                imageTimes,
                digestsBefore,
              }),
          }
        : undefined;

    return sendAndRelay(
      routed.versionPrefix,
      {
        method: 'POST',
        path: '/images/create',
        query,
        headers: pickHeaders(request, ['x-registry-auth']),
        signal: request.signal,
      },
      registerPulled,
    );
  };

  const handleOwnContainer = async (
    request: Request,
    versionPrefix: string,
    path: string,
    id: string,
  ): Promise<Response> => {
    const fullId = await findOwnContainer(versionPrefix, id);

    if (fullId === null) {
      return buildRefusal(request, path, `container ${id} was not created by this proxy`);
    }

    if (request.method === 'DELETE') {
      const query = new Map([
        ['force', ['1']],
        ['v', ['1']],
      ]);

      return sendAndRelay(versionPrefix, {
        method: 'DELETE',
        path: `/containers/${fullId}`,
        query,
      });
    }

    return sendAndRelay(versionPrefix, {
      method: 'GET',
      path: `/containers/${fullId}/export`,
      signal: request.signal,
    });
  };

  const sendImageRemove = (versionPrefix: string, reference: string): Promise<Response> =>
    sendUpstream(versionPrefix, {
      method: 'DELETE',
      path: `/images/${reference}`,
      query: new Map([
        ['force', ['0']],
        ['noprune', ['1']],
      ]),
    });

  // DELETE /images/{name}: a reference this proxy made, as it made it, or an
  // ID whose every tag is one, never in a kept repository. Each goes by its
  // reference, without force (docs/architecture/host-contract.md)
  const handleImageRemove = async (
    request: Request,
    versionPrefix: string,
    path: string,
    name: string,
  ): Promise<Response> => {
    const found = await findImage(versionPrefix, name);

    if (found.kind === 'absent') {
      // a reference the engine no longer has leaves the record
      options.ownedReferences.remove(normalizeReference(name));

      return buildJsonResponse(404, `No such image: ${name}`);
    }

    if (found.kind === 'unknown') {
      return buildRefusal(request, path, `the engine gave no image for ${name}`);
    }

    const image = found.image;
    const tags = image.RepoTags ?? [];
    const isId = isImageIdName(name, image.Id);
    const names = [...(isId ? [] : [name]), ...tags, ...(image.RepoDigests ?? [])];
    const kept = checkRemovableImage(names, options.hostImage);

    if (!kept.isOk) {
      return buildRefusal(request, path, kept.reason);
    }

    // an untagged image could be the owner's: only a tag says who made it
    const references = isId ? tags : [name];

    if (references.length === 0) {
      return buildRefusal(request, path, `image ${name} has no tag the proxy made`);
    }

    for (const reference of references) {
      const ownership = await findOwnership(versionPrefix, reference);

      if (ownership !== 'owned') {
        return buildRefusal(
          request,
          path,
          `image ${reference} was not pulled or built by this proxy`,
        );
      }
    }

    // the engine removes a repository's digest references with its last
    // tag, and all of them with the image: each must be the proxy's too
    const digests = findRemovedDigests(image, references, isId);

    for (const digest of digests) {
      const ownership = await findOwnership(versionPrefix, digest);

      if (ownership !== 'owned') {
        return buildRefusal(
          request,
          path,
          `image ${name} carries ${digest}, which this proxy did not pull`,
        );
      }
    }

    const answers: Response[] = [];

    for (const reference of references) {
      const upstream = await sendImageRemove(versionPrefix, reference);

      answers.push(upstream);

      if (!upstream.ok) {
        break;
      }

      options.ownedReferences.remove(normalizeReference(reference));
    }

    const last = answers.at(-1) ?? buildJsonResponse(500, 'no image removed');

    // a digest the engine removed with its tag leaves the record
    if (last.ok) {
      for (const digest of digests) {
        await findOwnership(versionPrefix, digest);
      }
    }

    const body = await last.text();

    return toClientResponse(new Response(body, last));
  };

  const checkRouteQuery = (routed: RoutedRequest): Check => {
    const kind = routed.route.kind;

    if (kind === 'build') {
      return checkBuildQuery(routed.query);
    }

    if (kind === 'pull') {
      return checkPullQuery(routed.query, options.hostImage);
    }

    if (kind === 'remove') {
      return checkRemoveQuery(routed.query);
    }

    if (kind === 'image-remove') {
      return checkImageRemoveQuery(routed.query);
    }

    return checkNoQuery(routed.query);
  };

  const handleRouted = (
    request: Request,
    routed: RoutedRequest,
    path: string,
  ): Promise<Response> | Response => {
    const checked = checkRouteQuery(routed);

    if (!checked.isOk) {
      return buildRefusal(request, path, checked.reason);
    }

    const route = routed.route;
    const prefix = routed.versionPrefix;

    switch (route.kind) {
      case 'ping': {
        return sendAndRelay(prefix, { method: request.method, path: '/_ping' });
      }

      case 'version': {
        return sendAndRelay(prefix, { method: 'GET', path: '/version' });
      }

      case 'image-inspect': {
        return sendAndRelay(prefix, { method: 'GET', path: `/images/${route.name}/json` });
      }

      case 'pull': {
        return handlePull(request, routed, path);
      }

      case 'build': {
        return handleBuild(request, routed, path);
      }

      case 'create': {
        return handleCreate(request, prefix, path);
      }

      case 'image-remove': {
        return handleImageRemove(request, prefix, path, route.name);
      }

      case 'export':
      case 'remove': {
        return handleOwnContainer(request, prefix, path, route.id);
      }

      default: {
        return buildRefusal(request, path, 'no handler for this route');
      }
    }
  };

  return async (request) => {
    const url = new URL(request.url);

    const routed = findRequestRoute(request.method, `${url.pathname}${url.search}`);

    if (!routed.isAllowed) {
      return buildRefusal(request, url.pathname, routed.reason);
    }

    // an Upgrade is a hijacked stream (attach, BuildKit's session): never
    if (request.headers.has('upgrade')) {
      return buildRefusal(request, url.pathname, 'an Upgrade request is not a call impd makes');
    }

    try {
      return await handleRouted(request, routed.request, url.pathname);
    } catch (error) {
      const message = readMessage(error);

      options.log(`error on ${request.method} ${url.pathname}: ${message}`);

      return buildJsonResponse(502, `imp-docker-proxy: the engine call failed: ${message}`);
    }
  };
}
