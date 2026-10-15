import type { Image, ImageBuildPhase, ImageOpEvent } from '@imp/api';
import { runOnInterval } from './build-event-stream';
import type { BuildReport, Repeat } from './build-event-stream';
import { BUILD_LOG_QUEUE_MAX_BYTES, createLogBudget } from './create-log-budget';

export interface ImageOpStreamOptions {
  readonly firstPhase: ImageBuildPhase;

  // aborts when the client goes
  readonly signal: AbortSignal;

  // the gap between progress events; BUILD_KEEPALIVE_MS
  readonly keepaliveMs: number;
  readonly now: () => number;

  // writes the audit row: null for the image, else what was thrown
  readonly record: (failure: unknown) => void;

  // the keepalive's timer; runOnInterval by default
  readonly repeat?: Repeat;

  // the build's output goes as log events; a client from before them reads
  // any event but the image as progress
  readonly logs?: boolean;
}

type Outcome =
  | { readonly ok: true; readonly image: Image }
  | { readonly ok: false; readonly error: unknown };

// What images.addStream and images.buildStream yield: progress now, at each
// phase, step and keepalive, then the image; with `logs`, each output line in
// order. The audit row is written as the work ends, even after its client went.
export async function* runImageOp(
  run: (signal: AbortSignal, report: BuildReport) => Promise<Image>,
  options: Readonly<ImageOpStreamOptions>,
): AsyncGenerator<ImageOpEvent> {
  const startedAt = options.now();

  const state = {
    phase: options.firstPhase,
    step: null as string | null,
    changed: Promise.withResolvers<void>(),
  };

  // the lines not yet yielded, and their bytes; none is kept once the
  // client went
  const lines: string[] = [];
  const queued = { bytes: 0 };
  const logs = createLogBudget();

  const drainLines = (): string[] => {
    queued.bytes = 0;

    return lines.splice(0);
  };

  const report: BuildReport = {
    setPhase: (phase) => {
      state.phase = phase;

      state.changed.resolve();
    },
    output: {
      emitLog: (line) => {
        if (options.logs !== true || options.signal.aborted) {
          return;
        }

        const bytes = Buffer.byteLength(line);
        const hasRoom = queued.bytes + bytes <= BUILD_LOG_QUEUE_MAX_BYTES;

        for (const text of logs.admit(line, hasRoom)) {
          lines.push(text);

          queued.bytes += Buffer.byteLength(text);
        }

        state.changed.resolve();
      },
      setStep: (step) => {
        state.step = step;

        state.changed.resolve();
      },
    },
  };

  const runToOutcome = async (): Promise<Outcome> => {
    try {
      const image = await run(options.signal, report);

      options.record(null);

      return { ok: true, image };
    } catch (error) {
      options.record(error);

      return { ok: false, error };
    }
  };

  const outcome = runToOutcome();
  const repeat = options.repeat ?? runOnInterval;
  const shown = { phase: state.phase, step: state.step };

  const buildProgress = (): ImageOpEvent => {
    shown.phase = state.phase;
    shown.step = state.step;

    return {
      type: 'progress',
      phase: state.phase,
      elapsedMs: options.now() - startedAt,
      ...(state.step !== null && { step: state.step }),
    };
  };

  yield buildProgress();

  // then each line, and progress at each phase, step and keepalive
  for (;;) {
    const tick = Promise.withResolvers<'tick'>();

    const stopTimer = repeat(options.keepaliveMs, () => {
      tick.resolve('tick');
    });

    const ended = await Promise.race([outcome, tick.promise, state.changed.promise]);

    stopTimer();

    state.changed = Promise.withResolvers<void>();

    for (const text of drainLines()) {
      yield { type: 'log', text };
    }

    if (ended !== 'tick' && ended !== undefined) {
      for (const text of logs.drain()) {
        yield { type: 'log', text };
      }

      if (!ended.ok) {
        throw ended.error;
      }

      yield { type: 'image', image: ended.image };

      return;
    }

    if (ended === 'tick' || shown.phase !== state.phase || shown.step !== state.step) {
      yield buildProgress();
    }
  }
}
