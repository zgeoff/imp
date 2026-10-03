// `imp cp`'s progress line on a terminal: bytes of file content copied, of
// the total when it is known. Off the terminal it prints nothing.
export interface CopyProgress {
  readonly setTotal: (bytes: number) => void;
  readonly add: (bytes: number) => void;
  readonly finish: () => void;
}

export interface ProgressOutput {
  readonly isTTY: boolean;
  readonly write: (text: string) => void;
}

// at most this often, so a fast copy does not spend its time printing
const REDRAW_MS = 250;
const MIB = 1_048_576;

function formatMib(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

export function formatProgress(copied: number, total: number | null, label = 'imp cp'): string {
  if (total === null || total === 0) {
    return `${label}: ${formatMib(copied)}`;
  }

  const percent = Math.min(100, Math.floor((copied / total) * 100));

  return `${label}: ${String(percent)}% ${formatMib(copied)} of ${formatMib(total)}`;
}

// `label` starts the line: the command that copies
export function createCopyProgress(
  output: ProgressOutput,
  now = Date.now,
  label = 'imp cp',
): CopyProgress {
  const state = { copied: 0, total: null as number | null, drawnAt: 0, drawn: false };

  const renderLine = (): void => {
    state.drawnAt = now();
    state.drawn = true;

    output.write(`\r${formatProgress(state.copied, state.total, label)}\u001B[K`);
  };

  return {
    setTotal: (bytes) => {
      state.total = bytes;
    },
    add: (bytes) => {
      state.copied += bytes;

      if (output.isTTY && now() - state.drawnAt >= REDRAW_MS) {
        renderLine();
      }
    },

    // ends the line once: a second call prints nothing
    finish: () => {
      if (output.isTTY && state.drawn) {
        renderLine();

        output.write('\n');

        state.drawn = false;
      }
    },
  };
}
