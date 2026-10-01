import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import * as z from 'zod';
import type { ImpPaths } from '../storage/data-layout';

// What a memory snapshot is tied to (docs/sleep-findings.md gotcha 6). The
// guest kernel and the system drive count too: the snapshot holds the guest's
// page cache of the system drive, and its kernel in memory.
const SnapshotIdentitySchema = z.object({
  firecrackerVersion: z.string(),
  snapshotVersion: z.string(),
  hostKernel: z.string(),
  guestKernel: z.string(),
  systemDrive: z.string(),
});

const SnapshotMetaSchema = SnapshotIdentitySchema.extend({
  createdAt: z.int(),
  memoryMib: z.int(),

  // the RAM the VM owned when it went to sleep: what a wake reserves
  ramMib: z.int().nonnegative(),
});

export type SnapshotIdentity = z.infer<typeof SnapshotIdentitySchema>;

export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;

interface IdentitySources {
  readonly firecrackerBin: string;
  readonly kernelPath: string;
  readonly systemDrivePath: string;
}

// Read once at start: impd swaps the kernel and the system drive only then.
export function readSnapshotIdentity(sources: Readonly<IdentitySources>): SnapshotIdentity {
  return {
    firecrackerVersion: readVersionOutput(sources.firecrackerBin, '--version'),
    snapshotVersion: readVersionOutput(sources.firecrackerBin, '--snapshot-version'),
    hostKernel: release(),
    guestKernel: readFileHash(sources.kernelPath),
    systemDrive: readFileHash(sources.systemDrivePath),
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

// why the snapshot cannot be loaded here, or null when it can
export function checkSnapshotMatch(
  meta: Readonly<SnapshotIdentity>,
  current: Readonly<SnapshotIdentity>,
): string | null {
  const keys: readonly (keyof SnapshotIdentity)[] = [
    'firecrackerVersion',
    'snapshotVersion',
    'hostKernel',
    'guestKernel',
    'systemDrive',
  ];

  for (const key of keys) {
    if (meta[key] !== current[key]) {
      return `${key} changed (${meta[key]} → ${current[key]})`;
    }
  }

  return null;
}

// A stopped imp boots cold, and a restored disk invalidates the memory.
export function removeSnapshot(paths: Readonly<ImpPaths>): void {
  rmSync(paths.snapshotDir, { recursive: true, force: true });
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

function readFileHash(path: string): string {
  try {
    return Bun.hash(readFileSync(path)).toString(16);
  } catch {
    return 'missing';
  }
}
