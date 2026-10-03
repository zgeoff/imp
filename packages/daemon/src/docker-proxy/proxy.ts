// imp-docker-proxy's handler: a call impd or its `docker` CLI makes, checked and
// rebuilt. It closes the Docker socket path only; SYS_ADMIN still lets root
// out of imp-host (docs/architecture/host-contract.md).

import { z } from 'zod';
import { findRequestRoute, formatQuery } from './router';
import type { RoutedRequest } from './router';
import {
  BUILD_CONTENT_TYPE,
  checkBuildContentType,
  checkBuildQuery,
  checkCreateBody,
  checkNoQuery,
  checkPullQuery,
  checkRemoveQuery,
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

export interface DockerProxyOptions {
  // the engine's socket
  readonly upstreamSocket: string;

  // the value of PROXY_LABEL on the containers this proxy creates
  readonly token: string;

  // the image imp-host runs from, whose repository a pull may not move
  readonly hostImage: string;

  // under IMP_BUILD_ISOLATION=imp, IMP_BUILD_IMAGE: the one image a pull may
  // fetch, by its digest, and no build passes; null under host isolation
  readonly builderImage: string | null;
  readonly buildContextMaxBytes: number;
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

function toClientResponse(upstream: Response): Response {
  const headers = new Headers();

  for (const [name, value] of upstream.headers) {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) {
      headers.append(name, value);
    }
  }

  return new Response(upstream.body, {
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

  const sendAndRelay = async (versionPrefix: string, call: UpstreamCall): Promise<Response> => {
    const upstream = await sendUpstream(versionPrefix, call);

    return toClientResponse(upstream);
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

    const checked = checkCreateBody(body, options.hostImage, options.builderImage);

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

    try {
      return await sendAndRelay(routed.versionPrefix, {
        method: 'POST',
        path: '/build',
        query: routed.query,

        // the proxy's own Content-Type (checkBuildContentType), and no
        // client header: a build without a session reads no registry auth
        headers: { 'content-type': BUILD_CONTENT_TYPE },
        body,
        signal: request.signal,
      });
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

    const query = new Map([['fromImage', routed.query.get('fromImage') ?? []]]);

    const tag = routed.query.get('tag');

    if (tag !== undefined) {
      query.set('tag', tag);
    }

    return sendAndRelay(routed.versionPrefix, {
      method: 'POST',
      path: '/images/create',
      query,
      headers: pickHeaders(request, ['x-registry-auth']),
      signal: request.signal,
    });
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

  const checkRouteQuery = (routed: RoutedRequest): Check => {
    const kind = routed.route.kind;

    // impd builds in builder imps then, never on this engine
    if (kind === 'build' && options.builderImage !== null) {
      return {
        isOk: false,
        reason: 'a build is refused: under IMP_BUILD_ISOLATION=imp impd builds in builder imps',
      };
    }

    if (kind === 'build') {
      return checkBuildQuery(routed.query);
    }

    if (kind === 'pull') {
      return checkPullQuery(routed.query, options.hostImage, options.builderImage);
    }

    if (kind === 'remove') {
      return checkRemoveQuery(routed.query);
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
      const message = error instanceof Error ? error.message : String(error);

      options.log(`error on ${request.method} ${url.pathname}: ${message}`);

      return buildJsonResponse(502, `imp-docker-proxy: the engine call failed: ${message}`);
    }
  };
}
