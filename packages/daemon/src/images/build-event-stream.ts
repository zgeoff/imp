import { IMAGE_BUILD_STREAM_TYPE } from '@imp/api';
import type { ImageBuildEvent, ImageBuildPhase } from '@imp/api';

// A progress line this often keeps a client's fetch reading: Bun's gives up
// after 360 s with no byte, undici's after 300 s (its headersTimeout before
// the headers, its bodyTimeout between two chunks).
export const BUILD_KEEPALIVE_MS = 15_000;

export interface BuildEventStreamDeps {
  readonly keepaliveMs: number;
  readonly now: () => number;
}

// The build's answer, at once: progress lines, then the event `run` ends
// with (it never throws). Its signal aborts when the client goes, whether
// the request says so or the stream is cancelled.
export function createBuildEventStream(
  clientSignal: AbortSignal,
  run: (
    signal: AbortSignal,
    setPhase: (phase: ImageBuildPhase) => void,
  ) => Promise<ImageBuildEvent>,
  deps: Readonly<BuildEventStreamDeps>,
): Response {
  const cancelled = new AbortController();

  const signal = AbortSignal.any([clientSignal, cancelled.signal]);

  const encoder = new TextEncoder();

  const startedAt = deps.now();

  const state: { phase: ImageBuildPhase; open: boolean; timer?: Timer } = {
    phase: 'upload',
    open: true,
  };

  const stop = (): void => {
    state.open = false;

    clearInterval(state.timer);
  };

  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      // a client gone mid-write closes the stream under us: then nothing
      // more is sent, and the build stops through the signal
      const send = (event: ImageBuildEvent): void => {
        if (!state.open) {
          return;
        }

        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          stop();
        }
      };

      const sendProgress = (): void => {
        send({ type: 'progress', phase: state.phase, elapsedMs: deps.now() - startedAt });
      };

      // Bun sends the headers with the first chunk
      sendProgress();

      state.timer = setInterval(sendProgress, deps.keepaliveMs);

      // nobody reads the progress of a build that stops for its client
      signal.addEventListener('abort', () => {
        clearInterval(state.timer);
      });

      const setPhase = (phase: ImageBuildPhase): void => {
        state.phase = phase;

        sendProgress();
      };

      const sendOutcome = async (): Promise<void> => {
        const outcome = await run(signal, setPhase);

        send(outcome);

        if (state.open) {
          stop();

          controller.close();
        }
      };

      void sendOutcome();
    },
    cancel: () => {
      stop();

      cancelled.abort();
    },
  });

  return new Response(body, { headers: { 'content-type': IMAGE_BUILD_STREAM_TYPE } });
}
