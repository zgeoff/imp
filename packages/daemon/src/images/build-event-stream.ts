import { IMAGE_BUILD_STREAM_TYPE } from '@impz/api';
import type { ImageBuildEvent, ImageBuildPhase } from '@impz/api';
import type { BuildOutput } from './create-build-steps';
import { BUILD_LOG_QUEUE_MAX_BYTES, createLogBudget } from './create-log-budget';

// A progress line this often keeps a client's fetch reading: Bun's gives up
// after 360 s with no byte, undici's after 300 s (its headersTimeout before
// the headers, its bodyTimeout between two chunks).
export const BUILD_KEEPALIVE_MS = 15_000;

// runs tick every ms until the returned stop is called
export type Repeat = (ms: number, tick: () => void) => () => void;

export function runOnInterval(ms: number, tick: () => void): () => void {
  const timer = setInterval(tick, ms);

  return () => {
    clearInterval(timer);
  };
}

export interface BuildEventStreamDeps {
  readonly keepaliveMs: number;
  readonly now: () => number;

  // the keepalive's timer; runOnInterval by default
  readonly repeat?: Repeat;
}

// what a build tells its stream as it runs: each phase as it starts, and
// the lines and steps of its output
export interface BuildReport {
  readonly setPhase: (phase: ImageBuildPhase) => void;
  readonly output: BuildOutput;
}

// The build's answer, at once: progress lines, at each phase and step too, a
// log line for each line of output, then the event `run` ends with (it never
// throws). Its signal aborts when the client goes or cancels the stream.
export function createBuildEventStream(
  clientSignal: AbortSignal,
  run: (signal: AbortSignal, report: BuildReport) => Promise<ImageBuildEvent>,
  deps: Readonly<BuildEventStreamDeps>,
): Response {
  const cancelled = new AbortController();

  const signal = AbortSignal.any([clientSignal, cancelled.signal]);

  const encoder = new TextEncoder();

  const startedAt = deps.now();
  const repeat = deps.repeat ?? runOnInterval;

  const state: {
    phase: ImageBuildPhase;
    step: string | null;
    open: boolean;
    stopKeepalive: () => void;
  } = {
    phase: 'upload',
    step: null,
    open: true,
    stopKeepalive: () => {},
  };

  const stop = (): void => {
    state.open = false;

    state.stopKeepalive();
  };

  const body = new ReadableStream<Uint8Array>(
    {
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
          send({
            type: 'progress',
            phase: state.phase,
            elapsedMs: deps.now() - startedAt,
            ...(state.step !== null && { step: state.step }),
          });
        };

        const logs = createLogBudget();

        // Bun sends the headers with the first chunk
        sendProgress();

        state.stopKeepalive = repeat(deps.keepaliveMs, sendProgress);

        // nobody reads the progress of a build that stops for its client
        signal.addEventListener('abort', () => {
          state.stopKeepalive();
        });

        const report: BuildReport = {
          setPhase: (phase) => {
            state.phase = phase;

            sendProgress();
          },
          output: {
            // the stream's queue holds what the client has not read yet
            emitLog: (line) => {
              const hasRoom = (controller.desiredSize ?? 0) > 0;

              for (const text of logs.admit(line, hasRoom)) {
                send({ type: 'log', text });
              }
            },
            setStep: (step) => {
              state.step = step;

              sendProgress();
            },
          },
        };

        const sendOutcome = async (): Promise<void> => {
          const outcome = await run(signal, report);

          for (const text of logs.drain()) {
            send({ type: 'log', text });
          }

          send(outcome);

          if (state.open) {
            stop();

            // a client that went as the build ended may have closed it already
            try {
              controller.close();
            } catch {
              // nothing is left to send
            }
          }
        };

        void sendOutcome();
      },
      cancel: () => {
        stop();

        cancelled.abort();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: BUILD_LOG_QUEUE_MAX_BYTES }),
  );

  return new Response(body, { headers: { 'content-type': IMAGE_BUILD_STREAM_TYPE } });
}
