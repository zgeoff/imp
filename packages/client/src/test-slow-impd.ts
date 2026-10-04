import type { ImageService } from '@imp/daemon/src/images/image-service';
import { buildTestApp } from '@imp/daemon/src/imps/test-imps';

// what buildTestApp takes from the harness; the test disposes of it
export type SlowImpdHarness = Parameters<typeof buildTestApp>[0] &
  Parameters<typeof buildTestApp>[1];

// impd on a real listener, with these in place of its image service's own,
// and `keepaliveMs` between the progress events of a streamed image call
export function startSlowImpd(
  harness: SlowImpdHarness,
  replaced: Readonly<Partial<ImageService>>,
  keepaliveMs: number,
) {
  const images = { ...harness.images, ...replaced };

  const app = buildTestApp(
    { ...harness, images },
    harness,
    undefined,
    {},
    null,
    {},
    keepaliveMs,
  ).app;

  app.listen({ port: 0, hostname: '127.0.0.1' });

  return {
    url: `http://127.0.0.1:${String(app.server?.port)}/`,
    [Symbol.asyncDispose]: async () => {
      await app.stop(true);
    },
  };
}

// The real fetch, but one that gives up after `idleMs` without a byte, before
// the headers or between two chunks of the body: Bun's own fetch does so
// after 360 s, undici's after 300 s.
export function createIdleFetch(idleMs: number) {
  return async (request: Request): Promise<Response> => {
    const watchdog = new AbortController();

    const state = { timer: setTimeout(() => {}, 0) };

    const resetWatchdog = (): void => {
      clearTimeout(state.timer);

      state.timer = setTimeout(() => {
        watchdog.abort(new DOMException('no byte came in time', 'TimeoutError'));
      }, idleMs);
    };

    resetWatchdog();

    const response = await fetch(request, { signal: watchdog.signal });

    resetWatchdog();

    const source: ReadableStream<Uint8Array> | null = response.body;
    const reader = source?.getReader();

    // a reader that stops early, as oRPC's does after its last event, ends
    // the watchdog too
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const chunk = await reader?.read();

        if (chunk === undefined || chunk.done) {
          clearTimeout(state.timer);

          controller.close();

          return;
        }

        resetWatchdog();

        controller.enqueue(chunk.value);
      },
      cancel: async (reason) => {
        clearTimeout(state.timer);

        await reader?.cancel(reason);
      },
    });

    return new Response(body, response);
  };
}
