// the most of a build's output a stream holds for a client that reads more
// slowly than the build writes; a log event holds a few KiB at most
export const BUILD_LOG_QUEUE_MAX_BYTES = 1024 ** 2;

export interface LogBudget {
  // The lines to queue for one line of output: none when the queue has no
  // room, else the line, after a marker for the lines dropped before it
  readonly admit: (line: string, hasRoom: boolean) => string[];

  // the marker for lines dropped since the last one admitted, as the build ends
  readonly drain: () => string[];
}

// A slow client loses lines of build output rather than holding them all in
// impd's memory, or holding back the build. The marker says how many it lost.
export function createLogBudget(): LogBudget {
  const state = { dropped: 0 };

  const drain = (): string[] => {
    if (state.dropped === 0) {
      return [];
    }

    const count = state.dropped === 1 ? '1 line' : `${String(state.dropped)} lines`;
    const marker = `imp: ${count} of build output dropped: the client read them more slowly than the build wrote them`;

    state.dropped = 0;

    return [marker];
  };

  return {
    admit: (line, hasRoom) => {
      if (!hasRoom) {
        state.dropped += 1;

        return [];
      }

      return [...drain(), line];
    },
    drain,
  };
}
