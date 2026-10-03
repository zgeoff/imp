import { readFileSync } from 'node:fs';
import { ORPCError } from '@orpc/server';
import { runCommand } from '../process/run-command';
import type { CommandResult } from '../process/run-command';

// CAP_SETFCAP's bit in /proc/<pid>/status (linux/capability.h)
const CAP_SETFCAP_BIT = 31n;
const SETFCAP_HELP = 'imp-host needs CAP_SETFCAP (docs/architecture/host-contract.md#privileges)';

// GNU tar's `--xattrs` alone restores only `user.*`; docker export writes
// file capabilities as `security.capability`. LC_ALL=C keeps tar's warnings
// in the English that findLostCapability reads.
const UNPACK_SCRIPT =
  'docker export "$1" | LC_ALL=C tar --numeric-owner --xattrs --xattrs-include=security.capability --xattrs-include="user.*" -xpf - -C "$2"';

// Unpacks a container's filesystem into root, as root, so tar keeps numeric
// owners, modes and file capabilities as they are in the image.
export async function writeExportedTree(containerId: string, root: string): Promise<void> {
  const result = await runCommand([
    'bash',
    '-o',
    'pipefail',
    '-c',
    UNPACK_SCRIPT,
    'export',
    containerId,
    root,
  ]);

  assertUnpacked(result);
}

// tar only warns, and exits 0, when it cannot set an extended attribute: a
// binary that lost its capability would fail later, in the imp, with EPERM
export function assertUnpacked(result: CommandResult): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `docker export | tar exited ${String(result.exitCode)}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  const lost = findLostCapability(result.stderr);

  if (lost !== null) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: `the image has a file capability that impd could not keep (${lost}); ${SETFCAP_HELP}`,
    });
  }
}

// tar's line about the first file capability it could not set, if any
export function findLostCapability(stderr: string): string | null {
  const line = stderr.split('\n').find((text) => text.includes('security.capability'));

  return line?.trim() ?? null;
}

// A warning for the start log when impd runs without CAP_SETFCAP, which an
// image with a file capability needs; null when it has it
export function readSetfcapWarning(
  status: string = readFileSync('/proc/self/status', 'utf8'),
): string | null {
  const effective = /^CapEff:\s*(?<mask>[0-9a-f]+)$/m.exec(status)?.groups?.['mask'] ?? '0';

  if ((BigInt(`0x${effective}`) >> CAP_SETFCAP_BIT) & 1n) {
    return null;
  }

  return `impd: warning: no CAP_SETFCAP, so an image add or build fails on an image with a file capability; ${SETFCAP_HELP}`;
}
