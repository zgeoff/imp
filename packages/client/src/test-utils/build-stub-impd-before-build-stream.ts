import { IMAGE_BUILD_PATH } from '@imp/api';

// impd from before the build stream in front of a real impd's `handle`: it
// reads no Accept header on `POST /images/build`, so the real one answers
// JSON; every other call passes through unchanged
export function buildStubImpdBeforeBuildStream(
  handle: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) => {
    if (new URL(request.url).pathname !== IMAGE_BUILD_PATH) {
      return handle(request);
    }

    const headers = new Headers(request.headers);

    headers.delete('accept');

    // `duplex` is in the fetch spec, but not yet in every RequestInit type
    const init: RequestInit & { readonly duplex: 'half' } = {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
      duplex: 'half',
    };

    return handle(new Request(request.url, init));
  };
}
