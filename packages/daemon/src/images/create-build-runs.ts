import type { ImageBuildPhase, ImageBuildRun, ImageBuildSource } from '@imp/api';

// One build as it runs: each setter updates what images.builds shows, and
// `end` takes the build off the list however it ended
export interface BuildRun {
  readonly setPhase: (phase: ImageBuildPhase) => void;
  readonly setStep: (step: string) => void;
  readonly setBuilder: (name: string) => void;
  readonly end: () => void;
}

export interface BuildRuns {
  readonly start: (name: string, source: ImageBuildSource) => BuildRun;

  // the builds running now, the oldest first
  readonly list: () => ImageBuildRun[];
}

// The builds impd runs now, in memory: a restart ends every build, so none
// outlives the list. `now` stamps each build's start.
export function createBuildRuns(now: () => number): BuildRuns {
  const runs = new Set<{ run: ImageBuildRun }>();

  return {
    start: (name, source) => {
      const entry: { run: ImageBuildRun } = {
        run: {
          name,
          source,
          startedAt: new Date(now()),
          phase: source === 'upload' ? 'upload' : 'pack',
          step: null,
          builder: null,
        },
      };

      runs.add(entry);

      return {
        setPhase: (phase) => {
          entry.run = { ...entry.run, phase };
        },
        setStep: (step) => {
          entry.run = { ...entry.run, step };
        },
        setBuilder: (builder) => {
          entry.run = { ...entry.run, builder };
        },
        end: () => {
          runs.delete(entry);
        },
      };
    },
    list: () => [...runs].map((entry) => entry.run),
  };
}
