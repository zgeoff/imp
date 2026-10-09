import type { Ticker, startTicker } from '../process/ticker';
import { readErrorMessage } from '../read-error-message';

interface StubTask {
  readonly intervalMs: number;
  readonly task: () => Promise<void>;
  readonly log: (message: string) => void;
  isStopped: boolean;
}

// Tickers the test steps by hand, in place of startTicker: a task runs only
// when the test fires its label, never on a timer. A failure is logged as
// startTicker logs it, and a stopped ticker cannot be fired.
export function buildStubTicker() {
  const tasks = new Map<string, StubTask>();

  const start: typeof startTicker = (label, intervalMs, task, log): Ticker => {
    const entry: StubTask = { intervalMs, task, log, isStopped: false };

    tasks.set(label, entry);

    return {
      stop: () => {
        entry.isStopped = true;

        return Promise.resolve();
      },
    };
  };

  return {
    startTicker: start,

    // one tick of the ticker named `label`, as if its interval had passed
    fire: async (label: string): Promise<void> => {
      const entry = tasks.get(label);

      if (entry === undefined || entry.isStopped) {
        throw new Error(`no ticker named ${label} runs`);
      }

      try {
        await entry.task();
      } catch (error) {
        entry.log(`impd: ${label}: ${readErrorMessage(error)}`);
      }
    },

    // each started ticker's interval, by label
    readIntervals: (): Record<string, number> =>
      Object.fromEntries([...tasks].map(([label, entry]) => [label, entry.intervalMs])),
  };
}
