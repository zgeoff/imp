import type { ImpRecord } from '../db/imps';
import type { ImpContext } from '../imps/imp-context';
import { readSnapshotMeta } from '../sleep/snapshot-meta';

type SessionSources = Pick<ImpContext, 'sessions' | 'findPaths'>;

// The sessions impd last saw, without asking the guest: what the idle loop
// recorded for an awake imp, the snapshot meta for a sleeping one. undefined
// when impd has not seen this boot's agent, or the snapshot predates them.
export function readSeenSessions(context: SessionSources, imp: Readonly<ImpRecord>) {
  if (imp.state === 'running') {
    return context.sessions.read(imp.id);
  }

  if (imp.state === 'sleeping') {
    return readSnapshotMeta(context.findPaths(imp.id))?.sessions;
  }

  return [];
}

export function countSessions(
  context: SessionSources,
  imp: Readonly<ImpRecord>,
): number | undefined {
  return readSeenSessions(context, imp)?.length;
}
