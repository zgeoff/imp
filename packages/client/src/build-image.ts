import { IMAGE_BUILD_PATH, ImageBuildErrorSchema, ImageBuildResultSchema } from '@imp/api';
import type { Image } from '@imp/api';
import { ORPCError } from '@orpc/client';
import { resolveImpdUrl } from './resolve-impd-url';

// a tar of the build context: a file the user picked, bytes, or a stream
// that is uploaded as it is made
export type BuildContext = Blob | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;

export interface BuildImageOptions {
  // the Dockerfile's path in the context; `Dockerfile` by default
  readonly dockerfile?: string;

  // the context's exact length in bytes, sent as Content-Length: impd then
  // holds that much disk for the upload, not its whole limit
  readonly size?: number;
  readonly signal?: AbortSignal;
}

export interface BuildImageDeps {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly fetch?: (request: Request) => Promise<Response>;
}

// Uploads a build context to `POST /images/build`, which builds it on the
// impd host. A failure throws an ORPCError, as a contract call would.
export async function buildImage(
  deps: Readonly<BuildImageDeps>,
  name: string,
  context: BuildContext,
  options: Readonly<BuildImageOptions> = {},
): Promise<Image> {
  const url = resolveImpdUrl(deps.baseUrl, IMAGE_BUILD_PATH);

  url.searchParams.set('name', name);

  if (options.dockerfile !== undefined) {
    url.searchParams.set('dockerfile', options.dockerfile);
  }

  const headers: Record<string, string> = { 'content-type': 'application/x-tar' };

  if (deps.token !== null) {
    headers['authorization'] = `Bearer ${deps.token}`;
  }

  if (options.size !== undefined) {
    headers['content-length'] = String(options.size);
  }

  // `duplex` is in the fetch spec, but not yet in every RequestInit type
  const init: RequestInit & { readonly duplex: 'half' } = {
    method: 'POST',
    headers,
    body: context,

    // a stream body goes out as it is read, not first into memory
    duplex: 'half',
    ...(options.signal !== undefined && { signal: options.signal }),
  };

  const request = new Request(url.href, init);

  const response = await (deps.fetch ?? fetch)(request);
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
