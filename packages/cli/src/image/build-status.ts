import type { ImageBuildPhase, ImageBuildProgress } from '@imp/api';
import type { ProgressOutput } from '../cp/copy-progress';

// The line of a streamed image call on a terminal: what impd does, and for
// how long, as its progress events say. Off the terminal it prints nothing.
export interface BuildStatus {
  // the time counts from the first event of the phase
  readonly show: (progress: ImageBuildProgress) => void;
  readonly finish: () => void;
}

const PHASE_WORDS: Readonly<Record<ImageBuildPhase, string>> = {
  upload: 'uploading',
  pack: 'packing',
  build: 'building',
  pull: 'pulling',
  unpack: 'unpacking',
  copy: 'copying',
};

export function formatBuildStatus(
  phase: ImageBuildPhase,
  elapsedMs: number,
  label: string,
): string {
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');

  return `${label}: ${PHASE_WORDS[phase]}, ${String(minutes)}m${rest}s`;
}

export function createBuildStatus(output: ProgressOutput, label: string): BuildStatus {
  const state = {
    drawn: false,
    phase: null as ImageBuildPhase | null,
    phaseStartMs: 0,
  };

  return {
    show: (progress) => {
      if (!output.isTTY) {
        return;
      }

      if (progress.phase !== state.phase) {
        state.phase = progress.phase;
        state.phaseStartMs = progress.elapsedMs;
      }

      state.drawn = true;

      const elapsedMs = progress.elapsedMs - state.phaseStartMs;

      output.write(`\r${formatBuildStatus(progress.phase, elapsedMs, label)}\u001B[K`);
    },
    finish: () => {
      if (state.drawn) {
        state.drawn = false;

        output.write('\n');
      }
    },
  };
}
