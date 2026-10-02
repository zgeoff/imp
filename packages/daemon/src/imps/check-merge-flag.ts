import type { ImpContext } from './imp-context';

// imps whose guest memory KSM cannot merge: the flag did not survive the exec
export interface MergeFlags {
  readonly recordLost: (id: string) => void;
  readonly clearLost: (id: string) => void;
  readonly isLost: (id: string) => boolean;
}

export function createMergeFlags(): MergeFlags {
  const lost = new Set<string>();

  return {
    recordLost: (id) => {
      lost.add(id);
    },
    clearLost: (id) => {
      lost.delete(id);
    },
    isLost: (id) => lost.has(id),
  };
}

// With IMP_KSM, checks that KSM may merge the VM's guest memory. Before Linux
// 6.19 (590c03ca6a3f) ksmd can clear the merge flag during the exec, and the
// guest then runs unmerged; `imp info` counts such imps.
export function checkMergeFlag(
  context: ImpContext,
  imp: Readonly<{ id: string; name: string }>,
  pid: number,
): void {
  if (context.config.ksm === null) {
    return;
  }

  const mergeable = context.checkGuestMerge(pid);

  if (mergeable === false) {
    context.mergeFlags.recordLost(imp.id);

    context.log(
      `impd: ${imp.name}: KSM cannot merge its guest memory (no merge flag after the exec)`,
    );

    return;
  }

  context.mergeFlags.clearLost(imp.id);
}
