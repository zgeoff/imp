import { buildStubNewerImpdFetch } from './build-stub-newer-impd-fetch';
import type { StubNewerImpdOptions } from './build-stub-newer-impd-fetch';

// A newer impd on a loopback port for a CLI child: the real app behind
// `fetch`, answered as buildStubNewerImpdFetch answers it. Its stop goes
// into `stack`, so it closes before the impd behind it.
export function startStubNewerImpd(
  stack: Readonly<AsyncDisposableStack>,
  fetch: (request: Request) => Promise<Response>,
  options: Readonly<StubNewerImpdOptions>,
) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: buildStubNewerImpdFetch(fetch, options),
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  return { url: `http://127.0.0.1:${String(server.port)}` };
}
