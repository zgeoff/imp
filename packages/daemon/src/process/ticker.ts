import { readErrorMessage } from '../read-error-message';

export interface Ticker {
  readonly stop: () => Promise<void>;
}

// Waits out a ticker's interval, then calls `run`, which returns the tick it
// starts so a test that fires it can wait for the tick; `label` names the
// ticker. The returned function cancels the wait.
export type TickerTimer = (label: string, run: () => Promise<void>, ms: number) => () => void;

// the runtime's own timers
function startRuntimeTimer(_label: string, run: () => Promise<void>, ms: number): () => void {
  const handle = setTimeout(() => {
    void run();
  }, ms);

  return () => {
    clearTimeout(handle);
  };
}

// Runs `task` every `intervalMs`, never two at once; a failure is logged and
// the next tick runs as usual.
export function startTicker(
  label: string,
  intervalMs: number,
  task: () => Promise<void>,
  log: (message: string) => void,
  timer: TickerTimer = startRuntimeTimer,
): Ticker {
  const state: { cancel: (() => void) | null; running: Promise<void> | null } = {
    cancel: null,
    running: null,
  };

  let stopped = false;

  const runTick = async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      log(`impd: ${label}: ${readErrorMessage(error)}`);
    }
  };

  const runAndReschedule = async (): Promise<void> => {
    await runTick();

    state.running = null;

    if (!stopped) {
      setupNextTick();
    }
  };

  const setupNextTick = (): void => {
    state.cancel = timer(
      label,
      () => {
        const running = runAndReschedule();

        state.running = running;

        return running;
      },
      intervalMs,
    );
  };

  setupNextTick();

  return {
    stop: async () => {
      stopped = true;
      state.cancel?.();

      await state.running;
    },
  };
}
