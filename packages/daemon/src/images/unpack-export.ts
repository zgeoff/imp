import { readFileSync } from 'node:fs';
import { ORPCError } from '@orpc/server';
import { runCommand } from '../process/run-command';
import type { CommandResult } from '../process/run-command';

// CAP_SETFCAP's bit in /proc/<pid>/status (linux/capability.h)
const CAP_SETFCAP_BIT = 31n;
const SETFCAP_HELP = 'imp-host needs CAP_SETFCAP (docs/architecture/host-contract.md#privileges)';

// GNU tar's `--xattrs` alone restores only `user.*`; docker export writes
// file capabilities as `security.capability`. Run with LC_ALL=C, which keeps
// tar's warnings in the English that findXattrFailure reads.
export const UNPACK_TAR_ARGS = [
  'tar',
  '--numeric-owner',
  '--xattrs',
  '--xattrs-include=security.capability',
  '--xattrs-include=user.*',
  '-xpf',
  '-',
] as const;

const UNPACK_SCRIPT = `docker export "$1" | LC_ALL=C ${UNPACK_TAR_ARGS.map((arg) => `'${arg}'`).join(' ')} -C "$2"`;

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

  const failure = findXattrFailure(result.stderr);

  if (failure?.missingSetfcap === true) {
    throw new ORPCError('PRECONDITION_FAILED', {
      message: `the image has a file capability that impd could not keep (${failure.line}); ${SETFCAP_HELP}`,
    });
  }

  // another cause, such as a namespaced capability the host refuses: not
  // SETFCAP's to fix, so the error is tar's own
  if (failure !== null) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: `the image has an extended attribute that impd could not keep: ${failure.line}`,
    });
  }
}

// GNU tar 1.35's warning for an attribute it could not set
const XATTR_FAILURE =
  /Cannot set '(?<name>[^']+)' extended attribute for file '.*': (?<reason>[^:]+)$/;

interface XattrFailure {
  readonly line: string;

  // EPERM on security.capability: what tar gets without CAP_SETFCAP
  readonly missingSetfcap: boolean;
}

// tar's line about an attribute it could not set, the missing-SETFCAP kind
// first; null when it set them all
function findXattrFailure(stderr: string): XattrFailure | null {
  const failures = stderr.split('\n').flatMap((text) => {
    const line = text.trim();
    const groups = XATTR_FAILURE.exec(line)?.groups;

    if (groups === undefined) {
      return [];
    }

    const missingSetfcap =
      groups['name'] === 'security.capability' && groups['reason'] === 'Operation not permitted';

    return [{ line, missingSetfcap }];
  });

  return failures.find((failure) => failure.missingSetfcap) ?? failures[0] ?? null;
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
