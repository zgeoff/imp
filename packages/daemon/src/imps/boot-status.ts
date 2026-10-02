import type { OutdatedPart } from '@imp/api';
import type { ImpRecord } from '../db/imps';
import { findColdBootReason, readSnapshotMeta } from '../sleep/snapshot-meta';
import { findOutdatedParts, readVmIdentity } from '../sleep/vm-identity';
import type { HostIdentity } from '../sleep/vm-identity';
import type { ImpPaths } from '../storage/data-layout';

interface BootStatus {
  readonly coldBootReason?: string;
  readonly outdated?: readonly OutdatedPart[];
}

// What an upgrade means for an imp: a sleeping one whose snapshot no longer
// loads boots cold, and why; an awake one, or one whose snapshot still loads,
// runs parts of the host it predates until its next cold boot.
export function readBootStatus(
  imp: Readonly<ImpRecord>,
  paths: Readonly<ImpPaths>,
  host: Readonly<HostIdentity>,
): BootStatus {
  if (imp.state === 'sleeping') {
    const meta = readSnapshotMeta(paths);

    if (meta === null) {
      return {};
    }

    const reason = findColdBootReason(meta, host);

    return reason === null
      ? withOutdated({}, findOutdatedParts(meta, host))
      : { coldBootReason: reason };
  }

  if (imp.state !== 'running') {
    return {};
  }

  const vm = readVmIdentity(paths);

  if (vm === null) {
    return {};
  }

  const status = vm.bootReason === null ? {} : { coldBootReason: vm.bootReason };

  return withOutdated(status, findOutdatedParts(vm, host));
}

function withOutdated(status: Readonly<BootStatus>, outdated: readonly OutdatedPart[]): BootStatus {
  return outdated.length === 0 ? status : { ...status, outdated };
}
