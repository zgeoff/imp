import type { ProgressOutput } from '../cp/copy-progress';

// The line after the upload's on a terminal: impd builds, and for how long,
// as its progress events say. Off the terminal it prints nothing.
export interface BuildStatus {
  readonly show: (elapsedMs: number) => void;
  readonly finish: () => void;
}

export function formatBuildStatus(elapsedMs: number, label: string): string {
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');

  return `${label}: building, ${String(minutes)}m${rest}s`;
}

export function createBuildStatus(output: ProgressOutput, label: string): BuildStatus {
  const state = { drawn: false };

  return {
    show: (elapsedMs) => {
      if (!output.isTTY) {
        return;
      }

      state.drawn = true;

      output.write(`\r${formatBuildStatus(elapsedMs, label)}\u001B[K`);
    },
    finish: () => {
      if (state.drawn) {
        state.drawn = false;

        output.write('\n');
      }
    },
  };
}
