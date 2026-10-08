import type { ImpState } from '@imp/api';

// The imp's states as a reverse forward's `watchImp` reads them, added by
// the test to one queue; a watch ends when its signal aborts or the test ends
// the stream. `reads` lets a test wait until the forward waits on a state.
export function buildStubImpStates() {
  const queue: ImpState[] = [];
  const waiting: (() => void)[] = [];
  const counts = { reads: 0, watches: 0, aborts: 0 };
  const state = { ended: false };

  const wakeReaders = (): void => {
    for (const wake of waiting.splice(0)) {
      wake();
    }
  };

  const readStates = (
    _config: unknown,
    _name: string,
    signal: AbortSignal,
  ): AsyncIterable<ImpState> => {
    counts.watches += 1;

    signal.addEventListener(
      'abort',
      () => {
        counts.aborts += 1;

        wakeReaders();
      },
      { once: true },
    );

    const readNext = async (): Promise<IteratorResult<ImpState>> => {
      counts.reads += 1;

      while (!signal.aborted) {
        const next = queue.shift();

        if (next !== undefined) {
          return { done: false, value: next };
        }

        if (state.ended) {
          break;
        }

        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
      }

      return { done: true, value: undefined };
    };

    return { [Symbol.asyncIterator]: () => ({ next: readNext }) };
  };

  return {
    watchImp: readStates,

    // the next state a watch reads
    add: (next: ImpState): void => {
      queue.push(next);

      wakeReaders();
    },

    // ends every watch once the queue is read, as a stream impd closed
    end: (): void => {
      state.ended = true;

      wakeReaders();
    },
    get reads(): number {
      return counts.reads;
    },
    get watches(): number {
      return counts.watches;
    },

    // watches whose signal aborted
    get aborts(): number {
      return counts.aborts;
    },
  };
}
