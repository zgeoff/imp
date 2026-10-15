// What a build reports as it runs: each line of its output, and the
// Dockerfile step it runs now
export interface BuildOutput {
  // one line, without its newline
  readonly emitLog: (line: string) => void;
  readonly setStep: (step: string) => void;
}

// a Dockerfile step as BuildKit names its vertex: `[2/5] RUN make`, or
// `[builder 2/5] RUN make` in a multi-stage build; not `[internal] load …`
const STEP_PATTERN = /^\[(?:\S+ )?\d+\/\d+\] /v;

export interface BuildSteps {
  // a vertex started: a step becomes the current one
  readonly start: (id: string, name: string) => void;

  // a vertex ended: the current step falls back to the last one still running
  readonly end: (id: string) => void;
}

// The current step of a build whose vertexes start and end in any order,
// as BuildKit runs independent stages side by side. A build with none left
// running keeps its last step.
export function createBuildSteps(setStep: (step: string) => void): BuildSteps {
  const running = new Map<string, string>();

  const state = { current: null as string | null };

  return {
    start: (id, name) => {
      if (!STEP_PATTERN.test(name)) {
        return;
      }

      running.delete(id);
      running.set(id, name);

      state.current = id;

      setStep(name);
    },
    end: (id) => {
      if (!running.delete(id) || state.current !== id) {
        return;
      }

      const last = [...running].at(-1);

      state.current = last?.[0] ?? null;

      if (last !== undefined) {
        setStep(last[1]);
      }
    },
  };
}
