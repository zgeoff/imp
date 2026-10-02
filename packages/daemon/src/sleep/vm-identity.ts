import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import type { OutdatedPart } from '@imp/api';
import * as z from 'zod';
import type { ImpPaths } from '../storage/data-layout';
import type { SystemFileInfo } from '../storage/system-file-info';

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

interface HostSources {
  readonly firecrackerBin: string;
  readonly systemDrivePath: string;
  readonly systemFiles: SystemFileInfo;
}

// Read once at start: impd installs the kernel and the system drive only then.
export function readHostIdentity(sources: Readonly<HostSources>): HostIdentity {
  return {
    firecrackerVersion: readVersionOutput(sources.firecrackerBin, '--version'),
    snapshotVersion: readVersionOutput(sources.firecrackerBin, '--snapshot-version'),
    hostKernel: release(),
    guestKernel: sources.systemFiles.guestKernel.sha256,
    systemDrive: sources.systemFiles.systemDrive.sha256,
    systemDrivePath: sources.systemDrivePath,
  };
}

export function writeVmIdentity(paths: Readonly<ImpPaths>, identity: Readonly<VmIdentity>): void {
  writeFileSync(paths.vmIdentity, `${JSON.stringify(identity, null, 2)}\n`);
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

function readVersionOutput(bin: string, flag: string): string {
  try {
    const result = Bun.spawnSync([bin, flag], { stdout: 'pipe', stderr: 'ignore' });
    const match = /v\d+\.\d+\.\d+/.exec(result.stdout.toString());

    return match?.[0] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
