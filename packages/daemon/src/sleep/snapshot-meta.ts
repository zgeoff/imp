import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as z from 'zod';
import { AgentSessionSchema } from '../agent-client/agent-requests';
import type { ImpPaths } from '../storage/data-layout';
import type { HostIdentity, VmIdentity } from './vm-identity';

// What a memory snapshot is tied to: the identity of the VM that wrote it, since the snapshot
// holds the guest kernel and the page cache of the system drive it reopens by path
// (docs/architecture/sleep-and-wake.md#4-gotchas, gotcha 6).
const SnapshotIdentitySchema = z.object({
  firecrackerVersion: z.string(),
  snapshotVersion: z.string(),
  hostKernel: z.string(),
  guestKernel: z.string(),
  systemDrive: z.string(),

  // left out by an older impd, whose snapshot then boots cold once, and for a
  // VM booted before impd kept its identity
  systemDrivePath: z.string().optional(),
  agentVersion: z.string().optional(),
});

const SnapshotMetaSchema = SnapshotIdentitySchema.extend({
  createdAt: z.int(),
  memoryMib: z.int(),

  // the RAM the VM owned when it went to sleep: what a wake reserves
  ramMib: z.int().nonnegative(),

  // the guest's sessions as it went to sleep, so listing them does not wake
  // it; left out by an older impd
  sessions: z.array(AgentSessionSchema).readonly().optional(),
});

export type SnapshotIdentity = z.infer<typeof SnapshotIdentitySchema>;

export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;

// What a sleep records: the VM's identity. A VM booted before impd kept one
// gets the host's Firecracker and no drive, so it boots cold once.
export function buildSnapshotIdentity(
  vm: Readonly<VmIdentity> | null,
  host: Readonly<HostIdentity>,
): SnapshotIdentity {
  if (vm === null) {
    return {
      firecrackerVersion: host.firecrackerVersion,
      snapshotVersion: host.snapshotVersion,
      hostKernel: host.hostKernel,
      guestKernel: 'unknown',
      systemDrive: 'unknown',
    };
  }

  return {
    firecrackerVersion: vm.firecrackerVersion,
    snapshotVersion: vm.snapshotVersion,
    hostKernel: vm.hostKernel,
    guestKernel: vm.guestKernel,
    systemDrive: vm.systemDrive,
    systemDrivePath: vm.systemDrivePath,
    agentVersion: vm.agentVersion,
  };
}

export function writeSnapshotMeta(paths: Readonly<ImpPaths>, meta: Readonly<SnapshotMeta>): void {
  writeFileSync(paths.snapshotMeta, `${JSON.stringify(meta, null, 2)}\n`);
}

// null when there is no complete snapshot to load
export function readSnapshotMeta(paths: Readonly<ImpPaths>): SnapshotMeta | null {
  if (!existsSync(paths.vmstate) || !existsSync(paths.memFile)) {
    return null;
  }

  try {
    return SnapshotMetaSchema.parse(JSON.parse(readFileSync(paths.snapshotMeta, 'utf8')));
  } catch {
    return null;
  }
}

export function hasSnapshot(paths: Readonly<ImpPaths>): boolean {
  return readSnapshotMeta(paths) !== null;
}

// Why the snapshot cannot be loaded on this host, or null when it can. The
// guest kernel does not count: the VM holds it in memory. The drive counts
// only as the file the snapshot reopens, which stays while a snapshot names it.
export function findColdBootReason(
  meta: Readonly<SnapshotIdentity>,
  host: Readonly<HostIdentity>,
): string | null {
  const keys = ['firecrackerVersion', 'snapshotVersion', 'hostKernel'] as const;

  for (const key of keys) {
    if (meta[key] !== host[key]) {
      return `${key} changed (${meta[key]} → ${host[key]})`;
    }
  }

  if (meta.systemDrivePath === undefined) {
    return 'the snapshot is from an older impd';
  }

  if (!existsSync(meta.systemDrivePath)) {
    return `its agent drive ${meta.systemDrive.slice(0, 12)} is gone`;
  }

  return null;
}

// A stopped imp boots cold, and a restored disk invalidates the memory.
export function removeSnapshot(paths: Readonly<ImpPaths>): void {
  rmSync(paths.snapshotDir, { recursive: true, force: true });
}
