import { updateImpState } from '../db/imps';
import type { ImpRecord, ImpStateChange } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { isLockedImp, toLockedImp } from './imp-lock';
import type { LockedImp } from './imp-lock';
import { requireTransition } from './imp-transitions';

// An imp's state write: only under its lifecycle lock, and only along the
// lifecycle table (docs/architecture/lifecycle/lifecycle.md#states)
export async function updateLockedImpState(
  db: ImpDatabase,
  imp: LockedImp,
  change: Readonly<ImpStateChange>,
): Promise<LockedImp> {
  // the type alone trusts a caller's cast
  const record: ImpRecord = imp;

  if (!isLockedImp(record)) {
    throw new Error(`imp ${record.id}: a state write needs the imp's lock`);
  }

  if (change.state !== imp.state) {
    requireTransition(imp.state, change.state, `move to ${change.state}`);
  }

  const updated = await updateImpState(db, imp.id, change);

  return toLockedImp(imp, updated);
}
