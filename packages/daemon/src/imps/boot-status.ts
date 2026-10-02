import type { OutdatedPart, SystemInfo } from '@imp/api';
import type { ImpRecord } from '../db/imps';
import { findColdBootReason, readSnapshotMeta } from '../sleep/snapshot-meta';
import { findOutdatedParts, readVmIdentity } from '../sleep/vm-identity';
import type { HostIdentity } from '../sleep/vm-identity';
import type { ImpPaths } from '../storage/data-layout';

export interface BootStatus {
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

    // its wake finds nothing to load
    if (meta === null) {
      return { coldBootReason: 'no snapshot' };
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

  // re-adopted from an impd that kept no identity: its sleep cannot name a drive
  if (vm === null) {
    return { outdated: ['impd'] };
  }

  const status = vm.bootReason === null ? {} : { coldBootReason: vm.bootReason };

  return withOutdated(status, findOutdatedParts(vm, host));
}

function withOutdated(status: Readonly<BootStatus>, outdated: readonly OutdatedPart[]): BootStatus {
  return outdated.length === 0 ? status : { ...status, outdated };
}

// Counts what readBootStatus says over the running and sleeping imps; no
// other state has a VM or a snapshot.
export function countBootStatuses<T extends Pick<ImpRecord, 'state'>>(
  imps: readonly T[],
  read: (imp: T) => BootStatus,
): SystemInfo['bootStatus'] {
  const outdated = { firecracker: 0, kernel: 0, agent: 0 };
  let coldBoots = 0;

  for (const imp of imps) {
    if (imp.state !== 'running' && imp.state !== 'sleeping') {
      continue;
    }

    const status = read(imp);
    const parts = status.outdated ?? [];

    // a running imp's next sleep records what it runs: an older Firecracker,
    // or no identity at all, which the host then cannot load
    const bootsCold =
      imp.state === 'sleeping'
        ? status.coldBootReason !== undefined
        : parts.includes('firecracker') || parts.includes('impd');

    if (bootsCold) {
      coldBoots += 1;
    }

    for (const part of parts) {
      if (part !== 'impd') {
        outdated[part] += 1;
      }
    }
  }

  return { coldBoots, outdated };
}
