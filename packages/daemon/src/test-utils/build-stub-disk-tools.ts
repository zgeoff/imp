import { copyFileSync } from 'node:fs';

// One step a test holds: `reached` resolves when a call arrives, and every
// call waits until `release`.
interface DiskToolHold {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

interface HoldGate {
  readonly gate: PromiseWithResolvers<void>;
  readonly reached: () => void;
}

// createImpTest's `cloneDisk` and `growFilesystem`: a clone copies the file,
// as an XFS reflink ends with the same bytes, and a grow reports success.
// A test fails clones, lands them empty, or holds either step.
export function buildStubDiskTools() {
  const settings = { isCloneFailing: false, isCloneEmpty: false };

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

    return {
      reached: reached.promise,
      release: () => {
        holds[step] = null;

        gate.resolve();
      },
    };
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

      return true;
    },

    // every later clone throws, until set back
    setCloneFailing: (isFailing: boolean) => {
      settings.isCloneFailing = isFailing;
    },

    // every later clone succeeds with no file at the target, until set back
    setCloneEmpty: (isEmpty: boolean) => {
      settings.isCloneEmpty = isEmpty;
    },

    holdClone: () => hold('clone'),
    holdGrow: () => hold('grow'),
  };
}
