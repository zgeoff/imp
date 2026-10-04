import { ORPCError } from '@orpc/server';

// builds that may run at once, an upload's or an on-host one; each holds up
// to buildContextMaxBytes on disk
const MAX_BUILDS = 4;

export interface BuildSlots {
  // a slot, or TOO_MANY_REQUESTS when all are taken; call what it returns
  // once, when the build ends
  readonly claim: () => () => void;
}

export function createBuildSlots(max = MAX_BUILDS): BuildSlots {
  const running = { count: 0 };

  return {
    claim: () => {
      if (running.count >= max) {
        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: `${String(max)} image builds are already uploading or running; try again`,
        });
      }

      running.count += 1;

      return () => {
        running.count -= 1;
      };
    },
  };
}
