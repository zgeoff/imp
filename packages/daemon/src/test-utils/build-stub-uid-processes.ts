// The host's processes by uid, as the jailer's kill deps see them, with the
// pause between two scans and each chroot's owner, which only root could
// chown; a SIGKILL ends a process unless the test made it survive or exit slowly
export function buildStubUidProcesses() {
  const byUid = new Map<number, number[]>();
  const survivors = new Set<number>();
  const owners = new Map<string, number>();

  // the scans a slow process stays through once killed, and those exiting now
  const exitScans = new Map<number, number>();
  const exiting = new Map<number, number>();

  // the pauses so far, and the one a test holds by its number
  const pauses = { count: 0 };

  const holds = new Map<number, { gate: PromiseWithResolvers<void>; reached: () => void }>();

  const cgroupKills: string[] = [];
  const kills: { pid: number; uid: number }[] = [];

  const removePid = (uid: number, pid: number) => {
    byUid.set(
      uid,
      (byUid.get(uid) ?? []).filter((running) => running !== pid),
    );
  };

  return {
    cgroupKills,
    kills,

    // a process of `uid` that runs from now on
    start: (uid: number, pid: number) => {
      byUid.set(uid, [...(byUid.get(uid) ?? []), pid]);
    },

    // a process no kill ends, as one stuck in the kernel
    surviveKills: (pid: number) => {
      survivors.add(pid);
    },

    // a process whose kill starts an exit that `scans` more scans of its uid
    // still list, as a Firecracker freeing a large guest's memory does;
    // Infinity for one that never ends
    exitSlowly: (pid: number, scans: number) => {
      exitScans.set(pid, scans);
    },

    // the `nth` pause between two scans waits for `release`; `reached`
    // resolves once it starts
    holdPause: (nth: number) => {
      const gate = Promise.withResolvers<void>();
      const reached = Promise.withResolvers<void>();

      holds.set(nth, {
        gate,
        reached: () => {
          reached.resolve();
        },
      });

      return {
        reached: reached.promise,
        release: () => {
          gate.resolve();
        },
      };
    },

    // the chroot at `root`, made by the jail of `uid`
    ownRoot: (root: string, uid: number) => {
      owners.set(root, uid);
    },
    deps: {
      killCgroup: (impId: string) => {
        cgroupKills.push(impId);
      },
      listUidPids: (uid: number): readonly number[] => {
        const pids = byUid.get(uid) ?? [];

        for (const pid of pids) {
          const left = exiting.get(pid);

          if (left === 0) {
            exiting.delete(pid);

            removePid(uid, pid);
          } else if (left !== undefined) {
            exiting.set(pid, left - 1);
          }
        }

        return byUid.get(uid) ?? [];
      },
      killUidPid: (pid: number, uid: number) => {
        kills.push({ pid, uid });

        const scans = exitScans.get(pid);

        if (scans !== undefined) {
          exitScans.delete(pid);
          exiting.set(pid, scans);
        } else if (!survivors.has(pid) && !exiting.has(pid)) {
          removePid(uid, pid);
        }
      },
      isPidExiting: (pid: number) => exiting.has(pid),
      wait: async () => {
        pauses.count += 1;

        const hold = holds.get(pauses.count);

        if (hold !== undefined) {
          hold.reached();

          await hold.gate.promise;
        }
      },
      readRootOwner: (root: string) => owners.get(root),
    },
  };
}
