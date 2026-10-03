import type { Image, ImageBuildPhase, ImageOpEvent } from '@imp/api';

export interface ImageOpStreamOptions {
  readonly firstPhase: ImageBuildPhase;

  // aborts when the client goes
  readonly signal: AbortSignal;

  // the gap between progress events; BUILD_KEEPALIVE_MS
  readonly keepaliveMs: number;
  readonly now: () => number;

  // writes the audit row: null for the image, else what was thrown
  readonly record: (failure: unknown) => void;
}

type Outcome =
  | { readonly ok: true; readonly image: Image }
  | { readonly ok: false; readonly error: unknown };

// What images.addStream and images.buildStream yield: progress now, at each
// phase and keepalive, then the image. The audit row is written as the work
// ends, even after its client went.
export async function* runImageOp(
  run: (signal: AbortSignal, setPhase: (phase: ImageBuildPhase) => void) => Promise<Image>,
  options: Readonly<ImageOpStreamOptions>,
): AsyncGenerator<ImageOpEvent> {
  const startedAt = options.now();
  const state = { phase: options.firstPhase, changed: Promise.withResolvers<void>() };

  const setPhase = (phase: ImageBuildPhase): void => {
    state.phase = phase;

    state.changed.resolve();
  };

  const runToOutcome = async (): Promise<Outcome> => {
    try {
      const image = await run(options.signal, setPhase);

      options.record(null);

      return { ok: true, image };
    } catch (error) {
      options.record(error);

      return { ok: false, error };
    }
  };

  const outcome = runToOutcome();

  for (;;) {
    yield { type: 'progress', phase: state.phase, elapsedMs: options.now() - startedAt };
    const tick = Promise.withResolvers<null>();
    const timer = setTimeout(tick.resolve, options.keepaliveMs, null);

    const ended = await Promise.race([outcome, tick.promise, state.changed.promise]);

    clearTimeout(timer);

    if (ended !== null && ended !== undefined) {
      if (!ended.ok) {
        throw ended.error;
      }

      yield { type: 'image', image: ended.image };

      return;
    }

    state.changed = Promise.withResolvers<void>();
  }
}
