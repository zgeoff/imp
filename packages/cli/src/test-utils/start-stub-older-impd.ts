import { buildStubOlderImpdFetch } from './build-stub-older-impd-fetch';
import type { StubOlderImpdOptions } from './build-stub-older-impd-fetch';

// An older impd on a loopback port for a CLI child: the real app behind
// `fetch`, answered as buildStubOlderImpdFetch answers it. Its stop goes
// into `stack`, so it closes before the impd behind it.
export function startStubOlderImpd(
  stack: Readonly<AsyncDisposableStack>,
  fetch: (request: Request) => Promise<Response>,
  options: Readonly<StubOlderImpdOptions> = {},
) {
  const older = buildStubOlderImpdFetch(fetch, options);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: older.fetch,
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  return { url: `http://127.0.0.1:${String(server.port)}`, calls: older.calls };
}
