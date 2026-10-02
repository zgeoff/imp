import type { ImpChangeReason, ImpEventDetail } from '@imp/api';
import type { CheckpointRecord } from './checkpoints';
import type { ImpRecord } from './imps';
import type { ImpDatabase } from './open-database';

// A committed write to the imps or checkpoints table, for the event stream:
// db/imps.ts and db/checkpoints.ts emit every one but activity times and the
// egress policy, which the API does not show.
export type ImpWrite =
  | { readonly kind: 'added'; readonly imp: ImpRecord }
  | {
      readonly kind: 'changed';
      readonly imp: ImpRecord;
      readonly reason: ImpChangeReason;
      readonly detail?: ImpEventDetail;
    }
  | { readonly kind: 'removed'; readonly imp: ImpRecord }
  | { readonly kind: 'checkpointAdded'; readonly checkpoint: CheckpointRecord }
  | { readonly kind: 'checkpointRemoved'; readonly checkpoint: CheckpointRecord };

type ImpWriteListener = (write: ImpWrite) => void;

// by database handle: a test's database and impd's never share listeners
const listeners = new WeakMap<ImpDatabase, Set<ImpWriteListener>>();

// calls `listener` after each write to this database; returns the unwatch
export function subscribeImpWrites(db: ImpDatabase, listener: ImpWriteListener): () => void {
  const set = listeners.get(db) ?? new Set<ImpWriteListener>();

  set.add(listener);
  listeners.set(db, set);

  return () => {
    set.delete(listener);
  };
}

export function emitImpWrite(db: ImpDatabase, write: ImpWrite): void {
  for (const listener of listeners.get(db) ?? []) {
    listener(write);
  }
}
