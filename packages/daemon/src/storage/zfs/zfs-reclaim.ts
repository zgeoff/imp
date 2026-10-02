import type { ZfsEntry } from './zfs-commands';

export type ReclaimStep =
  | { readonly kind: 'destroy'; readonly name: string }
  | { readonly kind: 'promote'; readonly name: string };

// The next step that frees a retired disk or image, or null when none can go
// yet. Promoting the clone of its newest snapshot leaves it with no snapshots
// (docs/architecture/storage.md#reclaim).
export function planReclaimStep(
  entries: readonly ZfsEntry[],
  retiredRoot: string,
): ReclaimStep | null {
  const filesystems = entries.filter((entry) => entry.type === 'filesystem');

  const findClones = (snapshot: string) =>
    filesystems.filter((filesystem) => filesystem.origin === snapshot);

  for (const retired of filesystems) {
    if (!retired.name.startsWith(`${retiredRoot}/`)) {
      continue;
    }

    const snapshots = entries.filter(
      (entry) => entry.type === 'snapshot' && entry.name.startsWith(`${retired.name}@`),
    );

    if (snapshots.some((snapshot) => !snapshot.deferDestroy)) {
      continue;
    }

    // ZFS destroys a marked snapshot with its last clone; one without clones
    // is a leftover a crash cut short
    const unused = snapshots.find((snapshot) => findClones(snapshot.name).length === 0);

    if (unused !== undefined) {
      return { kind: 'destroy', name: unused.name };
    }

    const newest = snapshots.at(-1);

    if (newest === undefined) {
      return { kind: 'destroy', name: retired.name };
    }

    const [clone] = findClones(newest.name);

    if (clone !== undefined) {
      return { kind: 'promote', name: clone.name };
    }
  }

  return null;
}
