import { onTestFinished } from 'bun:test';
import { copyFileSync } from 'node:fs';

// One step a test holds: `reached` resolves when a call arrives, and every
// call waits until `release`, which the test's end also runs.
interface DiskToolHold {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

interface HoldGate {
  readonly gate: PromiseWithResolvers<void>;
  readonly reached: () => void;
}

// createImpTest's `cloneDisk` and `growFilesystem`: a clone copies the file,
// as an XFS reflink ends with the same bytes, and a grow reports success
// unless a test set the filesystem unclean.
export function buildStubDiskTools() {
  const settings = { isCloneFailing: false, isCloneEmpty: false, isUnclean: false };

  // the target of each clone that finished, and each disk grown, in order
  const clones: string[] = [];
  const grows: string[] = [];
  const holds: { clone: HoldGate | null; grow: HoldGate | null } = { clone: null, grow: null };

  const waitAtHold = async (step: 'clone' | 'grow'): Promise<void> => {
    const hold = holds[step];

    if (hold !== null) {
      hold.reached();

      await hold.gate.promise;
    }
  };

  const hold = (step: 'clone' | 'grow'): DiskToolHold => {
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();

    holds[step] = { gate, reached: reached.resolve };

    const held: DiskToolHold = {
      reached: reached.promise,
      release: () => {
        if (holds[step]?.gate === gate) {
          holds[step] = null;
        }

        gate.resolve();
      },
    };

    // a test that fails while it holds a step still lets the call finish
    onTestFinished(() => {
      held.release();
    });

    return held;
  };

  return {
    clones,
    grows,

    cloneDisk: async (source: string, target: string): Promise<void> => {
      await waitAtHold('clone');

      if (settings.isCloneFailing) {
        throw new Error('clone failed: no space');
      }

      if (!settings.isCloneEmpty) {
        copyFileSync(source, target);
      }

      clones.push(target);
    },

    growFilesystem: async (disk: string): Promise<boolean> => {
      await waitAtHold('grow');

      grows.push(disk);

      // false: resize2fs is never run on a filesystem not unmounted cleanly
      return !settings.isUnclean;
    },

    // every later clone throws, until set back
    setCloneFailing: (isFailing: boolean) => {
      settings.isCloneFailing = isFailing;
    },

    // every later clone succeeds with no file at the target, until set back
    setCloneEmpty: (isEmpty: boolean) => {
      settings.isCloneEmpty = isEmpty;
    },

    // every later grow finds the filesystem unclean and leaves it, until set
    // back
    setUnclean: (isUnclean: boolean) => {
      settings.isUnclean = isUnclean;
    },

    holdClone: () => hold('clone'),
    holdGrow: () => hold('grow'),
  };
}
