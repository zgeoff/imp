import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import type { OutdatedPart } from '@imp/api';
import * as z from 'zod';
import type { ImpPaths } from '../storage/data-layout';
import type { SystemFiles } from '../storage/setup-system-files';

// What a VM booted with. impd writes it at every cold boot; it holds until the
// next one, across sleeps, wakes and impd restarts, so a sleep records what
// the VM runs, not what the host would boot now.
const VmIdentitySchema = z.object({
  firecrackerVersion: z.string(),
  snapshotVersion: z.string(),
  hostKernel: z.string(),

  // sha256 of the guest kernel and the system drive
  guestKernel: z.string(),
  systemDrive: z.string(),

  // the drive's content-addressed path, which the VM's snapshots reopen
  systemDrivePath: z.string(),
  agentVersion: z.string(),

  // why this boot was cold instead of a wake; null for a create or a start
  bootReason: z.string().nullable(),
});

export type VmIdentity = z.infer<typeof VmIdentitySchema>;

// What this host boots imps with now.
export type HostIdentity = Omit<VmIdentity, 'agentVersion' | 'bootReason'>;

// Read once at start: impd installs the kernel and the system drive only then.
export function readHostIdentity(
  firecrackerBin: string,
  systemFiles: Readonly<SystemFiles>,
): HostIdentity {
  return {
    firecrackerVersion: readVersionOutput(firecrackerBin, '--version'),
    snapshotVersion: readVersionOutput(firecrackerBin, '--snapshot-version'),
    hostKernel: release(),
    guestKernel: systemFiles.info.guestKernel.sha256,
    systemDrive: systemFiles.info.systemDrive.sha256,
    systemDrivePath: systemFiles.systemDrivePath,
  };
}

// written next to the old file and renamed over it: a crash never leaves half
export function writeVmIdentity(paths: Readonly<ImpPaths>, identity: Readonly<VmIdentity>): void {
  const next = `${paths.vmIdentity}.new`;

  writeFileSync(next, `${JSON.stringify(identity, null, 2)}\n`);
  renameSync(next, paths.vmIdentity);
}

// null for a VM booted before impd kept the file, or a broken one
export function readVmIdentity(paths: Readonly<ImpPaths>): VmIdentity | null {
  if (!existsSync(paths.vmIdentity)) {
    return null;
  }

  try {
    return VmIdentitySchema.parse(JSON.parse(readFileSync(paths.vmIdentity, 'utf8')));
  } catch {
    return null;
  }
}

type PartIdentity = Pick<HostIdentity, 'firecrackerVersion' | 'guestKernel' | 'systemDrive'>;

// The parts of the host a VM predates; it picks them up at its next cold boot.
export function findOutdatedParts(
  vm: Readonly<PartIdentity>,
  host: Readonly<PartIdentity>,
): OutdatedPart[] {
  const parts: [keyof PartIdentity, OutdatedPart][] = [
    ['firecrackerVersion', 'firecracker'],
    ['guestKernel', 'kernel'],
    ['systemDrive', 'agent'],
  ];

  return parts.filter(([key]) => vm[key] !== host[key]).map(([, part]) => part);
}

// what a version reads as when the binary is missing, as on a dev machine
export const UNKNOWN_VERSION = 'unknown';

function readVersionOutput(bin: string, flag: string): string {
  try {
    const result = Bun.spawnSync([bin, flag], { stdout: 'pipe', stderr: 'ignore' });
    const match = /v\d+\.\d+\.\d+/.exec(result.stdout.toString());

    return match?.[0] ?? UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}
