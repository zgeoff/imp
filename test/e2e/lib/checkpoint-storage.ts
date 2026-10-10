import { readInfo } from './imp-cli';
import { readGuestFile, writeGuestFile } from './imps';
import { runInContainer } from './instance';

// Thin glue over the host container and live guests, with nothing to test
// without them.

async function checkInContainer(...argv: readonly string[]): Promise<boolean> {
  const result = await runInContainer(argv);

  return result.exitCode === 0;
}

// whether impd's data dir in the host container still holds the imp's dir
export function hasImpDir(impId: string): Promise<boolean> {
  return checkInContainer('test', '-e', `/var/lib/imp/imps/${impId}`);
}

// A reflink file on XFS; on ZFS a snapshot not yet marked for destroy (one a
// fork still needs stays, marked, until the fork goes).
export async function hasCheckpointStorage(impId: string, checkpointId: string): Promise<boolean> {
  const info = await readInfo();

  if (info.storage.backend === 'xfs') {
    return checkInContainer('test', '-e', `/var/lib/imp/imps/${impId}/checkpoints/${checkpointId}`);
  }

  return checkInContainer(
    'sh',
    '-c',
    `zfs list -H -t snapshot -o name,defer_destroy | awk -F '\t' -v id="@$1" 'substr($1, length($1) - length(id) + 1) == id && $2 == "off" { found = 1 } END { exit !found }'`,
    'sh',
    checkpointId,
  );
}

export interface CrossWrites {
  // what each imp reads of the file only the other wrote: "none" when unseen
  readonly seenInA: string;
  readonly seenInB: string;

  // what b reads of its own file
  readonly ownInB: string;
}

// writes a file named for `tag` on each of two imps, then reads both from
// each side
export async function writeCrossFiles(a: string, b: string, tag: string): Promise<CrossWrites> {
  await writeGuestFile(a, `/root/only-${tag}-a`, 'a');
  await writeGuestFile(b, `/root/only-${tag}-b`, 'b');

  const seenInA = await readGuestFile(a, `/root/only-${tag}-b`);
  const seenInB = await readGuestFile(b, `/root/only-${tag}-a`);
  const ownInB = await readGuestFile(b, `/root/only-${tag}-b`);

  return { seenInA, seenInB, ownInB };
}
