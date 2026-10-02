import type { ImpWrite } from './imp-write-feed';

// An imp created, destroyed, or stopped before its first boot: what the
// proxy's ports and the broker's grants follow. The raw write, not the
// event, so a failure to build an event cannot leave a port open or closed.
export function isImpSetWrite(write: Readonly<ImpWrite>): boolean {
  if (write.kind === 'changed') {
    return write.reason === 'stopped';
  }

  return write.kind === 'added' || write.kind === 'removed';
}
