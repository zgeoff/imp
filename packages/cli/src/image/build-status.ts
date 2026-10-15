import type { ImageBuildPhase, ImageBuildProgress } from '@imp/api';
import type { ProgressOutput } from '../cp/copy-progress';

// What a streamed image call shows from impd's events. A terminal gets one
// line redrawn in place, the output above it; a log or an agent gets a plain
// line at each phase and step and every so often, and the output as it is.
export interface BuildStatus {
  // the time counts from the first event of the phase
  readonly show: (progress: ImageBuildProgress) => void;
  readonly printLog: (line: string) => void;
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

// off a terminal, the gap between two lines that report no change
const QUIET_LINE_MS = 30_000;

// the most of a step the terminal line shows, so the line fits on one row
const TTY_STEP_MAX_CHARS = 60;

export function formatBuildStatus(
  phase: ImageBuildPhase,
  elapsedMs: number,
  label: string,
  step?: string,
): string {
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  const line = `${label}: ${PHASE_WORDS[phase]}, ${String(minutes)}m${rest}s`;

  return step === undefined ? line : `${line}, ${step}`;
}

// `quiet` shows nothing at all
export function createBuildStatus(
  output: ProgressOutput,
  label: string,
  quiet = false,
): BuildStatus {
  const state = {
    drawn: '',
    phase: null as ImageBuildPhase | null,
    step: undefined as string | undefined,
    phaseStartMs: 0,
    printedMs: Number.NEGATIVE_INFINITY,
  };

  const printTerminalLine = (progress: ImageBuildProgress, elapsedMs: number): void => {
    const step = progress.step;

    const shortStep =
      step !== undefined && step.length > TTY_STEP_MAX_CHARS
        ? `${step.slice(0, TTY_STEP_MAX_CHARS - 1)}…`
        : step;

    state.drawn = formatBuildStatus(progress.phase, elapsedMs, label, shortStep);

    output.write(`\r${state.drawn}\u001B[K`);
  };

  const printPlainLine = (
    progress: ImageBuildProgress,
    elapsedMs: number,
    isChange: boolean,
  ): void => {
    if (!isChange && progress.elapsedMs - state.printedMs < QUIET_LINE_MS) {
      return;
    }

    state.printedMs = progress.elapsedMs;

    output.write(`${formatBuildStatus(progress.phase, elapsedMs, label, progress.step)}\n`);
  };

  return {
    show: (progress) => {
      if (quiet) {
        return;
      }

      const isChange = progress.phase !== state.phase || progress.step !== state.step;

      if (progress.phase !== state.phase) {
        state.phase = progress.phase;
        state.phaseStartMs = progress.elapsedMs;
      }

      state.step = progress.step;

      const elapsedMs = progress.elapsedMs - state.phaseStartMs;

      if (output.isTTY) {
        printTerminalLine(progress, elapsedMs);
      } else {
        printPlainLine(progress, elapsedMs, isChange);
      }
    },

    // above the terminal line, which is drawn again under it
    printLog: (line) => {
      if (quiet) {
        return;
      }

      if (output.isTTY && state.drawn !== '') {
        output.write(`\r\u001B[K${line}\n${state.drawn}\u001B[K`);
      } else {
        output.write(`${line}\n`);
      }
    },
    finish: () => {
      if (output.isTTY && state.drawn !== '') {
        state.drawn = '';

        output.write('\n');
      }
    },
  };
}
