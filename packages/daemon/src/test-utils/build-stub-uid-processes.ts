// The host's processes by uid, as the jailer's kill deps see them: a cgroup
// kill, a scan of a uid's pids and a SIGKILL to one pid, which ends it unless
// the test made it survive kills
export function buildStubUidProcesses() {
  const byUid = new Map<number, number[]>();
  const survivors = new Set<number>();

  const cgroupKills: string[] = [];
  const kills: { pid: number; uid: number }[] = [];

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
    deps: {
      killCgroup: (impId: string) => {
        cgroupKills.push(impId);
      },
      listUidPids: (uid: number): readonly number[] => byUid.get(uid) ?? [],
      killUidPid: (pid: number, uid: number) => {
        kills.push({ pid, uid });

        if (!survivors.has(pid)) {
          byUid.set(
            uid,
            (byUid.get(uid) ?? []).filter((running) => running !== pid),
          );
        }
      },
    },
  };
}
