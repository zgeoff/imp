import { readErrorMessage } from '../read-error-message';

export interface Ticker {
  readonly stop: () => Promise<void>;
}

// Runs `task` every `intervalMs`, never two at once; a failure is logged and
// the next tick runs as usual.
export function startTicker(
  label: string,
  intervalMs: number,
  task: () => Promise<void>,
  log: (message: string) => void,
): Ticker {
  const state: { timer: ReturnType<typeof setTimeout> | null; running: Promise<void> | null } = {
    timer: null,
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
    state.timer = setTimeout(() => {
      state.running = runAndReschedule();
    }, intervalMs);
  };

  setupNextTick();

  return {
    stop: async () => {
      stopped = true;

      if (state.timer !== null) {
        clearTimeout(state.timer);
      }

      await state.running;
    },
  };
}
